from __future__ import annotations

import asyncio
import base64
import hashlib
import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from time import monotonic
from typing import cast
from urllib.parse import unquote, urlsplit
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel import (
    BINDING_STATUS_ACTIVE,
    BOT_AGENT_LINK_STATUS_ACTIVE,
    CHANNEL_PROVIDER_WHATSAPP,
    CHANNEL_STATUS_ACTIVE,
    MESSAGE_DIRECTION_INBOUND,
    MESSAGE_DIRECTION_OUTBOUND,
    ChannelAccount,
    ChannelBinding,
    ChannelBotAgentLink,
    ChannelDelivery,
    ChannelMessage,
)
from app.models.session import AgentEnvironment
from app.schemas.whatsapp_application import (
    WhatsAppApplicationOperation,
    WhatsAppApplicationOperationName,
    WhatsAppDeleteMessageOperation,
    WhatsAppEditMessageOperation,
    WhatsAppInboxEvent,
    WhatsAppMarkReadOperation,
    WhatsAppOperationTarget,
    WhatsAppReactionOperation,
    WhatsAppSendMediaOperation,
    WhatsAppSendTextOperation,
    WhatsAppTypingOperation,
)
from app.services.channels import bot_agent_link_has_provider_cardinality_capability
from app.services.whatsapp_callback import stable_whatsapp_message_id
from app.services.whatsapp_sidecar_client import (
    WHATSAPP_OPERATION_MAX_MEDIA_BYTES,
    WhatsAppOperationStatus,
    WhatsAppSidecarClient,
    WhatsAppSidecarOperationResult,
    WhatsAppSidecarProtocolError,
    WhatsAppSidecarRejectedError,
    WhatsAppSidecarUnavailableError,
)
from app.services.whatsapp_sidecar_registry import get_configured_whatsapp_sidecar_client

WHATSAPP_APPLICATION_OPERATIONS: tuple[WhatsAppApplicationOperationName, ...] = (
    "send_text",
    "send_media",
    "reaction",
    "typing",
    "edit_message",
    "delete_message",
    "mark_read",
)


@dataclass(frozen=True)
class WhatsAppApplicationContext:
    account: ChannelAccount
    link: ChannelBotAgentLink


async def resolve_whatsapp_application_context(
    db: AsyncSession,
    *,
    account_id: UUID,
    token: str,
) -> WhatsAppApplicationContext:
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    row = (
        await db.execute(
            select(ChannelAccount, ChannelBotAgentLink)
            .join(ChannelBotAgentLink, ChannelBotAgentLink.account_id == ChannelAccount.id)
            .join(AgentEnvironment, AgentEnvironment.id == ChannelBotAgentLink.agent_id)
            .where(
                ChannelAccount.id == account_id,
                ChannelAccount.provider == CHANNEL_PROVIDER_WHATSAPP,
                ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
                ChannelAccount.archived_at.is_(None),
                ChannelBotAgentLink.agent_token_hash == token_hash,
                ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
                ChannelBotAgentLink.archived_at.is_(None),
                AgentEnvironment.user_id == ChannelBotAgentLink.user_id,
            )
            .execution_options(populate_existing=True)
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid link token")
    account, link = row
    if not await bot_agent_link_has_provider_cardinality_capability(
        db,
        account=account,
        link=link,
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "This Agent has multiple active WhatsApp bots. "
                "Unlink the extras until only one remains."
            ),
        )
    return WhatsAppApplicationContext(account=account, link=link)


async def get_authorized_whatsapp_binding(
    db: AsyncSession,
    *,
    context: WhatsAppApplicationContext,
    target: WhatsAppOperationTarget,
) -> ChannelBinding:
    binding = await _active_context_binding(db, context=context, binding_id=target.binding_id)
    expected_chat_type = _binding_chat_type(binding)
    if target.chat_id != binding.id or target.chat_type != expected_chat_type:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="operation target does not match the active binding",
        )
    return binding


async def _active_context_binding(
    db: AsyncSession,
    *,
    context: WhatsAppApplicationContext,
    binding_id: UUID,
) -> ChannelBinding:
    binding = (
        await db.execute(
            select(ChannelBinding)
            .join(ChannelBotAgentLink, ChannelBotAgentLink.id == ChannelBinding.bot_agent_link_id)
            .join(AgentEnvironment, AgentEnvironment.id == ChannelBotAgentLink.agent_id)
            .where(
                ChannelBinding.id == binding_id,
                ChannelBinding.account_id == context.account.id,
                ChannelBinding.bot_agent_link_id == context.link.id,
                ChannelBinding.user_id == context.link.user_id,
                ChannelBinding.status == BINDING_STATUS_ACTIVE,
                ChannelBotAgentLink.account_id == context.account.id,
                ChannelBotAgentLink.user_id == context.link.user_id,
                ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
                ChannelBotAgentLink.archived_at.is_(None),
                AgentEnvironment.user_id == context.link.user_id,
            )
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if binding is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="binding not found")
    return binding


async def list_whatsapp_inbox(
    db: AsyncSession,
    *,
    context: WhatsAppApplicationContext,
    cursor: int,
    limit: int,
) -> list[ChannelMessage]:
    result = await db.execute(
        select(ChannelMessage)
        .join(ChannelBinding, ChannelBinding.id == ChannelMessage.binding_id)
        .join(ChannelBotAgentLink, ChannelBotAgentLink.id == ChannelBinding.bot_agent_link_id)
        .where(
            ChannelMessage.account_id == context.account.id,
            ChannelMessage.bot_agent_link_id == context.link.id,
            ChannelMessage.user_id == context.link.user_id,
            ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
            ChannelMessage.delivered_at.is_(None),
            ChannelMessage.inbox_sequence > cursor,
            ChannelBinding.account_id == context.account.id,
            ChannelBinding.bot_agent_link_id == context.link.id,
            ChannelBinding.user_id == context.link.user_id,
            ChannelBinding.status == BINDING_STATUS_ACTIVE,
            ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
            ChannelBotAgentLink.archived_at.is_(None),
        )
        .order_by(ChannelMessage.inbox_sequence, ChannelMessage.created_at, ChannelMessage.id)
        .limit(limit)
    )
    return list(result.scalars().all())


async def whatsapp_inbox_high_watermark(
    db: AsyncSession,
    *,
    context: WhatsAppApplicationContext,
) -> int:
    value = (
        await db.execute(
            select(func.max(ChannelMessage.inbox_sequence))
            .join(ChannelBinding, ChannelBinding.id == ChannelMessage.binding_id)
            .join(ChannelBotAgentLink, ChannelBotAgentLink.id == ChannelBinding.bot_agent_link_id)
            .where(
                ChannelMessage.account_id == context.account.id,
                ChannelMessage.bot_agent_link_id == context.link.id,
                ChannelMessage.user_id == context.link.user_id,
                ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
                ChannelBinding.account_id == context.account.id,
                ChannelBinding.bot_agent_link_id == context.link.id,
                ChannelBinding.user_id == context.link.user_id,
                ChannelBinding.status == BINDING_STATUS_ACTIVE,
                ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
                ChannelBotAgentLink.archived_at.is_(None),
            )
        )
    ).scalar_one()
    return value if isinstance(value, int) else 0


async def wait_for_whatsapp_inbox(
    db: AsyncSession,
    *,
    context: WhatsAppApplicationContext,
    cursor: int,
    limit: int,
    wait_seconds: float,
    poll_interval_seconds: float = 0.2,
) -> list[ChannelMessage]:
    deadline = monotonic() + max(0.0, min(wait_seconds, 30.0))
    while True:
        messages = await list_whatsapp_inbox(
            db,
            context=context,
            cursor=cursor,
            limit=limit,
        )
        if messages or wait_seconds <= 0 or monotonic() >= deadline:
            return messages
        await asyncio.sleep(min(poll_interval_seconds, max(0.0, deadline - monotonic())))


async def ack_whatsapp_inbox_event(
    db: AsyncSession,
    *,
    context: WhatsAppApplicationContext,
    event_id: UUID,
) -> bool:
    message = (
        await db.execute(
            select(ChannelMessage)
            .join(ChannelBinding, ChannelBinding.id == ChannelMessage.binding_id)
            .where(
                ChannelMessage.id == event_id,
                ChannelMessage.account_id == context.account.id,
                ChannelMessage.bot_agent_link_id == context.link.id,
                ChannelMessage.user_id == context.link.user_id,
                ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
                ChannelBinding.account_id == context.account.id,
                ChannelBinding.bot_agent_link_id == context.link.id,
                ChannelBinding.user_id == context.link.user_id,
                ChannelBinding.status == BINDING_STATUS_ACTIVE,
            )
            .with_for_update(of=ChannelMessage)
        )
    ).scalar_one_or_none()
    if message is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="inbox event not found")
    duplicate = message.delivered_at is not None
    if not duplicate:
        message.delivered_at = datetime.now(UTC)
        await db.flush()
    return duplicate


async def lock_whatsapp_application_operation_namespace(
    db: AsyncSession,
    *,
    context: WhatsAppApplicationContext,
) -> None:
    """Serialize first-seen operation IDs for one active Link transaction."""
    locked_link_id = (
        await db.execute(
            select(ChannelBotAgentLink.id)
            .where(
                ChannelBotAgentLink.id == context.link.id,
                ChannelBotAgentLink.account_id == context.account.id,
                ChannelBotAgentLink.user_id == context.link.user_id,
                ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
                ChannelBotAgentLink.archived_at.is_(None),
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if locked_link_id is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid link token")


def project_whatsapp_inbox_event(
    message: ChannelMessage,
    *,
    media_url_for: Callable[[str], str],
) -> WhatsAppInboxEvent:
    payload = message.payload if isinstance(message.payload, dict) else {}
    chat = payload.get("chat")
    actor = payload.get("actor")
    content = payload.get("content")
    if (
        message.binding_id is None
        or message.provider_message_id is None
        or not isinstance(chat, dict)
        or not isinstance(actor, dict)
        or not isinstance(content, dict)
    ):
        raise ValueError("WhatsApp inbox message is missing normalized authority")
    chat_type = "group" if str(chat.get("primary", "")).endswith("@g.us") else "direct"
    timestamp = payload.get("timestamp")
    if not isinstance(timestamp, int) or isinstance(timestamp, bool):
        timestamp = max(0, int(message.created_at.timestamp()))
    content_type = content.get("type")
    text = ""
    reaction: dict[str, object] | None = None
    media: list[dict[str, object]] = []
    unsupported: dict[str, object] | None = None
    if content_type == "text" and isinstance(content.get("text"), str):
        text = content["text"]
    elif content_type == "media":
        if isinstance(content.get("caption"), str):
            text = content["caption"]
        media_id = content.get("mediaId")
        media_type = content.get("mediaType")
        if not isinstance(media_id, str) or not isinstance(media_type, str):
            raise ValueError("WhatsApp media event is invalid")
        if content.get("ptt") is True and media_type != "audio":
            raise ValueError("WhatsApp voice media event is invalid")
        media.append(
            {
                "url": media_url_for(media_id),
                "mimeType": _inbound_media_mime(content, media_type),
                **(
                    {"fileName": content["fileName"]}
                    if isinstance(content.get("fileName"), str)
                    else {}
                ),
                **({"ptt": True} if content.get("ptt") is True else {}),
            }
        )
    elif content_type == "reaction":
        target = content.get("target")
        if not isinstance(target, dict) or not isinstance(target.get("messageId"), str):
            raise ValueError("WhatsApp reaction event is invalid")
        reaction = {
            "emoji": content.get("reaction") if isinstance(content.get("reaction"), str) else "",
            "messageId": target["messageId"],
        }
    elif content_type == "unknown":
        provider_content_type = content.get("providerContentType")
        if not isinstance(provider_content_type, str):
            raise ValueError("WhatsApp unsupported content marker is invalid")
        unsupported = {"providerContentType": provider_content_type}
    reply_to = payload.get("replyTo")
    reply_to_message_id = (
        reply_to.get("messageId")
        if isinstance(reply_to, dict) and isinstance(reply_to.get("messageId"), str)
        else None
    )
    actor_aliases = sorted(
        value for value in (actor.get("primary"), actor.get("alt")) if isinstance(value, str)
    )
    sender_id = stable_whatsapp_message_id(
        "application-sender",
        message.account_id,
        message.binding_id,
        *actor_aliases,
    )
    push_name = payload.get("pushName")
    optional_name = {"name": push_name} if isinstance(push_name, str) else {}
    return WhatsAppInboxEvent.model_validate(
        {
            "id": message.id,
            "binding": {"id": message.binding_id},
            "chat": {
                "id": message.binding_id,
                "type": chat_type,
                **optional_name,
            },
            "sender": {
                "id": sender_id,
                **optional_name,
            },
            "message": {
                "id": message.provider_message_id,
                "text": text,
                "timestamp": timestamp,
                **({"replyTo": reply_to_message_id} if reply_to_message_id is not None else {}),
                **({"reaction": reaction} if reaction is not None else {}),
                "media": media,
                **({"unsupported": unsupported} if unsupported is not None else {}),
            },
        }
    )


async def require_owned_whatsapp_message(
    db: AsyncSession,
    *,
    context: WhatsAppApplicationContext,
    binding: ChannelBinding,
    provider_message_id: str,
    direction: str | None = None,
) -> ChannelMessage:
    filters = [
        ChannelMessage.account_id == context.account.id,
        ChannelMessage.bot_agent_link_id == context.link.id,
        ChannelMessage.binding_id == binding.id,
        ChannelMessage.user_id == context.link.user_id,
        ChannelMessage.provider_message_id == provider_message_id,
    ]
    if direction is not None:
        filters.append(ChannelMessage.direction == direction)
    messages = list(
        (
            await db.execute(
                select(ChannelMessage)
                .where(*filters)
                .order_by(ChannelMessage.created_at, ChannelMessage.id)
                .limit(2)
            )
        ).scalars()
    )
    if len(messages) != 1:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="message not found")
    message = messages[0]
    if direction == MESSAGE_DIRECTION_OUTBOUND:
        payload = message.payload if isinstance(message.payload, dict) else {}
        operation = payload.get("whatsappOperation")
        provider_response = payload.get("providerResponse")
        application_send = (
            isinstance(operation, dict)
            and operation.get("type") in {"send_text", "send_media"}
            and isinstance(provider_response, dict)
            and provider_response.get("status") == "completed"
        )
        delivery_operation = (
            provider_response.get("operation") if isinstance(provider_response, dict) else None
        )
        delivery_send = (
            payload.get("delivery") == "succeeded"
            and isinstance(provider_response, dict)
            and provider_response.get("status") == "completed"
            and isinstance(delivery_operation, dict)
            and delivery_operation.get("type") == "delivery_send_text"
        )
        if not application_send and not delivery_send:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="message not found")
    return message


async def require_owned_whatsapp_media(
    db: AsyncSession,
    *,
    context: WhatsAppApplicationContext,
    media_id: str,
    binding: ChannelBinding | None = None,
) -> tuple[ChannelMessage, ChannelBinding]:
    filters = [
        ChannelMessage.account_id == context.account.id,
        ChannelMessage.bot_agent_link_id == context.link.id,
        ChannelMessage.user_id == context.link.user_id,
        ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
        ChannelMessage.payload["content"]["mediaId"].as_string() == media_id,
        ChannelBinding.account_id == context.account.id,
        ChannelBinding.bot_agent_link_id == context.link.id,
        ChannelBinding.user_id == context.link.user_id,
        ChannelBinding.status == BINDING_STATUS_ACTIVE,
    ]
    if binding is not None:
        filters.append(ChannelMessage.binding_id == binding.id)
    rows = (
        await db.execute(
            select(ChannelMessage, ChannelBinding)
            .join(ChannelBinding, ChannelBinding.id == ChannelMessage.binding_id)
            .where(*filters)
            .limit(2)
        )
    ).all()
    if len(rows) != 1:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="media not found")
    message, media_binding = rows[0]
    return message, media_binding


async def build_sidecar_application_operation(
    db: AsyncSession,
    *,
    context: WhatsAppApplicationContext,
    binding: ChannelBinding,
    operation: WhatsAppApplicationOperation,
    client: WhatsAppSidecarClient,
) -> tuple[dict[str, object], str]:
    sidecar_operation_id = stable_whatsapp_message_id(
        "application-operation",
        context.account.id,
        context.link.id,
        operation.operation_id,
    )
    application_message_id = stable_whatsapp_message_id(
        "application-message",
        context.account.id,
        context.link.id,
        operation.operation_id,
    )
    base: dict[str, object] = {
        "schemaVersion": "clawdi.whatsapp.operation.v1",
        "operationId": sidecar_operation_id,
        "chatJid": binding.external_chat_id,
    }
    if isinstance(operation, WhatsAppSendTextOperation):
        payload = {
            **base,
            "type": "send",
            "messageId": application_message_id,
            "content": {"type": "text", "text": operation.text},
        }
        if operation.reply_to is not None:
            reply = await require_owned_whatsapp_message(
                db,
                context=context,
                binding=binding,
                provider_message_id=operation.reply_to,
            )
            payload["replyTo"] = _message_reference(reply, binding)
        return payload, application_message_id
    if isinstance(operation, WhatsAppSendMediaOperation):
        media = await _outbound_media_content(
            db,
            context=context,
            binding=binding,
            operation=operation,
            client=client,
        )
        payload = {
            **base,
            "type": "send",
            "messageId": application_message_id,
            "content": media,
        }
        if operation.reply_to is not None:
            reply = await require_owned_whatsapp_message(
                db,
                context=context,
                binding=binding,
                provider_message_id=operation.reply_to,
            )
            payload["replyTo"] = _message_reference(reply, binding)
        return payload, application_message_id
    if isinstance(operation, WhatsAppTypingOperation):
        presence = operation.state
        if presence is None:
            presence = "composing" if operation.active else "paused"
        return {**base, "type": "presence", "presence": presence}, application_message_id
    if isinstance(operation, WhatsAppMarkReadOperation):
        target = await require_owned_whatsapp_message(
            db,
            context=context,
            binding=binding,
            provider_message_id=operation.message_id,
            direction=MESSAGE_DIRECTION_INBOUND,
        )
        return (
            {
                **base,
                "type": "read",
                "messages": [_message_reference(target, binding)],
            },
            application_message_id,
        )
    target_direction = (
        MESSAGE_DIRECTION_OUTBOUND
        if isinstance(operation, (WhatsAppEditMessageOperation, WhatsAppDeleteMessageOperation))
        else None
    )
    target = await require_owned_whatsapp_message(
        db,
        context=context,
        binding=binding,
        provider_message_id=operation.message_id,
        direction=target_direction,
    )
    reference = _message_reference(target, binding)
    if isinstance(operation, WhatsAppReactionOperation):
        return (
            {
                **base,
                "type": "reaction",
                "messageId": application_message_id,
                "target": reference,
                "reaction": operation.emoji,
            },
            application_message_id,
        )
    if isinstance(operation, WhatsAppEditMessageOperation):
        return (
            {
                **base,
                "type": "edit",
                "messageId": application_message_id,
                "target": reference,
                "text": operation.text,
            },
            application_message_id,
        )
    return (
        {
            **base,
            "type": "delete",
            "messageId": application_message_id,
            "target": reference,
        },
        application_message_id,
    )


async def find_recorded_whatsapp_operation(
    db: AsyncSession,
    *,
    context: WhatsAppApplicationContext,
    operation_id: str,
) -> ChannelMessage | None:
    return (
        await db.execute(
            select(ChannelMessage)
            .where(
                ChannelMessage.account_id == context.account.id,
                ChannelMessage.bot_agent_link_id == context.link.id,
                ChannelMessage.user_id == context.link.user_id,
                ChannelMessage.direction == MESSAGE_DIRECTION_OUTBOUND,
                ChannelMessage.payload["whatsappOperation"]["operationId"].as_string()
                == operation_id,
            )
            .order_by(ChannelMessage.created_at, ChannelMessage.id)
            .limit(1)
        )
    ).scalar_one_or_none()


def canonical_whatsapp_application_request_hash(
    operation: WhatsAppApplicationOperation,
) -> str:
    normalized = operation.model_dump(mode="json", by_alias=True, exclude_none=True)
    encoded = json.dumps(normalized, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode()).hexdigest()


def ensure_recorded_whatsapp_operation_matches(
    message: ChannelMessage,
    *,
    request_hash: str,
) -> None:
    payload = message.payload if isinstance(message.payload, dict) else {}
    operation = payload.get("whatsappOperation")
    if not isinstance(operation, dict) or operation.get("requestHash") != request_hash:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="operationId was already used with a different request",
        )


def operation_response_from_message(
    message: ChannelMessage,
) -> tuple[str, str | None, WhatsAppOperationStatus, str | None]:
    payload = message.payload if isinstance(message.payload, dict) else {}
    operation = payload.get("whatsappOperation")
    response = payload.get("providerResponse")
    if not isinstance(operation, dict) or not isinstance(response, dict):
        raise ValueError("recorded WhatsApp operation metadata is invalid")
    operation_id = operation.get("operationId")
    response_message_id = operation.get("responseMessageId")
    status_value = response.get("status")
    error_code = response.get("error")
    if (
        not isinstance(operation_id, str)
        or (response_message_id is not None and not isinstance(response_message_id, str))
        or (error_code is not None and not isinstance(error_code, str))
        or status_value not in {"completed", "failed", "ambiguous"}
    ):
        raise ValueError("recorded WhatsApp operation metadata is invalid")
    return (
        operation_id,
        response_message_id,
        cast(WhatsAppOperationStatus, status_value),
        error_code,
    )


async def record_whatsapp_application_operation(
    db: AsyncSession,
    *,
    context: WhatsAppApplicationContext,
    binding: ChannelBinding,
    operation: WhatsAppApplicationOperation,
    result: WhatsAppSidecarOperationResult,
    application_message_id: str,
    request_hash: str,
) -> tuple[ChannelMessage, bool]:
    existing = await find_recorded_whatsapp_operation(
        db,
        context=context,
        operation_id=operation.operation_id,
    )
    if existing is not None:
        ensure_recorded_whatsapp_operation_matches(existing, request_hash=request_hash)
        return existing, False
    is_send = isinstance(operation, (WhatsAppSendTextOperation, WhatsAppSendMediaOperation))
    if is_send and result.status == "completed" and result.message_id is None:
        raise WhatsAppSidecarProtocolError("completed send response omitted messageId")
    response_message_id = result.message_id if is_send and result.status == "completed" else None
    metadata = _application_operation_metadata(operation)
    metadata["operationId"] = operation.operation_id
    metadata["sidecarOperationId"] = result.operation_id
    metadata["responseMessageId"] = response_message_id
    metadata["requestHash"] = request_hash
    text = operation.text if isinstance(operation, WhatsAppSendTextOperation) else None
    if isinstance(operation, (WhatsAppSendMediaOperation, WhatsAppEditMessageOperation)):
        text = operation.text
    message = ChannelMessage(
        account_id=context.account.id,
        bot_agent_link_id=context.link.id,
        binding_id=binding.id,
        user_id=context.link.user_id,
        direction=MESSAGE_DIRECTION_OUTBOUND,
        external_chat_id=binding.external_chat_id,
        provider_message_id=(
            result.message_id
            if is_send and result.status == "completed"
            else application_message_id
            if not is_send
            else None
        ),
        text=text,
        payload={
            "whatsappOperation": metadata,
            "providerResponse": result.metadata(),
        },
    )
    db.add(message)
    await db.flush()
    return message, True


async def execute_whatsapp_delivery_operation(
    *,
    account: ChannelAccount,
    binding: ChannelBinding,
    message: ChannelMessage,
    delivery: ChannelDelivery,
) -> tuple[str, dict[str, object]]:
    if (
        binding.status != BINDING_STATUS_ACTIVE
        or binding.account_id != account.id
        or message.account_id != account.id
        or message.binding_id != binding.id
        or message.bot_agent_link_id != binding.bot_agent_link_id
        or message.user_id != binding.user_id
        or delivery.account_id != account.id
        or delivery.message_id != message.id
        or delivery.bot_agent_link_id != binding.bot_agent_link_id
        or delivery.user_id != binding.user_id
    ):
        raise WhatsAppSidecarRejectedError("delivery_authority_mismatch")
    client = get_configured_whatsapp_sidecar_client(account.id)
    if client is None:
        raise WhatsAppSidecarUnavailableError("sidecar unavailable")
    operation_id = stable_whatsapp_message_id(
        "delivery-operation",
        account.id,
        message.id,
        delivery.id,
    )
    stable_message_id = stable_whatsapp_message_id(
        "delivery-message",
        account.id,
        message.id,
        delivery.id,
    )
    payload: dict[str, object] = {
        "schemaVersion": "clawdi.whatsapp.operation.v1",
        "operationId": operation_id,
        "chatJid": binding.external_chat_id,
        "type": "send",
        "messageId": stable_message_id,
        "content": {"type": "text", "text": message.text or ""},
    }
    result = await client.execute_operation(payload, expected_operation_id=operation_id)
    if result.status != "completed":
        raise WhatsAppSidecarRejectedError(
            "provider_outcome_ambiguous"
            if result.status == "ambiguous"
            else result.error_code or "operation_failed"
        )
    if result.message_id is None:
        raise WhatsAppSidecarProtocolError("completed send response omitted messageId")
    metadata: dict[str, object] = dict(result.metadata())
    metadata["operation"] = {
        "type": "delivery_send_text",
        "operationId": operation_id,
        "messageId": stable_message_id,
    }
    return result.message_id, metadata


def _message_reference(message: ChannelMessage, binding: ChannelBinding) -> dict[str, object]:
    if message.provider_message_id is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="message not found")
    from_me = message.direction == MESSAGE_DIRECTION_OUTBOUND
    reference: dict[str, object] = {
        "messageId": message.provider_message_id,
        "fromMe": from_me,
    }
    if _binding_chat_type(binding) == "group" and not from_me:
        payload = message.payload if isinstance(message.payload, dict) else {}
        actor = payload.get("actor")
        if not isinstance(actor, dict) or not isinstance(actor.get("primary"), str):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="group actor is ambiguous",
            )
        reference["participantJid"] = actor["primary"]
        if isinstance(actor.get("alt"), str):
            reference["participantJidAlt"] = actor["alt"]
    return reference


async def _outbound_media_content(
    db: AsyncSession,
    *,
    context: WhatsAppApplicationContext,
    binding: ChannelBinding,
    operation: WhatsAppSendMediaOperation,
    client: WhatsAppSidecarClient,
) -> dict[str, object]:
    source = operation.media
    ptt = False
    if source.content_base64 is not None:
        data_base64 = source.content_base64
        media_type, mime_type = _local_media_contract(source.kind)
        file_name = source.file_name
    else:
        assert source.relay_url is not None
        media_id = _media_id_from_relay_url(source.relay_url, context.account.id)
        message, _media_binding = await require_owned_whatsapp_media(
            db,
            context=context,
            binding=binding,
            media_id=media_id,
        )
        media = await client.fetch_media(media_id)
        if not media.content or len(media.content) > WHATSAPP_OPERATION_MAX_MEDIA_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail="WhatsApp outbound media exceeds 8 MiB",
            )
        content = message.payload.get("content") if isinstance(message.payload, dict) else None
        if not isinstance(content, dict):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="media metadata missing",
            )
        media_type = content.get("mediaType")
        if media_type not in {"image", "video", "audio", "document"}:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="media type cannot be sent",
            )
        mime_type = content.get("mimeType")
        if not isinstance(mime_type, str):
            mime_type = media.content_type
        file_name = content.get("fileName") if isinstance(content.get("fileName"), str) else None
        ptt = content.get("ptt") is True
        if ptt and media_type != "audio":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="invalid voice media metadata",
            )
        data_base64 = base64.b64encode(media.content).decode("ascii")
    result: dict[str, object] = {
        "type": "media",
        "mediaType": media_type,
        "dataBase64": data_base64,
        "mimeType": mime_type,
    }
    if file_name is not None:
        result["fileName"] = file_name
    if source.relay_url is not None and ptt:
        result["ptt"] = True
    if operation.text is not None:
        result["caption"] = operation.text
    return result


def _media_id_from_relay_url(value: str, account_id: UUID) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="invalid media URL",
        )
    if parsed.query or parsed.fragment:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="invalid media URL",
        )
    prefix = f"/v1/channels/whatsapp/application/{account_id}/media/"
    if not parsed.path.startswith(prefix):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="media URL is outside this account relay",
        )
    media_id = unquote(parsed.path[len(prefix) :])
    if "/" in media_id or not media_id.startswith("media_") or len(media_id) != 49:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="invalid media URL",
        )
    return media_id


def _binding_chat_type(binding: ChannelBinding) -> str:
    return "group" if binding.external_chat_type == "group" else "direct"


def _local_media_contract(kind: str | None) -> tuple[str, str]:
    mapping = {
        "image": ("image", "image/jpeg"),
        "video": ("video", "video/mp4"),
        "audio": ("audio", "audio/mpeg"),
        "document": ("document", "application/octet-stream"),
    }
    if kind not in mapping:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="media kind is required",
        )
    return mapping[kind]


def _inbound_media_mime(content: dict[object, object], media_type: str) -> str:
    mime_type = content.get("mimeType")
    if isinstance(mime_type, str) and mime_type:
        return mime_type
    return {
        "image": "image/jpeg",
        "video": "video/mp4",
        "audio": "audio/ogg",
        "document": "application/octet-stream",
        "sticker": "image/webp",
    }.get(media_type, "application/octet-stream")


def _application_operation_metadata(operation: WhatsAppApplicationOperation) -> dict[str, object]:
    metadata: dict[str, object] = {
        "type": operation.type,
        "target": {
            "bindingId": str(operation.target.binding_id),
            "chatId": str(operation.target.chat_id),
            "chatType": operation.target.chat_type,
        },
    }
    if isinstance(operation, WhatsAppSendMediaOperation):
        metadata["media"] = {
            "source": "relay" if operation.media.relay_url is not None else "inline",
            **({"kind": operation.media.kind} if operation.media.kind is not None else {}),
            **(
                {"fileName": operation.media.file_name}
                if operation.media.file_name is not None
                else {}
            ),
        }
    return metadata
