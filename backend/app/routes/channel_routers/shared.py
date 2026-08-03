from __future__ import annotations

import asyncio
import hashlib
import json
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import httpx
from fastapi import (
    HTTPException,
    Request,
    Response,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.channel import (
    BINDING_STATUS_ACTIVE,
    BOT_AGENT_LINK_STATUS_ACTIVE,
    CHANNEL_PROVIDER_DISCORD,
    CHANNEL_VISIBILITY_PRIVATE,
    CHANNEL_VISIBILITY_PUBLIC,
    ChannelAccount,
    ChannelBinding,
    ChannelBindingAlias,
    ChannelBotAgentLink,
)
from app.schemas.channel import (
    ChannelAccountResponse,
    ChannelBindingResponse,
    ChannelMessageResponse,
    ChannelVisibility,
)
from app.services.channel_webhooks import (
    deliver_telegram_agent_webhook,
    telegram_link_webhook_config,
    telegram_link_webhook_url,
    validate_agent_webhook_url,
)
from app.services.channels import (
    DISCORD_RESERVED_COMMAND_NAMES,
    ChannelAgentContext,
    channel_webhook_url,
    decrypt_provider_token,
    find_binding,
    resolve_channel_agent_by_token,
)
from app.services.discord_rate_limiter import discord_rate_limiter
from app.services.metrics import (
    outbound_errors,
    outbound_messages,
    rate_limit_rejects,
    track_proxy_latency,
)
from app.services.url_security import UnsafeOutboundUrlError, validate_channel_http_url

# Discord API docs baseline 07c83a8f1c54accd8e8d13072a5e08d1b1be7ac3.
# Keep both directions explicit: runtime credentials and hop-by-hop headers
# never cross into Discord, while documented rate-limit state remains usable.
_DISCORD_REQUEST_HEADER_ALLOWLIST = ("x-audit-log-reason",)
_DISCORD_RESPONSE_HEADER_ALLOWLIST = (
    "cache-control",
    "cf-ray",
    "etag",
    "last-modified",
    "retry-after",
    "x-correlation-id",
    "x-ratelimit-bucket",
    "x-ratelimit-global",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "x-ratelimit-reset-after",
    "x-ratelimit-scope",
    "x-request-id",
)
_DISCORD_AGENT_COMMANDS_CONFIG_KEY = "discord_agent_commands"
_DISCORD_COMMAND_MATERIALIZATIONS_CONFIG_KEY = "discord_command_materializations"
_DISCORD_COMMAND_RETRIES_CONFIG_KEY = "discord_command_retries"


def _channel_visibility(account: ChannelAccount) -> ChannelVisibility:
    if account.visibility == CHANNEL_VISIBILITY_PRIVATE:
        return "private"
    if account.visibility == CHANNEL_VISIBILITY_PUBLIC:
        return "public"
    raise ValueError("invalid channel account visibility")


def _account_response(account: ChannelAccount) -> ChannelAccountResponse:
    return ChannelAccountResponse(
        id=account.id,
        provider=account.provider,
        name=account.name,
        status=account.status,
        visibility=_channel_visibility(account),
        has_provider_token=bool(account.encrypted_provider_token and account.provider_token_nonce),
        webhook_url=channel_webhook_url(account.id, account.provider),
        created_at=account.created_at,
    )


async def _request_payload(request: Request) -> Any:
    if request.method == "GET":
        return dict(request.query_params)
    content_type = request.headers.get("content-type", "").lower()
    if "application/x-www-form-urlencoded" in content_type or "multipart/form-data" in content_type:
        form = await request.form()
        return {key: _parse_wire_value(value) for key, value in form.multi_items()}
    body = await request.body()
    if not body:
        return {}
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid json") from exc
    return payload


async def _request_params(request: Request) -> dict[str, Any]:
    payload = await _request_payload(request)
    if not isinstance(payload, dict):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="json object required")
    return payload


def _parse_wire_value(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    trimmed = value.strip()
    if trimmed in {"true", "false"}:
        return trimmed == "true"
    if trimmed.startswith(("{", "[")):
        try:
            return json.loads(trimmed)
        except json.JSONDecodeError:
            return value
    return value


def _required_str_param(params: dict[str, Any], key: str) -> str:
    value = _optional_str(params.get(key))
    if value is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"{key} is required")
    return value


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    if isinstance(value, int):
        return str(value)
    return None


def _optional_int_param(value: Any) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.lstrip("-").isdigit():
            return int(stripped)
    return None


def _optional_bool_param(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return False


async def _read_upload_bytes(upload: UploadFile, *, max_bytes: int) -> bytes:
    data = await upload.read(max_bytes + 1)
    await upload.close()
    if len(data) > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="attachment too large",
        )
    return data


def _allowed_updates(value: Any) -> set[str] | None:
    if value is None:
        return None
    parsed = value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            parsed = [value]
    if not isinstance(parsed, list):
        return None
    updates = {item for item in parsed if isinstance(item, str) and item}
    return updates or None


async def _set_account_config(account: ChannelAccount, updates: dict[str, Any]) -> None:
    config = dict(account.config) if isinstance(account.config, dict) else {}
    config.update(updates)
    account.config = config


async def _validate_agent_webhook_url(account: ChannelAccount, url: str) -> None:
    await validate_agent_webhook_url(account, url)


async def _require_bound_chat(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    external_chat_id: str,
    bot_agent_link_id: UUID | None = None,
) -> ChannelBinding:
    binding = await find_binding(
        db,
        account=account,
        external_chat_id=external_chat_id,
        bot_agent_link_id=bot_agent_link_id,
    )
    if binding is not None:
        return binding
    filters = [
        ChannelBinding.account_id == account.id,
        ChannelBinding.status == BINDING_STATUS_ACTIVE,
        ChannelBindingAlias.account_id == account.id,
        ChannelBindingAlias.alias_external_chat_id == external_chat_id,
    ]
    if bot_agent_link_id is not None:
        filters.append(ChannelBindingAlias.bot_agent_link_id == bot_agent_link_id)
    result = await db.execute(
        select(ChannelBinding)
        .join(ChannelBindingAlias, ChannelBindingAlias.binding_id == ChannelBinding.id)
        .where(*filters)
    )
    binding = result.scalars().first()
    if binding is not None:
        return binding
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="chat is not paired")


def _telegram_ok(result: Any) -> dict[str, Any]:
    return {"ok": True, "result": result}


def _telegram_error(description: str, error_code: int) -> dict[str, Any]:
    return {"ok": False, "error_code": error_code, "description": description}


def _telegram_me(account: ChannelAccount) -> dict[str, Any]:
    # Synthetic identities are account-scoped so rotating an AgentLink token
    # cannot impersonate a different physical bot. Without a provider getMe
    # snapshot, topic capability must fail closed.
    bot_id = (account.id.int % 999_999_999) + 1
    config = account.config if isinstance(account.config, dict) else {}
    username = _optional_str(config.get("bot_username")) or account.name.replace(" ", "_")
    return {
        "id": bot_id,
        "is_bot": True,
        "first_name": account.name,
        "username": username,
        "can_join_groups": True,
        "can_read_all_group_messages": False,
        "supports_inline_queries": False,
        "has_topics_enabled": False,
    }


def _telegram_sent_result(message: Any, *, chat_id: str, text: str) -> dict[str, Any]:
    payload = message.payload if isinstance(message.payload, dict) else {}
    result = payload.get("result")
    if isinstance(result, dict):
        return result
    return {
        "message_id": abs(hash(str(message.id))) % 2_147_483_647,
        "date": int(time.time()),
        "chat": {"id": int(chat_id) if chat_id.lstrip("-").isdigit() else chat_id},
        "text": text,
    }


def _telegram_link_webhook_config(link: ChannelBotAgentLink) -> dict[str, Any]:
    return telegram_link_webhook_config(link)


def _telegram_link_webhook_url(link: ChannelBotAgentLink) -> str | None:
    return telegram_link_webhook_url(link)


async def _deliver_telegram_agent_webhook(
    account: ChannelAccount,
    link: ChannelBotAgentLink,
    payload: dict[str, Any],
) -> bool:
    return await deliver_telegram_agent_webhook(account, link, payload)


async def _resolve_discord_agent_account(
    db: AsyncSession,
    authorization: str | None,
) -> ChannelAccount:
    return (await _resolve_discord_agent_context(db, authorization)).account


async def _resolve_discord_agent_context(
    db: AsyncSession,
    authorization: str | None,
) -> ChannelAgentContext:
    token = _extract_bot_token(authorization)
    if token is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing bot token")
    return await resolve_channel_agent_by_token(
        db,
        provider=CHANNEL_PROVIDER_DISCORD,
        token=token,
    )


def _extract_bot_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, value = authorization.partition(" ")
    if scheme.lower() != "bot" or not value.strip():
        return None
    return value.strip()


def _extract_bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, value = authorization.partition(" ")
    if scheme.lower() != "bearer" or not value.strip():
        return None
    return value.strip()


def _discord_application_id(account: ChannelAccount) -> str:
    config = account.config if isinstance(account.config, dict) else {}
    configured = _optional_str(config.get("application_id")) or _optional_str(config.get("app_id"))
    if configured:
        return configured
    return str(abs(hash(str(account.id))) % 10_000_000_000_000_000_000)


def _discord_bot_user(account: ChannelAccount) -> dict[str, Any]:
    config = account.config if isinstance(account.config, dict) else {}
    app_id = _discord_application_id(account)
    username = _optional_str(config.get("bot_username")) or account.name
    return {
        "id": app_id,
        "username": username,
        "global_name": username,
        "discriminator": "0000",
        "avatar": config.get("bot_avatar"),
        "bot": True,
        "system": False,
    }


def _discord_message_result(message: Any, *, channel_id: str, content: str) -> dict[str, Any]:
    payload = message.payload if isinstance(message.payload, dict) else {}
    if "id" in payload and "channel_id" in payload:
        return payload
    return {
        "id": message.provider_message_id or str(message.id),
        "channel_id": channel_id,
        "content": content,
        "timestamp": message.created_at.isoformat(),
        "author": {"id": str(message.account_id), "bot": True, "username": "Clawdi"},
    }


async def _handle_discord_application_commands(
    db: AsyncSession,
    *,
    agent: ChannelAgentContext,
    request: Request,
    segments: list[str],
) -> Any:
    account = agent.account
    link = agent.link
    if not segments or segments[0] != "applications":
        return None
    application_id = segments[1] if len(segments) > 1 else None
    command_id = None
    guild_id = None
    if len(segments) == 3 and segments[2] == "commands":
        scope_key = "global"
    elif len(segments) == 4 and segments[2] == "commands":
        scope_key = "global"
        command_id = segments[3]
    elif len(segments) == 5 and segments[2] == "guilds" and segments[4] == "commands":
        guild_id = segments[3]
        scope_key = f"guild:{guild_id}"
    elif len(segments) == 6 and segments[2] == "guilds" and segments[4] == "commands":
        guild_id = segments[3]
        scope_key = f"guild:{guild_id}"
        command_id = segments[5]
    else:
        return None
    if application_id is None or application_id != _discord_application_id(account):
        return _discord_command_error("Missing Access", 50001, 403)
    if guild_id is not None and not await _discord_guild_owned_by_link(
        db,
        account=account,
        bot_agent_link_id=link.id,
        guild_id=guild_id,
    ):
        return _discord_command_error("Missing Access", 50001, 403)
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        # Pair claims lock this Link row too. Take the same lock before the DM
        # boundary check so a concurrent User Install cannot make a rejected
        # mutation commit a hidden shadow.
        await db.refresh(link, with_for_update=True)
        await _assert_discord_command_mutation_supported(
            db,
            account=account,
            link=link,
            guild_id=guild_id,
        )
        # Serialize desired-shadow mutations with provider receipts/retries.
        # The subsequent shadow commit releases this row lock before network I/O.

    commands = _discord_command_shadow(link)
    if request.method == "GET" and command_id is None:
        return await _discord_materialized_command_list(
            db,
            account=account,
            link=link,
            guild_id=guild_id,
        )
    if request.method == "GET" and command_id is not None:
        materialized_commands = await _discord_materialized_command_list(
            db,
            account=account,
            link=link,
            guild_id=guild_id,
        )
        command = _find_discord_command(materialized_commands, command_id)
        return command or _discord_command_error("Unknown application command", 10063, 404)
    if request.method == "DELETE" and command_id is None:
        # Keep an explicit empty desired scope as a durable tombstone. If the
        # provider call fails, the worker can still converge the physical Guild
        # command set after the client observes an error or retries to a 404.
        commands[scope_key] = []
        await _store_discord_command_shadow(db, link=link, commands=commands)
        await _materialize_discord_command_scope(
            db,
            account=account,
            link=link,
            application_id=application_id,
            guild_id=guild_id,
            commands=[],
        )
        return {}
    if request.method == "DELETE" and command_id is not None:
        command_list = commands.get(scope_key, [])
        filtered = [
            command for command in command_list if _optional_str(command.get("id")) != command_id
        ]
        if len(filtered) == len(command_list):
            return _discord_command_error("Unknown application command", 10063, 404)
        commands[scope_key] = filtered
        await _store_discord_command_shadow(db, link=link, commands=commands)
        await _materialize_discord_command_scope(
            db,
            account=account,
            link=link,
            application_id=application_id,
            guild_id=guild_id,
            commands=filtered,
        )
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    if request.method not in {"POST", "PUT", "PATCH"}:
        return None

    payload = await _request_payload(request)
    params = payload if isinstance(payload, dict) else {}
    raw_commands = payload if isinstance(payload, list) else params.get("commands")
    if request.method == "PUT":
        if isinstance(raw_commands, list):
            command_list = _discord_command_list_shape(raw_commands, application_id=application_id)
        else:
            command_list = _discord_command_list_shape([params], application_id=application_id)
        commands[scope_key] = command_list
        await _store_discord_command_shadow(db, link=link, commands=commands)
        await _materialize_discord_command_scope(
            db,
            account=account,
            link=link,
            application_id=application_id,
            guild_id=guild_id,
            commands=command_list,
        )
        return command_list

    if request.method == "PATCH" and command_id is not None:
        command_list = commands.setdefault(scope_key, [])
        for index, existing in enumerate(command_list):
            if _optional_str(existing.get("id")) != command_id:
                continue
            merged = dict(existing)
            merged.update(params)
            merged["id"] = command_id
            command = _discord_command_shape(merged, application_id=application_id)
            if _discord_command_key_conflicts(command_list, command, ignored_id=command_id):
                return _discord_command_error("Application command already exists", 30032, 400)
            command_list[index] = command
            await _store_discord_command_shadow(db, link=link, commands=commands)
            await _materialize_discord_command_scope(
                db,
                account=account,
                link=link,
                application_id=application_id,
                guild_id=guild_id,
                commands=command_list,
            )
            return command
        return _discord_command_error("Unknown application command", 10063, 404)

    if command_id is not None:
        return _discord_command_error("Method Not Allowed", 0, 405)

    command = _discord_command_shape(params, application_id=application_id)
    command_list = commands.setdefault(scope_key, [])
    _discord_upsert_command(command_list, command)
    await _store_discord_command_shadow(db, link=link, commands=commands)
    await _materialize_discord_command_scope(
        db,
        account=account,
        link=link,
        application_id=application_id,
        guild_id=guild_id,
        commands=command_list,
    )
    return command


def _find_discord_command(
    commands: list[dict[str, Any]],
    command_id: str,
) -> dict[str, Any] | None:
    for command in commands:
        if _optional_str(command.get("id")) == command_id:
            return command
    return None


def _discord_command_error(message: str, code: int, status_code: int) -> Response:
    return Response(
        content=json.dumps({"code": code, "message": message}),
        status_code=status_code,
        media_type="application/json",
    )


def _discord_command_shadow(link: ChannelBotAgentLink) -> dict[str, list[dict[str, Any]]]:
    config = link.config if isinstance(link.config, dict) else {}
    commands = config.get(_DISCORD_AGENT_COMMANDS_CONFIG_KEY)
    if not isinstance(commands, dict):
        return {}
    clean: dict[str, list[dict[str, Any]]] = {}
    for scope, value in commands.items():
        if isinstance(scope, str) and isinstance(value, list):
            clean[scope] = [item for item in value if isinstance(item, dict)]
    return clean


def _discord_command_materializations(link: ChannelBotAgentLink) -> dict[str, str]:
    config = link.config if isinstance(link.config, dict) else {}
    raw = config.get(_DISCORD_COMMAND_MATERIALIZATIONS_CONFIG_KEY)
    if not isinstance(raw, dict):
        return {}
    return {
        guild_id: fingerprint
        for guild_id, fingerprint in raw.items()
        if isinstance(guild_id, str) and guild_id and isinstance(fingerprint, str) and fingerprint
    }


def _discord_command_retries(link: ChannelBotAgentLink) -> dict[str, dict[str, Any]]:
    config = link.config if isinstance(link.config, dict) else {}
    raw = config.get(_DISCORD_COMMAND_RETRIES_CONFIG_KEY)
    if not isinstance(raw, dict):
        return {}
    return {
        guild_id: dict(value)
        for guild_id, value in raw.items()
        if isinstance(guild_id, str) and guild_id and isinstance(value, dict)
    }


def _discord_retry_is_due(retry: dict[str, Any] | None, *, fingerprint: str) -> bool:
    if retry is None or retry.get("fingerprint") != fingerprint:
        return True
    if retry.get("blocked") is True:
        return False
    next_retry_at = retry.get("next_retry_at")
    if not isinstance(next_retry_at, str):
        return True
    try:
        due_at = datetime.fromisoformat(next_retry_at.replace("Z", "+00:00"))
    except ValueError:
        return True
    return due_at <= datetime.now(UTC)


def _discord_retry_after_seconds(result: _DiscordProviderResult) -> float | None:
    raw_header = next(
        (value for key, value in (result.headers or {}).items() if key.lower() == "retry-after"),
        None,
    )
    if raw_header is not None:
        try:
            value = float(raw_header)
        except ValueError:
            value = -1
        if value >= 0:
            return value
    payload = result.json_object()
    raw_body = payload.get("retry_after") if payload is not None else None
    if isinstance(raw_body, (int, float)) and not isinstance(raw_body, bool) and raw_body >= 0:
        return float(raw_body)
    return None


def _discord_command_retry_state(
    *,
    previous: dict[str, Any] | None,
    fingerprint: str,
    status_code: int,
    result: _DiscordProviderResult | None,
) -> dict[str, Any]:
    previous_attempts = previous.get("attempts") if isinstance(previous, dict) else None
    previous_fingerprint = previous.get("fingerprint") if isinstance(previous, dict) else None
    attempts = (
        previous_attempts + 1
        if isinstance(previous_attempts, int)
        and not isinstance(previous_attempts, bool)
        and previous_attempts >= 0
        and previous_fingerprint == fingerprint
        else 1
    )
    retry_after = _discord_retry_after_seconds(result) if result is not None else None
    # A 429 is always transient. Discord normally supplies Retry-After, but a
    # missing/malformed value must fall back to bounded exponential backoff
    # instead of turning a temporary rate limit into a permanent tombstone.
    blocked = 400 <= status_code < 500 and status_code != status.HTTP_429_TOO_MANY_REQUESTS
    if status_code == status.HTTP_429_TOO_MANY_REQUESTS and retry_after is not None:
        delay_seconds = retry_after
    else:
        delay_seconds = min(30.0 * (2 ** (attempts - 1)), 3600.0)
    return {
        "fingerprint": fingerprint,
        "attempts": attempts,
        "status_code": status_code,
        "blocked": blocked,
        "next_retry_at": (
            None if blocked else (datetime.now(UTC) + timedelta(seconds=delay_seconds)).isoformat()
        ),
    }


def _discord_effective_guild_commands(
    shadow: dict[str, list[dict[str, Any]]],
    *,
    guild_id: str,
) -> list[dict[str, Any]]:
    guild_commands = shadow.get(f"guild:{guild_id}")
    return guild_commands if guild_commands is not None else shadow.get("global", [])


def _discord_guild_command_fingerprint(
    commands: list[dict[str, Any]],
    *,
    application_id: str,
) -> str:
    provider_commands = [_discord_guild_command_provider_payload(command) for command in commands]
    encoded = json.dumps(
        {
            "application_id": application_id,
            "commands": provider_commands,
        },
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


async def _discord_materialized_command_list(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    link: ChannelBotAgentLink,
    guild_id: str | None,
) -> list[dict[str, Any]]:
    shadow = _discord_command_shadow(link)
    materializations = _discord_command_materializations(link)
    application_id = _discord_application_id(account)
    if guild_id is not None:
        desired = _discord_effective_guild_commands(shadow, guild_id=guild_id)
        expected = _discord_guild_command_fingerprint(
            desired,
            application_id=application_id,
        )
        return desired if materializations.get(guild_id) == expected else []
    guild_ids = await _discord_uncontested_guilds_for_link(
        db,
        account=account,
        bot_agent_link_id=link.id,
    )
    global_commands = shadow.get("global", [])
    global_targets = [
        target_guild_id for target_guild_id in guild_ids if f"guild:{target_guild_id}" not in shadow
    ]
    if not guild_ids:
        # Before any chat is paired, the shadow is a durable desired state for
        # a future server. Once the Link is DM-only, returning an empty list is
        # the explicit boundary: per-Link global commands are not materialized
        # into Discord's shared application-global DM namespace.
        bindings = await _discord_active_bindings_for_link(db, account=account, link=link)
        return global_commands if not bindings else []
    if not global_targets:
        return global_commands
    expected = _discord_guild_command_fingerprint(
        global_commands,
        application_id=application_id,
    )
    if all(materializations.get(target) == expected for target in global_targets):
        return global_commands
    return []


async def _store_discord_command_shadow(
    db: AsyncSession,
    *,
    link: ChannelBotAgentLink,
    commands: dict[str, list[dict[str, Any]]],
) -> None:
    config = dict(link.config) if isinstance(link.config, dict) else {}
    config[_DISCORD_AGENT_COMMANDS_CONFIG_KEY] = commands
    link.config = config
    await db.commit()


def _discord_command_list_shape(
    commands: list[Any],
    *,
    application_id: str,
) -> list[dict[str, Any]]:
    shaped: list[dict[str, Any]] = []
    seen_keys: set[tuple[int, str]] = set()
    for command in commands:
        item = _discord_command_shape(command, application_id=application_id)
        key = _discord_command_key(item)
        if key in seen_keys:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="duplicate application command name/type",
            )
        seen_keys.add(key)
        shaped.append(item)
    return shaped


def _discord_command_shape(command: Any, *, application_id: str) -> dict[str, Any]:
    if not isinstance(command, dict):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="application command object required",
        )
    source = command
    name = _optional_str(source.get("name"))
    if name is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="command name is required",
        )
    if name.startswith("bot_") or name in DISCORD_RESERVED_COMMAND_NAMES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="command name is reserved",
        )
    raw_command_type = source.get("type")
    if isinstance(raw_command_type, bool):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="command type is invalid",
        )
    command_type = raw_command_type if isinstance(raw_command_type, int) else 1
    description = source.get("description")
    if command_type == 1 and (not isinstance(description, str) or not description.strip()):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="command description is required",
        )
    shaped = dict(source)
    shaped.update(
        {
            "id": _optional_str(source.get("id"))
            or str(
                abs(
                    hash(
                        json.dumps(
                            {
                                "application_id": application_id,
                                "name": name,
                                "type": command_type,
                            },
                            sort_keys=True,
                        )
                    )
                )
            ),
            "application_id": application_id,
            "name": name,
            "type": command_type,
        }
    )
    return shaped


def _discord_command_key(command: dict[str, Any]) -> tuple[int, str]:
    raw_command_type = command.get("type")
    command_type = 1
    if isinstance(raw_command_type, int) and not isinstance(raw_command_type, bool):
        command_type = raw_command_type
    return command_type, _optional_str(command.get("name")) or ""


def _discord_upsert_command(
    commands: list[dict[str, Any]],
    command: dict[str, Any],
) -> None:
    command_key = _discord_command_key(command)
    for index, existing in enumerate(commands):
        if _discord_command_key(existing) == command_key:
            command["id"] = _optional_str(existing.get("id")) or command["id"]
            commands[index] = command
            return
    commands.append(command)


def _discord_command_key_conflicts(
    commands: list[dict[str, Any]],
    command: dict[str, Any],
    *,
    ignored_id: str,
) -> bool:
    command_key = _discord_command_key(command)
    for existing in commands:
        if _optional_str(existing.get("id")) == ignored_id:
            continue
        if _discord_command_key(existing) == command_key:
            return True
    return False


async def _discord_guild_owned_by_link(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID,
    guild_id: str,
) -> bool:
    owners = await _discord_guild_owner_principals(
        db,
        application_id=_discord_application_id(account),
        guild_id=guild_id,
    )
    return owners == {(account.id, bot_agent_link_id)}


async def _discord_uncontested_guilds_for_link(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID,
) -> list[str]:
    application_id = _discord_application_id(account)
    result = await db.execute(
        select(ChannelBinding, ChannelAccount, ChannelBotAgentLink)
        .join(ChannelAccount, ChannelAccount.id == ChannelBinding.account_id)
        .join(ChannelBotAgentLink, ChannelBotAgentLink.id == ChannelBinding.bot_agent_link_id)
        .where(
            ChannelAccount.provider == CHANNEL_PROVIDER_DISCORD,
            ChannelBinding.status == BINDING_STATUS_ACTIVE,
            ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
            ChannelBotAgentLink.archived_at.is_(None),
        )
    )
    owners_by_guild: dict[str, set[tuple[UUID, UUID]]] = {}
    for binding, owner_account, owner_link in result.all():
        if _discord_application_id(owner_account) != application_id:
            continue
        guild_id = _discord_binding_guild_id(binding)
        if guild_id is None:
            continue
        owners_by_guild.setdefault(guild_id, set()).add((owner_account.id, owner_link.id))
    return sorted(
        guild_id
        for guild_id, owners in owners_by_guild.items()
        if owners == {(account.id, bot_agent_link_id)}
    )


async def _discord_active_bindings_for_link(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    link: ChannelBotAgentLink,
) -> list[ChannelBinding]:
    result = await db.execute(
        select(ChannelBinding).where(
            ChannelBinding.account_id == account.id,
            ChannelBinding.bot_agent_link_id == link.id,
            ChannelBinding.status == BINDING_STATUS_ACTIVE,
        )
    )
    return list(result.scalars())


async def _assert_discord_command_mutation_supported(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    link: ChannelBotAgentLink,
    guild_id: str | None,
) -> None:
    if guild_id is not None:
        return
    guild_ids = await _discord_uncontested_guilds_for_link(
        db,
        account=account,
        bot_agent_link_id=link.id,
    )
    if guild_ids:
        return
    bindings = await _discord_active_bindings_for_link(db, account=account, link=link)
    if bindings:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "agent-defined Discord commands require a paired server; "
                "per-Link commands are unavailable in direct messages"
            ),
        )


async def _discord_guild_owner_principals(
    db: AsyncSession,
    *,
    application_id: str,
    guild_id: str,
) -> set[tuple[UUID, UUID]]:
    """Return active Link owners within one physical Discord app namespace."""
    result = await db.execute(
        select(ChannelBinding, ChannelAccount, ChannelBotAgentLink)
        .join(ChannelAccount, ChannelAccount.id == ChannelBinding.account_id)
        .join(ChannelBotAgentLink, ChannelBotAgentLink.id == ChannelBinding.bot_agent_link_id)
        .where(
            ChannelAccount.provider == CHANNEL_PROVIDER_DISCORD,
            ChannelBinding.status == BINDING_STATUS_ACTIVE,
            ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
            ChannelBotAgentLink.archived_at.is_(None),
        )
    )
    owners: set[tuple[UUID, UUID]] = set()
    for binding, owner_account, owner_link in result.all():
        if (
            _discord_application_id(owner_account) == application_id
            and _discord_binding_guild_id(binding) == guild_id
        ):
            owners.add((owner_account.id, owner_link.id))
    return owners


def _discord_binding_guild_id(binding: ChannelBinding) -> str | None:
    chat_type = (binding.external_chat_type or "").lower()
    if binding.external_chat_id and chat_type == "guild":
        return binding.external_chat_id
    if binding.external_chat_name and ("guild" in chat_type or "thread" in chat_type):
        return binding.external_chat_name
    return None


async def _lock_discord_command_projection(
    db: AsyncSession,
    *,
    application_id: str,
    guild_id: str,
) -> None:
    """Serialize every physical command overwrite for one app/Guild namespace."""
    lock_name = f"discord-command-projection:{application_id}:{guild_id}"
    await db.execute(select(func.pg_advisory_xact_lock(func.hashtextextended(lock_name, 0))))


def _discord_retry_exception(retry: dict[str, Any]) -> HTTPException:
    status_code = retry.get("status_code")
    if status_code == status.HTTP_429_TOO_MANY_REQUESTS:
        headers: dict[str, str] | None = None
        next_retry_at = retry.get("next_retry_at")
        if isinstance(next_retry_at, str):
            try:
                due_at = datetime.fromisoformat(next_retry_at.replace("Z", "+00:00"))
            except ValueError:
                pass
            else:
                remaining = max(0.0, (due_at - datetime.now(UTC)).total_seconds())
                headers = {"Retry-After": f"{remaining:.3f}"}
        return HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="discord command sync is rate limited",
            headers=headers,
        )
    if retry.get("blocked") is True:
        return HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="discord api rejected commands",
        )
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="discord command reconciliation is deferred",
    )


def _discord_provider_failure_exception(result: _DiscordProviderResult) -> HTTPException:
    if result.status_code == status.HTTP_429_TOO_MANY_REQUESTS:
        retry_after = _discord_retry_after_seconds(result)
        return HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="discord command sync is rate limited",
            headers=({"Retry-After": f"{retry_after:.3f}"} if retry_after is not None else None),
        )
    return HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail="discord api rejected commands",
    )


async def _fan_out_discord_global_commands(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID,
    application_id: str,
    commands: list[dict[str, Any]],
    guild_ids: set[str] | None = None,
    automatic: bool = False,
    force: bool = False,
) -> int:
    if not account.encrypted_provider_token or not account.provider_token_nonce:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="discord bot credential unavailable",
        )
    link = await db.get(ChannelBotAgentLink, bot_agent_link_id)
    if (
        link is None
        or link.account_id != account.id
        or link.status != BOT_AGENT_LINK_STATUS_ACTIVE
        or link.archived_at is not None
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="discord agent link unavailable",
        )
    uncontested_guild_ids = await _discord_uncontested_guilds_for_link(
        db,
        account=account,
        bot_agent_link_id=bot_agent_link_id,
    )
    target_guild_ids = [
        guild_id for guild_id in uncontested_guild_ids if guild_ids is None or guild_id in guild_ids
    ]
    if not target_guild_ids:
        return 0
    reconciled = 0
    first_error: HTTPException | None = None
    for guild_id in target_guild_ids:
        await _lock_discord_command_projection(
            db,
            application_id=application_id,
            guild_id=guild_id,
        )
        await db.refresh(link, with_for_update=True)
        if not await _discord_guild_owned_by_link(
            db,
            account=account,
            bot_agent_link_id=link.id,
            guild_id=guild_id,
        ):
            await db.commit()
            continue
        desired_shadow = _discord_command_shadow(link)
        materializations = _discord_command_materializations(link)
        retries = _discord_command_retries(link)
        desired_commands = _discord_effective_guild_commands(
            desired_shadow,
            guild_id=guild_id,
        )
        fingerprint = _discord_guild_command_fingerprint(
            desired_commands,
            application_id=application_id,
        )
        # GUILD_CREATE is also emitted for every available Guild on READY and
        # reconnect. A verified recovery trigger may bypass blocked/not-due
        # retry state, but an application-aware current receipt is converged
        # and must never cause another bulk overwrite.
        if materializations.get(guild_id) == fingerprint:
            await db.commit()
            continue
        retry = retries.get(guild_id)
        if not force and not _discord_retry_is_due(retry, fingerprint=fingerprint):
            await db.commit()
            if not automatic and first_error is None and retry is not None:
                first_error = _discord_retry_exception(retry)
            continue
        body = json.dumps(
            [_discord_guild_command_provider_payload(command) for command in desired_commands]
        ).encode("utf-8")
        try:
            result = await _request_discord_provider(
                account=account,
                method="PUT",
                path=f"/applications/{application_id}/guilds/{guild_id}/commands",
                body=body,
            )
        except HTTPException as exc:
            retries[guild_id] = _discord_command_retry_state(
                previous=retries.get(guild_id),
                fingerprint=fingerprint,
                status_code=status.HTTP_502_BAD_GATEWAY,
                result=None,
            )
            config = dict(link.config) if isinstance(link.config, dict) else {}
            config[_DISCORD_COMMAND_RETRIES_CONFIG_KEY] = retries
            link.config = config
            await db.commit()
            if not automatic and first_error is None:
                first_error = exc
            continue
        if not 200 <= result.status_code < 300:
            retries[guild_id] = _discord_command_retry_state(
                previous=retries.get(guild_id),
                fingerprint=fingerprint,
                status_code=result.status_code,
                result=result,
            )
            config = dict(link.config) if isinstance(link.config, dict) else {}
            config[_DISCORD_COMMAND_RETRIES_CONFIG_KEY] = retries
            link.config = config
            await db.commit()
            if not automatic and first_error is None:
                first_error = _discord_provider_failure_exception(result)
            continue
        materializations[guild_id] = fingerprint
        retries.pop(guild_id, None)
        config = dict(link.config) if isinstance(link.config, dict) else {}
        config[_DISCORD_COMMAND_MATERIALIZATIONS_CONFIG_KEY] = materializations
        config[_DISCORD_COMMAND_RETRIES_CONFIG_KEY] = retries
        link.config = config
        await db.commit()
        reconciled += 1
    if first_error is not None:
        raise first_error
    return reconciled


async def _discord_historical_guilds_for_link(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    link: ChannelBotAgentLink,
) -> set[str]:
    result = await db.execute(
        select(ChannelBinding).where(
            ChannelBinding.account_id == account.id,
            ChannelBinding.bot_agent_link_id == link.id,
        )
    )
    return {
        guild_id
        for binding in result.scalars()
        if (guild_id := _discord_binding_guild_id(binding)) is not None
    }


async def _clear_discord_guild_commands(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    link: ChannelBotAgentLink,
    application_id: str,
    guild_ids: set[str],
    force: bool = False,
) -> bool:
    """Converge stale physical Guild scopes to an explicit empty tombstone."""
    if not account.encrypted_provider_token or not account.provider_token_nonce:
        return False
    empty_fingerprint = _discord_guild_command_fingerprint(
        [],
        application_id=application_id,
    )
    succeeded = True
    for guild_id in sorted(guild_ids):
        await _lock_discord_command_projection(
            db,
            application_id=application_id,
            guild_id=guild_id,
        )
        await db.refresh(link, with_for_update=True)
        materializations = _discord_command_materializations(link)
        retries = _discord_command_retries(link)
        owners = await _discord_guild_owner_principals(
            db,
            application_id=application_id,
            guild_id=guild_id,
        )
        if len(owners) == 1:
            # A new active Link owns the physical namespace. Retire only this
            # stale Link's receipt; its owner will reconcile the desired set.
            materializations[guild_id] = empty_fingerprint
            retries.pop(guild_id, None)
            config = dict(link.config) if isinstance(link.config, dict) else {}
            config[_DISCORD_COMMAND_MATERIALIZATIONS_CONFIG_KEY] = materializations
            config[_DISCORD_COMMAND_RETRIES_CONFIG_KEY] = retries
            link.config = config
            await db.commit()
            continue
        # Multiple owners are a legacy/invalid collision in the same physical
        # app+Guild namespace. No Link may claim materialization; converge the
        # namespace to empty until identity admission is repaired.
        retry = retries.get(guild_id)
        if materializations.get(guild_id) == empty_fingerprint and retry is None:
            await db.commit()
            continue
        if not force and not _discord_retry_is_due(retry, fingerprint=empty_fingerprint):
            succeeded = False
            await db.commit()
            continue
        try:
            result = await _request_discord_provider(
                account=account,
                method="PUT",
                path=f"/applications/{application_id}/guilds/{guild_id}/commands",
                body=b"[]",
            )
        except HTTPException:
            retries[guild_id] = _discord_command_retry_state(
                previous=retry,
                fingerprint=empty_fingerprint,
                status_code=status.HTTP_502_BAD_GATEWAY,
                result=None,
            )
            succeeded = False
        else:
            if 200 <= result.status_code < 300:
                materializations[guild_id] = empty_fingerprint
                retries.pop(guild_id, None)
            else:
                retries[guild_id] = _discord_command_retry_state(
                    previous=retry,
                    fingerprint=empty_fingerprint,
                    status_code=result.status_code,
                    result=result,
                )
                succeeded = False
        config = dict(link.config) if isinstance(link.config, dict) else {}
        config[_DISCORD_COMMAND_MATERIALIZATIONS_CONFIG_KEY] = materializations
        config[_DISCORD_COMMAND_RETRIES_CONFIG_KEY] = retries
        link.config = config
        await db.commit()
    return succeeded


async def _materialize_discord_command_scope(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    link: ChannelBotAgentLink,
    application_id: str,
    guild_id: str | None,
    commands: list[dict[str, Any]],
) -> None:
    # Agent-defined commands are Link shadows. Never write them to the shared
    # physical global command set or DMs; only materialize them into this
    # Link's Guild bindings. Built-in reserved commands use the separate
    # account-level sync path and remain physical global commands.
    # TODO(discord): If Discord adds a per-install or per-DM command namespace,
    # project Link shadows there and retire this Guild-only boundary.
    target_guild_ids = await _discord_uncontested_guilds_for_link(
        db,
        account=account,
        bot_agent_link_id=link.id,
    )
    selected_guild_ids = (
        [target for target in target_guild_ids if target == guild_id]
        if guild_id is not None
        else target_guild_ids
    )
    if not selected_guild_ids:
        bindings = await _discord_active_bindings_for_link(
            db,
            account=account,
            link=link,
        )
        if bindings:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    "agent-defined Discord commands require a paired server; "
                    "per-Link commands are unavailable in direct messages"
                ),
            )
        return
    await _fan_out_discord_global_commands(
        db,
        account=account,
        bot_agent_link_id=link.id,
        application_id=application_id,
        commands=commands,
        guild_ids=set(selected_guild_ids),
    )


def _discord_guild_command_provider_payload(command: dict[str, Any]) -> dict[str, Any]:
    """Project a virtual response object onto Discord's guild write contract."""
    payload = dict(command)
    for field in (
        "id",
        "application_id",
        "guild_id",
        "version",
        "name_localized",
        "description_localized",
        "contexts",
        "integration_types",
        "dm_permission",
    ):
        payload.pop(field, None)
    return payload


def _discord_gateway_dispatch(message: Any) -> dict[str, Any]:
    payload = message.payload if isinstance(message.payload, dict) else {}
    data = payload.get("d") if isinstance(payload.get("d"), dict) else payload
    dispatch_type = payload.get("t") if isinstance(payload.get("t"), str) else "MESSAGE_CREATE"
    if not isinstance(data, dict):
        data = {}
    data = dict(data)
    data.setdefault("id", message.provider_message_id or str(message.id))
    data.setdefault("channel_id", message.external_chat_id)
    data.setdefault("content", message.text or "")
    return {
        "op": 0,
        "t": dispatch_type,
        "s": int(message.inbox_sequence),
        "d": data,
    }


@dataclass(frozen=True)
class _DiscordProviderResult:
    content: bytes
    status_code: int
    media_type: str
    headers: dict[str, str] | None = None

    def as_response(self) -> Response:
        return Response(
            content=self.content,
            status_code=self.status_code,
            media_type=self.media_type,
            headers=self.headers,
        )

    def json_object(self) -> dict[str, Any] | None:
        try:
            payload = json.loads(self.content)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        return payload if isinstance(payload, dict) else None


async def _request_discord_provider(
    *,
    account: ChannelAccount,
    method: str,
    path: str,
    body: bytes | None = None,
    content_type: str = "application/json",
    query_params: Any = None,
    request_headers: Any = None,
) -> _DiscordProviderResult:
    token = decrypt_provider_token(account)
    normalized_path = f"/{path.lstrip('/')}"
    base_url = settings.channel_discord_api_base_url.strip()
    await _validate_discord_provider_base_url(base_url)
    url = f"{base_url.rstrip('/')}{normalized_path}"
    headers = {
        "Authorization": f"Bot {token}",
        "Content-Type": content_type,
    }
    headers.update(_discord_request_headers(request_headers))
    account_scope = str(account.id)
    decision = discord_rate_limiter.check(account_scope, method, normalized_path)
    if not decision.allowed:
        rate_limit_rejects.labels(
            channel="discord",
            scope="bot" if decision.global_limit else "route",
        ).inc()
        return _DiscordProviderResult(
            content=json.dumps(
                {
                    "message": "You are being rate limited.",
                    "retry_after": decision.retry_after_seconds,
                    "global": decision.global_limit,
                }
            ).encode("utf-8"),
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            media_type="application/json",
            headers={"Retry-After": str(decision.retry_after_seconds or 1)},
        )
    try:
        with track_proxy_latency("discord", method):
            async with httpx.AsyncClient(timeout=20.0) as client:
                discord_rate_limiter.consume(account_scope, method, normalized_path)
                response = await client.request(
                    method,
                    url,
                    content=body,
                    headers=headers,
                    params=query_params,
                )
                discord_rate_limiter.observe(
                    account_scope,
                    method,
                    normalized_path,
                    _discord_rate_limit_response_headers(response),
                    response.status_code,
                )
    except httpx.HTTPError as exc:
        outbound_errors.labels(channel="discord", method=method).inc()
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="discord api unreachable",
        ) from exc
    outbound_messages.labels(channel="discord", method=method).inc()
    if response.status_code >= 400:
        outbound_errors.labels(channel="discord", method=method).inc()
    return _DiscordProviderResult(
        content=response.content,
        status_code=response.status_code,
        media_type=response.headers.get("content-type", "application/json"),
        headers=_discord_response_headers(_discord_rate_limit_response_headers(response)),
    )


async def _proxy_discord_request(
    *,
    account: ChannelAccount,
    request: Request,
    path: str,
) -> Response:
    result = await _request_discord_provider(
        account=account,
        method=request.method,
        path=path,
        body=await request.body(),
        content_type=request.headers.get("content-type", "application/json"),
        query_params=request.query_params,
        request_headers=request.headers,
    )
    return result.as_response()


def _discord_request_headers(headers: Any) -> dict[str, str]:
    if headers is None:
        return {}
    return {
        name: value for name in _DISCORD_REQUEST_HEADER_ALLOWLIST if (value := headers.get(name))
    }


def _discord_response_headers(headers: Any) -> dict[str, str]:
    if headers is None:
        return {}
    return {
        name: value for name in _DISCORD_RESPONSE_HEADER_ALLOWLIST if (value := headers.get(name))
    }


def _discord_rate_limit_response_headers(response: httpx.Response) -> dict[str, str]:
    headers = {str(key).lower(): str(value) for key, value in response.headers.items()}
    if response.status_code != status.HTTP_429_TOO_MANY_REQUESTS or "retry-after" in headers:
        return headers
    try:
        payload = response.json()
    except ValueError:
        return headers
    raw_retry_after = payload.get("retry_after") if isinstance(payload, dict) else None
    if (
        isinstance(raw_retry_after, (int, float))
        and not isinstance(raw_retry_after, bool)
        and raw_retry_after >= 0
    ):
        headers["retry-after"] = str(raw_retry_after)
    return headers


async def _validate_discord_provider_base_url(base_url: str) -> None:
    try:
        await validate_channel_http_url(base_url, label="discord api base url")
    except UnsafeOutboundUrlError as exc:
        outbound_errors.labels(channel="discord", method="provider_url").inc()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="discord api base url must be a public https URL",
        ) from exc


def _public_ws_url(path: str) -> str:
    base = settings.public_api_url.rstrip("/")
    if base.startswith("https://"):
        return "wss://" + base.removeprefix("https://") + path
    if base.startswith("http://"):
        return "ws://" + base.removeprefix("http://") + path
    return base + path


async def _socketio_ping_loop(websocket: WebSocket) -> None:
    try:
        while True:
            await asyncio.sleep(25)
            await websocket.send_text("2")
    except (WebSocketDisconnect, RuntimeError):
        return


def _socketio_auth_token(packet: str) -> str | None:
    payload = packet[2:]
    if not payload:
        return None
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    return (
        _optional_str(parsed.get("apiKey"))
        or _optional_str(parsed.get("password"))
        or _optional_str(parsed.get("token"))
    )


def _binding_response(
    binding: ChannelBinding,
    *,
    last_message_at: datetime | None = None,
) -> ChannelBindingResponse:
    return ChannelBindingResponse(
        id=binding.id,
        account_id=binding.account_id,
        agent_link_id=binding.bot_agent_link_id,
        external_chat_id=binding.external_chat_id,
        external_chat_type=binding.external_chat_type,
        external_chat_name=binding.external_chat_name,
        status=binding.status,
        created_at=binding.created_at,
        last_message_at=last_message_at,
    )


def _message_response(message, *, delivery=None) -> ChannelMessageResponse:
    return ChannelMessageResponse(
        id=message.id,
        direction=message.direction,
        external_chat_id=message.external_chat_id,
        provider_message_id=message.provider_message_id,
        delivery_id=delivery.id if delivery else None,
        delivery_status=delivery.status if delivery else None,
        text=message.text,
        created_at=message.created_at,
    )


def _discord_interaction_content(
    *,
    paired: bool,
    unpaired: bool,
    command: Any = None,
    reply: str | None = None,
) -> str:
    if command is not None and reply:
        return reply
    if paired:
        return "Channel paired."
    if unpaired:
        return "Channel unpaired."
    return "Message received."


async def _json_object(request: Request) -> dict[str, Any]:
    try:
        payload = await request.json()
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid json") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="json object required")
    return payload


def _json_object_from_bytes(body: bytes) -> dict[str, Any]:
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid json") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="json object required")
    return payload
