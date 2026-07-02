from __future__ import annotations

from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    Response,
    UploadFile,
)
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session
from app.routes.channel_routers.imessage_auth import (
    BlueBubblesAccount,
    BlueBubblesAgent,
    bluebubbles_account,
    bluebubbles_agent,
)
from app.routes.channel_routers.shared import (
    _bluebubbles_ok,
    _optional_bool_param,
    _optional_str,
    _read_upload_bytes,
    _require_bound_chat,
)
from app.services.bluebubbles_compat import (
    BLUEBUBBLES_ATTACHMENT_MAX_BYTES,
    apply_attachment_payload,
    count_attachments,
    create_imessage_agent_message,
    download_attachment_bytes,
    get_attachment_metadata,
    stage_attachment_upload,
)
from app.services.file_store import get_file_store

router = APIRouter(prefix="/channels/imessage/bluebubbles/v1", tags=["channels"])
file_store = get_file_store()


@router.post("/attachment/upload", include_in_schema=False)
async def bluebubbles_upload_attachment(
    attachment: UploadFile = File(...),
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    data = await _read_upload_bytes(attachment, max_bytes=BLUEBUBBLES_ATTACHMENT_MAX_BYTES)
    upload = await stage_attachment_upload(
        db,
        account=agent.account,
        file_store=file_store,
        data=data,
        file_name=attachment.filename,
        content_type=attachment.content_type,
        user_id=agent.link.user_id,
    )
    await db.commit()
    return _bluebubbles_ok({"path": upload.upload_path, "guid": str(upload.id)})


@router.post("/message/attachment", include_in_schema=False)
async def bluebubbles_send_attachment(
    attachment: UploadFile = File(...),
    chat_guid: str = Form(..., alias="chatGuid"),
    name: str | None = Form(default=None),
    message: str | None = Form(default=None),
    text: str | None = Form(default=None),
    caption: str | None = Form(default=None),
    is_audio_message: str | bool | None = Form(default=None, alias="isAudioMessage"),
    is_sticker: str | bool | None = Form(default=None, alias="isSticker"),
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    account = agent.account
    binding = await _require_bound_chat(
        db,
        account=account,
        external_chat_id=chat_guid,
        bot_agent_link_id=agent.link.id,
    )
    data = await _read_upload_bytes(attachment, max_bytes=BLUEBUBBLES_ATTACHMENT_MAX_BYTES)
    upload = await stage_attachment_upload(
        db,
        account=account,
        file_store=file_store,
        data=data,
        file_name=name or attachment.filename,
        content_type=attachment.content_type,
        user_id=agent.link.user_id,
    )
    caption_text = _optional_str(message) or _optional_str(text) or _optional_str(caption)
    outbound = await create_imessage_agent_message(
        db,
        account=account,
        binding=binding,
        text=caption_text,
        payload={},
    )
    apply_attachment_payload(
        outbound,
        upload=upload,
        caption=caption_text,
        is_audio_message=_optional_bool_param(is_audio_message),
        is_sticker=_optional_bool_param(is_sticker),
    )
    await db.commit()
    return _bluebubbles_ok(
        {
            "guid": outbound.provider_message_id or str(outbound.id),
            "messageId": outbound.provider_message_id or str(outbound.id),
            "chatGuid": chat_guid,
        }
    )


@router.get("/attachment/count", include_in_schema=False)
async def bluebubbles_attachment_count(
    account: BlueBubblesAccount = Depends(bluebubbles_account),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    total = await count_attachments(db, account=account)
    return _bluebubbles_ok({"total": total})


@router.get("/attachment/{attachment_guid}/download", include_in_schema=False)
async def bluebubbles_download_attachment(
    attachment_guid: str,
    account: BlueBubblesAccount = Depends(bluebubbles_account),
    db: AsyncSession = Depends(get_session),
) -> Response:
    data, headers = await download_attachment_bytes(
        db,
        account=account,
        attachment_guid=attachment_guid,
        file_store=file_store,
    )
    return Response(
        content=data,
        media_type=headers.get("content-type", "application/octet-stream"),
        headers=headers,
    )


@router.get("/attachment/{attachment_guid}/live", include_in_schema=False)
async def bluebubbles_live_attachment(
    attachment_guid: str,
    account: BlueBubblesAccount = Depends(bluebubbles_account),
    db: AsyncSession = Depends(get_session),
) -> Response:
    return await bluebubbles_download_attachment(
        attachment_guid=attachment_guid,
        account=account,
        db=db,
    )


@router.get("/attachment/{attachment_guid}/blurhash", include_in_schema=False)
async def bluebubbles_attachment_blurhash(
    attachment_guid: str,
    account: BlueBubblesAccount = Depends(bluebubbles_account),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    await get_attachment_metadata(db, account=account, attachment_guid=attachment_guid)
    return _bluebubbles_ok({"guid": attachment_guid, "blurhash": None})


@router.get("/attachment/{attachment_guid}", include_in_schema=False)
async def bluebubbles_get_attachment(
    attachment_guid: str,
    account: BlueBubblesAccount = Depends(bluebubbles_account),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    metadata = await get_attachment_metadata(db, account=account, attachment_guid=attachment_guid)
    return _bluebubbles_ok(metadata)
