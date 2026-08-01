from __future__ import annotations

import hashlib
import hmac
import logging
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_session
from app.models.channel import (
    BINDING_STATUS_ACTIVE,
    CHANNEL_PROVIDER_WHATSAPP,
    MESSAGE_DIRECTION_OUTBOUND,
    PROVIDER_EVENT_SCOPE_ACCOUNT,
    ChannelBinding,
    ChannelMessage,
)
from app.routes.channel_routers.shared import _extract_bearer_token
from app.schemas.channel import (
    WhatsAppApplicationAckRequest,
    WhatsAppApplicationAckResponse,
    WhatsAppApplicationInboxEvent,
    WhatsAppApplicationInboxResponse,
    WhatsAppApplicationOutboundRequest,
    WhatsAppApplicationOutboundResponse,
    WhatsAppSidecarEvent,
    WhatsAppSidecarEventResponse,
)
from app.services.channels import (
    ack_channel_inbox_events,
    channel_runtime_account_key,
    find_existing_inbound_provider_event,
    get_active_channel_account,
    pairing_reply_for_command,
    parse_pair_command,
    record_inbound_messages_for_bindings,
    resolve_channel_agent_by_token,
    resolve_inbound_binding,
    wait_for_channel_inbox_events,
)
from app.services.whatsapp_application_runtime import (
    WhatsAppApplicationIdempotencyConflictError,
    WhatsAppApplicationReplyNotFoundError,
    WhatsAppApplicationSidecarRejectedError,
    WhatsAppApplicationSidecarUnavailableError,
    send_whatsapp_application_outbound,
)
from app.services.whatsapp_baileys import (
    remember_whatsapp_binding_aliases,
    resolve_whatsapp_binding_by_jids,
)
from app.services.whatsapp_native_transport import WhatsAppApplicationSendRequest
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
    account,
    external_chat_id: str,
    source_message_id: str,
    source_actor_jid: str,
    command,
    binding_result,
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
        provider_message_id = await sidecar.send_application_message(
            WhatsAppApplicationSendRequest(
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


async def _resolve_application_agent(
    db: AsyncSession,
    *,
    account_key: str,
    authorization: str | None,
):
    token = _extract_bearer_token(authorization)
    if token is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing access token")
    agent = await resolve_channel_agent_by_token(
        db,
        provider=CHANNEL_PROVIDER_WHATSAPP,
        token=token,
    )
    expected_account_key = channel_runtime_account_key(agent.account.id)
    if not hmac.compare_digest(account_key, expected_account_key):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="account key mismatch")
    return agent


@router.get("/application/{account_key}/inbox", include_in_schema=False)
async def whatsapp_application_inbox(
    account_key: str,
    after: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=100),
    timeout: int = Query(default=0, ge=0, le=30),
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
) -> WhatsAppApplicationInboxResponse:
    agent = await _resolve_application_agent(
        db,
        account_key=account_key,
        authorization=authorization,
    )
    events = await wait_for_channel_inbox_events(
        db,
        account=agent.account,
        bot_agent_link_id=agent.link.id,
        after_sequence=after,
        limit=limit,
        timeout_seconds=timeout,
    )
    return WhatsAppApplicationInboxResponse(events=[_inbox_event(message) for message in events])


@router.post("/application/{account_key}/ack", include_in_schema=False)
async def whatsapp_application_ack(
    account_key: str,
    body: WhatsAppApplicationAckRequest,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
) -> WhatsAppApplicationAckResponse:
    agent = await _resolve_application_agent(
        db,
        account_key=account_key,
        authorization=authorization,
    )
    acked = await ack_channel_inbox_events(
        db,
        account=agent.account,
        bot_agent_link_id=agent.link.id,
        through_sequence=body.through_sequence,
    )
    await db.commit()
    return WhatsAppApplicationAckResponse(
        ackedCount=acked,
        throughSequence=body.through_sequence,
    )


@router.post("/application/{account_key}/messages", include_in_schema=False)
async def whatsapp_application_messages(
    account_key: str,
    body: WhatsAppApplicationOutboundRequest,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
) -> WhatsAppApplicationOutboundResponse:
    agent = await _resolve_application_agent(
        db,
        account_key=account_key,
        authorization=authorization,
    )
    binding = (
        await db.execute(
            select(ChannelBinding).where(
                ChannelBinding.id == body.binding_id,
                ChannelBinding.account_id == agent.account.id,
                ChannelBinding.bot_agent_link_id == agent.link.id,
                ChannelBinding.status == BINDING_STATUS_ACTIVE,
            )
        )
    ).scalar_one_or_none()
    if binding is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="binding not found")

    try:
        provider_message_id = await send_whatsapp_application_outbound(
            db,
            account_id=agent.account.id,
            link_id=agent.link.id,
            binding=binding,
            body=body,
        )
    except WhatsAppApplicationReplyNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="reply message not found"
        ) from exc
    except WhatsAppApplicationIdempotencyConflictError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="clientMessageId was already used for a different message",
        ) from exc
    except WhatsAppApplicationSidecarUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="WhatsApp sidecar unavailable",
        ) from exc
    except WhatsAppApplicationSidecarRejectedError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="WhatsApp sidecar rejected message",
        ) from exc
    return WhatsAppApplicationOutboundResponse(providerMessageId=provider_message_id)


def _inbox_event(message: ChannelMessage) -> WhatsAppApplicationInboxEvent:
    payload = message.payload if isinstance(message.payload, dict) else {}
    if message.binding_id is None or message.provider_message_id is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="invalid WhatsApp inbox event",
        )
    actor_jid = payload.get("actorJid")
    if not isinstance(actor_jid, str):
        actor_jid = message.external_chat_id
    actor_jid_alt = payload.get("actorJidAlt")
    push_name = payload.get("pushName")
    timestamp_value = payload.get("timestamp")
    return WhatsAppApplicationInboxEvent(
        sequence=message.inbox_sequence,
        bindingId=message.binding_id,
        chatJid=message.external_chat_id,
        actorJid=actor_jid,
        actorJidAlt=actor_jid_alt if isinstance(actor_jid_alt, str) else None,
        messageId=message.provider_message_id,
        text=message.text,
        pushName=push_name if isinstance(push_name, str) else None,
        timestamp=timestamp_value if isinstance(timestamp_value, int) else None,
    )


def _pairing_reply_message_id(account_id: UUID, source_message_id: str) -> str:
    material = f"clawdi-whatsapp-pairing-reply:{account_id}:{source_message_id}".encode()
    return hashlib.sha256(material).hexdigest().upper()
