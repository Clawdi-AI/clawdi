from __future__ import annotations

import asyncio
import json
import logging
import secrets
import threading
import zlib
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from email import policy
from email.message import Message
from email.parser import BytesParser
from time import monotonic
from typing import NotRequired, TypedDict
from urllib.parse import quote
from uuid import UUID

import jwt
from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    Header,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.responses import JSONResponse, Response
from pydantic import JsonValue, TypeAdapter, ValidationError
from sqlalchemy import and_, select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession
from starlette.datastructures import UploadFile

from app.core.config import settings
from app.core.database import async_session_factory, get_session
from app.core.database import engine as database_engine
from app.models.channel import (
    BINDING_STATUS_ACTIVE,
    BOT_AGENT_LINK_STATUS_ACTIVE,
    CHANNEL_PROVIDER_DISCORD,
    CHANNEL_STATUS_ACTIVE,
    ChannelAccount,
    ChannelBinding,
    ChannelBindingAlias,
    ChannelBotAgentLink,
    ChannelMessage,
)
from app.routes.channel_routers.shared import (
    DiscordProviderResult,
    clear_discord_guild_commands,
    discord_application_id,
    discord_bot_user,
    discord_gateway_dispatch,
    discord_interaction_content,
    discord_retry_after_seconds,
    fan_out_discord_global_commands,
    handle_discord_application_commands,
    json_object_from_bytes,
    optional_int_param,
    optional_str,
    proxy_discord_request,
    public_ws_url,
    request_discord_provider,
    request_params,
    require_bound_chat,
    resolve_discord_agent_context,
)
from app.services.channels import (
    DISCORD_REF_INTERACTION_ID_TOKEN,
    DISCORD_REF_INTERACTION_TOKEN,
    ChannelAgentContext,
    ack_discord_gateway_messages,
    channel_control_command_event_was_handled,
    channel_runtime_account_key,
    channel_runtime_placeholder_token,
    dequeue_discord_gateway_events,
    discord_channel_scope_from_payload,
    discord_chat_from_payload,
    discord_control_command_admission,
    discord_control_command_from_payload,
    discord_control_reply_for_command,
    discord_external_user_id_from_payload,
    discord_message_id_from_payload,
    discord_text_from_payload,
    discord_user_display_name_from_payload,
    get_active_channel_account,
    get_channel_agent_reference,
    lock_active_discord_binding_lease,
    record_discord_interaction_references,
    record_discord_outbound_message,
    record_inactive_bot_agent_link_event,
    record_inbound_messages_for_bindings,
    resolve_channel_agent_by_identity,
    resolve_channel_agent_by_token,
    resolve_inbound_binding,
    send_control_command_reply,
    update_discord_binding_display_name_from_trusted_event,
    upsert_binding_alias,
    verify_discord_signature,
    verify_webhook_secret,
)
from app.services.discord_gateway_worker import (
    release_advisory_lock,
    try_advisory_lock,
)

router = APIRouter(prefix="/channels/discord", tags=["channels"])
log = logging.getLogger(__name__)

_DISCORD_GATEWAY_RESUME_BUFFER_SIZE = 100
_DISCORD_GATEWAY_MAX_CHANNELS = 256
_DISCORD_GATEWAY_MAX_SESSIONS = 256
_DISCORD_GATEWAY_SESSION_TTL_SECONDS = 5 * 60.0
_DISCORD_GATEWAY_CAPABILITY_SUBJECT = "clawdi_discord_gateway"
_DISCORD_GATEWAY_CAPABILITY_AUDIENCE = "clawdi_discord_gateway"
type JsonObject = dict[str, JsonValue]
_JSON_VALUE_ADAPTER: TypeAdapter[JsonValue] = TypeAdapter(JsonValue)
_JSON_OBJECT_ADAPTER: TypeAdapter[JsonObject] = TypeAdapter(dict[str, JsonValue])


class _DiscordGatewayConsumerLeaseLost(RuntimeError):
    pass


@dataclass(frozen=True)
class _DiscordGatewayCapability:
    account_id: UUID
    link_id: UUID
    agent_token_hash: str


@dataclass(frozen=True)
class _DiscordChannelAuthorization:
    binding: ChannelBinding
    preflight: DiscordProviderResult | None = None


@dataclass(frozen=True)
class _DiscordMessageReferenceIdentity:
    guild_id: str | None
    channel_id: str | None


@dataclass
class _DiscordGatewaySessionEntry:
    state: _DiscordGatewaySessionState
    touched_at: float
    connection_count: int


class _DiscordGatewaySessionState(TypedDict):
    account_id: UUID
    bot_agent_link_id: UUID
    frames: list[JsonObject]
    identified: bool
    projected_guilds: set[str]
    projected_channels: dict[str, JsonObject]
    message_checkpoints: OrderedDict[int, tuple[UUID, int]]
    last_inbox_sequence: int
    last_sequence: NotRequired[int]
    dropped_through_sequence: NotRequired[int]


class _DiscordGatewaySessionStore:
    """Process-local Resume optimization with a bounded disconnected cache."""

    def __init__(
        self,
        *,
        max_sessions: int,
        ttl_seconds: float,
        now: Callable[[], float] = monotonic,
    ) -> None:
        if max_sessions <= 0 or ttl_seconds <= 0:
            raise ValueError("discord gateway session bounds must be positive")
        self._max_sessions = max_sessions
        self._ttl_seconds = ttl_seconds
        self._now = now
        self._entries: OrderedDict[str, _DiscordGatewaySessionEntry] = OrderedDict()
        self._lock = threading.Lock()

    def put(self, session_id: str, state: _DiscordGatewaySessionState) -> None:
        now = self._now()
        with self._lock:
            self._prune(now)
            self._entries[session_id] = _DiscordGatewaySessionEntry(
                state=state,
                touched_at=now,
                connection_count=1,
            )
            self._entries.move_to_end(session_id)

    def connect(self, session_id: str) -> _DiscordGatewaySessionState | None:
        """Claim a disconnected Resume session for one live connection."""
        now = self._now()
        with self._lock:
            self._prune(now)
            entry = self._entries.get(session_id)
            if entry is None:
                return None
            entry.connection_count += 1
            entry.touched_at = now
            self._entries.move_to_end(session_id)
            return entry.state

    def disconnect(self, session_id: str) -> None:
        now = self._now()
        with self._lock:
            entry = self._entries.get(session_id)
            if entry is None:
                return
            entry.connection_count = max(0, entry.connection_count - 1)
            if entry.connection_count:
                return
            entry.touched_at = now
            self._entries.move_to_end(session_id)
            self._prune(now)
            self._enforce_bound()

    def touch(self, session_id: str) -> bool:
        now = self._now()
        with self._lock:
            self._prune(now)
            entry = self._entries.get(session_id)
            if entry is None:
                return False
            entry.touched_at = now
            self._entries.move_to_end(session_id)
            return True

    def discard(self, session_id: str) -> None:
        with self._lock:
            self._entries.pop(session_id, None)

    def _prune(self, now: float) -> None:
        expired = [
            session_id
            for session_id, entry in self._entries.items()
            if entry.connection_count == 0 and entry.touched_at + self._ttl_seconds <= now
        ]
        for session_id in expired:
            self._entries.pop(session_id, None)

    def _enforce_bound(self) -> None:
        disconnected = sum(entry.connection_count == 0 for entry in self._entries.values())
        if disconnected <= self._max_sessions:
            return
        for session_id, entry in tuple(self._entries.items()):
            if entry.connection_count:
                continue
            self._entries.pop(session_id, None)
            disconnected -= 1
            if disconnected <= self._max_sessions:
                break


_DISCORD_GATEWAY_SESSIONS = _DiscordGatewaySessionStore(
    max_sessions=_DISCORD_GATEWAY_MAX_SESSIONS,
    ttl_seconds=_DISCORD_GATEWAY_SESSION_TTL_SECONDS,
)


class _DiscordCreateMessageParseError(ValueError):
    pass


class _DiscordJsonObject(list[tuple[str, object]]):
    pass


def _discord_gateway_capability(agent: ChannelAgentContext) -> str:
    agent_token_hash = agent.link.agent_token_hash
    if not agent_token_hash or not settings.encryption_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="discord gateway credential unavailable",
        )
    return jwt.encode(
        {
            "sub": _DISCORD_GATEWAY_CAPABILITY_SUBJECT,
            "aud": _DISCORD_GATEWAY_CAPABILITY_AUDIENCE,
            "account_id": str(agent.account.id),
            "link_id": str(agent.link.id),
            "agent_token_hash": agent_token_hash,
        },
        settings.encryption_key,
        algorithm="HS256",
    )


def _decode_discord_gateway_capability(raw: str) -> _DiscordGatewayCapability:
    try:
        payload = _JSON_OBJECT_ADAPTER.validate_python(
            jwt.decode(
                raw,
                settings.encryption_key,
                algorithms=["HS256"],
                audience=_DISCORD_GATEWAY_CAPABILITY_AUDIENCE,
            )
        )
        if payload.get("sub") != _DISCORD_GATEWAY_CAPABILITY_SUBJECT:
            raise ValueError("invalid subject")
        account_id = UUID(str(payload["account_id"]))
        link_id = UUID(str(payload["link_id"]))
        agent_token_hash = payload["agent_token_hash"]
        if not isinstance(agent_token_hash, str) or not agent_token_hash:
            raise ValueError("invalid credential fingerprint")
    except (jwt.PyJWTError, ValidationError, KeyError, TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid discord gateway capability",
        ) from exc
    return _DiscordGatewayCapability(
        account_id=account_id,
        link_id=link_id,
        agent_token_hash=agent_token_hash,
    )


def _discord_gateway_url(agent: ChannelAgentContext) -> str:
    capability = quote(_discord_gateway_capability(agent), safe="")
    return public_ws_url(f"/v1/channels/discord/gateway/{capability}")


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
) -> object:
    agent = await resolve_discord_agent_context(db, authorization)
    account = agent.account
    account_id = account.id
    link_id = agent.link.id
    segments = [segment for segment in discord_path.strip("/").split("/") if segment]
    if segments in (["gateway"], ["gateway", "bot"]):
        return {
            "url": _discord_gateway_url(agent),
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
            params = await request_params(request)
            config = dict(account.config) if isinstance(account.config, dict) else {}
            username = optional_str(params.get("username"))
            if username:
                config["bot_username"] = username
            if "avatar" in params:
                avatar = params.get("avatar")
                if isinstance(avatar, UploadFile):
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="avatar must be a JSON value",
                    )
                config["bot_avatar"] = avatar
            account.config = config
            await db.commit()
        return discord_bot_user(account)
    command_response = await handle_discord_application_commands(
        db,
        agent=agent,
        request=request,
        segments=segments,
    )
    if command_response is not None:
        return command_response
    if segments in (["oauth2", "applications", "@me"], ["applications", "@me"]):
        user = discord_bot_user(account)
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
        raw_body = await request.body()
        content_types = request.headers.getlist("content-type")
        if len(content_types) > 1:
            return _discord_rest_error("Invalid Form Body", 50035, 400)
        content_type = content_types[0] if content_types else "application/json"
        try:
            reference = _discord_create_message_reference(
                raw_body,
                content_type=content_type,
            )
        except _DiscordCreateMessageParseError:
            return _discord_rest_error("Invalid Form Body", 50035, 400)
        try:
            channel_authorization = await _authorize_discord_channel_request(
                db,
                agent=agent,
                channel_id=channel_id,
                request=request,
                original_is_channel_get=False,
            )
        except HTTPException as exc:
            if exc.status_code == status.HTTP_403_FORBIDDEN:
                return _discord_rest_error("Missing Access", 50001, 403)
            raise
        if not await _discord_message_reference_is_authorized(
            db,
            agent=agent,
            binding=channel_authorization.binding,
            reference=reference,
            request=request,
        ):
            return _discord_rest_error("Unknown Message", 10008, 404)
        provider_result = await request_discord_provider(
            account=account,
            method=request.method,
            path=discord_path,
            body=raw_body,
            content_type=content_type,
            query_params=request.query_params,
            request_headers=request.headers,
        )
        if 200 <= provider_result.status_code < 300:
            provider_payload = provider_result.json_object()
            if provider_payload is None:
                log.warning(
                    "discord_outbound_record_skipped_invalid_response account_id=%s "
                    "link_id=%s channel_id=%s",
                    account_id,
                    link_id,
                    channel_id,
                )
            else:
                try:
                    await record_discord_outbound_message(
                        db,
                        account=account,
                        binding=channel_authorization.binding,
                        external_chat_id=channel_id,
                        provider_response=provider_payload,
                    )
                    await db.commit()
                except ValueError:
                    log.warning(
                        "discord_outbound_record_skipped_invalid_metadata account_id=%s "
                        "link_id=%s channel_id=%s",
                        account_id,
                        link_id,
                        channel_id,
                    )
                except Exception:
                    log.exception(
                        "discord_outbound_record_failed account_id=%s link_id=%s channel_id=%s",
                        account_id,
                        link_id,
                        channel_id,
                    )
                    try:
                        await db.rollback()
                    except Exception:
                        log.exception(
                            "discord_outbound_record_rollback_failed account_id=%s "
                            "link_id=%s channel_id=%s",
                            account_id,
                            link_id,
                            channel_id,
                        )
        return provider_result.as_response()
    if segments and segments[0] == "channels" and len(segments) >= 2:
        original_is_channel_get = len(segments) == 2 and request.method == "GET"
        try:
            channel_authorization = await _authorize_discord_channel_request(
                db,
                agent=agent,
                channel_id=segments[1],
                request=request,
                original_is_channel_get=original_is_channel_get,
            )
        except HTTPException as exc:
            if exc.status_code == status.HTTP_403_FORBIDDEN:
                return _discord_rest_error("Missing Access", 50001, 403)
            raise
        if original_is_channel_get and channel_authorization.preflight is not None:
            return channel_authorization.preflight.as_response()
        return await proxy_discord_request(account=account, request=request, path=discord_path)
    if segments and segments[0] == "guilds" and len(segments) >= 2:
        if not await _discord_guild_is_bound(
            db,
            account=account,
            guild_id=segments[1],
            bot_agent_link_id=agent.link.id,
        ):
            return _discord_rest_error("Missing Access", 50001, 403)
        return await proxy_discord_request(account=account, request=request, path=discord_path)
    return _discord_rest_error("Missing Access", 50001, 403)


async def _authorize_discord_channel_request(
    db: AsyncSession,
    *,
    agent: ChannelAgentContext,
    channel_id: str,
    request: Request,
    original_is_channel_get: bool,
) -> _DiscordChannelAuthorization:
    """Resolve a physical Discord channel without making it a Binding.

    Known channel aliases stay local. For an unobserved ID, Discord's own
    Channel object is the authority for ``guild_id`` (threads are channels),
    then the account and AgentLink are revalidated before the alias is cached.
    A Channel without ``guild_id`` can only use a direct DM Binding.
    """
    try:
        binding = await require_bound_chat(
            db,
            account=agent.account,
            external_chat_id=channel_id,
            bot_agent_link_id=agent.link.id,
        )
        return _DiscordChannelAuthorization(binding=binding)
    except HTTPException as exc:
        if exc.status_code != status.HTTP_403_FORBIDDEN:
            raise

    path = f"channels/{channel_id}"
    preflight = await request_discord_provider(
        account=agent.account,
        method="GET",
        path=path,
        query_params=request.query_params if original_is_channel_get else None,
    )
    if preflight.status_code != status.HTTP_200_OK:
        if preflight.status_code in {status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND}:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="channel is not paired",
            )
        retry_after = discord_retry_after_seconds(preflight)
        raise HTTPException(
            status_code=preflight.status_code,
            detail=(
                "discord api temporarily unavailable"
                if preflight.status_code == status.HTTP_429_TOO_MANY_REQUESTS
                or preflight.status_code >= 500
                else "discord channel lookup failed"
            ),
            headers={"Retry-After": str(retry_after)} if retry_after is not None else None,
        )
    payload = preflight.json_object() if preflight.status_code == status.HTTP_200_OK else None
    if payload is None or optional_str(payload.get("id")) != channel_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="channel is not paired")
    guild_id = optional_str(payload.get("guild_id"))
    binding = await _discord_revalidated_channel_binding(
        db,
        agent=agent,
        channel_id=channel_id,
        guild_id=guild_id,
    )
    if binding is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="channel is not paired")
    if guild_id is not None and channel_id != binding.external_chat_id:
        await upsert_binding_alias(
            db,
            binding=binding,
            alias_external_chat_id=channel_id,
            alias_kind="discord_channel",
            require_same_binding=True,
        )
        await db.commit()
    return _DiscordChannelAuthorization(binding=binding, preflight=preflight)


def _discord_create_message_reference(
    body: bytes,
    *,
    content_type: str,
) -> _DiscordMessageReferenceIdentity | None:
    """Extract only Create Message identities while preserving ``body`` unchanged."""
    media_type = _discord_media_type(content_type)
    if media_type == "application/json":
        payload = _discord_json_object(body)
    elif media_type == "multipart/form-data":
        payload = _discord_multipart_payload_json(body, content_type=content_type)
    else:
        raise _DiscordCreateMessageParseError
    reference = _discord_unique_json_member(payload, "message_reference")
    if reference is None:
        return None
    if not isinstance(reference, _DiscordJsonObject):
        raise _DiscordCreateMessageParseError
    return _DiscordMessageReferenceIdentity(
        guild_id=_discord_reference_identity(reference, "guild_id"),
        channel_id=_discord_reference_identity(reference, "channel_id"),
    )


def _discord_media_type(content_type: str) -> str:
    if "\r" in content_type or "\n" in content_type:
        raise _DiscordCreateMessageParseError
    message = Message()
    message["content-type"] = content_type
    return message.get_content_type().lower()


def _discord_json_object(body: bytes) -> _DiscordJsonObject:
    def reject_nonstandard_constant(_value: str) -> None:
        raise ValueError

    try:
        payload = json.loads(
            body.decode("utf-8"),
            object_pairs_hook=_DiscordJsonObject,
            parse_constant=reject_nonstandard_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise _DiscordCreateMessageParseError from exc
    if not isinstance(payload, _DiscordJsonObject):
        raise _DiscordCreateMessageParseError
    return payload


def _discord_unique_json_member(payload: _DiscordJsonObject, name: str) -> object:
    values = [value for key, value in payload if key == name]
    if len(values) > 1:
        raise _DiscordCreateMessageParseError
    return values[0] if values else None


def _discord_reference_identity(reference: _DiscordJsonObject, name: str) -> str | None:
    value = _discord_unique_json_member(reference, name)
    if value is None:
        return None
    identity = optional_str(value) if not isinstance(value, bool) else None
    if identity is None:
        raise _DiscordCreateMessageParseError
    return identity


def _discord_multipart_payload_json(
    body: bytes,
    *,
    content_type: str,
) -> _DiscordJsonObject:
    content_type_message = Message()
    content_type_message["content-type"] = content_type
    content_type_params = (
        content_type_message.get_params(
            header="content-type",
            unquote=True,
        )
        or []
    )
    boundary_params = [
        value for name, value in content_type_params[1:] if name.lower() == "boundary"
    ]
    if len(boundary_params) != 1 or not boundary_params[0]:
        raise _DiscordCreateMessageParseError
    try:
        message = BytesParser(policy=policy.default).parsebytes(
            b"Content-Type: "
            + content_type.encode("ascii")
            + b"\r\nMIME-Version: 1.0\r\n\r\n"
            + body
        )
    except (UnicodeEncodeError, ValueError) as exc:
        raise _DiscordCreateMessageParseError from exc
    if not message.is_multipart() or any(part.defects for part in message.walk()):
        raise _DiscordCreateMessageParseError

    payload_parts: list[Message] = []
    for part in message.iter_parts():
        dispositions = part.get_all("content-disposition", [])
        if len(dispositions) != 1 or part.get_content_disposition() != "form-data":
            raise _DiscordCreateMessageParseError
        disposition_params = (
            part.get_params(
                header="content-disposition",
                unquote=True,
            )
            or []
        )
        names = [value for name, value in disposition_params[1:] if name.lower() == "name"]
        if len(names) != 1 or not names[0]:
            raise _DiscordCreateMessageParseError
        if names[0] == "payload_json":
            payload_parts.append(part)
    if len(payload_parts) > 1:
        raise _DiscordCreateMessageParseError
    if not payload_parts:
        return _DiscordJsonObject()
    payload_part = payload_parts[0]
    if payload_part.is_multipart() or payload_part.get("content-transfer-encoding") is not None:
        raise _DiscordCreateMessageParseError
    payload_body = payload_part.get_payload(decode=True)
    if not isinstance(payload_body, bytes):
        raise _DiscordCreateMessageParseError
    return _discord_json_object(payload_body)


async def _discord_message_reference_is_authorized(
    db: AsyncSession,
    *,
    agent: ChannelAgentContext,
    binding: ChannelBinding,
    reference: _DiscordMessageReferenceIdentity | None,
    request: Request,
) -> bool:
    if reference is None:
        return True
    binding_guild_id = _discord_binding_guild_id(binding)
    if reference.guild_id is not None and reference.guild_id != binding_guild_id:
        return False
    if reference.channel_id is not None:
        try:
            reference_authorization = await _authorize_discord_channel_request(
                db,
                agent=agent,
                channel_id=reference.channel_id,
                request=request,
                original_is_channel_get=False,
            )
        except HTTPException as exc:
            if exc.status_code == status.HTTP_403_FORBIDDEN:
                return False
            raise
        if reference_authorization.binding.id != binding.id:
            return False
    return True


async def _discord_revalidated_channel_binding(
    db: AsyncSession,
    *,
    agent: ChannelAgentContext,
    channel_id: str,
    guild_id: str | None,
) -> ChannelBinding | None:
    agent_token_hash = agent.link.agent_token_hash
    if not agent_token_hash:
        return None
    await resolve_channel_agent_by_identity(
        db,
        provider=CHANNEL_PROVIDER_DISCORD,
        account_id=agent.account.id,
        link_id=agent.link.id,
        agent_token_hash=agent_token_hash,
    )
    result = await db.execute(
        select(ChannelBinding)
        .join(
            ChannelBotAgentLink,
            (ChannelBotAgentLink.id == ChannelBinding.bot_agent_link_id)
            & (ChannelBotAgentLink.account_id == ChannelBinding.account_id)
            & (ChannelBotAgentLink.user_id == ChannelBinding.user_id),
        )
        .where(
            ChannelBinding.account_id == agent.account.id,
            ChannelBinding.bot_agent_link_id == agent.link.id,
            ChannelBinding.status == BINDING_STATUS_ACTIVE,
            ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
            ChannelBotAgentLink.archived_at.is_(None),
        )
    )
    candidates = list(result.scalars().all())
    if guild_id is not None:
        matching = [
            binding for binding in candidates if _discord_binding_guild_id(binding) == guild_id
        ]
    else:
        matching = [
            binding
            for binding in candidates
            if binding.external_chat_id == channel_id
            and _discord_binding_guild_id(binding) is None
            and (binding.external_chat_type or "").lower()
            in {"dm", "direct_messages", "group_dm", "private"}
        ]
    return matching[0] if len(matching) == 1 else None


@router.websocket("/gateway")
@router.websocket("/gateway/")
@router.websocket("/gateway/{path_capability}")
async def discord_agent_gateway(
    websocket: WebSocket,
    path_capability: str | None = None,
) -> None:
    await websocket.accept()
    encoding = websocket.query_params.get("encoding") or "json"
    compress = websocket.query_params.get("compress")
    if encoding != "json" or (compress is not None and compress != "zlib-stream"):
        await websocket.close(code=4012)
        return
    raw_capability = path_capability or websocket.query_params.get("capability")
    authorization = websocket.headers.get("authorization")
    link_token = None
    if authorization:
        scheme, separator, credential = authorization.partition(" ")
        if separator and scheme.lower() == "bearer" and credential and " " not in credential:
            link_token = credential
    try:
        capability = _decode_discord_gateway_capability(raw_capability) if raw_capability else None
    except HTTPException:
        await websocket.close(code=4004)
        return

    compressor = zlib.compressobj(wbits=zlib.MAX_WBITS) if compress == "zlib-stream" else None
    account: ChannelAccount | None = None
    bot_agent_link_id: UUID | None = None
    last_inbox_sequence = 0
    gateway_sequence = 0
    session_id = secrets.token_urlsafe(18)
    session_state: _DiscordGatewaySessionState | None = None
    projected_guilds: set[str] = set()
    projected_channels: dict[str, JsonObject] = {}
    deferred_channels: dict[str, float] = {}
    consumer_lease: AbstractAsyncContextManager[bool] | None = None
    consumer_lease_entered = False
    owns_session_entry = False

    async def send_gateway_frame(
        payload: JsonObject,
        *,
        record: bool = True,
        message_checkpoint: tuple[UUID, int] | None = None,
    ) -> None:
        sequence = payload.get("s")
        if (
            session_state is not None
            and payload.get("op") == 0
            and isinstance(sequence, int)
            and not isinstance(sequence, bool)
        ):
            session_state["last_sequence"] = sequence
            if record:
                frames = session_state["frames"]
                frames.append(payload)
                if message_checkpoint is not None:
                    session_state["message_checkpoints"][sequence] = message_checkpoint
                if len(frames) > _DISCORD_GATEWAY_RESUME_BUFFER_SIZE:
                    dropped = frames[:-_DISCORD_GATEWAY_RESUME_BUFFER_SIZE]
                    del frames[:-_DISCORD_GATEWAY_RESUME_BUFFER_SIZE]
                    dropped_sequence = dropped[-1].get("s")
                    if isinstance(dropped_sequence, int) and not isinstance(dropped_sequence, bool):
                        session_state["dropped_through_sequence"] = dropped_sequence
        if compressor is None:
            await websocket.send_json(payload)
        else:
            raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            await websocket.send_bytes(
                compressor.compress(raw) + compressor.flush(zlib.Z_SYNC_FLUSH)
            )
        if session_state is not None:
            _DISCORD_GATEWAY_SESSIONS.touch(session_id)

    async def send_dispatch(
        event_type: str,
        data: JsonObject,
        *,
        record: bool = True,
        message_checkpoint: tuple[UUID, int] | None = None,
    ) -> int:
        nonlocal gateway_sequence
        gateway_sequence += 1
        await send_gateway_frame(
            {"op": 0, "t": event_type, "s": gateway_sequence, "d": data},
            record=record,
            message_checkpoint=message_checkpoint,
        )
        return gateway_sequence

    async def acknowledge_gateway_sequence(sequence: int | None) -> None:
        if (
            sequence is None
            or sequence < 0
            or session_state is None
            or account is None
            or bot_agent_link_id is None
        ):
            return
        last_sequence = session_state.get("last_sequence", 0)
        if sequence > last_sequence:
            return
        checkpoints = session_state["message_checkpoints"]
        acknowledged_sequences = [
            gateway_sequence for gateway_sequence in checkpoints if gateway_sequence <= sequence
        ]
        message_ids = [
            checkpoint[0]
            for gateway_sequence in acknowledged_sequences
            if (checkpoint := checkpoints.get(gateway_sequence)) is not None
        ]
        if message_ids:
            async with async_session_factory() as db:
                await ack_discord_gateway_messages(
                    db,
                    account_id=account.id,
                    bot_agent_link_id=bot_agent_link_id,
                    message_ids=message_ids,
                )
                await db.commit()
        for gateway_sequence in acknowledged_sequences:
            checkpoints.pop(gateway_sequence, None)

    async def send_guild(guild_id: str, guild_name: str) -> None:
        payload = _discord_guild_create_payload(
            guild_id=guild_id,
            guild_name=guild_name,
            sequence=0,
        )
        data = payload.get("d")
        if not isinstance(data, dict):
            raise RuntimeError("discord guild payload has no dispatch data")
        await send_dispatch("GUILD_CREATE", data)
        projected_guilds.add(guild_id)

    async def send_channel(payload: JsonObject) -> None:
        event_type = _discord_gateway_channel_event(payload)
        data = dict(payload)
        if event_type == "THREAD_CREATE":
            data["newly_created"] = False
        await send_dispatch(event_type, data)

    await send_gateway_frame({"op": 10, "d": {"heartbeat_interval": 45_000}}, record=False)
    try:
        while account is None:
            frame = _JSON_VALUE_ADAPTER.validate_python(await websocket.receive_json())
            if not isinstance(frame, dict):
                continue
            op = frame.get("op")
            if op == 1:
                await send_gateway_frame({"op": 11, "d": None}, record=False)
                continue
            if op not in {2, 6}:
                continue
            data = frame.get("d")
            if not isinstance(data, dict):
                await websocket.close(code=4002)
                return
            token = optional_str(data.get("token"))
            if not token:
                await websocket.close(code=4004)
                return
            async with async_session_factory() as db:
                try:
                    capability_agent = (
                        await resolve_channel_agent_by_identity(
                            db,
                            provider=CHANNEL_PROVIDER_DISCORD,
                            account_id=capability.account_id,
                            link_id=capability.link_id,
                            agent_token_hash=capability.agent_token_hash,
                        )
                        if capability is not None
                        else None
                    )
                    bearer_agent = (
                        await resolve_channel_agent_by_token(
                            db,
                            provider=CHANNEL_PROVIDER_DISCORD,
                            token=link_token,
                        )
                        if link_token is not None
                        else None
                    )
                    if (
                        capability_agent is not None
                        and bearer_agent is not None
                        and (
                            capability_agent.account.id != bearer_agent.account.id
                            or capability_agent.link.id != bearer_agent.link.id
                        )
                    ):
                        raise HTTPException(
                            status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="discord gateway credentials do not match",
                        )
                    resolved_agent = capability_agent or bearer_agent
                    if resolved_agent is None:
                        resolved_agent = await resolve_channel_agent_by_token(
                            db,
                            provider=CHANNEL_PROVIDER_DISCORD,
                            token=token,
                        )
                    else:
                        expected_placeholder = channel_runtime_placeholder_token(
                            CHANNEL_PROVIDER_DISCORD,
                            channel_runtime_account_key(resolved_agent.account.id),
                        )
                        if not secrets.compare_digest(token, expected_placeholder):
                            raise HTTPException(
                                status_code=status.HTTP_401_UNAUTHORIZED,
                                detail="invalid discord gateway placeholder",
                            )
                except HTTPException:
                    if op == 6:
                        await send_gateway_frame({"op": 9, "d": False}, record=False)
                        continue
                    await websocket.close(code=4004)
                    return
                resolved_account = resolved_agent.account
                resolved_link_id = resolved_agent.link.id
            if op == 6:
                resume_session_id = optional_str(data.get("session_id"))
                if resume_session_id is None:
                    await send_gateway_frame({"op": 9, "d": False}, record=False)
                    continue
                resume_state = _DISCORD_GATEWAY_SESSIONS.connect(resume_session_id)
                if resume_state is None:
                    await send_gateway_frame({"op": 9, "d": False}, record=False)
                    continue
                if (
                    resume_state.get("account_id") != resolved_account.id
                    or resume_state.get("bot_agent_link_id") != resolved_link_id
                ):
                    _DISCORD_GATEWAY_SESSIONS.disconnect(resume_session_id)
                    await send_gateway_frame({"op": 9, "d": False}, record=False)
                    continue
                owns_session_entry = True
                consumer_lease = _discord_gateway_consumer_lease(
                    account_id=resolved_account.id,
                    bot_agent_link_id=resolved_link_id,
                )
                lease_acquired = await consumer_lease.__aenter__()
                consumer_lease_entered = True
                if not lease_acquired:
                    await consumer_lease.__aexit__(None, None, None)
                    consumer_lease = None
                    consumer_lease_entered = False
                    _DISCORD_GATEWAY_SESSIONS.disconnect(resume_session_id)
                    owns_session_entry = False
                    await websocket.close(code=4008)
                    return
                account = resolved_account
                bot_agent_link_id = resolved_link_id
                session_id = resume_session_id
                session_state = resume_state
                resume_sequence = optional_int_param(data.get("seq"))
                frames = session_state["frames"]
                latest_sequence = max(
                    max(
                        (
                            sequence
                            for retained in frames
                            if isinstance((sequence := retained.get("s")), int)
                            and not isinstance(sequence, bool)
                        ),
                        default=0,
                    ),
                    session_state.get("last_sequence", 0),
                )
                dropped_through_sequence = session_state.get("dropped_through_sequence")
                if (
                    resume_sequence is None
                    or resume_sequence < 0
                    or resume_sequence > latest_sequence
                    or session_state.get("identified") is not True
                    or (
                        isinstance(dropped_through_sequence, int)
                        and resume_sequence < dropped_through_sequence
                    )
                ):
                    await send_gateway_frame({"op": 9, "d": False}, record=False)
                    _DISCORD_GATEWAY_SESSIONS.discard(session_id)
                    await consumer_lease.__aexit__(None, None, None)
                    consumer_lease = None
                    consumer_lease_entered = False
                    account = None
                    bot_agent_link_id = None
                    session_state = None
                    owns_session_entry = False
                    session_id = secrets.token_urlsafe(18)
                    continue
                await acknowledge_gateway_sequence(resume_sequence)
                gateway_sequence = latest_sequence
                last_inbox_sequence = max(
                    (
                        session_state["last_inbox_sequence"],
                        *(
                            checkpoint[1]
                            for checkpoint in session_state["message_checkpoints"].values()
                        ),
                    )
                )
                projected_guilds.update(session_state["projected_guilds"])
                projected_channels.update(session_state["projected_channels"])
                async with async_session_factory() as db:
                    resume_guilds, resume_channels = await _discord_gateway_authority(
                        db,
                        account=account,
                        bot_agent_link_id=bot_agent_link_id,
                    )
                projected_guilds.intersection_update(resume_guilds)
                for projected_channel_id in set(projected_channels) - set(resume_channels):
                    projected_channels.pop(projected_channel_id, None)
                for retained in frames:
                    retained_event_type = retained.get("t")
                    event_data = retained.get("d")
                    if not isinstance(event_data, dict):
                        continue
                    if retained_event_type == "READY":
                        private_channels = event_data.get("private_channels")
                        if not isinstance(private_channels, list):
                            continue
                        for private in private_channels:
                            if not isinstance(private, dict):
                                continue
                            private_id = optional_str(private.get("id"))
                            if private_id in resume_channels:
                                projected_channels[private_id] = private
                    elif retained_event_type == "GUILD_CREATE":
                        retained_guild_id = optional_str(event_data.get("id"))
                        if retained_guild_id in resume_guilds:
                            projected_guilds.add(retained_guild_id)
                    elif retained_event_type == "GUILD_DELETE":
                        projected_guilds.discard(optional_str(event_data.get("id")) or "")
                    elif retained_event_type in {
                        "CHANNEL_CREATE",
                        "CHANNEL_UPDATE",
                        "THREAD_CREATE",
                        "THREAD_UPDATE",
                    }:
                        retained_channel_id = optional_str(event_data.get("id"))
                        if retained_channel_id in resume_channels:
                            thread_metadata = event_data.get("thread_metadata")
                            if (
                                retained_event_type == "THREAD_UPDATE"
                                and isinstance(thread_metadata, dict)
                                and thread_metadata.get("archived") is True
                            ):
                                projected_channels.pop(retained_channel_id, None)
                            else:
                                projected_channels[retained_channel_id] = event_data
                    elif retained_event_type in {"CHANNEL_DELETE", "THREAD_DELETE"}:
                        projected_channels.pop(optional_str(event_data.get("id")) or "", None)
                for replayed in frames:
                    replayed_sequence = replayed.get("s")
                    if not isinstance(replayed_sequence, int) or isinstance(
                        replayed_sequence, bool
                    ):
                        continue
                    if replayed_sequence <= resume_sequence:
                        continue
                    await send_gateway_frame(replayed, record=False)
                session_state["projected_guilds"] = projected_guilds
                session_state["projected_channels"] = projected_channels
                await send_dispatch("RESUMED", {}, record=False)
            else:
                consumer_lease = _discord_gateway_consumer_lease(
                    account_id=resolved_account.id,
                    bot_agent_link_id=resolved_link_id,
                )
                lease_acquired = await consumer_lease.__aenter__()
                consumer_lease_entered = True
                if not lease_acquired:
                    await consumer_lease.__aexit__(None, None, None)
                    consumer_lease = None
                    consumer_lease_entered = False
                    await websocket.close(code=4008)
                    return
                account = resolved_account
                bot_agent_link_id = resolved_link_id
                owns_session_entry = True
                last_inbox_sequence = 0
                session_state = {
                    "account_id": account.id,
                    "bot_agent_link_id": bot_agent_link_id,
                    "frames": [],
                    "identified": True,
                    "projected_guilds": projected_guilds,
                    "projected_channels": projected_channels,
                    "message_checkpoints": OrderedDict(),
                    "last_inbox_sequence": 0,
                }
                _DISCORD_GATEWAY_SESSIONS.put(session_id, session_state)
                async with async_session_factory() as db:
                    guilds, channels = await _discord_gateway_authority(
                        db,
                        account=account,
                        bot_agent_link_id=bot_agent_link_id,
                    )
                for channel_id, guild_id in channels.items():
                    try:
                        result = await request_discord_provider(
                            account=account,
                            method="GET",
                            path=f"channels/{channel_id}",
                        )
                    except HTTPException:
                        continue
                    channel = _discord_gateway_channel(
                        result,
                        channel_id=channel_id,
                        guild_id=guild_id,
                    )
                    if channel is not None:
                        projected_channels[channel_id] = channel
                await send_dispatch(
                    "READY",
                    {
                        "v": 10,
                        "session_id": session_id,
                        "resume_gateway_url": (
                            _discord_gateway_url(resolved_agent)
                            if capability is not None
                            else (
                                settings.channel_discord_gateway_url.strip().rstrip("/")
                                if link_token is not None
                                else public_ws_url("/v1/channels/discord/gateway")
                            )
                        ),
                        "user": discord_bot_user(account),
                        "application": {"id": discord_application_id(account)},
                        "guilds": [{"id": guild_id, "unavailable": False} for guild_id in guilds],
                        "private_channels": [
                            payload
                            for channel_id, payload in projected_channels.items()
                            if channels.get(channel_id) is None
                        ],
                    },
                )
                for guild_id, guild_name in guilds.items():
                    await send_guild(guild_id, guild_name)
                for channel_id, channel in projected_channels.items():
                    if channels.get(channel_id) is not None:
                        await send_channel(channel)

        if bot_agent_link_id is None:
            await websocket.close(code=4004)
            return
        active_link_id = bot_agent_link_id

        while True:
            checkpoints = (
                session_state.get("message_checkpoints") if session_state is not None else None
            )
            checkpoint_count = len(checkpoints) if isinstance(checkpoints, OrderedDict) else 0
            events: list[ChannelMessage] = []
            if checkpoint_count < _DISCORD_GATEWAY_RESUME_BUFFER_SIZE:
                async with async_session_factory() as db:
                    events = await dequeue_discord_gateway_events(
                        db,
                        account=account,
                        bot_agent_link_id=active_link_id,
                        after_sequence=last_inbox_sequence,
                        limit=_DISCORD_GATEWAY_RESUME_BUFFER_SIZE - checkpoint_count,
                    )
            if events:
                for message in events:
                    payload = discord_gateway_dispatch(message)
                    guild_id, channel_id = _discord_gateway_scope(payload)
                    async with async_session_factory() as db:
                        guilds, channels = await _discord_gateway_authority(
                            db,
                            account=account,
                            bot_agent_link_id=active_link_id,
                            priority_channel_id=channel_id,
                        )
                    for removed_guild_id in projected_guilds - set(guilds):
                        await send_dispatch(
                            "GUILD_DELETE",
                            {"id": removed_guild_id, "unavailable": False},
                        )
                        projected_guilds.discard(removed_guild_id)
                        for projected_id, projected in list(projected_channels.items()):
                            if optional_str(projected.get("guild_id")) == removed_guild_id:
                                projected_channels.pop(projected_id, None)
                    for removed_channel_id in set(projected_channels) - set(channels):
                        projected_channels.pop(removed_channel_id, None)
                    for removed_channel_id in set(deferred_channels) - set(channels):
                        deferred_channels.pop(removed_channel_id, None)
                    event_type = optional_str(payload.get("t"))
                    lifecycle = bool(
                        event_type and event_type.startswith(("GUILD_", "CHANNEL_", "THREAD_"))
                    )
                    authorized = (
                        guild_id in guilds
                        if lifecycle and guild_id is not None
                        else channel_id in channels and channels[channel_id] == guild_id
                    )
                    projected = (
                        projected_channels.get(channel_id) if channel_id is not None else None
                    )
                    if authorized and not lifecycle and channel_id is not None:
                        if projected is None:
                            retry_at = deferred_channels.get(channel_id, 0.0)
                            if monotonic() < retry_at:
                                break
                            result: DiscordProviderResult | None = None
                            try:
                                result = await request_discord_provider(
                                    account=account,
                                    method="GET",
                                    path=f"channels/{channel_id}",
                                )
                            except HTTPException as exc:
                                if exc.status_code == status.HTTP_429_TOO_MANY_REQUESTS:
                                    retry_after = discord_retry_after_seconds(
                                        DiscordProviderResult(
                                            content=b"",
                                            status_code=exc.status_code,
                                            media_type="application/json",
                                            headers=dict(exc.headers or {}),
                                        )
                                    )
                                    deferred_channels[channel_id] = monotonic() + (
                                        retry_after if retry_after is not None else 1.0
                                    )
                                    break
                                if exc.status_code >= 500:
                                    deferred_channels[channel_id] = monotonic() + 1.0
                                    break
                            if (
                                result is not None
                                and result.status_code == status.HTTP_429_TOO_MANY_REQUESTS
                            ):
                                retry_after = discord_retry_after_seconds(result)
                                deferred_channels[channel_id] = monotonic() + (
                                    retry_after if retry_after is not None else 1.0
                                )
                                break
                            if result is not None and result.status_code >= 500:
                                deferred_channels[channel_id] = monotonic() + 1.0
                                break
                            projected = (
                                _discord_gateway_channel(
                                    result,
                                    channel_id=channel_id,
                                    guild_id=guild_id,
                                )
                                if result is not None
                                else None
                            )
                            if projected is not None:
                                deferred_channels.pop(channel_id, None)

                    async def send_message() -> int:
                        if guild_id is not None and guild_id not in projected_guilds:
                            await send_guild(guild_id, guilds[guild_id])
                        if channel_id is not None and projected is not None:
                            if channel_id not in projected_channels:
                                await send_channel(projected)
                            projected_channels[channel_id] = projected
                        data = payload.get("d")
                        if event_type is not None and isinstance(data, dict):
                            return await send_dispatch(
                                event_type,
                                data,
                                message_checkpoint=(
                                    message.id,
                                    int(message.inbox_sequence),
                                ),
                            )
                        raise RuntimeError("discord gateway message has no dispatch payload")

                    sent, _dispatched_sequence = await _send_discord_gateway_message(
                        account_id=account.id,
                        bot_agent_link_id=active_link_id,
                        message=message,
                        send=(
                            send_message
                            if authorized and (lifecycle or projected is not None)
                            else None
                        ),
                    )
                    last_inbox_sequence = int(message.inbox_sequence)
                    if session_state is not None:
                        session_state["last_inbox_sequence"] = last_inbox_sequence
                    if sent == "sent" and lifecycle and channel_id is not None:
                        data = payload.get("d")
                        if event_type in {"CHANNEL_DELETE", "THREAD_DELETE"}:
                            projected_channels.pop(channel_id, None)
                        elif isinstance(data, dict) and channels.get(channel_id) == guild_id:
                            thread_metadata = data.get("thread_metadata")
                            if (
                                event_type == "THREAD_UPDATE"
                                and isinstance(thread_metadata, dict)
                                and thread_metadata.get("archived") is True
                            ):
                                projected_channels.pop(channel_id, None)
                            else:
                                projected_channels[channel_id] = dict(data)
                else:
                    continue

            try:
                frame = _JSON_VALUE_ADAPTER.validate_python(
                    await asyncio.wait_for(
                        websocket.receive_json(),
                        timeout=max(0.001, settings.discord_gateway_poll_interval_seconds),
                    )
                )
                if isinstance(frame, dict) and frame.get("op") == 1:
                    await acknowledge_gateway_sequence(optional_int_param(frame.get("d")))
                    await send_gateway_frame({"op": 11, "d": None}, record=False)
            except TimeoutError:
                pass
    except WebSocketDisconnect:
        return
    finally:
        if consumer_lease is not None and consumer_lease_entered:
            await consumer_lease.__aexit__(None, None, None)
        if owns_session_entry:
            _DISCORD_GATEWAY_SESSIONS.disconnect(session_id)


@router.post(
    "/{account_id}/webhook",
    include_in_schema=False,
    response_model=None,
)
async def discord_webhook(
    account_id: UUID,
    request: Request,
    background_tasks: BackgroundTasks,
    x_clawdi_channel_secret: str | None = Header(default=None),
    x_signature_ed25519: str | None = Header(default=None),
    x_signature_timestamp: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
) -> JsonObject | Response:
    account = await get_active_channel_account(db, account_id=account_id)
    if account.provider != CHANNEL_PROVIDER_DISCORD:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="channel not found")
    body = await request.body()
    signature_verified = verify_discord_signature(
        account=account,
        body=body,
        signature=x_signature_ed25519,
        timestamp=x_signature_timestamp,
    )
    if not (
        verify_webhook_secret(x_clawdi_channel_secret, account.webhook_secret_hash)
        or signature_verified
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid webhook secret",
        )
    payload = json_object_from_bytes(body)
    if payload.get("type") == 1:
        return {"type": 1}

    chat = discord_chat_from_payload(payload)
    if chat is None:
        if payload.get("type") == 4:
            return {"type": 8, "data": {"choices": []}}
        if payload.get("type") in {2, 3, 5}:
            return {
                "type": 4,
                "data": {
                    "content": "Discord could not route this interaction.",
                    "flags": 64,
                },
            }
        return {"ok": True}
    external_chat_id, external_chat_type, external_chat_name = chat
    command = discord_control_command_from_payload(payload)
    channel_id, guild_id = discord_channel_scope_from_payload(payload)
    provider_event_id = discord_message_id_from_payload(payload)
    if await channel_control_command_event_was_handled(
        db,
        account=account,
        external_chat_id=external_chat_id,
        provider_event_id=provider_event_id,
        command=command,
    ):
        if payload.get("type") == 2:
            return {
                "type": 4,
                "data": {
                    "content": "This interaction was already handled.",
                    "flags": 64,
                },
            }
        return {"ok": True}
    external_user_id = discord_external_user_id_from_payload(payload)
    trusted_dm_name = (
        discord_user_display_name_from_payload(
            payload,
            external_user_id=external_user_id,
        )
        if signature_verified and guild_id is None
        else None
    )
    if trusted_dm_name is not None:
        external_chat_name = trusted_dm_name
    admission = await discord_control_command_admission(
        account,
        payload,
        command=command,
        guild_id=guild_id,
        external_user_id=external_user_id,
        trusted_interaction=signature_verified,
    )
    if admission.external_chat_name is not None:
        external_chat_name = admission.external_chat_name
    binding_result = await resolve_inbound_binding(
        db,
        account=account,
        external_chat_id=external_chat_id,
        external_chat_type=external_chat_type,
        external_chat_name=external_chat_name,
        external_user_id=external_user_id,
        text=discord_text_from_payload(payload),
        command=command,
        command_denied_reason=admission.denied_reason,
        command_actor_required=True,
    )
    if signature_verified and guild_id is None:
        for binding in binding_result.bindings:
            update_discord_binding_display_name_from_trusted_event(
                binding,
                external_chat_id=external_chat_id,
                external_chat_type=external_chat_type,
                external_chat_name=trusted_dm_name,
                external_user_id=external_user_id,
            )

    messages = await record_inbound_messages_for_bindings(
        db,
        account=account,
        binding_result=binding_result,
        external_chat_id=external_chat_id,
        provider_message_id=provider_event_id,
        text=discord_text_from_payload(payload),
        payload=payload,
    )
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
                require_same_binding=True,
            )
        await record_discord_interaction_references(
            db,
            account=account,
            binding=binding,
            message=message,
            payload=payload,
        )
        await record_inactive_bot_agent_link_event(db, account=account, binding=binding)
    await db.commit()
    message = messages[0][0] if messages else None
    reply_text = discord_control_reply_for_command(command, binding_result, guild_id=guild_id)
    if (
        command is None
        and binding_result.binding is not None
        and payload.get("type") in {2, 3, 4, 5}
    ):
        # The bound Agent receives this interaction over Clawdi's synthetic
        # Gateway and responds through the proxied interaction callback. For
        # interactions received over HTTP, Discord requires this original
        # request to be released with 202 and no body when that separate
        # callback path is used.
        # https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-callback
        return Response(status_code=status.HTTP_202_ACCEPTED)
    if command is None and payload.get("type") == 4:
        return {"type": 8, "data": {"choices": []}}
    if command is None and payload.get("type") in {2, 3, 5}:
        scope = "server" if guild_id is not None else "direct message"
        return {
            "type": 4,
            "data": {
                "content": f"This {scope} is not paired.",
                "flags": 64,
            },
        }
    if payload.get("type") == 2:
        if binding_result.paired and binding_result.binding is not None and guild_id is not None:
            # Discord interactions have a short acknowledgement deadline. The
            # binding commit is authoritative; replay the already-shadowed
            # Agent commands once after the interaction response is available.
            background_tasks.add_task(
                _replay_discord_commands_for_paired_guild,
                account_id=account.id,
                bot_agent_link_id=binding_result.binding.bot_agent_link_id,
                guild_id=guild_id,
            )
        if binding_result.unpaired and guild_id is not None and binding_result.bindings:
            background_tasks.add_task(
                cleanup_discord_guild_commands_after_authority_revoked,
                account_id=account.id,
                bot_agent_link_id=binding_result.bindings[0].bot_agent_link_id,
                guild_ids={guild_id},
            )
        return {
            "type": 4,
            "data": {
                "content": discord_interaction_content(
                    command=command,
                    paired=binding_result.paired,
                    unpaired=binding_result.unpaired,
                    reply=reply_text,
                ),
                "flags": 64,
            },
        }
    await _replay_discord_commands_on_pair(
        db,
        account=account,
        link=(
            await db.get(ChannelBotAgentLink, binding_result.binding.bot_agent_link_id)
            if binding_result.binding is not None
            else None
        ),
        application_id=discord_application_id(account),
        guild_id=guild_id,
        paired=binding_result.paired,
    )
    reply = await send_control_command_reply(
        db,
        account=account,
        external_chat_id=external_chat_id,
        send_external_chat_id=channel_id,
        command=command,
        binding_result=binding_result,
        reply=reply_text,
    )
    if reply is not None:
        await db.commit()
    return {
        "ok": True,
        "paired": binding_result.paired,
        "unpaired": binding_result.unpaired,
        "binding_id": (
            str(message.binding_id) if message is not None and message.binding_id else None
        ),
    }


async def _replay_discord_commands_on_pair(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    link: ChannelBotAgentLink | None,
    application_id: str,
    guild_id: str | None,
    paired: bool,
) -> None:
    if (
        not paired
        or guild_id is None
        or link is None
        or link.account_id != account.id
        or link.status != BOT_AGENT_LINK_STATUS_ACTIVE
        or link.archived_at is not None
    ):
        return
    config = link.config if isinstance(link.config, dict) else {}
    shadow = config.get("discord_agent_commands")
    if not isinstance(shadow, dict):
        return
    commands = shadow.get("global")
    if not isinstance(commands, list):
        return
    try:
        await fan_out_discord_global_commands(
            db,
            account=account,
            bot_agent_link_id=link.id,
            application_id=application_id,
            commands=[command for command in commands if isinstance(command, dict)],
            guild_ids={guild_id},
            force=True,
        )
    except HTTPException:
        return


async def _replay_discord_commands_for_paired_guild(
    *,
    account_id: UUID,
    bot_agent_link_id: UUID,
    guild_id: str,
) -> None:
    try:
        async with async_session_factory() as db:
            account = await get_active_channel_account(db, account_id=account_id)
            link = await db.get(ChannelBotAgentLink, bot_agent_link_id)
            await _replay_discord_commands_on_pair(
                db,
                account=account,
                link=link,
                application_id=discord_application_id(account),
                guild_id=guild_id,
                paired=True,
            )
    except (HTTPException, SQLAlchemyError):
        # The interaction has already acknowledged a durable pairing. Command
        # fan-out is best effort and must not turn a provider/DB retry into an
        # unhandled background-task failure.
        log.exception(
            "discord_command_replay_failed account_id=%s guild_id=%s",
            account_id,
            guild_id,
        )


async def cleanup_discord_guild_commands_after_authority_revoked(
    *,
    account_id: UUID,
    bot_agent_link_id: UUID,
    guild_ids: set[str],
) -> bool:
    """Durably reconcile Guild command cleanup after authority revocation."""
    try:
        async with async_session_factory() as db:
            account = await get_active_channel_account(db, account_id=account_id)
            link = await db.get(ChannelBotAgentLink, bot_agent_link_id)
            if link is None or link.account_id != account.id:
                return False
            return await clear_discord_guild_commands(
                db,
                account=account,
                link=link,
                application_id=discord_application_id(account),
                guild_ids=guild_ids,
            )
    except (HTTPException, SQLAlchemyError):
        log.exception(
            "discord_command_cleanup_setup_failed account_id=%s link_id=%s",
            account_id,
            bot_agent_link_id,
        )
        return False


async def _handle_discord_interaction_callback(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID,
    request: Request,
    path: str,
    segments: list[str],
) -> object:
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
    return await proxy_discord_request(account=account, request=request, path=path)


async def _handle_discord_webhook_followup(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID,
    request: Request,
    path: str,
    segments: list[str],
) -> object:
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
    return await proxy_discord_request(account=account, request=request, path=path)


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


def _discord_binding_guild_id(binding: ChannelBinding) -> str | None:
    chat_type = (binding.external_chat_type or "").lower()
    if binding.external_chat_id and chat_type == "guild":
        return binding.external_chat_id
    if binding.external_chat_name and ("guild" in chat_type or "thread" in chat_type):
        return binding.external_chat_name
    if binding.external_chat_id and ("guild" in chat_type or "thread" in chat_type):
        return binding.external_chat_id
    return None


async def _discord_gateway_authority(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID,
    priority_channel_id: str | None = None,
) -> tuple[dict[str, str], dict[str, str | None]]:
    priority = (ChannelBindingAlias.alias_external_chat_id == priority_channel_id) | (
        ChannelBinding.external_chat_id == priority_channel_id
    )
    rows = (
        await db.execute(
            select(ChannelBinding, ChannelBindingAlias)
            .join(ChannelAccount, ChannelAccount.id == ChannelBinding.account_id)
            .join(ChannelBotAgentLink, ChannelBotAgentLink.id == ChannelBinding.bot_agent_link_id)
            .outerjoin(
                ChannelBindingAlias,
                and_(
                    ChannelBindingAlias.binding_id == ChannelBinding.id,
                    ChannelBindingAlias.account_id == account.id,
                    ChannelBindingAlias.bot_agent_link_id == bot_agent_link_id,
                    ChannelBindingAlias.alias_kind == "discord_channel",
                ),
            )
            .where(
                ChannelBinding.account_id == account.id,
                ChannelBinding.bot_agent_link_id == bot_agent_link_id,
                ChannelBinding.status == BINDING_STATUS_ACTIVE,
                ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
                ChannelAccount.archived_at.is_(None),
                ChannelBotAgentLink.account_id == account.id,
                ChannelBotAgentLink.user_id == ChannelBinding.user_id,
                ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
                ChannelBotAgentLink.archived_at.is_(None),
            )
            .order_by(priority.desc(), ChannelBindingAlias.updated_at.desc())
            .limit(_DISCORD_GATEWAY_MAX_CHANNELS)
        )
    ).all()
    guilds: dict[str, str] = {}
    channels: dict[str, str | None] = {}
    for binding, alias in rows:
        guild_id = _discord_binding_guild_id(binding)
        if guild_id is not None:
            guilds[guild_id] = binding.external_chat_name or guild_id
            if alias is not None:
                channels[alias.alias_external_chat_id] = guild_id
        elif (binding.external_chat_type or "").lower() in {
            "dm",
            "direct_messages",
            "group_dm",
            "private",
        }:
            channels[binding.external_chat_id] = None
    return guilds, channels


def _discord_gateway_channel(
    result: DiscordProviderResult,
    *,
    channel_id: str,
    guild_id: str | None,
) -> JsonObject | None:
    payload = result.json_object() if result.status_code == status.HTTP_200_OK else None
    channel_type = payload.get("type") if payload is not None else None
    if (
        payload is None
        or optional_str(payload.get("id")) != channel_id
        or isinstance(channel_type, bool)
        or not isinstance(channel_type, int)
    ):
        return None
    payload_guild_id = optional_str(payload.get("guild_id"))
    if (guild_id is None and (payload_guild_id is not None or channel_type not in {1, 3})) or (
        guild_id is not None and (payload_guild_id != guild_id or channel_type in {1, 3})
    ):
        return None
    return dict(payload)


def _discord_gateway_channel_event(payload: JsonObject) -> str:
    return "THREAD_CREATE" if payload.get("type") in {10, 11, 12} else "CHANNEL_CREATE"


def _discord_guild_create_payload(
    *,
    guild_id: str,
    guild_name: str,
    sequence: int,
) -> JsonObject:
    return {
        "op": 0,
        "t": "GUILD_CREATE",
        "s": sequence,
        "d": {
            "id": guild_id,
            "name": guild_name,
            "unavailable": False,
            "channels": [],
            "threads": [],
            "members": [],
        },
    }


def _discord_gateway_scope(payload: JsonObject) -> tuple[str | None, str | None]:
    data = payload.get("d")
    if not isinstance(data, dict):
        return None, None
    event_type = optional_str(payload.get("t"))
    guild_id = optional_str(data.get("guild_id"))
    channel_id = optional_str(data.get("channel_id"))
    if event_type and event_type.startswith("GUILD_"):
        guild_id = optional_str(data.get("id")) or guild_id
    elif event_type and event_type.startswith(("CHANNEL_", "THREAD_")):
        channel_id = optional_str(data.get("id")) or channel_id
    return guild_id, channel_id


async def _send_discord_gateway_message(
    *,
    account_id: UUID,
    bot_agent_link_id: UUID,
    message: ChannelMessage,
    send: Callable[[], Awaitable[int]] | None,
) -> tuple[str, int | None]:
    if message.binding_id is None:
        return "dropped", None
    async with async_session_factory() as db:
        binding = await lock_active_discord_binding_lease(
            db,
            account_id=account_id,
            bot_agent_link_id=bot_agent_link_id,
            binding_id=message.binding_id,
            external_chat_id=message.external_chat_id,
        )
        current = (
            await db.execute(
                select(ChannelMessage)
                .where(
                    ChannelMessage.id == message.id,
                    ChannelMessage.account_id == account_id,
                    ChannelMessage.bot_agent_link_id == bot_agent_link_id,
                )
                .with_for_update(of=ChannelMessage, skip_locked=True)
            )
        ).scalar_one_or_none()
        if current is None or current.delivered_at is not None:
            return "consumed", None
        if binding is not None and send is not None:
            dispatched_sequence = await send()
            # The downstream heartbeat/Resume sequence, not socket.send(), is
            # the durable receipt acknowledgement for synthetic Gateway data.
            await db.commit()
            return "sent", dispatched_sequence
        current.delivered_at = datetime.now(UTC)
        await db.commit()
        return "dropped", None


@asynccontextmanager
async def _discord_gateway_consumer_lease(
    *,
    account_id: UUID,
    bot_agent_link_id: UUID,
    lock_engine: AsyncEngine | None = None,
    liveness_interval_seconds: float | None = None,
):
    """Allow one synthetic shard consumer per AgentLink across processes."""
    connection = await (lock_engine or database_engine).connect()
    acquired = False
    lock_key: int | None = None
    safe_to_pool = False
    monitor_failure: Exception | None = None
    body_error: BaseException | None = None
    cleanup_error: BaseException | None = None
    monitor_stop = asyncio.Event()
    monitor_task: asyncio.Task[None] | None = None
    owner_task = asyncio.current_task()
    if owner_task is None:
        await connection.close()
        raise RuntimeError("discord gateway consumer lease requires an asyncio task")
    lock_name = f"discord-agent-gateway:{account_id}:{bot_agent_link_id}"

    async def monitor_connection() -> None:
        nonlocal monitor_failure
        interval = max(
            0.001,
            liveness_interval_seconds
            if liveness_interval_seconds is not None
            else settings.discord_gateway_poll_interval_seconds,
        )
        try:
            while True:
                try:
                    await asyncio.wait_for(monitor_stop.wait(), timeout=interval)
                    return
                except TimeoutError:
                    await connection.execute(text("SELECT 1"))
                    await connection.commit()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            monitor_failure = exc
            owner_task.cancel()

    try:
        await connection.execution_options(isolation_level="AUTOCOMMIT")
        # Keep the transaction-level lease identity used by older rolling-deploy peers.
        lock_key_result = await connection.execute(
            text("SELECT hashtextextended(:lock_name, 0)"),
            {"lock_name": lock_name},
        )
        await connection.commit()
        resolved_lock_key = lock_key_result.scalar_one()
        if not isinstance(resolved_lock_key, int) or isinstance(resolved_lock_key, bool):
            raise RuntimeError("discord gateway consumer advisory lock key is invalid")
        lock_key = resolved_lock_key
        acquired = await try_advisory_lock(connection, lock_key)
        safe_to_pool = not acquired
        if acquired:
            monitor_task = asyncio.create_task(
                monitor_connection(),
                name=f"discord-gateway-consumer-lease-{bot_agent_link_id}",
            )
        try:
            yield acquired
        except BaseException as exc:
            body_error = exc
    finally:
        monitor_stop.set()
        try:
            if monitor_task is not None:
                await monitor_task
            if acquired:
                if lock_key is None:
                    raise RuntimeError("discord gateway consumer advisory lock key is missing")
                if not await release_advisory_lock(connection, lock_key):
                    raise RuntimeError("discord gateway consumer advisory unlock failed")
                safe_to_pool = True
        except BaseException as exc:
            cleanup_error = exc
        finally:
            try:
                if not safe_to_pool:
                    await connection.invalidate()
            finally:
                await connection.close()

    if monitor_failure is not None:
        raise _DiscordGatewayConsumerLeaseLost(
            "discord gateway consumer lease connection lost"
        ) from monitor_failure
    if cleanup_error is not None:
        raise cleanup_error
    if body_error is not None:
        raise body_error
