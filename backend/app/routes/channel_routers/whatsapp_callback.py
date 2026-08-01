from __future__ import annotations

import hmac
import logging
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session
from app.models.channel import (
    CHANNEL_PROVIDER_WHATSAPP,
    MESSAGE_DIRECTION_OUTBOUND,
    PROVIDER_EVENT_SCOPE_ACCOUNT,
    ChannelAccount,
    ChannelBinding,
    ChannelBotAgentLink,
    ChannelMessage,
)
from app.routes.channel_routers.shared import _extract_bearer_token
from app.schemas.whatsapp_callback import WhatsAppSidecarEvent, WhatsAppSidecarEventResponse
from app.services.channels import (
    InboundBindingResult,
    find_existing_inbound_provider_event,
    get_active_channel_account,
    get_channel_secret,
    pairing_reply_for_command,
    parse_pair_command,
    record_inbound_message,
    resolve_inbound_binding,
)
from app.services.whatsapp_callback import (
    WHATSAPP_SIDECAR_INGRESS_SECRET_NAME,
    ensure_callback_binding_authority,
    ensure_whatsapp_actor_ownership,
    ignored_whatsapp_callback_exists,
    record_ignored_whatsapp_callback,
    remember_explicit_whatsapp_chat_alias,
    resolve_whatsapp_callback_binding,
    stable_whatsapp_message_id,
)
from app.services.whatsapp_sidecar_registry import get_configured_whatsapp_sidecar_client

router = APIRouter(prefix="/channels/whatsapp", tags=["channels"])
log = logging.getLogger(__name__)


@router.post("/{account_id}/sidecar/events", include_in_schema=False)
async def whatsapp_sidecar_event(
    account_id: UUID,
    body: WhatsAppSidecarEvent,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
) -> WhatsAppSidecarEventResponse:
    account = await _whatsapp_account(db, account_id)
    await _authenticate_sidecar_callback(
        db,
        account=account,
        authorization=authorization,
    )
    if _event_account_id(body) != account.id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="sidecar event account does not match callback path",
        )
    existing = await find_existing_inbound_provider_event(
        db,
        account=account,
        external_chat_id=body.chat.primary,
        provider_event_id=body.provider_event_id,
        provider_event_scope=PROVIDER_EVENT_SCOPE_ACCOUNT,
    )
    if existing is not None:
        return WhatsAppSidecarEventResponse(duplicate=True, bindingId=existing.binding_id)
    if await ignored_whatsapp_callback_exists(
        db,
        account=account,
        provider_event_id=body.provider_event_id,
    ):
        return WhatsAppSidecarEventResponse(duplicate=True)
    if body.from_me:
        created = await record_ignored_whatsapp_callback(
            db,
            account=account,
            provider_event_id=body.provider_event_id,
            reason="from_me",
        )
        await db.commit()
        return WhatsAppSidecarEventResponse(
            duplicate=not created,
            ignoredFromMe=created,
        )

    lookup = await resolve_whatsapp_callback_binding(
        db,
        account=account,
        chat_jid=body.chat.primary,
        chat_jid_alt=body.chat.alt,
    )
    if lookup.conflict:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="WhatsApp chat aliases resolve to different bindings",
        )

    command = parse_pair_command(_event_text(body))
    link: ChannelBotAgentLink | None = None
    if lookup.binding is not None:
        link = await ensure_callback_binding_authority(db, account=account, binding=lookup.binding)
        ensure_whatsapp_actor_ownership(body, lookup.binding)
        await remember_explicit_whatsapp_chat_alias(
            db,
            binding=lookup.binding,
            chat_jid=body.chat.primary,
            chat_jid_alt=body.chat.alt,
        )

    binding_result = InboundBindingResult(binding=lookup.binding)
    if command is not None:
        binding_result = await resolve_inbound_binding(
            db,
            account=account,
            external_chat_id=(
                lookup.binding.external_chat_id if lookup.binding is not None else body.chat.primary
            ),
            external_chat_type=_event_chat_type(body),
            external_chat_name=body.push_name if _event_chat_type(body) == "private" else None,
            external_user_id=body.actor.primary,
            text=_event_text(body),
            command=command,
            command_actor_required=_event_chat_type(body) == "group",
        )
    binding = binding_result.binding
    if binding is None:
        created = await record_ignored_whatsapp_callback(
            db,
            account=account,
            provider_event_id=body.provider_event_id,
            reason="unpaired_command" if command is not None else "unpaired",
        )
        await db.commit()
        return WhatsAppSidecarEventResponse(
            duplicate=not created,
            ignoredUnpaired=created,
        )
    if link is None or link.id != binding.bot_agent_link_id:
        link = await ensure_callback_binding_authority(db, account=account, binding=binding)
        ensure_whatsapp_actor_ownership(body, binding)
        await remember_explicit_whatsapp_chat_alias(
            db,
            binding=binding,
            chat_jid=body.chat.primary,
            chat_jid_alt=body.chat.alt,
        )

    payload = {
        "schemaVersion": body.schema_version,
        "accountId": body.account_id,
        "eventType": body.event_type,
        "chat": body.chat.model_dump(mode="json", by_alias=True, exclude_none=True),
        "actor": body.actor.model_dump(mode="json", by_alias=True, exclude_none=True),
        "ownership": body.ownership,
        "timestamp": body.timestamp,
        "pushName": body.push_name,
        "content": body.content.model_dump(mode="json", by_alias=True, exclude_none=True),
        "replyTo": (
            body.reply_to.model_dump(mode="json", by_alias=True)
            if body.reply_to is not None
            else None
        ),
    }
    try:
        message = await record_inbound_message(
            db,
            account=account,
            binding=binding,
            external_chat_id=binding.external_chat_id,
            provider_message_id=body.message_id,
            provider_event_id=body.provider_event_id,
            provider_event_scope=PROVIDER_EVENT_SCOPE_ACCOUNT,
            text=_event_text(body),
            payload=payload,
        )
        if binding_result.command_handled:
            message.delivered_at = message.created_at
        await db.commit()
    except IntegrityError:
        await db.rollback()
        replay = await find_existing_inbound_provider_event(
            db,
            account=account,
            external_chat_id=body.chat.primary,
            provider_event_id=body.provider_event_id,
            provider_event_scope=PROVIDER_EVENT_SCOPE_ACCOUNT,
        )
        if replay is None:
            raise
        return WhatsAppSidecarEventResponse(duplicate=True, bindingId=replay.binding_id)

    if binding_result.command_handled:
        await _send_pairing_reply_best_effort(
            account=account,
            link=link,
            binding=binding,
            event=body,
            reply_text=pairing_reply_for_command(command, binding_result),
            db=db,
        )
    return WhatsAppSidecarEventResponse(
        paired=binding_result.paired,
        unpaired=binding_result.unpaired,
        bindingId=binding.id,
    )


async def _authenticate_sidecar_callback(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    authorization: str | None,
) -> None:
    configured_token = await get_channel_secret(
        db,
        account=account,
        name=WHATSAPP_SIDECAR_INGRESS_SECRET_NAME,
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


async def _whatsapp_account(db: AsyncSession, account_id: UUID) -> ChannelAccount:
    account = await get_active_channel_account(db, account_id=account_id)
    if account.provider != CHANNEL_PROVIDER_WHATSAPP:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="channel not found")
    return account


def _event_text(event: WhatsAppSidecarEvent) -> str | None:
    return event.content.text if event.content.type == "text" else None


def _event_account_id(event: WhatsAppSidecarEvent) -> UUID | None:
    try:
        return UUID(event.account_id)
    except ValueError:
        return None


def _event_chat_type(event: WhatsAppSidecarEvent) -> str:
    return "group" if event.chat.primary.endswith("@g.us") else "private"


async def _send_pairing_reply_best_effort(
    *,
    account: ChannelAccount,
    link: ChannelBotAgentLink,
    binding: ChannelBinding,
    event: WhatsAppSidecarEvent,
    reply_text: str,
    db: AsyncSession,
) -> None:
    client = get_configured_whatsapp_sidecar_client(account.id)
    if client is None:
        return
    operation_id = stable_whatsapp_message_id(
        "pairing-reply-operation", account.id, event.message_id
    )
    message_id = stable_whatsapp_message_id("pairing-reply-message", account.id, event.message_id)
    reply_to: dict[str, object] = {
        "messageId": event.message_id,
        "fromMe": False,
    }
    if _event_chat_type(event) == "group":
        reply_to["participantJid"] = event.actor.primary
        if event.actor.alt is not None:
            reply_to["participantJidAlt"] = event.actor.alt
    payload = {
        "schemaVersion": "clawdi.whatsapp.operation.v1",
        "operationId": operation_id,
        "chatJid": binding.external_chat_id,
        "type": "send",
        "messageId": message_id,
        "content": {"type": "text", "text": reply_text},
        "replyTo": reply_to,
    }
    try:
        result = await client.execute_operation(
            payload,
            expected_operation_id=operation_id,
        )
        db.add(
            ChannelMessage(
                account_id=account.id,
                bot_agent_link_id=link.id,
                binding_id=binding.id,
                user_id=link.user_id,
                direction=MESSAGE_DIRECTION_OUTBOUND,
                external_chat_id=binding.external_chat_id,
                provider_message_id=result.message_id,
                text=reply_text,
                payload={
                    "whatsappOperation": {
                        "type": "pairingReply",
                        "operationId": operation_id,
                    },
                    "providerResponse": result.metadata(),
                },
            )
        )
        await db.commit()
    except Exception:  # noqa: BLE001 - pairing reply does not undo accepted authority.
        await db.rollback()
        log.warning("WhatsApp pairing reply failed account_id=%s", account.id)
