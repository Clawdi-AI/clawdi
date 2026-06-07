from __future__ import annotations

from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    Request,
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
    _bluebubbles_handle,
    _bluebubbles_message,
    _bluebubbles_ok,
    _list_imessage_bindings,
    _optional_int_param,
    _optional_str,
    _request_params,
    _require_bound_chat,
    _required_str_param,
)
from app.services.bluebubbles_compat import (
    count_imessage_messages,
    create_imessage_agent_message,
    synthetic_operation_response,
)

router = APIRouter(prefix="/api/channels/imessage/bluebubbles/v1", tags=["channels"])


@router.post("/facetime/session", include_in_schema=False)
async def bluebubbles_facetime_session(
    account: BlueBubblesAccount = Depends(bluebubbles_account),
) -> dict[str, Any]:
    return _bluebubbles_ok({"id": f"facetime-{account.id}", "active": False})


@router.post("/facetime/link", include_in_schema=False)
async def bluebubbles_facetime_link(
    account: BlueBubblesAccount = Depends(bluebubbles_account),
) -> dict[str, Any]:
    return _bluebubbles_ok({"url": None, "accountId": str(account.id)})


@router.post("/poll/create", include_in_schema=False)
@router.post("/poll", include_in_schema=False)
async def bluebubbles_create_poll(
    request: Request,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    account = agent.account
    params = await _request_params(request)
    chat_guid = _required_str_param(params, "chatGuid")
    binding = await _require_bound_chat(
        db,
        account=account,
        external_chat_id=chat_guid,
        bot_agent_link_id=agent.link.id,
    )
    message = await create_imessage_agent_message(
        db,
        account=account,
        binding=binding,
        text=_optional_str(params.get("title")) or _optional_str(params.get("message")),
        payload={"poll": params},
    )
    await db.commit()
    return _bluebubbles_ok(_bluebubbles_message(message))


@router.post("/poll/vote", include_in_schema=False)
@router.post("/poll/unvote", include_in_schema=False)
@router.post("/poll/option", include_in_schema=False)
async def bluebubbles_poll_action(
    request: Request,
    _account: BlueBubblesAccount = Depends(bluebubbles_account),
) -> dict[str, Any]:
    params = await _request_params(request)
    return _bluebubbles_ok(params)


@router.get("/handle/availability", include_in_schema=False)
@router.get("/handle/availability/{handle_type}", include_in_schema=False)
async def bluebubbles_handle_availability(
    handle_type: str | None = None,
    _account: BlueBubblesAccount = Depends(bluebubbles_account),
) -> dict[str, Any]:
    return _bluebubbles_ok({"available": True, "type": handle_type})


@router.get("/handle/count", include_in_schema=False)
async def bluebubbles_handle_count(
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    bindings = await _list_imessage_bindings(
        db,
        account=agent.account,
        bot_agent_link_id=agent.link.id,
    )
    return _bluebubbles_ok({"total": len(bindings)})


@router.post("/handle/query", include_in_schema=False)
async def bluebubbles_query_handles(
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
    handles = [
        _bluebubbles_handle(binding.external_chat_id)
        for binding in bindings[offset : offset + limit]
    ]
    return _bluebubbles_ok(handles)


@router.get("/handle/{handle_guid}/focus", include_in_schema=False)
async def bluebubbles_handle_focus(
    handle_guid: str,
    _account: BlueBubblesAccount = Depends(bluebubbles_account),
) -> dict[str, Any]:
    return _bluebubbles_ok({"handle": _bluebubbles_handle(handle_guid), "focus": None})


@router.get("/handle/{handle_guid}", include_in_schema=False)
async def bluebubbles_get_handle(
    handle_guid: str,
    _account: BlueBubblesAccount = Depends(bluebubbles_account),
) -> dict[str, Any]:
    return _bluebubbles_ok(_bluebubbles_handle(handle_guid))


@router.get("/contact", include_in_schema=False)
@router.get("/icloud/contact", include_in_schema=False)
@router.get("/icloud/findmy/friends", include_in_schema=False)
@router.post("/icloud/findmy/friends/refresh", include_in_schema=False)
@router.get("/icloud/findmy/location", include_in_schema=False)
@router.get("/icloud/findmy/location/status", include_in_schema=False)
async def bluebubbles_empty_collection(
    _account: BlueBubblesAccount = Depends(bluebubbles_account),
) -> dict[str, Any]:
    return _bluebubbles_ok([])


@router.post("/chat/{chat_guid}/share/contact", include_in_schema=False)
@router.get("/chat/{chat_guid}/share/contact/status", include_in_schema=False)
async def bluebubbles_contact_share(
    chat_guid: str,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    binding = await _require_bound_chat(
        db,
        account=agent.account,
        external_chat_id=chat_guid,
        bot_agent_link_id=agent.link.id,
    )
    return _bluebubbles_ok(synthetic_operation_response(binding, shared=False))


@router.get("/server/statistics/totals", include_in_schema=False)
@router.get("/server/statistics/media", include_in_schema=False)
@router.get("/server/statistics/media/chat", include_in_schema=False)
@router.get("/server/logs", include_in_schema=False)
async def bluebubbles_server_statistics(
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    chats = await _list_imessage_bindings(
        db,
        account=agent.account,
        bot_agent_link_id=agent.link.id,
    )
    messages = await count_imessage_messages(
        db,
        account=agent.account,
        scope="all",
        bot_agent_link_id=agent.link.id,
    )
    return _bluebubbles_ok({"chats": len(chats), "messages": messages, "logs": []})
