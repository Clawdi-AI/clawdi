from __future__ import annotations

from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    Query,
    Request,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session
from app.models.channel import (
    BINDING_STATUS_ACTIVE,
    ChannelBinding,
    ChannelMessage,
)
from app.routes.channel_routers.imessage_auth import BlueBubblesAgent, bluebubbles_agent
from app.routes.channel_routers.shared import (
    _bluebubbles_message,
    _bluebubbles_message_count,
    _bluebubbles_ok,
    _get_imessage_message,
    _list_imessage_messages,
    _optional_int_param,
    _optional_str,
    _request_params,
    _require_bound_chat,
    _required_str_param,
)
from app.services.bluebubbles_compat import (
    create_scheduled_message,
    delete_scheduled_message,
    edit_imessage_message,
    get_scheduled_message,
    list_scheduled_messages,
    react_to_imessage_message,
    scheduled_message_response,
    unsend_imessage_message,
    update_scheduled_message,
)

router = APIRouter(prefix="/api/channels/imessage/bluebubbles/v1", tags=["channels"])


@router.post("/message/query", include_in_schema=False)
async def bluebubbles_query_messages(
    request: Request,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    account = agent.account
    params = await _request_params(request)
    chat_guid = _optional_str(params.get("chatGuid")) or _optional_str(params.get("chat_guid"))
    if chat_guid:
        await _require_bound_chat(
            db,
            account=account,
            external_chat_id=chat_guid,
            bot_agent_link_id=agent.link.id,
        )
    messages = await _list_imessage_messages(
        db,
        account=account,
        chat_guid=chat_guid,
        limit=max(1, min(_optional_int_param(params.get("limit")) or 100, 500)),
        offset=max(_optional_int_param(params.get("offset")) or 0, 0),
        bot_agent_link_id=agent.link.id,
    )
    return _bluebubbles_ok([_bluebubbles_message(message) for message in messages])


@router.post("/message/search", include_in_schema=False)
async def bluebubbles_search_messages(
    request: Request,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    account = agent.account
    params = await _request_params(request)
    term = _optional_str(params.get("query")) or _optional_str(params.get("text")) or ""
    chat_guid = _optional_str(params.get("chatGuid")) or _optional_str(params.get("chat_guid"))
    limit = max(1, min(_optional_int_param(params.get("limit")) or 50, 500))
    query = (
        select(ChannelMessage)
        .join(ChannelBinding, ChannelMessage.binding_id == ChannelBinding.id)
        .where(
            ChannelMessage.account_id == account.id,
            ChannelMessage.bot_agent_link_id == agent.link.id,
            ChannelBinding.status == BINDING_STATUS_ACTIVE,
        )
        .order_by(ChannelMessage.created_at.desc(), ChannelMessage.inbox_sequence.desc())
        .limit(limit)
    )
    if chat_guid:
        await _require_bound_chat(
            db,
            account=account,
            external_chat_id=chat_guid,
            bot_agent_link_id=agent.link.id,
        )
        query = query.where(ChannelMessage.external_chat_id == chat_guid)
    if term:
        query = query.where(ChannelMessage.text.contains(term, autoescape=True))
    result = await db.execute(query)
    return _bluebubbles_ok([_bluebubbles_message(message) for message in result.scalars().all()])


@router.get("/message/count", include_in_schema=False)
async def bluebubbles_message_count(
    chat_guid: str = Query(alias="chatGuid"),
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    return await _bluebubbles_message_count(
        db,
        chat_guid=chat_guid,
        account=agent.account,
        scope="all",
        bot_agent_link_id=agent.link.id,
    )


@router.get("/message/count/updated", include_in_schema=False)
async def bluebubbles_updated_message_count(
    chat_guid: str = Query(alias="chatGuid"),
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    return await _bluebubbles_message_count(
        db,
        chat_guid=chat_guid,
        account=agent.account,
        scope="updated",
        bot_agent_link_id=agent.link.id,
    )


@router.get("/message/count/me", include_in_schema=False)
async def bluebubbles_sent_message_count(
    chat_guid: str = Query(alias="chatGuid"),
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    return await _bluebubbles_message_count(
        db,
        chat_guid=chat_guid,
        account=agent.account,
        scope="sent",
        bot_agent_link_id=agent.link.id,
    )


@router.post("/message/schedule", include_in_schema=False)
async def bluebubbles_create_scheduled_message(
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
    row = await create_scheduled_message(db, account=account, binding=binding, payload=params)
    await db.commit()
    return _bluebubbles_ok(scheduled_message_response(row))


@router.get("/message/schedule", include_in_schema=False)
async def bluebubbles_list_scheduled_messages(
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    rows = await list_scheduled_messages(
        db,
        account=agent.account,
        bot_agent_link_id=agent.link.id,
    )
    return _bluebubbles_ok([scheduled_message_response(row) for row in rows])


@router.put("/message/schedule/{schedule_id}", include_in_schema=False)
async def bluebubbles_update_scheduled_message(
    schedule_id: str,
    request: Request,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    params = await _request_params(request)
    row = await get_scheduled_message(
        db,
        account=agent.account,
        schedule_id=schedule_id,
        bot_agent_link_id=agent.link.id,
    )
    updated = await update_scheduled_message(db, row=row, payload=params)
    await db.commit()
    return _bluebubbles_ok(scheduled_message_response(updated))


@router.delete("/message/schedule/{schedule_id}", include_in_schema=False)
async def bluebubbles_delete_scheduled_message(
    schedule_id: str,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    row = await get_scheduled_message(
        db,
        account=agent.account,
        schedule_id=schedule_id,
        bot_agent_link_id=agent.link.id,
    )
    await delete_scheduled_message(db, row=row)
    await db.commit()
    return _bluebubbles_ok({"id": schedule_id})


@router.get("/message/{message_guid}", include_in_schema=False)
async def bluebubbles_get_message(
    message_guid: str,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    message = await _get_imessage_message(
        db,
        account=agent.account,
        message_guid=message_guid,
        bot_agent_link_id=agent.link.id,
    )
    return _bluebubbles_ok(_bluebubbles_message(message))


@router.post("/message/react", include_in_schema=False)
async def bluebubbles_react_message(
    request: Request,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    account = agent.account
    params = await _request_params(request)
    chat_guid = _required_str_param(params, "chatGuid")
    selected_message_guid = _required_str_param(params, "selectedMessageGuid")
    reaction = _required_str_param(params, "reaction")
    await _require_bound_chat(
        db,
        account=account,
        external_chat_id=chat_guid,
        bot_agent_link_id=agent.link.id,
    )
    message = await react_to_imessage_message(
        db,
        account=account,
        chat_guid=chat_guid,
        selected_message_guid=selected_message_guid,
        reaction=reaction,
        part_index=_optional_int_param(params.get("partIndex")),
        bot_agent_link_id=agent.link.id,
    )
    await db.commit()
    return _bluebubbles_ok(_bluebubbles_message(message))


@router.post("/message/{message_guid}/edit", include_in_schema=False)
async def bluebubbles_edit_message(
    message_guid: str,
    request: Request,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    params = await _request_params(request)
    edited_message = _required_str_param(params, "editedMessage")
    message = await edit_imessage_message(
        db,
        account=agent.account,
        message_guid=message_guid,
        edited_message=edited_message,
        backwards_compatibility_message=_optional_str(params.get("backwardsCompatibilityMessage")),
        part_index=_optional_int_param(params.get("partIndex")),
        bot_agent_link_id=agent.link.id,
    )
    await db.commit()
    return _bluebubbles_ok(_bluebubbles_message(message))


@router.post("/message/{message_guid}/unsend", include_in_schema=False)
async def bluebubbles_unsend_message(
    message_guid: str,
    request: Request,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    params = await _request_params(request)
    message = await unsend_imessage_message(
        db,
        account=agent.account,
        message_guid=message_guid,
        part_index=_optional_int_param(params.get("partIndex")),
        bot_agent_link_id=agent.link.id,
    )
    await db.commit()
    return _bluebubbles_ok(_bluebubbles_message(message))


@router.post("/message/{message_guid}/notify", include_in_schema=False)
async def bluebubbles_notify_message(
    message_guid: str,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    message = await _get_imessage_message(
        db,
        account=agent.account,
        message_guid=message_guid,
        bot_agent_link_id=agent.link.id,
    )
    return _bluebubbles_ok({"guid": message.provider_message_id or str(message.id)})


@router.get("/message/{message_guid}/embedded-media", include_in_schema=False)
async def bluebubbles_embedded_media(
    message_guid: str,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    await _get_imessage_message(
        db,
        account=agent.account,
        message_guid=message_guid,
        bot_agent_link_id=agent.link.id,
    )
    return _bluebubbles_ok([])
