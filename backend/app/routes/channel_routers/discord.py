from __future__ import annotations

import asyncio
import json
import secrets
import zlib
from typing import Any
from uuid import UUID

from fastapi import (
    APIRouter,
    Depends,
    Header,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import (
    async_session_factory,
    get_session,
)
from app.models.channel import (
    BINDING_STATUS_ACTIVE,
    CHANNEL_PROVIDER_DISCORD,
    ChannelAccount,
    ChannelBinding,
    ChannelBindingAlias,
)
from app.routes.channel_routers.shared import (
    _discord_application_id,
    _discord_bot_user,
    _discord_gateway_dispatch,
    _discord_interaction_content,
    _discord_message_result,
    _fan_out_discord_global_commands,
    _handle_discord_application_commands,
    _json_object_from_bytes,
    _optional_int_param,
    _optional_str,
    _proxy_discord_request,
    _public_ws_url,
    _request_params,
    _require_bound_chat,
    _resolve_discord_agent_context,
)
from app.services.channels import (
    DISCORD_REF_INTERACTION_ID_TOKEN,
    DISCORD_REF_INTERACTION_TOKEN,
    dequeue_discord_gateway_events,
    discord_channel_scope_from_payload,
    discord_chat_from_payload,
    discord_external_user_id_from_payload,
    discord_message_id_from_payload,
    discord_pair_command_from_payload,
    discord_text_from_payload,
    get_active_channel_account,
    get_channel_agent_reference,
    pairing_reply_for_command,
    record_discord_interaction_references,
    record_inbound_messages_for_bindings,
    resolve_channel_agent_by_token,
    resolve_inbound_binding,
    send_channel_outbound_message,
    send_pairing_command_reply,
    upsert_binding_alias,
    verify_discord_signature,
    verify_webhook_secret,
)

router = APIRouter(prefix="/api/channels/discord", tags=["channels"])

_DISCORD_GATEWAY_RESUME_BUFFER_SIZE = 100
_DISCORD_GATEWAY_SESSIONS: dict[str, dict[str, Any]] = {}


@router.api_route(
    "/v10/{discord_path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    include_in_schema=False,
    response_model=None,
)
@router.api_route(
    "/api/v10/{discord_path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    include_in_schema=False,
    response_model=None,
)
async def discord_agent_rest(
    discord_path: str,
    request: Request,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
) -> Any:
    agent = await _resolve_discord_agent_context(db, authorization)
    account = agent.account
    segments = [segment for segment in discord_path.strip("/").split("/") if segment]
    if segments in (["gateway"], ["gateway", "bot"]):
        return {
            "url": _public_ws_url("/api/channels/discord/gateway"),
            "shards": 1,
            "session_start_limit": {
                "total": 1000,
                "remaining": 1000,
                "reset_after": 0,
                "max_concurrency": 1,
            },
        }
    if segments == ["users", "@me"]:
        if request.method == "PATCH":
            params = await _request_params(request)
            config = dict(account.config) if isinstance(account.config, dict) else {}
            username = _optional_str(params.get("username"))
            if username:
                config["bot_username"] = username
            if "avatar" in params:
                config["bot_avatar"] = params.get("avatar")
            account.config = config
            await db.commit()
        return _discord_bot_user(account)
    command_response = await _handle_discord_application_commands(
        db,
        account=account,
        request=request,
        segments=segments,
    )
    if command_response is not None:
        return command_response
    if segments in (["oauth2", "applications", "@me"], ["applications", "@me"]):
        user = _discord_bot_user(account)
        return {
            "id": user["id"],
            "name": user["username"],
            "description": "",
            "icon": None,
            "verify_key": "",
            "bot_public": False,
            "bot_require_code_grant": False,
            "owner": user,
            "bot": user,
        }
    if segments and segments[0] == "interactions":
        return await _handle_discord_interaction_callback(
            db,
            account=account,
            bot_agent_link_id=agent.link.id,
            request=request,
            path=discord_path,
            segments=segments,
        )
    if segments and segments[0] == "webhooks":
        return await _handle_discord_webhook_followup(
            db,
            account=account,
            bot_agent_link_id=agent.link.id,
            request=request,
            path=discord_path,
            segments=segments,
        )
    if (
        len(segments) == 3
        and segments[0] == "channels"
        and segments[2] == "messages"
        and request.method == "POST"
    ):
        channel_id = segments[1]
        await _require_bound_chat(
            db,
            account=account,
            external_chat_id=channel_id,
            bot_agent_link_id=agent.link.id,
        )
        params = await _request_params(request)
        text = _optional_str(params.get("content")) or ""
        message = await send_channel_outbound_message(
            db,
            account=account,
            external_chat_id=channel_id,
            text=text,
            bot_agent_link_id=agent.link.id,
        )
        await db.commit()
        return _discord_message_result(message, channel_id=channel_id, content=text)
    if segments and segments[0] == "channels" and len(segments) >= 2:
        await _require_bound_chat(
            db,
            account=account,
            external_chat_id=segments[1],
            bot_agent_link_id=agent.link.id,
        )
        return await _proxy_discord_request(account=account, request=request, path=discord_path)
    if segments and segments[0] == "guilds" and len(segments) >= 2:
        if not await _discord_guild_is_bound(
            db,
            account=account,
            guild_id=segments[1],
            bot_agent_link_id=agent.link.id,
        ):
            return _discord_rest_error("Missing Access", 50001, 403)
        return await _proxy_discord_request(account=account, request=request, path=discord_path)
    return _discord_rest_error("Missing Access", 50001, 403)


@router.websocket("/gateway")
@router.websocket("/gateway/")
async def discord_agent_gateway(websocket: WebSocket) -> None:
    await websocket.accept()
    encoding = websocket.query_params.get("encoding") or "json"
    compress = websocket.query_params.get("compress")
    if encoding != "json" or (compress is not None and compress != "zlib-stream"):
        await websocket.close(code=4012)
        return

    compressor = zlib.compressobj(wbits=zlib.MAX_WBITS) if compress == "zlib-stream" else None
    account: ChannelAccount | None = None
    bot_agent_link_id: UUID | None = None
    last_sequence = 0
    gateway_sequence = 1
    session_id = secrets.token_urlsafe(18)
    session_state: dict[str, Any] | None = None

    async def send_gateway_frame(payload: dict[str, Any], *, record: bool = True) -> None:
        if record and session_state is not None and payload.get("op") == 0 and payload.get("s"):
            frames = session_state.setdefault("frames", [])
            frames.append(payload)
            if len(frames) > _DISCORD_GATEWAY_RESUME_BUFFER_SIZE:
                del frames[:-_DISCORD_GATEWAY_RESUME_BUFFER_SIZE]
                if frames and isinstance(frames[0].get("s"), int):
                    session_state["dropped_before_sequence"] = frames[0]["s"]
        if compressor is None:
            await websocket.send_json(payload)
            return
        raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        await websocket.send_bytes(compressor.compress(raw) + compressor.flush(zlib.Z_SYNC_FLUSH))

    await send_gateway_frame({"op": 10, "d": {"heartbeat_interval": 45_000}}, record=False)
    try:
        while account is None:
            frame = await websocket.receive_json()
            op = frame.get("op") if isinstance(frame, dict) else None
            if op == 1:
                await send_gateway_frame({"op": 11, "d": None}, record=False)
                continue
            if op not in {2, 6}:
                continue
            data = frame.get("d")
            if not isinstance(data, dict):
                await websocket.close(code=4002)
                return
            token = _optional_str(data.get("token"))
            if not token:
                await websocket.close(code=4004)
                return
            async with async_session_factory() as db:
                try:
                    resolved_agent = await resolve_channel_agent_by_token(
                        db,
                        provider=CHANNEL_PROVIDER_DISCORD,
                        token=token,
                    )
                except HTTPException:
                    if op == 6:
                        await send_gateway_frame({"op": 9, "d": False}, record=False)
                        continue
                    await websocket.close(code=4004)
                    return
                resolved_account = resolved_agent.account
                resolved_link_id = resolved_agent.link.id
                bound_guilds = await _discord_bound_guilds(
                    db,
                    account=resolved_account,
                    bot_agent_link_id=resolved_link_id,
                )
                bound_guild_channels = await _discord_bound_guild_channels(
                    db,
                    account=resolved_account,
                    bot_agent_link_id=resolved_link_id,
                )
            if op == 6:
                resume_session_id = _optional_str(data.get("session_id"))
                resume_state = (
                    _DISCORD_GATEWAY_SESSIONS.get(resume_session_id)
                    if resume_session_id is not None
                    else None
                )
                if (
                    resume_state is None
                    or resume_state.get("account_id") != resolved_account.id
                    or resume_state.get("bot_agent_link_id") != resolved_link_id
                ):
                    await send_gateway_frame({"op": 9, "d": False}, record=False)
                    continue
                account = resolved_account
                bot_agent_link_id = resolved_link_id
                session_id = resume_session_id
                session_state = resume_state
                last_sequence = _optional_int_param(data.get("seq")) or 0
                dropped_before_sequence = session_state.get("dropped_before_sequence")
                if (
                    isinstance(dropped_before_sequence, int)
                    and last_sequence < dropped_before_sequence
                ):
                    await send_gateway_frame({"op": 9, "d": False}, record=False)
                    account = None
                    bot_agent_link_id = None
                    session_state = None
                    continue
                for replayed in [
                    frame
                    for frame in session_state.get("frames", [])
                    if isinstance(frame.get("s"), int) and frame["s"] > last_sequence
                ]:
                    await send_gateway_frame(replayed, record=False)
                    last_sequence = max(last_sequence, replayed["s"])
                await send_gateway_frame(
                    {"op": 0, "t": "RESUMED", "s": last_sequence, "d": {}},
                    record=False,
                )
            else:
                account = resolved_account
                bot_agent_link_id = resolved_link_id
                session_state = {
                    "account_id": account.id,
                    "bot_agent_link_id": bot_agent_link_id,
                    "frames": [],
                }
                _DISCORD_GATEWAY_SESSIONS[session_id] = session_state
                await send_gateway_frame(
                    {
                        "op": 0,
                        "t": "READY",
                        "s": 1,
                        "d": {
                            "v": 10,
                            "session_id": session_id,
                            "resume_gateway_url": _public_ws_url("/api/channels/discord/gateway"),
                            "user": _discord_bot_user(account),
                            "application": {"id": _discord_application_id(account)},
                            "guilds": [
                                {"id": guild_id, "unavailable": False} for guild_id in bound_guilds
                            ],
                        },
                    }
                )
                for guild_id in bound_guilds:
                    gateway_sequence += 1
                    await send_gateway_frame(
                        _discord_guild_create_payload(
                            guild_id=guild_id,
                            channel_ids=bound_guild_channels.get(guild_id, []),
                            sequence=gateway_sequence,
                        )
                    )

        while True:
            async with async_session_factory() as db:
                events = await dequeue_discord_gateway_events(
                    db,
                    account=account,
                    bot_agent_link_id=bot_agent_link_id,
                    after_sequence=last_sequence,
                    limit=100,
                )
            if events:
                for message in events:
                    last_sequence = int(message.inbox_sequence)
                    await send_gateway_frame(_discord_gateway_dispatch(message))
                continue

            try:
                frame = await asyncio.wait_for(
                    websocket.receive_json(),
                    timeout=max(0.001, settings.discord_gateway_poll_interval_seconds),
                )
                if isinstance(frame, dict) and frame.get("op") == 1:
                    await send_gateway_frame({"op": 11, "d": None}, record=False)
            except TimeoutError:
                pass
    except WebSocketDisconnect:
        return


@router.post(
    "/{account_id}/webhook",
    include_in_schema=False,
)
async def discord_webhook(
    account_id: UUID,
    request: Request,
    x_clawdi_channel_secret: str | None = Header(default=None),
    x_signature_ed25519: str | None = Header(default=None),
    x_signature_timestamp: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    account = await get_active_channel_account(db, account_id=account_id)
    if account.provider != CHANNEL_PROVIDER_DISCORD:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="channel not found")
    body = await request.body()
    if not (
        verify_webhook_secret(x_clawdi_channel_secret, account.webhook_secret_hash)
        or verify_discord_signature(
            account=account,
            body=body,
            signature=x_signature_ed25519,
            timestamp=x_signature_timestamp,
        )
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid webhook secret",
        )
    payload = _json_object_from_bytes(body)
    if payload.get("type") == 1:
        return {"type": 1}

    chat = discord_chat_from_payload(payload)
    if chat is None:
        return {"ok": True}
    external_chat_id, external_chat_type, external_chat_name = chat
    command = discord_pair_command_from_payload(payload)
    binding_result = await resolve_inbound_binding(
        db,
        account=account,
        external_chat_id=external_chat_id,
        external_chat_type=external_chat_type,
        external_chat_name=external_chat_name,
        external_user_id=discord_external_user_id_from_payload(payload),
        text=discord_text_from_payload(payload),
        command=command,
    )

    messages = await record_inbound_messages_for_bindings(
        db,
        account=account,
        binding_result=binding_result,
        external_chat_id=external_chat_id,
        provider_message_id=discord_message_id_from_payload(payload),
        text=discord_text_from_payload(payload),
        payload=payload,
    )
    channel_id, guild_id = discord_channel_scope_from_payload(payload)
    for message, binding in messages:
        if (
            binding is not None
            and channel_id is not None
            and guild_id is not None
            and channel_id != guild_id
        ):
            await upsert_binding_alias(
                db,
                binding=binding,
                alias_external_chat_id=channel_id,
                alias_kind="discord_channel",
            )
        await record_discord_interaction_references(
            db,
            account=account,
            binding=binding,
            message=message,
            payload=payload,
        )
    await db.commit()
    message = messages[0][0]
    if payload.get("type") == 2:
        return {
            "type": 4,
            "data": {
                "content": _discord_interaction_content(
                    command=command,
                    paired=binding_result.paired,
                    unpaired=binding_result.unpaired,
                    reply=pairing_reply_for_command(command, binding_result),
                ),
                "flags": 64,
            },
        }
    await _replay_discord_commands_on_pair(
        db,
        account=account,
        application_id=_discord_application_id(account),
        guild_id=guild_id,
        paired=binding_result.paired,
    )
    reply = await send_pairing_command_reply(
        db,
        account=account,
        external_chat_id=external_chat_id,
        send_external_chat_id=channel_id,
        command=command,
        binding_result=binding_result,
    )
    if reply is not None:
        await db.commit()
    return {
        "ok": True,
        "paired": binding_result.paired,
        "unpaired": binding_result.unpaired,
        "binding_id": str(message.binding_id) if message.binding_id else None,
    }


async def _replay_discord_commands_on_pair(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    application_id: str,
    guild_id: str | None,
    paired: bool,
) -> None:
    if not paired or guild_id is None:
        return
    config = account.config if isinstance(account.config, dict) else {}
    shadow = config.get("discord_agent_commands")
    if not isinstance(shadow, dict):
        return
    commands = shadow.get("global")
    if not isinstance(commands, list):
        return
    try:
        await _fan_out_discord_global_commands(
            db,
            account=account,
            application_id=application_id,
            commands=[command for command in commands if isinstance(command, dict)],
            guild_ids={guild_id},
        )
    except HTTPException:
        return


async def _handle_discord_interaction_callback(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID,
    request: Request,
    path: str,
    segments: list[str],
) -> Any:
    if len(segments) < 4 or segments[3] != "callback":
        return _discord_rest_error("Unknown Interaction", 10062, 404)
    interaction_id = segments[1]
    token = segments[2]
    reference = await get_channel_agent_reference(
        db,
        account=account,
        ref_kind=DISCORD_REF_INTERACTION_ID_TOKEN,
        ref_value=f"{interaction_id}:{token}",
        bot_agent_link_id=bot_agent_link_id,
    )
    if reference is None:
        return _discord_rest_error("Unknown Interaction", 10062, 404)
    return await _proxy_discord_request(account=account, request=request, path=path)


async def _handle_discord_webhook_followup(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID,
    request: Request,
    path: str,
    segments: list[str],
) -> Any:
    if len(segments) < 3:
        return _discord_rest_error("Unknown Webhook", 10015, 404)
    application_id = segments[1]
    token = segments[2]
    reference = await get_channel_agent_reference(
        db,
        account=account,
        ref_kind=DISCORD_REF_INTERACTION_TOKEN,
        ref_value=token,
        bot_agent_link_id=bot_agent_link_id,
    )
    metadata = reference.metadata_ if reference is not None else None
    recorded_application_id = metadata.get("application_id") if isinstance(metadata, dict) else None
    if reference is None or recorded_application_id != application_id:
        return _discord_rest_error("Unknown Webhook", 10015, 404)
    return await _proxy_discord_request(account=account, request=request, path=path)


def _discord_rest_error(message: str, code: int, status_code: int) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"code": code, "message": message})


async def _discord_guild_is_bound(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    guild_id: str,
    bot_agent_link_id: UUID | None = None,
) -> bool:
    filters = [
        ChannelBinding.account_id == account.id,
        ChannelBinding.status == BINDING_STATUS_ACTIVE,
        (
            (ChannelBinding.external_chat_id == guild_id)
            | (ChannelBinding.external_chat_name == guild_id)
        ),
    ]
    if bot_agent_link_id is not None:
        filters.append(ChannelBinding.bot_agent_link_id == bot_agent_link_id)
    result = await db.execute(select(ChannelBinding.id).where(*filters))
    return result.scalar_one_or_none() is not None


async def _discord_bound_guilds(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID | None = None,
) -> list[str]:
    filters = [
        ChannelBinding.account_id == account.id,
        ChannelBinding.status == BINDING_STATUS_ACTIVE,
    ]
    if bot_agent_link_id is not None:
        filters.append(ChannelBinding.bot_agent_link_id == bot_agent_link_id)
    result = await db.execute(select(ChannelBinding).where(*filters))
    guilds: set[str] = set()
    for binding in result.scalars().all():
        chat_type = (binding.external_chat_type or "").lower()
        if binding.external_chat_name and ("guild" in chat_type or "thread" in chat_type):
            guilds.add(binding.external_chat_name)
        elif binding.external_chat_id and chat_type == "guild":
            guilds.add(binding.external_chat_id)
    return sorted(guilds)


async def _discord_bound_guild_channels(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID | None = None,
) -> dict[str, list[str]]:
    filters = [
        ChannelBinding.account_id == account.id,
        ChannelBinding.status == BINDING_STATUS_ACTIVE,
        ChannelBindingAlias.account_id == account.id,
        ChannelBindingAlias.alias_kind == "discord_channel",
    ]
    if bot_agent_link_id is not None:
        filters.append(ChannelBindingAlias.bot_agent_link_id == bot_agent_link_id)
    result = await db.execute(
        select(ChannelBinding, ChannelBindingAlias)
        .join(ChannelBindingAlias, ChannelBindingAlias.binding_id == ChannelBinding.id)
        .where(*filters)
        .order_by(ChannelBindingAlias.updated_at.desc(), ChannelBindingAlias.created_at.desc())
    )
    channels_by_guild: dict[str, list[str]] = {}
    seen_by_guild: dict[str, set[str]] = {}
    for binding, alias in result.all():
        guild_id = _discord_binding_guild_id(binding)
        if guild_id is None:
            continue
        seen = seen_by_guild.setdefault(guild_id, set())
        if alias.alias_external_chat_id in seen:
            continue
        seen.add(alias.alias_external_chat_id)
        channels_by_guild.setdefault(guild_id, []).append(alias.alias_external_chat_id)
    return channels_by_guild


def _discord_binding_guild_id(binding: ChannelBinding) -> str | None:
    chat_type = (binding.external_chat_type or "").lower()
    if binding.external_chat_name and ("guild" in chat_type or "thread" in chat_type):
        return binding.external_chat_name
    if binding.external_chat_id and ("guild" in chat_type or "thread" in chat_type):
        return binding.external_chat_id
    return None


def _discord_gateway_channel_payload(*, guild_id: str, channel_id: str) -> dict[str, Any]:
    return {
        "id": channel_id,
        "guild_id": guild_id,
        "name": channel_id,
        "type": 0,
        "position": 0,
        "permission_overwrites": [],
        "parent_id": None,
    }


def _discord_guild_create_payload(
    *,
    guild_id: str,
    channel_ids: list[str],
    sequence: int,
) -> dict[str, Any]:
    return {
        "op": 0,
        "t": "GUILD_CREATE",
        "s": sequence,
        "d": {
            "id": guild_id,
            "name": guild_id,
            "unavailable": False,
            "channels": [
                _discord_gateway_channel_payload(guild_id=guild_id, channel_id=channel_id)
                for channel_id in channel_ids
            ],
            "threads": [],
            "members": [],
        },
    }
