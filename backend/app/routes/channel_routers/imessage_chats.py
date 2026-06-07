from __future__ import annotations

import secrets
from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session
from app.models.channel import ChannelBinding
from app.routes.channel_routers.imessage_auth import BlueBubblesAgent, bluebubbles_agent
from app.routes.channel_routers.shared import (
    _bluebubbles_chat,
    _bluebubbles_message,
    _bluebubbles_ok,
    _list_imessage_bindings,
    _list_imessage_messages,
    _optional_int_param,
    _optional_str,
    _read_upload_bytes,
    _request_params,
    _require_bound_chat,
    _required_str_param,
)
from app.services.bluebubbles_compat import (
    BLUEBUBBLES_ATTACHMENT_MAX_BYTES,
    create_imessage_agent_message,
    rename_chat,
    synthetic_operation_response,
)
from app.services.channels import find_binding

router = APIRouter(prefix="/api/channels/imessage/bluebubbles/v1", tags=["channels"])


async def _require_agent_bound_chat(
    db: AsyncSession,
    *,
    agent: BlueBubblesAgent,
    external_chat_id: str,
) -> ChannelBinding:
    return await _require_bound_chat(
        db,
        account=agent.account,
        external_chat_id=external_chat_id,
        bot_agent_link_id=agent.link.id,
    )


@router.post("/chat/query", include_in_schema=False)
async def bluebubbles_query_chats(
    request: Request,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    params = await _request_params(request)
    offset = max(_optional_int_param(params.get("offset")) or 0, 0)
    limit = max(1, min(_optional_int_param(params.get("limit")) or 100, 500))
    bindings = await _list_imessage_bindings(
        db,
        account=agent.account,
        bot_agent_link_id=agent.link.id,
    )
    chats = [_bluebubbles_chat(binding) for binding in bindings[offset : offset + limit]]
    return _bluebubbles_ok(chats)


@router.get("/chat/count", include_in_schema=False)
async def bluebubbles_chat_count(
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    bindings = await _list_imessage_bindings(
        db,
        account=agent.account,
        bot_agent_link_id=agent.link.id,
    )
    total = len(bindings)
    return _bluebubbles_ok({"total": total, "breakdown": {"imessage": total}})


@router.post("/chat/new", include_in_schema=False)
async def bluebubbles_create_chat(
    request: Request,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    account = agent.account
    params = await _request_params(request)
    raw_addresses = params.get("addresses")
    participants = _string_list(raw_addresses)
    if raw_addresses is None:
        participants = _string_list(params.get("participants"))
    elif not participants:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="address is required",
        )
    first_participant = participants[0] if participants else None
    chat_guid = _optional_str(params.get("chatGuid")) or _optional_str(params.get("guid"))
    if chat_guid is None:
        if participants and len(participants) > 1:
            chat_guid = f"iMessage;+;{secrets.token_hex(8)}"
        else:
            suffix = first_participant or secrets.token_hex(8)
            chat_guid = f"iMessage;-;{suffix}"
    binding = await find_binding(
        db,
        account=account,
        external_chat_id=chat_guid,
        bot_agent_link_id=agent.link.id,
    )
    if binding is None:
        chat_type = "group" if participants and len(participants) > 1 else "dm"
        binding = ChannelBinding(
            account_id=account.id,
            bot_agent_link_id=agent.link.id,
            user_id=account.user_id,
            external_chat_id=chat_guid,
            external_chat_type=chat_type,
            external_chat_name=_optional_str(params.get("groupChatName"))
            or _optional_str(params.get("displayName")),
        )
        db.add(binding)
        await db.flush()
    chat_payload = _bluebubbles_chat(binding)
    chat_payload["chatGuid"] = binding.external_chat_id
    message_text = _optional_str(params.get("message")) or _optional_str(params.get("text"))
    if message_text:
        message = await create_imessage_agent_message(
            db,
            account=account,
            binding=binding,
            text=message_text,
            payload={
                "data": {
                    "tempGuid": _optional_str(params.get("tempGuid")),
                    "method": "private-api"
                    if _optional_str(params.get("method")) == "apple-script"
                    else _optional_str(params.get("method")),
                }
            },
        )
        await db.commit()
        message_payload = _bluebubbles_message(message)
        return _bluebubbles_ok(
            {
                **message_payload,
                "chatGuid": binding.external_chat_id,
                "messageGuid": message_payload["guid"],
                "messageId": message_payload["guid"],
                "chat": chat_payload,
                "message": message_payload,
            }
        )
    await db.commit()
    return _bluebubbles_ok(chat_payload)


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()]


@router.get("/chat/{chat_guid}", include_in_schema=False)
async def bluebubbles_get_chat(
    chat_guid: str,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    binding = await _require_agent_bound_chat(db, agent=agent, external_chat_id=chat_guid)
    return _bluebubbles_ok(_bluebubbles_chat(binding))


@router.get("/chat/{chat_guid}/message", include_in_schema=False)
async def bluebubbles_get_chat_messages(
    chat_guid: str,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    await _require_agent_bound_chat(db, agent=agent, external_chat_id=chat_guid)
    messages = await _list_imessage_messages(
        db,
        account=agent.account,
        chat_guid=chat_guid,
        limit=limit,
        offset=offset,
        bot_agent_link_id=agent.link.id,
    )
    return _bluebubbles_ok([_bluebubbles_message(message) for message in messages])


@router.get("/chat/{chat_guid}/messages", include_in_schema=False)
async def bluebubbles_get_chat_messages_alias(
    chat_guid: str,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    return await bluebubbles_get_chat_messages(
        chat_guid=chat_guid,
        agent=agent,
        limit=limit,
        offset=offset,
        db=db,
    )


@router.get("/messages", include_in_schema=False)
async def bluebubbles_get_messages_alias(
    chat_guid: str = Query(alias="chatGuid"),
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    return await bluebubbles_get_chat_messages(
        chat_guid=chat_guid,
        agent=agent,
        limit=limit,
        offset=offset,
        db=db,
    )


@router.post("/chat/{chat_guid}/read", include_in_schema=False)
async def bluebubbles_mark_chat_read(
    chat_guid: str,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    binding = await _require_agent_bound_chat(db, agent=agent, external_chat_id=chat_guid)
    return _bluebubbles_ok(synthetic_operation_response(binding))


@router.post("/chat/{chat_guid}/unread", include_in_schema=False)
async def bluebubbles_mark_chat_unread(
    chat_guid: str,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    binding = await _require_agent_bound_chat(db, agent=agent, external_chat_id=chat_guid)
    return _bluebubbles_ok(synthetic_operation_response(binding, unread=True))


@router.post("/chat/{chat_guid}/typing", include_in_schema=False)
async def bluebubbles_start_typing(
    chat_guid: str,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    binding = await _require_agent_bound_chat(db, agent=agent, external_chat_id=chat_guid)
    return _bluebubbles_ok(synthetic_operation_response(binding, typing=True))


@router.delete("/chat/{chat_guid}/typing", include_in_schema=False)
async def bluebubbles_stop_typing(
    chat_guid: str,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    binding = await _require_agent_bound_chat(db, agent=agent, external_chat_id=chat_guid)
    return _bluebubbles_ok(synthetic_operation_response(binding, typing=False))


@router.put("/chat/{chat_guid}", include_in_schema=False)
async def bluebubbles_rename_chat(
    chat_guid: str,
    request: Request,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    params = await _request_params(request)
    display_name = _required_str_param(params, "displayName")
    binding = await _require_agent_bound_chat(db, agent=agent, external_chat_id=chat_guid)
    await rename_chat(db, binding=binding, display_name=display_name)
    await db.commit()
    return _bluebubbles_ok(synthetic_operation_response(binding, displayName=display_name))


@router.post("/chat/{chat_guid}/leave", include_in_schema=False)
async def bluebubbles_leave_chat(
    chat_guid: str,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    binding = await _require_agent_bound_chat(db, agent=agent, external_chat_id=chat_guid)
    return _bluebubbles_ok(synthetic_operation_response(binding))


@router.post("/chat/{chat_guid}/participant", include_in_schema=False)
async def bluebubbles_add_participant(
    chat_guid: str,
    request: Request,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    params = await _request_params(request)
    address = _required_str_param(params, "address")
    binding = await _require_agent_bound_chat(db, agent=agent, external_chat_id=chat_guid)
    return _bluebubbles_ok(synthetic_operation_response(binding, address=address))


@router.post("/chat/{chat_guid}/participant/remove", include_in_schema=False)
@router.delete("/chat/{chat_guid}/participant", include_in_schema=False)
async def bluebubbles_remove_participant(
    chat_guid: str,
    request: Request,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    params = await _request_params(request)
    address = _required_str_param(params, "address")
    binding = await _require_agent_bound_chat(db, agent=agent, external_chat_id=chat_guid)
    return _bluebubbles_ok(synthetic_operation_response(binding, address=address))


@router.post("/chat/{chat_guid}/icon", include_in_schema=False)
async def bluebubbles_set_chat_icon(
    chat_guid: str,
    icon: UploadFile = File(...),
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    binding = await _require_agent_bound_chat(db, agent=agent, external_chat_id=chat_guid)
    await _read_upload_bytes(icon, max_bytes=10 * 1024 * 1024)
    return _bluebubbles_ok(synthetic_operation_response(binding))


@router.get("/chat/{chat_guid}/icon", include_in_schema=False)
async def bluebubbles_get_chat_icon(
    chat_guid: str,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> Response:
    await _require_agent_bound_chat(db, agent=agent, external_chat_id=chat_guid)
    return Response(content=b"", media_type="image/png")


@router.delete("/chat/{chat_guid}/icon", include_in_schema=False)
async def bluebubbles_delete_chat_icon(
    chat_guid: str,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    binding = await _require_agent_bound_chat(db, agent=agent, external_chat_id=chat_guid)
    return _bluebubbles_ok(synthetic_operation_response(binding))


@router.get("/chat/{chat_guid}/background", include_in_schema=False)
async def bluebubbles_get_chat_background(
    chat_guid: str,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    binding = await _require_agent_bound_chat(db, agent=agent, external_chat_id=chat_guid)
    return _bluebubbles_ok(synthetic_operation_response(binding, background=None))


@router.post("/chat/{chat_guid}/background", include_in_schema=False)
async def bluebubbles_set_chat_background(
    chat_guid: str,
    background: UploadFile | None = File(default=None),
    attachment: UploadFile | None = File(default=None),
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    binding = await _require_agent_bound_chat(db, agent=agent, external_chat_id=chat_guid)
    upload = background or attachment
    if upload is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="background file required",
        )
    await _read_upload_bytes(upload, max_bytes=BLUEBUBBLES_ATTACHMENT_MAX_BYTES)
    return _bluebubbles_ok(synthetic_operation_response(binding))


@router.delete("/chat/{chat_guid}/background", include_in_schema=False)
async def bluebubbles_delete_chat_background(
    chat_guid: str,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    binding = await _require_agent_bound_chat(db, agent=agent, external_chat_id=chat_guid)
    return _bluebubbles_ok(synthetic_operation_response(binding))


@router.delete("/chat/{chat_guid}", include_in_schema=False)
async def bluebubbles_delete_chat(
    chat_guid: str,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    binding = await _require_agent_bound_chat(db, agent=agent, external_chat_id=chat_guid)
    return _bluebubbles_ok(synthetic_operation_response(binding))


@router.post("/chat/{chat_guid}/share/contact", include_in_schema=False)
@router.get("/chat/{chat_guid}/share/contact/status", include_in_schema=False)
async def bluebubbles_contact_share(
    chat_guid: str,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    binding = await _require_agent_bound_chat(db, agent=agent, external_chat_id=chat_guid)
    return _bluebubbles_ok(synthetic_operation_response(binding, shared=False))
