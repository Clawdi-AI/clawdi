from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import httpx
from fastapi import (
    APIRouter,
    Depends,
    Header,
    HTTPException,
    Request,
    Response,
    status,
)
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_session
from app.models.channel import (
    BINDING_STATUS_ACTIVE,
    BOT_AGENT_LINK_STATUS_ACTIVE,
    CHANNEL_PROVIDER_TELEGRAM,
    ChannelAccount,
    ChannelBinding,
    ChannelBotAgentLink,
)
from app.routes.channel_routers.shared import (
    _allowed_updates,
    _deliver_telegram_agent_webhook,
    _json_object,
    _optional_int_param,
    _optional_str,
    _request_params,
    _telegram_error,
    _telegram_link_webhook_url,
    _telegram_me,
    _telegram_ok,
    _validate_agent_webhook_url,
)
from app.schemas.channel import TelegramWebhookResponse
from app.services.channels import (
    TELEGRAM_REF_CALLBACK_QUERY_ID,
    TELEGRAM_REF_FILE_ID,
    TELEGRAM_REF_FILE_PATH,
    channel_agent_reference_exists,
    decrypt_provider_token,
    drop_pending_telegram_updates,
    find_binding,
    get_active_channel_account,
    parse_pair_command,
    pending_channel_inbox_count,
    record_channel_agent_reference,
    record_inactive_bot_agent_link_event,
    record_inbound_messages_for_bindings,
    record_telegram_update_references,
    resolve_channel_agent_by_token,
    resolve_inbound_binding,
    send_pairing_command_reply,
    telegram_chat_from_update,
    telegram_external_user_id_from_update,
    telegram_message_id_from_update,
    telegram_text_from_update,
    verify_hashed_token,
    wait_for_telegram_updates,
)
from app.services.metrics import (
    outbound_errors,
    outbound_messages,
    rate_limit_rejects,
    track_proxy_latency,
)
from app.services.telegram_rate_limiter import telegram_rate_limiter
from app.services.url_security import UnsafeOutboundUrlError, validate_channel_http_url

router = APIRouter(prefix="/api/channels/telegram", tags=["channels"])


@router.api_route(
    "/bot/{agent_token}/{method}",
    methods=["GET", "POST"],
    include_in_schema=False,
    response_model=None,
)
@router.api_route(
    "/bot{agent_token}/{method}",
    methods=["GET", "POST"],
    include_in_schema=False,
    response_model=None,
)
async def telegram_bot_api(
    agent_token: str,
    method: str,
    request: Request,
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    agent = await resolve_channel_agent_by_token(
        db,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        token=agent_token,
    )
    account = agent.account
    raw_body = await request.body()
    params = await _request_params(request)
    method_key = method.lower()

    if method_key == "getme":
        if account.encrypted_provider_token and account.provider_token_nonce:
            return await _proxy_telegram_bot_method(
                account=account,
                method="getMe",
                request=request,
                raw_body=raw_body,
            )
        return _telegram_ok(_telegram_me(account, agent_token))
    if method_key == "getupdates":
        if _telegram_link_webhook_url(agent.link):
            return _telegram_error_response(
                "Conflict: can't use getUpdates method while webhook is active",
                409,
            )
        offset = _optional_int_param(params.get("offset"))
        limit = max(1, min(_optional_int_param(params.get("limit")) or 100, 100))
        timeout = _optional_int_param(params.get("timeout"))
        timeout_seconds = max(
            0.0,
            min(float(timeout or 0), settings.channel_long_poll_max_seconds),
        )
        updates = await wait_for_telegram_updates(
            db,
            account=account,
            bot_agent_link_id=agent.link.id,
            offset=offset,
            limit=limit,
            allowed_updates=_allowed_updates(params.get("allowed_updates")),
            timeout_seconds=timeout_seconds,
        )
        await db.commit()
        return _telegram_ok(updates)
    if method_key == "setwebhook":
        webhook_url = _optional_str(params.get("url"))
        if webhook_url is None:
            return _telegram_error_response("Bad Request: url is required", 400)
        webhook_error = await _validate_telegram_webhook_url(account, webhook_url)
        if webhook_error is not None:
            return webhook_error
        _set_link_config(
            agent.link,
            {
                "telegram_webhook": {
                    "url": webhook_url,
                    "secret_token": _optional_str(params.get("secret_token")),
                },
            },
        )
        await db.commit()
        return _telegram_ok(True)
    if method_key == "deletewebhook":
        config = dict(agent.link.config) if isinstance(agent.link.config, dict) else {}
        config.pop("telegram_webhook", None)
        agent.link.config = config
        if params.get("drop_pending_updates") is True:
            await drop_pending_telegram_updates(
                db,
                account=account,
                bot_agent_link_id=agent.link.id,
            )
        await db.commit()
        return _telegram_ok(True)
    if method_key == "getwebhookinfo":
        config = agent.link.config if isinstance(agent.link.config, dict) else {}
        webhook = config.get("telegram_webhook")
        webhook_url = webhook.get("url") if isinstance(webhook, dict) else ""
        return _telegram_ok(
            {
                "url": webhook_url or "",
                "has_custom_certificate": False,
                "pending_update_count": await pending_channel_inbox_count(
                    db,
                    account=account,
                    bot_agent_link_id=agent.link.id,
                ),
            }
        )
    if method_key == "setmycommands":
        command_error = await _validate_telegram_command_scope(
            db,
            account=account,
            bot_agent_link_id=agent.link.id,
            params=params,
        )
        if command_error is not None:
            return command_error
        _store_telegram_commands(agent.link, params=params)
        fanout_error = await _fan_out_telegram_commands(
            db,
            account=account,
            bot_agent_link_id=agent.link.id,
            method="setMyCommands",
            params=params,
        )
        if fanout_error is not None:
            return fanout_error
        await db.commit()
        return _telegram_ok(True)
    if method_key == "deletemycommands":
        command_error = await _validate_telegram_command_scope(
            db,
            account=account,
            bot_agent_link_id=agent.link.id,
            params=params,
        )
        if command_error is not None:
            return command_error
        _delete_telegram_commands(agent.link, params=params)
        fanout_error = await _fan_out_telegram_commands(
            db,
            account=account,
            bot_agent_link_id=agent.link.id,
            method="deleteMyCommands",
            params=params,
        )
        if fanout_error is not None:
            return fanout_error
        await db.commit()
        return _telegram_ok(True)
    if method_key == "getmycommands":
        command_error = await _validate_telegram_command_scope(
            db,
            account=account,
            bot_agent_link_id=agent.link.id,
            params=params,
        )
        if command_error is not None:
            return command_error
        return _telegram_ok(_get_telegram_commands(agent.link, params=params))

    profile_result = await _handle_telegram_profile_shadow(account, method_key, params)
    if profile_result is not None:
        await db.commit()
        return profile_result

    if method_key == "getfile":
        return await _handle_telegram_get_file(
            db,
            account=account,
            bot_agent_link_id=agent.link.id,
            params=params,
            raw_body=raw_body,
            request=request,
        )
    if method_key == "answercallbackquery":
        return await _handle_telegram_callback_answer(
            db,
            account=account,
            bot_agent_link_id=agent.link.id,
            method=method,
            params=params,
            raw_body=raw_body,
            request=request,
        )

    outbound_error = await _validate_telegram_outbound_scope(
        db,
        account=account,
        bot_agent_link_id=agent.link.id,
        params=params,
    )
    if outbound_error is not None:
        return outbound_error
    chat_id = _optional_str(params.get("chat_id"))
    if chat_id is not None:
        rate_limit = telegram_rate_limiter.check_and_consume(
            account_id=str(account.id),
            method=method,
            chat_id=chat_id,
        )
        if not rate_limit.allowed:
            rate_limit_rejects.labels(channel="telegram", scope="chat").inc()
            retry_after = rate_limit.retry_after_seconds or 1
            return JSONResponse(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                content={
                    "ok": False,
                    "error_code": 429,
                    "description": f"Too Many Requests: retry after {retry_after}",
                    "parameters": {"retry_after": retry_after},
                },
                headers={"Retry-After": str(retry_after)},
            )

    return await _proxy_telegram_bot_method(
        account=account,
        method=method,
        request=request,
        raw_body=raw_body,
    )


@router.get(
    "/file/bot/{agent_token}/{file_path:path}",
    include_in_schema=False,
    response_model=None,
)
@router.get(
    "/file/bot{agent_token}/{file_path:path}",
    include_in_schema=False,
    response_model=None,
)
async def telegram_file_api(
    agent_token: str,
    file_path: str,
    db: AsyncSession = Depends(get_session),
):
    agent = await resolve_channel_agent_by_token(
        db,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        token=agent_token,
    )
    account = agent.account
    if not file_path or file_path.startswith("/"):
        return _telegram_error_response("Bad Request: file_path is required", 400)
    if not await channel_agent_reference_exists(
        db,
        account=account,
        ref_kind=TELEGRAM_REF_FILE_PATH,
        ref_value=file_path,
        bot_agent_link_id=agent.link.id,
    ):
        return _telegram_error_response(
            "Forbidden: file_path is not bound to this bot",
            403,
        )

    provider_token = decrypt_provider_token(account)
    base_url = settings.channel_telegram_api_base_url.strip()
    await _validate_telegram_provider_base_url(base_url)
    url = f"{base_url.rstrip('/')}/file/bot{provider_token}/{file_path}"
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(url)
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="telegram api unreachable",
        ) from exc
    return Response(
        content=response.content,
        status_code=response.status_code,
        media_type=response.headers.get("content-type", "application/octet-stream"),
        headers=_telegram_passthrough_headers(response),
    )


@router.post(
    "/{account_id}/webhook",
    include_in_schema=False,
)
async def telegram_webhook(
    account_id: UUID,
    request: Request,
    x_telegram_bot_api_secret_token: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
) -> TelegramWebhookResponse:
    account = await get_active_channel_account(db, account_id=account_id)
    if account.provider != CHANNEL_PROVIDER_TELEGRAM:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="channel not found")
    if not x_telegram_bot_api_secret_token or not verify_hashed_token(
        x_telegram_bot_api_secret_token,
        account.webhook_secret_hash,
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid webhook secret"
        )

    payload = await _json_object(request)
    _ensure_telegram_bot_command_entities(payload)
    chat = telegram_chat_from_update(payload)
    if chat is None:
        return TelegramWebhookResponse(ok=True)

    external_chat_id, external_chat_type, external_chat_name = chat
    text = telegram_text_from_update(payload)
    command = parse_pair_command(text)
    binding_result = await resolve_inbound_binding(
        db,
        account=account,
        external_chat_id=external_chat_id,
        external_chat_type=external_chat_type,
        external_chat_name=external_chat_name,
        external_user_id=telegram_external_user_id_from_update(payload),
        text=text,
        command=command,
    )

    messages = await record_inbound_messages_for_bindings(
        db,
        account=account,
        binding_result=binding_result,
        external_chat_id=external_chat_id,
        provider_message_id=telegram_message_id_from_update(payload),
        text=text,
        payload=payload,
    )
    message = messages[0][0]
    for routed_message, binding in messages:
        await record_telegram_update_references(
            db,
            account=account,
            binding=binding,
            message=routed_message,
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
    await _replay_telegram_commands_on_pair(
        db,
        account=account,
        binding=binding_result.binding if binding_result.paired else None,
    )
    if messages and message.binding_id and not binding_result.command_handled:
        delivered_at = datetime.now(UTC)
        for routed_message, binding in messages:
            delivered = await _deliver_telegram_agent_webhook_for_binding(
                db,
                account=account,
                binding=binding,
                payload=payload,
            )
            if delivered:
                routed_message.delivered_at = delivered_at
        await db.commit()
    return TelegramWebhookResponse(
        ok=True,
        paired=binding_result.paired,
        unpaired=binding_result.unpaired,
        binding_id=message.binding_id,
    )


def _telegram_error_response(description: str, error_code: int) -> JSONResponse:
    return JSONResponse(
        status_code=error_code,
        content=_telegram_error(description, error_code),
    )


async def _deliver_telegram_agent_webhook_for_binding(
    db: AsyncSession,
    *,
    account: Any,
    binding: ChannelBinding | None,
    payload: dict[str, Any],
) -> bool:
    if binding is None or binding.bot_agent_link_id is None:
        return False
    link = await db.get(ChannelBotAgentLink, binding.bot_agent_link_id)
    if link is None or link.status != BOT_AGENT_LINK_STATUS_ACTIVE or link.archived_at is not None:
        await record_inactive_bot_agent_link_event(
            db,
            account=account,
            binding=binding,
            link=link,
        )
        return False
    return await _deliver_telegram_agent_webhook(account, link, payload)


async def _validate_telegram_webhook_url(account: Any, url: str) -> JSONResponse | None:
    try:
        await _validate_agent_webhook_url(account, url)
    except HTTPException as exc:
        detail = exc.detail if isinstance(exc.detail, str) else "invalid webhook url"
        return _telegram_error_response(f"Bad Request: {detail}", 400)
    return None


def _set_link_config(link: ChannelBotAgentLink, updates: dict[str, Any]) -> None:
    config = dict(link.config) if isinstance(link.config, dict) else {}
    config.update(updates)
    link.config = config


def _telegram_command_scope_key(params: dict[str, Any]) -> str:
    scope = params.get("scope")
    if not isinstance(scope, dict):
        return "default"
    scope_type = _optional_str(scope.get("type"))
    if scope_type in {"default", "all_private_chats", "all_group_chats", "all_chat_administrators"}:
        return "default" if scope_type == "default" else scope_type
    chat_id = _optional_str(scope.get("chat_id"))
    if scope_type in {"chat", "chat_administrators"} and chat_id:
        return f"{scope_type}:{chat_id}"
    user_id = _optional_str(scope.get("user_id"))
    if scope_type == "chat_member" and chat_id and user_id:
        return f"chat_member:{chat_id}:{user_id}"
    return json.dumps(scope, sort_keys=True, separators=(",", ":"))


def _ensure_telegram_bot_command_entities(update: dict[str, Any]) -> None:
    for container_key in ("message", "edited_message", "channel_post", "edited_channel_post"):
        message = update.get(container_key)
        if not isinstance(message, dict):
            continue
        text = message.get("text")
        if not isinstance(text, str) or not text.startswith("/"):
            continue
        entities = message.get("entities")
        if isinstance(entities, list) and any(
            isinstance(entity, dict) and entity.get("type") == "bot_command" for entity in entities
        ):
            continue
        command_length = _telegram_command_length(text)
        if command_length == 0:
            continue
        clean_entities = (
            [entity for entity in entities if isinstance(entity, dict)]
            if isinstance(entities, list)
            else []
        )
        message["entities"] = [
            *clean_entities,
            {"type": "bot_command", "offset": 0, "length": command_length},
        ]


def _telegram_command_length(text: str) -> int:
    for index, char in enumerate(text):
        if index == 0:
            continue
        if char.isspace():
            return index
    return len(text)


def _telegram_language_code(params: dict[str, Any]) -> str:
    return _optional_str(params.get("language_code")) or ""


async def _validate_telegram_command_scope(
    db: AsyncSession,
    *,
    account: Any,
    bot_agent_link_id: UUID,
    params: dict[str, Any],
) -> JSONResponse | None:
    scope = params.get("scope")
    if not isinstance(scope, dict):
        return None
    scope_type = _optional_str(scope.get("type"))
    if scope_type not in {"chat", "chat_administrators", "chat_member"}:
        return None
    chat_id = _optional_str(scope.get("chat_id"))
    if chat_id is None:
        return _telegram_error_response("Bad Request: invalid scope", 400)
    if (
        await find_binding(
            db,
            account=account,
            external_chat_id=chat_id,
            bot_agent_link_id=bot_agent_link_id,
        )
        is None
    ):
        return _telegram_error_response("Forbidden: bot was blocked by the user", 403)
    return None


def _store_telegram_commands(link: ChannelBotAgentLink, *, params: dict[str, Any]) -> None:
    commands = params.get("commands")
    stored_commands = (
        [command for command in commands if isinstance(command, dict)]
        if isinstance(commands, list)
        else []
    )
    config = dict(link.config) if isinstance(link.config, dict) else {}
    shadow = config.get("telegram_agent_commands")
    command_shadow = dict(shadow) if isinstance(shadow, dict) else {}
    command_shadow[_telegram_command_shadow_key(params)] = stored_commands
    config["telegram_agent_commands"] = command_shadow
    link.config = config


def _delete_telegram_commands(link: ChannelBotAgentLink, *, params: dict[str, Any]) -> None:
    config = dict(link.config) if isinstance(link.config, dict) else {}
    shadow = config.get("telegram_agent_commands")
    command_shadow = dict(shadow) if isinstance(shadow, dict) else {}
    command_shadow.pop(_telegram_command_shadow_key(params), None)
    config["telegram_agent_commands"] = command_shadow
    link.config = config


def _get_telegram_commands(
    link: ChannelBotAgentLink,
    *,
    params: dict[str, Any],
) -> list[dict[str, Any]]:
    config = link.config if isinstance(link.config, dict) else {}
    shadow = config.get("telegram_agent_commands")
    command_shadow = shadow if isinstance(shadow, dict) else {}
    commands = command_shadow.get(_telegram_command_shadow_key(params))
    if isinstance(commands, list):
        return [command for command in commands if isinstance(command, dict)]
    return [
        {"command": "bot_pair", "description": "Pair this chat with Clawdi."},
        {"command": "bot_unpair", "description": "Disconnect this chat from Clawdi."},
    ]


def _telegram_command_shadow_key(params: dict[str, Any]) -> str:
    return f"{_telegram_command_scope_key(params)}:{_telegram_language_code(params)}"


async def _fan_out_telegram_commands(
    db: AsyncSession,
    *,
    account: Any,
    bot_agent_link_id: UUID,
    method: str,
    params: dict[str, Any],
) -> JSONResponse | None:
    if not account.encrypted_provider_token or not account.provider_token_nonce:
        return None

    scope = params.get("scope")
    scope_type = _optional_str(scope.get("type")) if isinstance(scope, dict) else None
    if isinstance(scope, dict) and scope_type not in {
        "default",
        "all_private_chats",
        "all_group_chats",
        "all_chat_administrators",
    }:
        response = await _post_telegram_command_payload(
            account=account,
            method=method,
            payload=_telegram_command_provider_payload(method, params, scope=scope),
        )
        if response.status_code >= 400:
            return JSONResponse(
                status_code=response.status_code,
                content=_telegram_response_json(response),
            )
        return None

    result = await db.execute(
        select(ChannelBinding).where(
            ChannelBinding.account_id == account.id,
            ChannelBinding.bot_agent_link_id == bot_agent_link_id,
            ChannelBinding.status == BINDING_STATUS_ACTIVE,
        )
    )
    scope_key = scope_type if isinstance(scope_type, str) and scope_type != "default" else "default"
    for binding in result.scalars().all():
        fanout_scope = _telegram_command_fanout_scope(binding, scope_key=scope_key)
        if fanout_scope is None:
            continue
        response = await _post_telegram_command_payload(
            account=account,
            method=method,
            payload=_telegram_command_provider_payload(
                method,
                params,
                scope=fanout_scope,
            ),
        )
        if response.status_code >= 400:
            return JSONResponse(
                status_code=response.status_code,
                content=_telegram_response_json(response),
            )
    return None


async def _replay_telegram_commands_on_pair(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    binding: ChannelBinding | None,
) -> None:
    if binding is None or not account.encrypted_provider_token or not account.provider_token_nonce:
        return
    link = await db.get(ChannelBotAgentLink, binding.bot_agent_link_id)
    if link is None or link.status != BOT_AGENT_LINK_STATUS_ACTIVE:
        return
    config = link.config if isinstance(link.config, dict) else {}
    shadow = config.get("telegram_agent_commands")
    if not isinstance(shadow, dict):
        return
    for key, commands in shadow.items():
        if not isinstance(key, str) or not isinstance(commands, list):
            continue
        scope_key, language_code = _telegram_command_shadow_parts(key)
        if scope_key not in {
            "default",
            "all_private_chats",
            "all_group_chats",
            "all_chat_administrators",
        }:
            continue
        scope = _telegram_command_fanout_scope(binding, scope_key=scope_key)
        if scope is None:
            continue
        payload: dict[str, Any] = {
            "commands": [command for command in commands if isinstance(command, dict)],
            "scope": scope,
        }
        if language_code:
            payload["language_code"] = language_code
        try:
            await _post_telegram_command_payload(
                account=account,
                method="setMyCommands",
                payload=payload,
            )
        except HTTPException:
            return


def _telegram_command_shadow_parts(key: str) -> tuple[str, str]:
    scope_key, separator, language_code = key.rpartition(":")
    if not separator:
        return key, ""
    return scope_key, language_code


def _telegram_command_fanout_scope(
    binding: ChannelBinding,
    *,
    scope_key: str,
) -> dict[str, Any] | None:
    chat_type = (binding.external_chat_type or "").lower()
    is_group = chat_type in {"group", "supergroup"}
    is_private = chat_type == "private" or not chat_type
    if scope_key == "default":
        return {
            "type": "chat_administrators" if is_group else "chat",
            "chat_id": binding.external_chat_id,
        }
    if scope_key == "all_private_chats" and is_private:
        return {"type": "chat", "chat_id": binding.external_chat_id}
    if scope_key == "all_group_chats" and is_group:
        return {"type": "chat", "chat_id": binding.external_chat_id}
    if scope_key == "all_chat_administrators" and is_group:
        return {"type": "chat_administrators", "chat_id": binding.external_chat_id}
    return None


def _telegram_command_provider_payload(
    method: str,
    params: dict[str, Any],
    *,
    scope: dict[str, Any],
) -> dict[str, Any]:
    payload: dict[str, Any] = {"scope": scope}
    language_code = _telegram_language_code(params)
    if language_code:
        payload["language_code"] = language_code
    if method.lower() == "setmycommands":
        commands = params.get("commands")
        payload["commands"] = commands if isinstance(commands, list) else []
    return payload


async def _post_telegram_command_payload(
    *,
    account: Any,
    method: str,
    payload: dict[str, Any],
) -> httpx.Response:
    provider_token = decrypt_provider_token(account)
    base_url = settings.channel_telegram_api_base_url.strip()
    await _validate_telegram_provider_base_url(base_url)
    url = f"{base_url.rstrip('/')}/bot{provider_token}/{method}"
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            return await client.post(url, json=payload)
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="telegram api unreachable",
        ) from exc


async def _handle_telegram_profile_shadow(
    account: Any,
    method_key: str,
    params: dict[str, Any],
) -> dict[str, Any] | JSONResponse | None:
    if method_key in {
        "setmyname",
        "setmydescription",
        "setmyshortdescription",
        "setmydefaultadministratorrights",
        "setchatmenubutton",
    }:
        value_result = _telegram_profile_set_value(method_key, params)
        if value_result is None:
            return _telegram_error_response(
                f"Bad Request: {_telegram_profile_required_hint(method_key)}",
                400,
            )
        field_key, value = value_result
        _set_telegram_profile_value(account, params=params, field_key=field_key, value=value)
        return _telegram_ok(True)

    if method_key in {
        "getmyname",
        "getmydescription",
        "getmyshortdescription",
        "getmydefaultadministratorrights",
        "getchatmenubutton",
    }:
        return _telegram_ok(_telegram_profile_get_value(account, method_key, params))
    return None


def _telegram_profile_set_value(
    method_key: str,
    params: dict[str, Any],
) -> tuple[str, Any] | None:
    if method_key == "setmyname":
        value = _optional_str(params.get("name"))
        return ("name", value) if value is not None else None
    if method_key == "setmydescription":
        value = _optional_str(params.get("description"))
        return ("description", value) if value is not None else None
    if method_key == "setmyshortdescription":
        value = _optional_str(params.get("short_description"))
        return ("short_description", value) if value is not None else None
    if method_key == "setmydefaultadministratorrights":
        if "rights" not in params:
            return None
        field_key = (
            "default_admin_rights:channels"
            if params.get("for_channels") is True
            else "default_admin_rights:groups"
        )
        return field_key, params.get("rights")
    if method_key == "setchatmenubutton":
        if params.get("chat_id") is not None:
            return None
        return "menu_button:default", params.get("menu_button") or {}
    return None


def _telegram_profile_required_hint(method_key: str) -> str:
    return {
        "setmyname": "name is required",
        "setmydescription": "description is required",
        "setmyshortdescription": "short_description is required",
        "setmydefaultadministratorrights": "rights is required",
        "setchatmenubutton": "menu_button is required (or supply chat_id for per-chat)",
    }.get(method_key, "invalid profile request")


def _set_telegram_profile_value(
    account: Any,
    *,
    params: dict[str, Any],
    field_key: str,
    value: Any,
) -> None:
    config = dict(account.config) if isinstance(account.config, dict) else {}
    profile = config.get("telegram_bot_profile")
    profile_shadow = dict(profile) if isinstance(profile, dict) else {}
    profile_shadow[_telegram_profile_key(params, field_key)] = value
    config["telegram_bot_profile"] = profile_shadow
    account.config = config


def _telegram_profile_get_value(
    account: Any,
    method_key: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    field_key = {
        "getmyname": "name",
        "getmydescription": "description",
        "getmyshortdescription": "short_description",
        "getmydefaultadministratorrights": (
            "default_admin_rights:channels"
            if params.get("for_channels") is True
            else "default_admin_rights:groups"
        ),
        "getchatmenubutton": "menu_button:default",
    }[method_key]
    config = account.config if isinstance(account.config, dict) else {}
    profile = config.get("telegram_bot_profile")
    profile_shadow = profile if isinstance(profile, dict) else {}
    stored = profile_shadow.get(_telegram_profile_key(params, field_key))
    if method_key == "getmyname":
        return {"name": stored if isinstance(stored, str) else ""}
    if method_key == "getmydescription":
        return {"description": stored if isinstance(stored, str) else ""}
    if method_key == "getmyshortdescription":
        return {"short_description": stored if isinstance(stored, str) else ""}
    if method_key == "getmydefaultadministratorrights":
        return stored if isinstance(stored, dict) else {}
    return stored if isinstance(stored, dict) else {"type": "default"}


def _telegram_profile_key(params: dict[str, Any], field_key: str) -> str:
    return f"{field_key}:{_telegram_language_code(params)}"


async def _handle_telegram_get_file(
    db: AsyncSession,
    *,
    account: Any,
    bot_agent_link_id: UUID,
    params: dict[str, Any],
    raw_body: bytes,
    request: Request,
) -> dict[str, Any] | JSONResponse:
    file_id = _optional_str(params.get("file_id"))
    if file_id is None:
        return _telegram_error_response("Bad Request: file_id is required", 400)
    if not await channel_agent_reference_exists(
        db,
        account=account,
        ref_kind=TELEGRAM_REF_FILE_ID,
        ref_value=file_id,
        bot_agent_link_id=bot_agent_link_id,
    ):
        return _telegram_error_response(
            "Forbidden: file_id is not bound to this bot",
            403,
        )
    response = await _telegram_provider_response(
        account=account,
        method="getFile",
        request=request,
        raw_body=raw_body,
    )
    response_payload = _telegram_response_json(response)
    if response.status_code >= 400:
        return JSONResponse(status_code=response.status_code, content=response_payload)
    result = response_payload.get("result")
    file_path = result.get("file_path") if isinstance(result, dict) else None
    if response_payload.get("ok") is True and isinstance(file_path, str) and file_path:
        await record_channel_agent_reference(
            db,
            account=account,
            ref_kind=TELEGRAM_REF_FILE_PATH,
            ref_value=file_path,
            bot_agent_link_id=bot_agent_link_id,
            metadata={"file_id": file_id},
        )
        await db.commit()
    return response_payload


async def _handle_telegram_callback_answer(
    db: AsyncSession,
    *,
    account: Any,
    bot_agent_link_id: UUID,
    method: str,
    params: dict[str, Any],
    raw_body: bytes,
    request: Request,
) -> dict[str, Any] | JSONResponse:
    callback_query_id = _optional_str(params.get("callback_query_id"))
    if callback_query_id is None:
        return _telegram_error_response("Bad Request: callback_query_id is required", 400)
    if not await channel_agent_reference_exists(
        db,
        account=account,
        ref_kind=TELEGRAM_REF_CALLBACK_QUERY_ID,
        ref_value=callback_query_id,
        bot_agent_link_id=bot_agent_link_id,
    ):
        return _telegram_error_response(
            "Forbidden: callback_query_id is not bound to this bot",
            403,
        )
    response = await _telegram_provider_response(
        account=account,
        method=method,
        request=request,
        raw_body=raw_body,
    )
    payload = _telegram_response_json(response)
    if response.status_code >= 400:
        return JSONResponse(status_code=response.status_code, content=payload)
    return payload


async def _validate_telegram_outbound_scope(
    db: AsyncSession,
    *,
    account: Any,
    bot_agent_link_id: UUID,
    params: dict[str, Any],
) -> JSONResponse | None:
    chat_id = _optional_str(params.get("chat_id"))
    if chat_id is None:
        return _telegram_error_response("Forbidden: method requires a bound chat_id", 403)
    if (
        await find_binding(
            db,
            account=account,
            external_chat_id=chat_id,
            bot_agent_link_id=bot_agent_link_id,
        )
        is None
    ):
        return _telegram_error_response("Forbidden: bot was blocked by the user", 403)

    for ref_chat_id in _referenced_telegram_chat_ids(params):
        if (
            await find_binding(
                db,
                account=account,
                external_chat_id=ref_chat_id,
                bot_agent_link_id=bot_agent_link_id,
            )
            is None
        ):
            return _telegram_error_response(
                "Forbidden: referenced chat is not bound to this bot",
                403,
            )
    return None


def _referenced_telegram_chat_ids(params: dict[str, Any]) -> set[str]:
    chat_ids: set[str] = set()
    from_chat_id = _optional_str(params.get("from_chat_id"))
    if from_chat_id is not None:
        chat_ids.add(from_chat_id)
    reply_parameters = params.get("reply_parameters")
    if isinstance(reply_parameters, dict):
        reply_chat_id = _optional_str(reply_parameters.get("chat_id"))
        if reply_chat_id is not None:
            chat_ids.add(reply_chat_id)
    return chat_ids


async def _proxy_telegram_json_method(
    *,
    account: Any,
    method: str,
    request: Request,
    raw_body: bytes,
) -> dict[str, Any]:
    response = await _telegram_provider_response(
        account=account,
        method=method,
        request=request,
        raw_body=raw_body,
    )
    return _telegram_response_json(response)


def _telegram_response_json(response: Any) -> dict[str, Any]:
    try:
        payload = response.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="telegram api returned invalid json",
        ) from exc
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="telegram api returned invalid json",
        )
    return payload


async def _proxy_telegram_bot_method(
    *,
    account: Any,
    method: str,
    request: Request,
    raw_body: bytes,
) -> Response:
    response = await _telegram_provider_response(
        account=account,
        method=method,
        request=request,
        raw_body=raw_body,
    )
    return Response(
        content=response.content,
        status_code=response.status_code,
        media_type=response.headers.get("content-type", "application/json"),
        headers=_telegram_passthrough_headers(response),
    )


async def _telegram_provider_response(
    *,
    account: Any,
    method: str,
    request: Request,
    raw_body: bytes,
) -> httpx.Response:
    provider_token = decrypt_provider_token(account)
    base_url = settings.channel_telegram_api_base_url.strip()
    await _validate_telegram_provider_base_url(base_url)
    url = f"{base_url.rstrip('/')}/bot{provider_token}/{method}"
    headers = {}
    content_type = request.headers.get("content-type")
    if content_type:
        headers["content-type"] = content_type
    forward_body = _resolve_telegram_attach_refs(raw_body, content_type or "")
    try:
        with track_proxy_latency("telegram", method):
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.request(
                    request.method,
                    url,
                    content=forward_body if forward_body else None,
                    headers=headers,
                    params=request.query_params,
                )
    except httpx.HTTPError as exc:
        outbound_errors.labels(channel="telegram", method=method).inc()
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="telegram api unreachable",
        ) from exc
    outbound_messages.labels(channel="telegram", method=method).inc()
    if response.status_code >= 400:
        outbound_errors.labels(channel="telegram", method=method).inc()
    return response


def _resolve_telegram_attach_refs(raw_body: bytes, content_type: str) -> bytes:
    if not raw_body or "multipart/form-data" not in content_type.lower():
        return raw_body
    boundary_match = re.search(r"boundary=([^;\s]+)", content_type)
    if boundary_match is None:
        return raw_body
    boundary = boundary_match.group(1).strip('"')
    separator = f"--{boundary}"
    raw = raw_body.decode("latin-1")
    parts = raw.split(separator)
    refs: dict[str, str] = {}
    ref_parts: dict[str, int] = {}

    for index, part in enumerate(parts[1:], start=1):
        if part.startswith("--"):
            continue
        header_end = part.find("\r\n\r\n")
        if header_end < 0:
            continue
        headers = part[:header_end]
        value = part[header_end + 4 :].removesuffix("\r\n")
        name = _multipart_part_name(headers)
        if name is None:
            continue
        attach_match = re.match(r"^attach://([^\r\n]+)", value)
        if attach_match is not None:
            refs[name] = attach_match.group(1)
        if _multipart_part_filename(headers) is not None:
            ref_parts[name] = index

    if not refs:
        return raw_body

    used_ref_parts: set[int] = set()
    rewritten_parts = [parts[0]]
    for index, part in enumerate(parts[1:], start=1):
        if part.startswith("--"):
            rewritten_parts.append(part)
            continue
        if index in used_ref_parts:
            continue
        header_end = part.find("\r\n\r\n")
        if header_end < 0:
            rewritten_parts.append(part)
            continue
        headers = part[:header_end]
        name = _multipart_part_name(headers)
        if name is None:
            rewritten_parts.append(part)
            continue
        ref_id = refs.get(name)
        ref_part_index = ref_parts.get(ref_id) if ref_id else None
        if ref_part_index is None:
            rewritten_parts.append(part)
            continue

        file_part = parts[ref_part_index]
        file_header_end = file_part.find("\r\n\r\n")
        if file_header_end < 0:
            rewritten_parts.append(part)
            continue
        file_headers = file_part[:file_header_end]
        file_body = file_part[file_header_end + 4 :]
        filename = _multipart_part_filename(file_headers) or "file"
        file_content_type = _multipart_part_content_type(file_headers)
        used_ref_parts.add(ref_part_index)
        rewritten_parts.append(
            "\r\n"
            f'Content-Disposition: form-data; name="{name}"; filename="{filename}"'
            f"\r\nContent-Type: {file_content_type}"
            f"\r\n\r\n{file_body}"
        )
    return separator.join(rewritten_parts).encode("latin-1")


def _multipart_part_name(headers: str) -> str | None:
    match = re.search(r'name="([^"]+)"', headers, flags=re.IGNORECASE)
    return match.group(1) if match else None


def _multipart_part_filename(headers: str) -> str | None:
    match = re.search(r'filename=("?)([^"\r\n;]+)\1', headers, flags=re.IGNORECASE)
    return match.group(2) if match else None


def _multipart_part_content_type(headers: str) -> str:
    match = re.search(r"content-type:([^\r\n]+)", headers, flags=re.IGNORECASE)
    return match.group(1).strip() if match else "application/octet-stream"


async def _validate_telegram_provider_base_url(base_url: str) -> None:
    try:
        await validate_channel_http_url(base_url, label="telegram api base url")
    except UnsafeOutboundUrlError as exc:
        outbound_errors.labels(channel="telegram", method="provider_url").inc()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc


def _telegram_passthrough_headers(response: Any) -> dict[str, str]:
    headers = getattr(response, "headers", {}) or {}
    passthrough: dict[str, str] = {}
    for key in ("content-length", "cache-control"):
        value = headers.get(key)
        if value:
            passthrough[key] = value
    return passthrough
