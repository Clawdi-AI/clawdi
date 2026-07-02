from __future__ import annotations

from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
    status,
)
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session
from app.routes.channel_routers.imessage_auth import BlueBubblesAgent, bluebubbles_agent
from app.routes.channel_routers.shared import (
    _bluebubbles_message,
    _bluebubbles_ok,
    _optional_str,
    _request_params,
    _required_str_param,
)
from app.services.bluebubbles_compat import (
    apply_multipart_payload,
    create_imessage_agent_message,
    extract_multipart_text,
    validate_multipart_uploads,
)
from app.services.channels import find_imessage_binding_for_send, send_channel_outbound_message

router = APIRouter(prefix="/channels/imessage/bluebubbles/v1", tags=["channels"])


@router.api_route(
    "/message/text",
    methods=["POST"],
    include_in_schema=False,
)
async def bluebubbles_send_text(
    request: Request,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    account = agent.account
    params = await _request_params(request)
    chat_guid = _required_str_param(params, "chatGuid")
    text = _optional_str(params.get("message")) or _required_str_param(params, "text")
    if (
        await find_imessage_binding_for_send(
            db,
            account=account,
            requested_chat_guid=chat_guid,
            bot_agent_link_id=agent.link.id,
        )
        is None
    ):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="chat is not paired")
    message = await send_channel_outbound_message(
        db,
        account=account,
        external_chat_id=chat_guid,
        text=text,
        bot_agent_link_id=agent.link.id,
    )
    await db.commit()
    return {
        "status": 200,
        "message": "Message sent",
        "data": {
            "guid": message.provider_message_id or str(message.id),
            "chatGuid": chat_guid,
            "text": text,
        },
    }


@router.post("/message/multipart", include_in_schema=False)
async def bluebubbles_send_multipart(
    request: Request,
    agent: BlueBubblesAgent = Depends(bluebubbles_agent),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    account = agent.account
    params = await _request_params(request)
    chat_guid = _required_str_param(params, "chatGuid")
    parts = params.get("parts")
    if not isinstance(parts, list) or not parts:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="chatGuid and parts[] required",
        )
    binding = await find_imessage_binding_for_send(
        db,
        account=account,
        requested_chat_guid=chat_guid,
        bot_agent_link_id=agent.link.id,
    )
    if binding is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="chat is not paired")
    uploads = await validate_multipart_uploads(db, account=account, parts=parts)
    text = _optional_str(params.get("message")) or extract_multipart_text(parts)
    message = await create_imessage_agent_message(
        db,
        account=account,
        binding=binding,
        text=text or None,
        payload={"raw": params},
    )
    apply_multipart_payload(message, parts=parts, uploads=uploads)
    await db.commit()
    return _bluebubbles_ok(_bluebubbles_message(message))
