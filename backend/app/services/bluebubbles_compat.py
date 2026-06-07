from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel import (
    BINDING_STATUS_ACTIVE,
    MESSAGE_DIRECTION_OUTBOUND,
    ChannelAccount,
    ChannelAttachmentUpload,
    ChannelBinding,
    ChannelMessage,
    ChannelScheduledMessage,
)
from app.services.file_store import FileStore

BLUEBUBBLES_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024
BLUEBUBBLES_ATTACHMENT_UPLOAD_TTL_SECONDS = 60 * 60
BLUEBUBBLES_ATTACHMENT_UPLOAD_MAX_ROWS_PER_ACCOUNT = 256
BLUEBUBBLES_FORBIDDEN_CLIENT_MESSAGE_KEYS = frozenset({"replyToGuid", "replyGuid"})
BLUEBUBBLES_SAFE_MESSAGE_PAYLOAD_KEYS = frozenset(
    {
        "associatedMessageEmoji",
        "associatedMessageGuid",
        "associatedMessageType",
        "balloonBundleId",
        "caption",
        "dateCreated",
        "dateDelivered",
        "dateEdited",
        "dateRead",
        "dateRetracted",
        "edit",
        "groupActionType",
        "isAudioMessage",
        "isEdited",
        "isSticker",
        "isUnsent",
        "messageType",
        "parts",
        "reactions",
        "replyToMessageGuid",
        "selectedMessageGuid",
        "subject",
        "threadOriginatorGuid",
        "threadOriginatorPart",
        "unsend",
    }
)


def sanitize_bluebubbles_message_for_client(message: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in message.items()
        if key not in BLUEBUBBLES_FORBIDDEN_CLIENT_MESSAGE_KEYS
    }


def sanitize_bluebubbles_messages_for_client(
    messages: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    return [sanitize_bluebubbles_message_for_client(message) for message in messages]


def sanitize_bluebubbles_data_for_client(data: Any) -> Any:
    if isinstance(data, dict):
        return sanitize_bluebubbles_message_for_client(data)
    return data


def bluebubbles_message_client_payload(payload: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    data = payload.get("data")
    source = {**data, **payload} if isinstance(data, dict) else payload
    source.pop("data", None)
    sanitized = sanitize_bluebubbles_message_for_client(source)
    return {
        key: value
        for key, value in sanitized.items()
        if key in BLUEBUBBLES_SAFE_MESSAGE_PAYLOAD_KEYS
    }


def normalize_bluebubbles_attachments(payload: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    attachments = payload.get("attachments")
    if not isinstance(attachments, list):
        data = payload.get("data")
        if isinstance(data, dict):
            attachments = data.get("attachments")
    if not isinstance(attachments, list):
        return []
    return [item for item in attachments if isinstance(item, dict)]


def extract_multipart_text(parts: list[Any]) -> str:
    text_parts: list[str] = []
    for part in parts:
        if not isinstance(part, dict):
            continue
        for key in ("text", "message", "caption"):
            value = part.get(key)
            if isinstance(value, str) and value.strip():
                text_parts.append(value.strip())
                break
    return "\n".join(text_parts)


async def create_imessage_agent_message(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    binding: ChannelBinding,
    text: str | None,
    payload: dict[str, Any] | None = None,
) -> ChannelMessage:
    message = ChannelMessage(
        account_id=account.id,
        bot_agent_link_id=binding.bot_agent_link_id,
        binding_id=binding.id,
        user_id=account.user_id,
        direction=MESSAGE_DIRECTION_OUTBOUND,
        external_chat_id=binding.external_chat_id,
        provider_message_id=f"clawdi-imsg-{uuid4().hex}",
        text=text,
        payload=payload,
    )
    db.add(message)
    await db.flush()
    return message


async def count_imessage_messages(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    chat_guid: str | None = None,
    scope: str = "all",
    bot_agent_link_id: UUID | None = None,
) -> int:
    filters = [
        ChannelMessage.account_id == account.id,
        ChannelBinding.status == BINDING_STATUS_ACTIVE,
    ]
    if bot_agent_link_id is not None:
        filters.append(ChannelMessage.bot_agent_link_id == bot_agent_link_id)
    query = (
        select(func.count(ChannelMessage.id))
        .join(ChannelBinding, ChannelMessage.binding_id == ChannelBinding.id)
        .where(*filters)
    )
    if chat_guid:
        query = query.where(ChannelMessage.external_chat_id == chat_guid)
    if scope == "sent":
        query = query.where(ChannelMessage.direction == MESSAGE_DIRECTION_OUTBOUND)
    elif scope == "updated":
        query = query.where(ChannelMessage.updated_at > ChannelMessage.created_at)
    result = await db.execute(query)
    return int(result.scalar_one() or 0)


async def list_scheduled_messages(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID | None = None,
) -> list[ChannelScheduledMessage]:
    filters = [ChannelScheduledMessage.account_id == account.id]
    if bot_agent_link_id is not None:
        filters.append(ChannelScheduledMessage.bot_agent_link_id == bot_agent_link_id)
    result = await db.execute(
        select(ChannelScheduledMessage)
        .where(*filters)
        .order_by(ChannelScheduledMessage.created_at.desc())
    )
    return list(result.scalars().all())


async def create_scheduled_message(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    binding: ChannelBinding,
    payload: dict[str, Any],
) -> ChannelScheduledMessage:
    row = ChannelScheduledMessage(
        account_id=account.id,
        bot_agent_link_id=binding.bot_agent_link_id,
        binding_id=binding.id,
        user_id=account.user_id,
        external_chat_id=binding.external_chat_id,
        scheduled_for=_parse_scheduled_for(payload),
        payload=payload,
    )
    db.add(row)
    await db.flush()
    return row


async def get_scheduled_message(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    schedule_id: str,
    bot_agent_link_id: UUID | None = None,
) -> ChannelScheduledMessage:
    try:
        parsed_id = UUID(schedule_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="scheduled message not found",
        ) from exc
    filters = [
        ChannelScheduledMessage.account_id == account.id,
        ChannelScheduledMessage.id == parsed_id,
    ]
    if bot_agent_link_id is not None:
        filters.append(ChannelScheduledMessage.bot_agent_link_id == bot_agent_link_id)
    result = await db.execute(select(ChannelScheduledMessage).where(*filters))
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="scheduled message not found",
        )
    return row


async def update_scheduled_message(
    db: AsyncSession,
    *,
    row: ChannelScheduledMessage,
    payload: dict[str, Any],
) -> ChannelScheduledMessage:
    row.payload = {**row.payload, **payload}
    row.scheduled_for = _parse_scheduled_for(row.payload)
    await db.flush()
    return row


async def delete_scheduled_message(
    db: AsyncSession,
    *,
    row: ChannelScheduledMessage,
) -> None:
    await db.delete(row)
    await db.flush()


def scheduled_message_response(row: ChannelScheduledMessage) -> dict[str, Any]:
    scheduled_for = row.scheduled_for.isoformat() if row.scheduled_for else None
    return {
        "id": str(row.id),
        "guid": str(row.id),
        "chatGuid": row.external_chat_id,
        "status": row.status,
        "scheduledFor": scheduled_for,
        **row.payload,
    }


async def get_bound_message(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    message_guid: str,
    bot_agent_link_id: UUID | None = None,
) -> ChannelMessage:
    filters = [ChannelMessage.provider_message_id == message_guid]
    try:
        parsed_id = UUID(message_guid)
    except ValueError:
        parsed_id = None
    if parsed_id is not None:
        filters = [ChannelMessage.id == parsed_id]
    scope_filters = [
        ChannelMessage.account_id == account.id,
        ChannelBinding.status == BINDING_STATUS_ACTIVE,
    ]
    if bot_agent_link_id is not None:
        scope_filters.append(ChannelMessage.bot_agent_link_id == bot_agent_link_id)
    result = await db.execute(
        select(ChannelMessage)
        .join(ChannelBinding, ChannelMessage.binding_id == ChannelBinding.id)
        .where(*scope_filters, *filters)
    )
    message = result.scalar_one_or_none()
    if message is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="message not found")
    return message


async def edit_imessage_message(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    message_guid: str,
    edited_message: str,
    backwards_compatibility_message: str | None = None,
    part_index: int | None = None,
    bot_agent_link_id: UUID | None = None,
) -> ChannelMessage:
    message = await get_bound_message(
        db,
        account=account,
        message_guid=message_guid,
        bot_agent_link_id=bot_agent_link_id,
    )
    now_ms = _epoch_ms()
    payload = _payload_dict(message)
    payload["editedMessage"] = edited_message
    payload["dateEdited"] = now_ms
    payload["isEdited"] = True
    payload["edit"] = {
        "editedMessage": edited_message,
        "backwardsCompatibilityMessage": backwards_compatibility_message,
        "partIndex": part_index,
        "dateEdited": now_ms,
    }
    message.text = edited_message
    message.payload = payload
    await db.flush()
    return message


async def unsend_imessage_message(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    message_guid: str,
    part_index: int | None = None,
    bot_agent_link_id: UUID | None = None,
) -> ChannelMessage:
    message = await get_bound_message(
        db,
        account=account,
        message_guid=message_guid,
        bot_agent_link_id=bot_agent_link_id,
    )
    now_ms = _epoch_ms()
    payload = _payload_dict(message)
    payload["isUnsent"] = True
    payload["dateRetracted"] = now_ms
    payload["unsend"] = {"partIndex": part_index, "dateRetracted": now_ms}
    message.text = None
    message.payload = payload
    await db.flush()
    return message


async def react_to_imessage_message(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    chat_guid: str,
    selected_message_guid: str,
    reaction: str,
    part_index: int | None = None,
    bot_agent_link_id: UUID | None = None,
) -> ChannelMessage:
    message = await get_bound_message(
        db,
        account=account,
        message_guid=selected_message_guid,
        bot_agent_link_id=bot_agent_link_id,
    )
    if message.external_chat_id != chat_guid:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="message is not in chat")
    payload = _payload_dict(message)
    reactions = payload.get("reactions")
    if not isinstance(reactions, list):
        reactions = []
    reactions.append(
        {
            "reaction": reaction,
            "partIndex": part_index,
            "dateCreated": _epoch_ms(),
            "isFromMe": True,
        }
    )
    payload["reactions"] = reactions
    message.payload = payload
    await db.flush()
    return message


async def stage_attachment_upload(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    file_store: FileStore,
    data: bytes,
    file_name: str | None,
    content_type: str | None,
) -> ChannelAttachmentUpload:
    if len(data) > BLUEBUBBLES_ATTACHMENT_MAX_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="attachment too large",
        )
    now = datetime.now(UTC)
    await prune_expired_uploads(db, account=account, file_store=file_store, now=now)
    safe_name = _safe_file_name(file_name)
    token = uuid4().hex
    file_key = f"channels/{account.id}/bluebubbles/uploads/{token}/{safe_name}"
    upload_path = f"clawdi-upload://{account.id}/{token}/{safe_name}"
    await file_store.put(file_key, data)
    upload = ChannelAttachmentUpload(
        account_id=account.id,
        user_id=account.user_id,
        upload_path=upload_path,
        file_key=file_key,
        file_name=safe_name,
        content_type=content_type,
        size_bytes=len(data),
        expires_at=now + timedelta(seconds=BLUEBUBBLES_ATTACHMENT_UPLOAD_TTL_SECONDS),
    )
    db.add(upload)
    await db.flush()
    await prune_account_uploads(db, account=account, file_store=file_store)
    return upload


async def get_attachment_upload(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    upload_path: str,
) -> ChannelAttachmentUpload:
    now = datetime.now(UTC)
    result = await db.execute(
        select(ChannelAttachmentUpload).where(
            ChannelAttachmentUpload.account_id == account.id,
            ChannelAttachmentUpload.upload_path == upload_path,
            ChannelAttachmentUpload.expires_at >= now,
        )
    )
    upload = result.scalar_one_or_none()
    if upload is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="multipart attachment path was not uploaded by this account or has expired",
        )
    return upload


async def validate_multipart_uploads(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    parts: list[Any],
) -> list[ChannelAttachmentUpload]:
    uploads: list[ChannelAttachmentUpload] = []
    for part in parts:
        if not isinstance(part, dict):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="multipart parts must be objects",
            )
        if isinstance(part.get("path"), str) or isinstance(part.get("filePath"), str):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="multipart attachments must use /attachment/upload paths",
            )
        attachment_path = part.get("attachment")
        if attachment_path is None:
            continue
        if not isinstance(attachment_path, str) or not attachment_path.strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="multipart attachment path invalid",
            )
        uploads.append(
            await get_attachment_upload(
                db,
                account=account,
                upload_path=attachment_path.strip(),
            )
        )
    return uploads


def apply_multipart_payload(
    message: ChannelMessage,
    *,
    parts: list[Any],
    uploads: list[ChannelAttachmentUpload],
) -> None:
    payload = _payload_dict(message)
    payload["parts"] = parts
    payload["attachments"] = [_upload_attachment_payload(upload) for upload in uploads]
    payload["messageType"] = "multipart"
    message.payload = payload


def apply_attachment_payload(
    message: ChannelMessage,
    *,
    upload: ChannelAttachmentUpload,
    caption: str | None,
    is_audio_message: bool = False,
    is_sticker: bool = False,
) -> None:
    payload = _payload_dict(message)
    payload["attachments"] = [_upload_attachment_payload(upload)]
    payload["messageType"] = "attachment"
    payload["caption"] = caption
    payload["isAudioMessage"] = is_audio_message
    payload["isSticker"] = is_sticker
    message.payload = payload


async def download_attachment_bytes(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    attachment_guid: str,
    file_store: FileStore,
) -> tuple[bytes, dict[str, str]]:
    upload = await _find_upload_by_guid(db, account=account, attachment_guid=attachment_guid)
    if upload is not None:
        data = await file_store.get(upload.file_key)
        return data, _attachment_headers(upload)
    message, attachment = await _find_message_attachment(
        db,
        account=account,
        attachment_guid=attachment_guid,
    )
    inline = attachment.get("base64") or attachment.get("data")
    if isinstance(inline, str):
        import base64

        data = base64.b64decode(inline)
        headers = {
            "content-type": str(attachment.get("mimeType") or "application/octet-stream"),
        }
        transfer_name = attachment.get("transferName") or attachment.get("name")
        if isinstance(transfer_name, str) and transfer_name:
            headers["content-disposition"] = _content_disposition(transfer_name)
        return data, headers
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="attachment not found")


async def get_attachment_metadata(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    attachment_guid: str,
) -> dict[str, Any]:
    upload = await _find_upload_by_guid(db, account=account, attachment_guid=attachment_guid)
    if upload is not None:
        return _upload_attachment_payload(upload)
    _message, attachment = await _find_message_attachment(
        db,
        account=account,
        attachment_guid=attachment_guid,
    )
    return dict(attachment)


async def count_attachments(
    db: AsyncSession,
    *,
    account: ChannelAccount,
) -> int:
    result = await db.execute(
        select(ChannelMessage)
        .join(ChannelBinding, ChannelMessage.binding_id == ChannelBinding.id)
        .where(
            ChannelMessage.account_id == account.id,
            ChannelBinding.status == BINDING_STATUS_ACTIVE,
        )
    )
    total = 0
    for message in result.scalars().all():
        total += len(normalize_bluebubbles_attachments(message.payload))
    upload_count = await db.execute(
        select(func.count(ChannelAttachmentUpload.id)).where(
            ChannelAttachmentUpload.account_id == account.id,
            ChannelAttachmentUpload.expires_at >= datetime.now(UTC),
        )
    )
    return total + int(upload_count.scalar_one() or 0)


async def mark_chat_read(
    db: AsyncSession,
    *,
    binding: ChannelBinding,
    unread: bool = False,
) -> None:
    payload = _binding_config(binding)
    payload["unread"] = unread
    payload["readAt"] = None if unread else _epoch_ms()
    binding.external_chat_type = binding.external_chat_type
    await db.flush()


async def rename_chat(
    db: AsyncSession,
    *,
    binding: ChannelBinding,
    display_name: str,
) -> None:
    binding.external_chat_name = display_name
    await db.flush()


def synthetic_operation_response(binding: ChannelBinding, **extra: Any) -> dict[str, Any]:
    return {"chatGuid": binding.external_chat_id, **extra}


async def prune_expired_uploads(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    file_store: FileStore,
    now: datetime | None = None,
) -> None:
    cutoff = now or datetime.now(UTC)
    result = await db.execute(
        select(ChannelAttachmentUpload).where(
            ChannelAttachmentUpload.account_id == account.id,
            ChannelAttachmentUpload.expires_at < cutoff,
        )
    )
    expired = list(result.scalars().all())
    for upload in expired:
        await file_store.delete(upload.file_key)
        await db.delete(upload)
    await db.flush()


async def prune_account_uploads(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    file_store: FileStore,
) -> None:
    result = await db.execute(
        select(ChannelAttachmentUpload)
        .where(ChannelAttachmentUpload.account_id == account.id)
        .order_by(
            ChannelAttachmentUpload.expires_at.desc(),
            ChannelAttachmentUpload.created_at.desc(),
        )
        .offset(BLUEBUBBLES_ATTACHMENT_UPLOAD_MAX_ROWS_PER_ACCOUNT)
    )
    old_uploads = list(result.scalars().all())
    for upload in old_uploads:
        await file_store.delete(upload.file_key)
        await db.delete(upload)
    await db.flush()


async def _find_upload_by_guid(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    attachment_guid: str,
) -> ChannelAttachmentUpload | None:
    result = await db.execute(
        select(ChannelAttachmentUpload).where(
            ChannelAttachmentUpload.account_id == account.id,
            ChannelAttachmentUpload.upload_path == attachment_guid,
        )
    )
    upload = result.scalar_one_or_none()
    if upload is not None:
        return upload
    try:
        parsed_id = UUID(attachment_guid)
    except ValueError:
        return None
    result = await db.execute(
        select(ChannelAttachmentUpload).where(
            ChannelAttachmentUpload.account_id == account.id,
            ChannelAttachmentUpload.id == parsed_id,
        )
    )
    return result.scalar_one_or_none()


async def _find_message_attachment(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    attachment_guid: str,
) -> tuple[ChannelMessage, dict[str, Any]]:
    result = await db.execute(
        select(ChannelMessage)
        .join(ChannelBinding, ChannelMessage.binding_id == ChannelBinding.id)
        .where(
            ChannelMessage.account_id == account.id,
            ChannelBinding.status == BINDING_STATUS_ACTIVE,
        )
        .order_by(ChannelMessage.created_at.desc())
    )
    for message in result.scalars().all():
        for attachment in normalize_bluebubbles_attachments(message.payload):
            guid = attachment.get("guid") or attachment.get("path") or attachment.get("uploadPath")
            if guid == attachment_guid:
                return message, attachment
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="attachment not found")


def _payload_dict(message: ChannelMessage) -> dict[str, Any]:
    return dict(message.payload) if isinstance(message.payload, dict) else {}


def _upload_attachment_payload(upload: ChannelAttachmentUpload) -> dict[str, Any]:
    return {
        "guid": str(upload.id),
        "path": upload.upload_path,
        "uploadPath": upload.upload_path,
        "transferName": upload.file_name,
        "mimeType": upload.content_type or "application/octet-stream",
        "totalBytes": upload.size_bytes,
    }


def _attachment_headers(upload: ChannelAttachmentUpload) -> dict[str, str]:
    headers = {"content-type": upload.content_type or "application/octet-stream"}
    if upload.file_name:
        headers["content-disposition"] = _content_disposition(upload.file_name)
    return headers


def _binding_config(binding: ChannelBinding) -> dict[str, Any]:
    return {
        "guid": binding.external_chat_id,
        "displayName": binding.external_chat_name,
    }


def _safe_file_name(file_name: str | None) -> str:
    candidate = (file_name or "attachment").strip().replace("\\", "/").split("/")[-1]
    candidate = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in candidate)
    return candidate[:180] or "attachment"


def _content_disposition(file_name: str) -> str:
    safe = _safe_file_name(file_name)
    return f'attachment; filename="{safe}"'


def _epoch_ms() -> int:
    return int(datetime.now(UTC).timestamp() * 1000)


def _parse_scheduled_for(payload: dict[str, Any]) -> datetime | None:
    raw = (
        payload.get("scheduledFor")
        or payload.get("scheduled_for")
        or payload.get("dateScheduled")
        or payload.get("sendAt")
    )
    if isinstance(raw, int | float):
        seconds = raw / 1000 if raw > 10_000_000_000 else raw
        return datetime.fromtimestamp(seconds, tz=UTC)
    if isinstance(raw, str) and raw.strip():
        value = raw.strip().replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    return None
