from __future__ import annotations

import logging
from uuid import UUID

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel import (
    MESSAGE_DIRECTION_INBOUND,
    MESSAGE_DIRECTION_OUTBOUND,
    ChannelBinding,
    ChannelMessage,
)
from app.schemas.channel import WhatsAppApplicationOutboundRequest
from app.services.whatsapp_native_transport import WhatsAppApplicationSendRequest
from app.services.whatsapp_sidecar_registry import get_configured_whatsapp_sidecar_client

log = logging.getLogger(__name__)


class WhatsAppApplicationReplyNotFoundError(Exception):
    pass


class WhatsAppApplicationIdempotencyConflictError(Exception):
    pass


class WhatsAppApplicationSidecarUnavailableError(Exception):
    pass


class WhatsAppApplicationSidecarRejectedError(Exception):
    pass


async def send_whatsapp_application_outbound(
    db: AsyncSession,
    *,
    account_id: UUID,
    link_id: UUID,
    binding: ChannelBinding,
    body: WhatsAppApplicationOutboundRequest,
) -> str:
    reply_message_id, reply_participant_jid = await _resolve_reply(
        db,
        account_id=account_id,
        link_id=link_id,
        binding=binding,
        reply_to_sequence=body.reply_to_sequence,
    )
    lock_name = (
        f"whatsapp-application-send:{account_id}:{link_id}:{binding.id}:{body.client_message_id}"
    )
    await db.execute(select(func.pg_advisory_xact_lock(func.hashtextextended(lock_name, 0))))
    existing = (
        await db.execute(
            select(ChannelMessage).where(
                ChannelMessage.account_id == account_id,
                ChannelMessage.bot_agent_link_id == link_id,
                ChannelMessage.binding_id == binding.id,
                ChannelMessage.direction == MESSAGE_DIRECTION_OUTBOUND,
                ChannelMessage.provider_message_id == body.client_message_id,
            )
        )
    ).scalar_one_or_none()
    request_payload = {
        "transport": "baileys_sidecar",
        "final": True,
        "deliveryState": "pending",
        "clientMessageId": body.client_message_id,
        **(
            {"replyToSequence": body.reply_to_sequence}
            if body.reply_to_sequence is not None
            else {}
        ),
    }
    if existing is not None:
        payload = existing.payload if isinstance(existing.payload, dict) else {}
        if existing.text != body.text or payload.get("replyToSequence") != body.reply_to_sequence:
            raise WhatsAppApplicationIdempotencyConflictError
        if payload.get("deliveryState") == "sent":
            return body.client_message_id
    else:
        existing = ChannelMessage(
            account_id=account_id,
            bot_agent_link_id=link_id,
            binding_id=binding.id,
            user_id=binding.user_id,
            direction=MESSAGE_DIRECTION_OUTBOUND,
            external_chat_id=binding.external_chat_id,
            provider_message_id=body.client_message_id,
            text=body.text,
            payload=request_payload,
        )
        db.add(existing)
        await db.commit()

    sidecar = get_configured_whatsapp_sidecar_client(account_id)
    if sidecar is None:
        raise WhatsAppApplicationSidecarUnavailableError
    try:
        provider_message_id = await sidecar.send_application_message(
            WhatsAppApplicationSendRequest(
                jid=binding.external_chat_id,
                text=body.text,
                message_id=body.client_message_id,
                reply_to_message_id=reply_message_id,
                reply_to_participant_jid=reply_participant_jid,
            )
        )
    except (httpx.HTTPError, ValueError) as exc:
        raise WhatsAppApplicationSidecarRejectedError from exc

    binding_id_for_log = binding.id
    existing.payload = {**request_payload, "deliveryState": "sent"}
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        log.warning(
            "WhatsApp provider succeeded but outbound metadata persistence failed "
            "account_id=%s binding_id=%s client_message_id=%s",
            account_id,
            binding_id_for_log,
            body.client_message_id,
            exc_info=True,
        )
    return provider_message_id


async def _resolve_reply(
    db: AsyncSession,
    *,
    account_id: UUID,
    link_id: UUID,
    binding: ChannelBinding,
    reply_to_sequence: int | None,
) -> tuple[str | None, str | None]:
    if reply_to_sequence is None:
        return None, None
    reply = (
        await db.execute(
            select(ChannelMessage).where(
                ChannelMessage.account_id == account_id,
                ChannelMessage.bot_agent_link_id == link_id,
                ChannelMessage.binding_id == binding.id,
                ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
                ChannelMessage.inbox_sequence == reply_to_sequence,
            )
        )
    ).scalar_one_or_none()
    if reply is None or not reply.provider_message_id:
        raise WhatsAppApplicationReplyNotFoundError
    payload = reply.payload if isinstance(reply.payload, dict) else {}
    actor_jid = payload.get("actorJid")
    participant = (
        actor_jid
        if binding.external_chat_id.endswith("@g.us") and isinstance(actor_jid, str)
        else None
    )
    return reply.provider_message_id, participant
