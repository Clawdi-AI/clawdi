from __future__ import annotations

import asyncio
import json
import time
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
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.channel import (
    BINDING_STATUS_ACTIVE,
    CHANNEL_PROVIDER_DISCORD,
    ChannelAccount,
    ChannelBinding,
    ChannelBindingAlias,
    ChannelBotAgentLink,
    ChannelMessage,
)
from app.schemas.channel import (
    ChannelAccountResponse,
    ChannelBindingResponse,
    ChannelMessageResponse,
)
from app.services.bluebubbles_compat import (
    bluebubbles_message_client_payload,
    count_imessage_messages,
    normalize_bluebubbles_attachments,
    sanitize_bluebubbles_data_for_client,
)
from app.services.channel_webhooks import (
    bluebubbles_webhook_config,
    deliver_bluebubbles_agent_webhook,
    deliver_telegram_agent_webhook,
    telegram_link_webhook_config,
    telegram_link_webhook_url,
    validate_agent_webhook_url,
)
from app.services.channels import (
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


def _account_response(account: ChannelAccount) -> ChannelAccountResponse:
    return ChannelAccountResponse(
        id=account.id,
        provider=account.provider,
        name=account.name,
        status=account.status,
        visibility=account.visibility,
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


def _bluebubbles_ok(data: Any) -> dict[str, Any]:
    return {"status": 200, "message": "OK", "data": sanitize_bluebubbles_data_for_client(data)}


def _bluebubbles_webhook_config(account: ChannelAccount) -> dict[str, Any]:
    return bluebubbles_webhook_config(account)


def _bluebubbles_webhook_events() -> list[str]:
    return [
        "new-message",
        "updated-message",
        "message-updated",
        "message-send-error",
        "group-name-change",
        "participant-added",
        "participant-removed",
        "participant-left",
        "typing-indicator",
        "message-reaction",
    ]


async def _validate_agent_webhook_url(account: ChannelAccount, url: str) -> None:
    await validate_agent_webhook_url(account, url)


async def _list_imessage_bindings(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID | None = None,
) -> list[ChannelBinding]:
    filters = [
        ChannelBinding.account_id == account.id,
        ChannelBinding.status == BINDING_STATUS_ACTIVE,
    ]
    if bot_agent_link_id is not None:
        filters.append(ChannelBinding.bot_agent_link_id == bot_agent_link_id)
    result = await db.execute(
        select(ChannelBinding).where(*filters).order_by(ChannelBinding.created_at.desc())
    )
    return list(result.scalars().all())


async def _list_imessage_messages(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    chat_guid: str | None,
    limit: int,
    offset: int,
    bot_agent_link_id: UUID | None = None,
) -> list[ChannelMessage]:
    filters = [
        ChannelMessage.account_id == account.id,
        ChannelBinding.status == BINDING_STATUS_ACTIVE,
    ]
    if bot_agent_link_id is not None:
        filters.append(ChannelMessage.bot_agent_link_id == bot_agent_link_id)
    query = (
        select(ChannelMessage)
        .join(ChannelBinding, ChannelMessage.binding_id == ChannelBinding.id)
        .where(*filters)
        .order_by(ChannelMessage.created_at.desc(), ChannelMessage.inbox_sequence.desc())
        .offset(offset)
        .limit(limit)
    )
    if chat_guid:
        query = query.where(ChannelMessage.external_chat_id == chat_guid)
    result = await db.execute(query)
    return list(result.scalars().all())


async def _bluebubbles_message_count(
    db: AsyncSession,
    *,
    chat_guid: str,
    account: ChannelAccount,
    scope: str,
    bot_agent_link_id: UUID | None = None,
) -> dict[str, Any]:
    await _require_bound_chat(
        db,
        account=account,
        external_chat_id=chat_guid,
        bot_agent_link_id=bot_agent_link_id,
    )
    total = await count_imessage_messages(
        db,
        account=account,
        chat_guid=chat_guid,
        scope=scope,
        bot_agent_link_id=bot_agent_link_id,
    )
    return _bluebubbles_ok({"total": total})


async def _get_imessage_message(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    message_guid: str,
    bot_agent_link_id: UUID | None = None,
) -> ChannelMessage:
    filters = [
        ChannelMessage.account_id == account.id,
        ChannelMessage.provider_message_id == message_guid,
    ]
    try:
        parsed_uuid = UUID(message_guid)
    except ValueError:
        parsed_uuid = None
    if parsed_uuid is not None:
        filters = [
            ChannelMessage.account_id == account.id,
            ChannelMessage.id == parsed_uuid,
        ]
    if bot_agent_link_id is not None:
        filters.append(ChannelMessage.bot_agent_link_id == bot_agent_link_id)
    result = await db.execute(
        select(ChannelMessage)
        .join(ChannelBinding, ChannelMessage.binding_id == ChannelBinding.id)
        .where(*filters, ChannelBinding.status == BINDING_STATUS_ACTIVE)
    )
    message = result.scalar_one_or_none()
    if message is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="message not found")
    return message


def _bluebubbles_chat(binding: ChannelBinding) -> dict[str, Any]:
    return {
        "guid": binding.external_chat_id,
        "chatIdentifier": binding.external_chat_id,
        "displayName": binding.external_chat_name,
        "style": 43 if binding.external_chat_type == "group" else 45,
        "participants": [{"address": binding.external_chat_id}],
    }


def _bluebubbles_handle(handle_guid: str) -> dict[str, Any]:
    return {
        "guid": handle_guid,
        "address": handle_guid,
        "country": None,
        "service": "iMessage",
        "uncanonicalizedId": handle_guid,
    }


def _bluebubbles_message(message: ChannelMessage) -> dict[str, Any]:
    created_ms = int(message.created_at.timestamp() * 1000)
    payload = message.payload if isinstance(message.payload, dict) else {}
    client_payload = bluebubbles_message_client_payload(payload)
    response = {
        **client_payload,
        "guid": message.provider_message_id or str(message.id),
        "text": message.text,
        "dateCreated": client_payload.get("dateCreated") or created_ms,
        "dateRead": client_payload.get("dateRead"),
        "dateDelivered": client_payload.get("dateDelivered") or created_ms,
        "dateEdited": client_payload.get("dateEdited"),
        "dateRetracted": client_payload.get("dateRetracted"),
        "isEdited": client_payload.get("isEdited") is True,
        "isUnsent": client_payload.get("isUnsent") is True,
        "isFromMe": message.direction == "outbound",
        "chats": [{"guid": message.external_chat_id}],
        "handle": {"address": message.external_chat_id},
        "attachments": normalize_bluebubbles_attachments(payload),
        "reactions": client_payload.get("reactions")
        if isinstance(client_payload.get("reactions"), list)
        else [],
        "clawdi": {
            "messageId": str(message.id),
            "accountId": str(message.account_id),
            "bindingId": str(message.binding_id) if message.binding_id else None,
        },
    }
    return sanitize_bluebubbles_data_for_client(response)


async def _deliver_bluebubbles_agent_webhook(
    account: ChannelAccount,
    event_type: str,
    data: dict[str, Any],
) -> bool:
    return await deliver_bluebubbles_agent_webhook(account, event_type, data)


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


def _telegram_me(account: ChannelAccount, token: str) -> dict[str, Any]:
    bot_id = token.split(":", 1)[0]
    config = account.config if isinstance(account.config, dict) else {}
    username = _optional_str(config.get("bot_username")) or account.name.replace(" ", "_")
    return {
        "id": int(bot_id) if bot_id.isdigit() else abs(hash(bot_id)) % 1_000_000_000,
        "is_bot": True,
        "first_name": account.name,
        "username": username,
        "can_join_groups": True,
        "can_read_all_group_messages": False,
        "supports_inline_queries": False,
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
    account: ChannelAccount,
    request: Request,
    segments: list[str],
) -> Any:
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
    if application_id != _discord_application_id(account):
        return _discord_command_error("Missing Access", 50001, 403)
    if guild_id is not None and not await _discord_guild_owned_by_account(
        db,
        account=account,
        guild_id=guild_id,
    ):
        return _discord_command_error("Missing Access", 50001, 403)

    commands = _discord_command_shadow(account)
    if request.method == "GET" and command_id is None:
        return commands.get(scope_key, [])
    if request.method == "GET" and command_id is not None:
        command = _find_discord_command(commands.get(scope_key, []), command_id)
        return command or _discord_command_error("Unknown application command", 10063, 404)
    if request.method == "DELETE" and command_id is None:
        commands.pop(scope_key, None)
        await _store_discord_command_shadow(db, account=account, commands=commands)
        return {}
    if request.method == "DELETE" and command_id is not None:
        command_list = commands.get(scope_key, [])
        filtered = [
            command for command in command_list if _optional_str(command.get("id")) != command_id
        ]
        if len(filtered) == len(command_list):
            return _discord_command_error("Unknown application command", 10063, 404)
        commands[scope_key] = filtered
        await _store_discord_command_shadow(db, account=account, commands=commands)
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
        await _store_discord_command_shadow(db, account=account, commands=commands)
        if scope_key == "global":
            await _fan_out_discord_global_commands(
                db,
                account=account,
                application_id=application_id,
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
            await _store_discord_command_shadow(db, account=account, commands=commands)
            if scope_key == "global":
                await _fan_out_discord_global_commands(
                    db,
                    account=account,
                    application_id=application_id,
                    commands=command_list,
                )
            return command
        return _discord_command_error("Unknown application command", 10063, 404)

    if command_id is not None:
        return _discord_command_error("Method Not Allowed", 0, 405)

    command = _discord_command_shape(params, application_id=application_id)
    command_list = commands.setdefault(scope_key, [])
    _discord_upsert_command(command_list, command)
    await _store_discord_command_shadow(db, account=account, commands=commands)
    if scope_key == "global":
        await _fan_out_discord_global_commands(
            db,
            account=account,
            application_id=application_id,
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


def _discord_command_shadow(account: ChannelAccount) -> dict[str, list[dict[str, Any]]]:
    config = account.config if isinstance(account.config, dict) else {}
    commands = config.get("discord_agent_commands")
    if not isinstance(commands, dict):
        return {}
    clean: dict[str, list[dict[str, Any]]] = {}
    for scope, value in commands.items():
        if isinstance(scope, str) and isinstance(value, list):
            clean[scope] = [item for item in value if isinstance(item, dict)]
    return clean


async def _store_discord_command_shadow(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    commands: dict[str, list[dict[str, Any]]],
) -> None:
    config = dict(account.config) if isinstance(account.config, dict) else {}
    config["discord_agent_commands"] = commands
    account.config = config
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
    source = command if isinstance(command, dict) else {}
    name = _optional_str(source.get("name"))
    if name is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="command name is required",
        )
    if name.startswith("bot_"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail='command names starting with "bot_" are reserved',
        )
    command_type = source.get("type") if isinstance(source.get("type"), int) else 1
    description = _optional_str(source.get("description"))
    if command_type == 1 and description is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="command description is required",
        )
    shaped = {
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
        "description": description or "",
        "type": command_type,
    }
    options = source.get("options")
    if isinstance(options, list):
        shaped["options"] = [option for option in options if isinstance(option, dict)]
    return shaped


def _discord_command_key(command: dict[str, Any]) -> tuple[int, str]:
    command_type = command.get("type") if isinstance(command.get("type"), int) else 1
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


async def _discord_guild_owned_by_account(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    guild_id: str,
) -> bool:
    owners = await _discord_guild_owner_ids(db, guild_id=guild_id)
    return owners == {account.id}


async def _discord_uncontested_guilds_for_account(
    db: AsyncSession,
    *,
    account: ChannelAccount,
) -> list[str]:
    result = await db.execute(
        select(ChannelBinding, ChannelAccount)
        .join(ChannelAccount, ChannelAccount.id == ChannelBinding.account_id)
        .where(
            ChannelAccount.provider == CHANNEL_PROVIDER_DISCORD,
            ChannelBinding.status == BINDING_STATUS_ACTIVE,
        )
    )
    owners_by_guild: dict[str, set[UUID]] = {}
    for binding, owner_account in result.all():
        guild_id = _discord_binding_guild_id(binding)
        if guild_id is None:
            continue
        owners_by_guild.setdefault(guild_id, set()).add(owner_account.id)
    return sorted(
        guild_id for guild_id, owners in owners_by_guild.items() if owners == {account.id}
    )


async def _discord_guild_owner_ids(db: AsyncSession, *, guild_id: str) -> set[UUID]:
    result = await db.execute(
        select(ChannelBinding, ChannelAccount)
        .join(ChannelAccount, ChannelAccount.id == ChannelBinding.account_id)
        .where(
            ChannelAccount.provider == CHANNEL_PROVIDER_DISCORD,
            ChannelBinding.status == BINDING_STATUS_ACTIVE,
        )
    )
    owners: set[UUID] = set()
    for binding, owner_account in result.all():
        if _discord_binding_guild_id(binding) == guild_id:
            owners.add(owner_account.id)
    return owners


def _discord_binding_guild_id(binding: ChannelBinding) -> str | None:
    chat_type = (binding.external_chat_type or "").lower()
    if binding.external_chat_name and ("guild" in chat_type or "thread" in chat_type):
        return binding.external_chat_name
    if binding.external_chat_id and chat_type == "guild":
        return binding.external_chat_id
    return None


async def _fan_out_discord_global_commands(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    application_id: str,
    commands: list[dict[str, Any]],
    guild_ids: set[str] | None = None,
) -> None:
    if not account.encrypted_provider_token or not account.provider_token_nonce:
        return
    token = decrypt_provider_token(account)
    uncontested_guild_ids = await _discord_uncontested_guilds_for_account(db, account=account)
    target_guild_ids = [
        guild_id
        for guild_id in uncontested_guild_ids
        if guild_ids is None or guild_id in guild_ids
    ]
    if not target_guild_ids:
        return
    base_url = settings.channel_discord_api_base_url.strip()
    await _validate_discord_provider_base_url(base_url)
    base_url = base_url.rstrip("/")
    headers = {
        "Authorization": f"Bot {token}",
        "Content-Type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            for guild_id in target_guild_ids:
                await client.put(
                    f"{base_url}/applications/{application_id}/guilds/{guild_id}/commands",
                    json=commands,
                    headers=headers,
                )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="discord api unreachable",
        ) from exc


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


async def _proxy_discord_request(
    *,
    account: ChannelAccount,
    request: Request,
    path: str,
) -> Response:
    token = decrypt_provider_token(account)
    normalized_path = f"/{path.lstrip('/')}"
    base_url = settings.channel_discord_api_base_url.strip()
    await _validate_discord_provider_base_url(base_url)
    url = f"{base_url.rstrip('/')}{normalized_path}"
    body = await request.body()
    headers = {
        "Authorization": f"Bot {token}",
        "Content-Type": request.headers.get("content-type", "application/json"),
    }
    decision = discord_rate_limiter.check(request.method, normalized_path)
    if not decision.allowed:
        rate_limit_rejects.labels(
            channel="discord",
            scope="bot" if decision.global_limit else "route",
        ).inc()
        return Response(
            content=json.dumps(
                {
                    "message": "You are being rate limited.",
                    "retry_after": decision.retry_after_seconds,
                    "global": decision.global_limit,
                }
            ),
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            media_type="application/json",
            headers={"Retry-After": str(decision.retry_after_seconds or 1)},
        )
    try:
        with track_proxy_latency("discord", request.method):
            async with httpx.AsyncClient(timeout=20.0) as client:
                discord_rate_limiter.consume(request.method, normalized_path)
                response = await client.request(
                    request.method,
                    url,
                    content=body if body else None,
                    headers=headers,
                    params=request.query_params,
                )
                discord_rate_limiter.observe(
                    request.method,
                    normalized_path,
                    response.headers,
                    response.status_code,
                )
    except httpx.HTTPError as exc:
        outbound_errors.labels(channel="discord", method=request.method).inc()
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="discord api unreachable",
        ) from exc
    outbound_messages.labels(channel="discord", method=request.method).inc()
    if response.status_code >= 400:
        outbound_errors.labels(channel="discord", method=request.method).inc()
    return Response(
        content=response.content,
        status_code=response.status_code,
        media_type=response.headers.get("content-type", "application/json"),
    )


async def _validate_discord_provider_base_url(base_url: str) -> None:
    try:
        await validate_channel_http_url(base_url, label="discord api base url")
    except UnsafeOutboundUrlError as exc:
        outbound_errors.labels(channel="discord", method="provider_url").inc()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
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


def _whatsapp_graph_text(params: dict[str, Any]) -> str:
    text = params.get("text")
    if isinstance(text, dict):
        body = _optional_str(text.get("body"))
        if body:
            return body
    body = _optional_str(params.get("body"))
    if body:
        return body
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="text.body is required")


def _binding_response(binding: ChannelBinding) -> ChannelBindingResponse:
    return ChannelBindingResponse(
        id=binding.id,
        account_id=binding.account_id,
        agent_link_id=binding.bot_agent_link_id,
        external_chat_id=binding.external_chat_id,
        external_chat_type=binding.external_chat_type,
        external_chat_name=binding.external_chat_name,
        status=binding.status,
        created_at=binding.created_at,
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
