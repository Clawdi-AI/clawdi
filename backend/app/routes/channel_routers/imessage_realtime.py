from __future__ import annotations

import asyncio
import json
import secrets
from uuid import UUID

from fastapi import (
    APIRouter,
    Depends,
    Header,
    HTTPException,
    Query,
    Request,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import (
    async_session_factory,
    get_session,
)
from app.models.channel import CHANNEL_PROVIDER_IMESSAGE
from app.routes.channel_routers.shared import (
    _bluebubbles_message,
    _deliver_bluebubbles_agent_webhook,
    _json_object,
    _socketio_auth_token,
    _socketio_ping_loop,
)
from app.schemas.channel import TelegramWebhookResponse
from app.services.bluebubbles_socket import bluebubbles_socket_manager
from app.services.channels import (
    get_active_channel_account,
    imessage_chat_from_payload,
    imessage_external_user_id_from_payload,
    imessage_message_id_from_payload,
    imessage_text_from_payload,
    parse_pair_command,
    record_inbound_messages_for_bindings,
    resolve_channel_agent_by_token,
    resolve_inbound_binding,
    send_pairing_command_reply,
    verify_webhook_secret,
)

router = APIRouter(prefix="/api/channels/imessage", tags=["channels"])


@router.websocket("/bluebubbles/socket.io/")
async def bluebubbles_socketio(websocket: WebSocket) -> None:
    await websocket.accept()
    sid = secrets.token_urlsafe(12)
    await websocket.send_text(
        "0"
        + json.dumps(
            {
                "sid": sid,
                "upgrades": [],
                "pingInterval": 25_000,
                "pingTimeout": 20_000,
                "maxPayload": 1_000_000,
            }
        )
    )
    ping_task = asyncio.create_task(_socketio_ping_loop(websocket))
    try:
        while True:
            packet = await websocket.receive_text()
            if packet == "3":
                continue
            if not packet.startswith("40"):
                continue
            token = _socketio_auth_token(packet)
            if not token:
                await websocket.send_text(
                    '42["auth-error",{"message":"Unauthorized","reason":"missing apiKey"}]'
                )
                await websocket.close(code=1008)
                return
            try:
                async with async_session_factory() as db:
                    agent = await resolve_channel_agent_by_token(
                        db,
                        provider=CHANNEL_PROVIDER_IMESSAGE,
                        token=token,
                    )
                    account = agent.account
            except HTTPException:
                await websocket.send_text(
                    '42["auth-error",{"message":"Unauthorized","reason":"invalid apiKey"}]'
                )
                await websocket.close(code=1008)
                return
            await bluebubbles_socket_manager.connect(websocket, account.id)
            while True:
                packet = await websocket.receive_text()
                if packet == "3":
                    continue
    except WebSocketDisconnect:
        return
    finally:
        ping_task.cancel()
        bluebubbles_socket_manager.disconnect(websocket)


@router.post(
    "/{account_id}/webhook",
    include_in_schema=False,
)
async def imessage_webhook(
    account_id: UUID,
    request: Request,
    secret: str | None = Query(default=None),
    x_clawdi_channel_secret: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
) -> TelegramWebhookResponse:
    account = await get_active_channel_account(db, account_id=account_id)
    if account.provider != CHANNEL_PROVIDER_IMESSAGE:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="channel not found")
    if not verify_webhook_secret(
        x_clawdi_channel_secret or secret,
        account.webhook_secret_hash,
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid webhook secret",
        )

    payload = await _json_object(request)
    chat = imessage_chat_from_payload(payload)
    if chat is None:
        return TelegramWebhookResponse(ok=True)
    external_chat_id, external_chat_type, external_chat_name = chat
    text = imessage_text_from_payload(payload)
    command = parse_pair_command(text)
    binding_result = await resolve_inbound_binding(
        db,
        account=account,
        external_chat_id=external_chat_id,
        external_chat_type=external_chat_type,
        external_chat_name=external_chat_name,
        external_user_id=imessage_external_user_id_from_payload(payload),
        text=text,
        command=command,
    )

    messages = await record_inbound_messages_for_bindings(
        db,
        account=account,
        binding_result=binding_result,
        external_chat_id=external_chat_id,
        provider_message_id=imessage_message_id_from_payload(payload),
        text=text,
        payload=payload,
    )
    await db.commit()
    reply = await send_pairing_command_reply(
        db,
        account=account,
        external_chat_id=external_chat_id,
        command=command,
        binding_result=binding_result,
    )
    if reply is not None:
        await db.commit()
    message = messages[0][0]
    if not binding_result.command_handled:
        for routed_message, _binding in messages:
            if routed_message.binding_id:
                bluebubbles_payload = _bluebubbles_message(routed_message)
                await _deliver_bluebubbles_agent_webhook(
                    account,
                    "new-message",
                    bluebubbles_payload,
                )
                await bluebubbles_socket_manager.emit(
                    account.id,
                    "new-message",
                    bluebubbles_payload,
                )
    return TelegramWebhookResponse(
        ok=True,
        paired=binding_result.paired,
        unpaired=binding_result.unpaired,
        binding_id=message.binding_id,
    )
