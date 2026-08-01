from __future__ import annotations

import hashlib
import hmac
import logging
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_session
from app.models.channel import (
    CHANNEL_PROVIDER_WHATSAPP,
    MESSAGE_DIRECTION_OUTBOUND,
    PROVIDER_EVENT_SCOPE_ACCOUNT,
    ChannelAccount,
    ChannelMessage,
)
from app.routes.channel_routers.shared import _extract_bearer_token
from app.schemas.channel import WhatsAppSidecarEvent, WhatsAppSidecarEventResponse
from app.services.channels import (
    ChannelPairCommand,
    InboundBindingResult,
    find_existing_inbound_provider_event,
    get_active_channel_account,
    pairing_reply_for_command,
    parse_pair_command,
    record_inbound_messages_for_bindings,
    resolve_inbound_binding,
)
from app.services.whatsapp_baileys import (
    remember_whatsapp_binding_aliases,
    resolve_whatsapp_binding_by_jids,
)
from app.services.whatsapp_native_transport import WhatsAppSidecarSendRequest
from app.services.whatsapp_sidecar_registry import (
    configured_whatsapp_sidecar_ingress_token,
    get_configured_whatsapp_sidecar_client,
)

router = APIRouter(prefix="/channels/whatsapp", tags=["channels"])
log = logging.getLogger(__name__)


@router.post("/{account_id}/sidecar/events", include_in_schema=False)
async def whatsapp_sidecar_event(
    account_id: UUID,
    body: WhatsAppSidecarEvent,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
) -> WhatsAppSidecarEventResponse:
    account = await get_active_channel_account(db, account_id=account_id)
    if account.provider != CHANNEL_PROVIDER_WHATSAPP:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="channel not found")
    configured_token = configured_whatsapp_sidecar_ingress_token(
        account.id,
        settings.channel_whatsapp_baileys_sidecars_json,
    )
    supplied_token = _extract_bearer_token(authorization)
    if (
        configured_token is None
        or supplied_token is None
        or not hmac.compare_digest(supplied_token, configured_token)
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid sidecar token",
        )

    existing = await find_existing_inbound_provider_event(
        db,
        account=account,
        external_chat_id=body.chat_jid,
        provider_event_id=body.provider_event_id,
        provider_event_scope=PROVIDER_EVENT_SCOPE_ACCOUNT,
    )
    if existing is not None:
        return WhatsAppSidecarEventResponse(duplicate=True, bindingId=existing.binding_id)

    binding_lookup = await resolve_whatsapp_binding_by_jids(
        db,
        account=account,
        remote_jid=body.chat_jid,
        alt_jid=body.chat_jid_alt,
    )
    if binding_lookup.conflict:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="WhatsApp JID aliases resolve to different links",
        )
    external_chat_id = body.chat_jid
    external_chat_type = "group" if body.chat_jid.endswith("@g.us") else "private"
    external_chat_name = None if external_chat_type == "group" else body.push_name
    if binding_lookup.binding is not None:
        external_chat_id = binding_lookup.binding.external_chat_id
        external_chat_type = binding_lookup.binding.external_chat_type or external_chat_type
        external_chat_name = binding_lookup.binding.external_chat_name or external_chat_name

    command = parse_pair_command(body.text)
    binding_result = await resolve_inbound_binding(
        db,
        account=account,
        external_chat_id=external_chat_id,
        external_chat_type=external_chat_type,
        external_chat_name=external_chat_name,
        external_user_id=body.actor_jid,
        text=body.text,
        command=command,
        command_actor_required=external_chat_type == "group",
    )
    inbox_payload: dict[str, str | int] = {"actorJid": body.actor_jid}
    if body.actor_jid_alt is not None:
        inbox_payload["actorJidAlt"] = body.actor_jid_alt
    if body.push_name is not None:
        inbox_payload["pushName"] = body.push_name
    if body.timestamp is not None:
        inbox_payload["timestamp"] = body.timestamp
    messages = await record_inbound_messages_for_bindings(
        db,
        account=account,
        binding_result=binding_result,
        external_chat_id=external_chat_id,
        provider_message_id=body.message_id,
        provider_event_id=body.provider_event_id,
        provider_event_scope=PROVIDER_EVENT_SCOPE_ACCOUNT,
        text=body.text,
        payload=inbox_payload,
        suppress_duplicate_event=True,
    )
    if not messages:
        return WhatsAppSidecarEventResponse(duplicate=True)
    for _message, binding in messages:
        await remember_whatsapp_binding_aliases(
            db,
            binding=binding,
            remote_jid=body.chat_jid,
            alt_jid=body.chat_jid_alt,
        )
    await db.commit()
    message = messages[0][0]
    await _send_pairing_reply_best_effort(
        db,
        account=account,
        external_chat_id=body.chat_jid,
        source_message_id=body.message_id,
        source_actor_jid=body.actor_jid,
        command=command,
        binding_result=binding_result,
    )
    return WhatsAppSidecarEventResponse(
        paired=binding_result.paired,
        unpaired=binding_result.unpaired,
        bindingId=message.binding_id,
    )


async def _send_pairing_reply_best_effort(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    external_chat_id: str,
    source_message_id: str,
    source_actor_jid: str,
    command: ChannelPairCommand | None,
    binding_result: InboundBindingResult,
) -> None:
    if not binding_result.command_handled:
        return
    sidecar = get_configured_whatsapp_sidecar_client(account.id)
    if sidecar is None:
        log.warning(
            "WhatsApp pairing reply skipped because sidecar is unavailable account_id=%s",
            account.id,
        )
        return
    reply_text = pairing_reply_for_command(command, binding_result)
    reply_message_id = _pairing_reply_message_id(account.id, source_message_id)
    try:
        provider_message_id = await sidecar.send_text_message(
            WhatsAppSidecarSendRequest(
                jid=external_chat_id,
                text=reply_text,
                message_id=reply_message_id,
                reply_to_message_id=source_message_id,
                reply_to_participant_jid=(
                    source_actor_jid if external_chat_id.endswith("@g.us") else None
                ),
            )
        )
    except Exception:
        log.warning(
            "WhatsApp pairing reply delivery failed account_id=%s chat_id=%s",
            account.id,
            external_chat_id,
            exc_info=True,
        )
        return
    binding = binding_result.binding
    db.add(
        ChannelMessage(
            account_id=account.id,
            bot_agent_link_id=binding.bot_agent_link_id if binding is not None else None,
            binding_id=binding.id if binding is not None else None,
            user_id=binding.user_id if binding is not None else account.user_id,
            direction=MESSAGE_DIRECTION_OUTBOUND,
            external_chat_id=external_chat_id,
            provider_message_id=provider_message_id,
            text=reply_text,
            payload={"transport": "baileys_sidecar", "pairingReply": True},
        )
    )
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        log.warning(
            "WhatsApp pairing reply metadata persistence failed account_id=%s chat_id=%s",
            account.id,
            external_chat_id,
            exc_info=True,
        )


def _pairing_reply_message_id(account_id: UUID, source_message_id: str) -> str:
    material = f"clawdi-whatsapp-pairing-reply:{account_id}:{source_message_id}".encode()
    return hashlib.sha256(material).hexdigest().upper()
