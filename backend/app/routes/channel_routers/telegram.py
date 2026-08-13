from __future__ import annotations

import hmac
import json
import logging
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TypeGuard
from urllib.parse import unquote_plus
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
from pydantic import JsonValue, TypeAdapter, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.datastructures import UploadFile

from app.core.config import settings
from app.core.database import get_session
from app.models.channel import (
    BINDING_STATUS_ACTIVE,
    BINDING_STATUS_ARCHIVED,
    BOT_AGENT_LINK_STATUS_ACTIVE,
    CHANNEL_PROVIDER_TELEGRAM,
    CHANNEL_STATUS_ACTIVE,
    CHANNEL_VISIBILITY_PUBLIC,
    MESSAGE_DIRECTION_OUTBOUND,
    ChannelAccount,
    ChannelBinding,
    ChannelBotAgentLink,
    ChannelMessage,
)
from app.routes.channel_routers.shared import (
    allowed_updates,
    json_object,
    optional_int_param,
    optional_str,
    request_params,
    telegram_error,
    telegram_me,
    telegram_ok,
)
from app.schemas.channel import TelegramWebhookResponse
from app.services.channel_webhooks import (
    deliver_telegram_agent_webhook,
    telegram_link_webhook_url,
    validate_agent_webhook_url,
)
from app.services.channels import (
    DEFAULT_CHANNEL_COMMANDS,
    TELEGRAM_REF_CALLBACK_QUERY_ID,
    TELEGRAM_REF_FILE_ID,
    TELEGRAM_REF_FILE_PATH,
    TELEGRAM_REF_MESSAGE_ID,
    ChannelAgentContext,
    ChannelControlCommand,
    InboundBindingResult,
    binding_is_controlled_by_actor,
    bot_agent_link_has_provider_cardinality_capability,
    bot_agent_link_has_strict_v2_authority,
    channel_agent_reference_exists,
    channel_control_command_event_was_handled,
    channel_runtime_account_key,
    channel_runtime_placeholder_token,
    decrypt_provider_token,
    drop_pending_telegram_updates,
    find_binding,
    find_existing_inbound_provider_event,
    find_platform_channel_runtime_marker,
    get_active_channel_account,
    lock_channel_binding_identity,
    parse_channel_control_command,
    pending_channel_inbox_count,
    record_channel_agent_reference,
    record_inactive_bot_agent_link_event,
    record_inbound_messages_for_bindings,
    record_platform_channel_runtime_marker,
    record_telegram_update_references,
    resolve_channel_agent_by_token,
    resolve_inbound_binding,
    send_control_command_reply,
    send_platform_unbound_channel_message,
    send_telegram_message,
    telegram_chat_from_update,
    telegram_direct_messages_topic_id_from_update,
    telegram_event_id_from_update,
    telegram_event_scope_from_update,
    telegram_external_user_id_from_update,
    telegram_file_ids,
    telegram_message_id_from_update,
    telegram_message_reference_value,
    telegram_message_thread_id_from_update,
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

router = APIRouter(prefix="/channels/telegram", tags=["channels"])
log = logging.getLogger(__name__)

TELEGRAM_UNPAIRED_TUTORIAL = (
    "This chat isn't paired yet. In Clawdi, open your agent's Telegram channel, "
    "choose Pair, then use the link or send /clawdi_pair <code> here."
)
TELEGRAM_UNPAIRED_TUTORIAL_COOLDOWN = timedelta(minutes=10)
_TELEGRAM_UNPAIRED_TUTORIAL_KIND = "telegram_unpaired_tutorial"
_JSON_VALUE_ADAPTER: TypeAdapter[JsonValue] = TypeAdapter(JsonValue)
_JSON_OBJECT_ADAPTER: TypeAdapter[dict[str, JsonValue]] = TypeAdapter(dict[str, JsonValue])
type _TelegramJsonObject = dict[str, JsonValue]
type _TelegramCommands = list[_TelegramJsonObject]
type _TelegramParam = JsonValue | UploadFile
type _TelegramParams = dict[str, _TelegramParam]


# Keep this list explicit. Telegram ignores parameters it doesn't use, so the
# presence of a bound chat_id must never authorize an unknown method.
# Payment and paid-media sends are deliberately absent: their follow-up
# updates have no chat identity, so a shared physical bot cannot attribute
# them to one Agent Link.
_TELEGRAM_CHAT_SCOPED_METHODS = frozenset(
    {
        "approvesuggestedpost",
        "approvechatjoinrequest",
        "banchatmember",
        "banchatsenderchat",
        "closeforumtopic",
        "closegeneralforumtopic",
        "copymessage",
        "copymessages",
        "createchatinvitelink",
        "createchatsubscriptioninvitelink",
        "createforumtopic",
        "declinechatjoinrequest",
        "declinesuggestedpost",
        "deleteallmessagereactions",
        "deletechatphoto",
        "deletechatstickerset",
        "deleteephemeralmessage",
        "deleteforumtopic",
        "deletemessage",
        "deletemessagereaction",
        "deletemessages",
        "editchatinvitelink",
        "editchatsubscriptioninvitelink",
        "editephemeralmessagecaption",
        "editephemeralmessagemedia",
        "editephemeralmessagereplymarkup",
        "editephemeralmessagetext",
        "editforumtopic",
        "editgeneralforumtopic",
        "editmessagecaption",
        "editmessagechecklist",
        "editmessagelivelocation",
        "editmessagemedia",
        "editmessagereplymarkup",
        "editmessagetext",
        "exportchatinvitelink",
        "forwardmessage",
        "forwardmessages",
        "getchat",
        "getchatadministrators",
        "getchatgifts",
        "getchatmember",
        "getchatmembercount",
        "getchatmemberscount",
        "getgamehighscores",
        "getuserchatboosts",
        "hidegeneralforumtopic",
        "kickchatmember",
        "leavechat",
        "pinchatmessage",
        "promotechatmember",
        "removechatverification",
        "reopenforumtopic",
        "reopengeneralforumtopic",
        "restrictchatmember",
        "revokechatinvitelink",
        "sendanimation",
        "sendaudio",
        "sendchataction",
        "sendchecklist",
        "sendcontact",
        "senddice",
        "senddocument",
        "sendgame",
        "sendlivephoto",
        "sendlocation",
        "sendmediagroup",
        "sendmessage",
        "sendmessagedraft",
        "sendphoto",
        "sendpoll",
        "sendrichmessage",
        "sendrichmessagedraft",
        "sendsticker",
        "sendvenue",
        "sendvideo",
        "sendvideonote",
        "sendvoice",
        "setchatadministratorcustomtitle",
        "setchatdescription",
        "setchatmembertag",
        "setchatpermissions",
        "setchatphoto",
        "setchatstickerset",
        "setchattitle",
        "setgamescore",
        "setmessagereaction",
        "stopmessagelivelocation",
        "stoppoll",
        "unbanchatmember",
        "unbanchatsenderchat",
        "unhidegeneralforumtopic",
        "unpinallchatmessages",
        "unpinallforumtopicmessages",
        "unpinallgeneralforumtopicmessages",
        "unpinchatmessage",
        "verifychat",
    }
)

# These parameters select resources in addition to the method's primary chat.
_TELEGRAM_REFERENCED_CHAT_PATHS = (
    ("from_chat_id",),
    ("sender_chat_id",),
    ("actor_chat_id",),
    ("reply_parameters", "chat_id"),
)

_TELEGRAM_SOURCE_MESSAGE_METHODS = frozenset(
    {"copymessage", "copymessages", "forwardmessage", "forwardmessages"}
)

# Bot API 10.2 accepts direct_messages_topic_id only on message sends. The
# managed runtimes expose a channel-DM topic as message_thread_id, so translate
# that compatibility field only for methods that actually use the direct topic.
_TELEGRAM_DIRECT_TOPIC_SEND_METHODS = frozenset(
    {
        "copymessage",
        "copymessages",
        "forwardmessage",
        "forwardmessages",
        "sendanimation",
        "sendaudio",
        "sendchecklist",
        "sendcontact",
        "senddice",
        "senddocument",
        "sendgame",
        "sendlivephoto",
        "sendlocation",
        "sendmediagroup",
        "sendmessage",
        "sendphoto",
        "sendpoll",
        "sendrichmessage",
        "sendsticker",
        "sendvenue",
        "sendvideo",
        "sendvideonote",
        "sendvoice",
    }
)

_TELEGRAM_BROAD_COMMAND_SCOPE_TYPES = frozenset(
    {
        "default",
        "all_private_chats",
        "all_group_chats",
        "all_chat_administrators",
    }
)
_TELEGRAM_CHAT_COMMAND_SCOPE_TYPES = frozenset({"chat", "chat_administrators", "chat_member"})
TELEGRAM_UI_UNPAIR_REPLY = "Unpaired. This chat is no longer connected to an agent."
_TELEGRAM_RESERVED_COMMANDS = tuple(
    {"command": command["name"], "description": command["description"]}
    for command in DEFAULT_CHANNEL_COMMANDS
)
_TELEGRAM_RESERVED_COMMAND_NAMES = frozenset(
    command["command"] for command in _TELEGRAM_RESERVED_COMMANDS
)


@dataclass(frozen=True)
class TelegramBindingUnpairOutcome:
    notification_sent: bool
    commands_cleared: bool
    menu_reset: bool


_TELEGRAM_FILE_FIELD_NAMES = frozenset(
    {
        "animation",
        "audio",
        "cover",
        "document",
        "file_id",
        "live_photo",
        "media",
        "photo",
        "sticker",
        "thumb",
        "thumbnail",
        "video",
        "video_note",
        "voice",
        "voice_note",
    }
)

_TELEGRAM_UNIQUE_TOP_LEVEL_PARAMETER_NAMES = frozenset(
    {
        "actor_chat_id",
        "allow_paid_broadcast",
        "business_connection_id",
        "callback_query_id",
        "chat_id",
        "commands",
        "direct_messages_topic_id",
        "file_id",
        "for_channels",
        "from_chat_id",
        "inline_message_id",
        "language_code",
        "menu_button",
        "message_id",
        "message_ids",
        "message_thread_id",
        "receiver_user_id",
        "reply_parameters",
        "rights",
        "scope",
        "secret_token",
        "sender_chat_id",
        "url",
        *_TELEGRAM_FILE_FIELD_NAMES,
    }
)

_TELEGRAM_UNIQUE_NESTED_PARAMETER_NAMES = {
    "menu_button": frozenset({"type"}),
    "reply_parameters": frozenset({"chat_id", "message_id"}),
    "scope": frozenset({"type", "chat_id", "user_id"}),
}


@router.api_route(
    "/bot/{routing_id}/{method}",
    methods=["GET", "POST"],
    include_in_schema=False,
    response_model=None,
)
@router.api_route(
    "/bot{routing_id}/{method}",
    methods=["GET", "POST"],
    include_in_schema=False,
    response_model=None,
)
async def telegram_bot_api(
    routing_id: str,
    method: str,
    request: Request,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
) -> _TelegramJsonObject | Response:
    agent, _agent_token = await _resolve_telegram_agent(
        db,
        routing_id=routing_id,
        authorization=authorization,
    )
    account = agent.account
    raw_body = await request.body()
    params = await _telegram_request_params(request)
    duplicate_parameter = await _telegram_duplicate_security_parameter(request, raw_body, params)
    if duplicate_parameter is not None:
        return _telegram_error_response(
            f"Bad Request: duplicate parameter {duplicate_parameter}", 400
        )
    if request.method != "GET":
        params = {**dict(request.query_params), **params}
    method_key = method.lower()

    if method_key == "getme":
        if account.encrypted_provider_token and account.provider_token_nonce:
            return await _proxy_telegram_bot_method(
                db,
                account=account,
                bot_agent_link_id=agent.link.id,
                method="getMe",
                request=request,
                raw_body=raw_body,
            )
        return telegram_ok(telegram_me(account))
    if method_key == "getupdates":
        if telegram_link_webhook_url(agent.link):
            return _telegram_error_response(
                "Conflict: can't use getUpdates method while webhook is active",
                409,
            )
        offset = optional_int_param(params.get("offset"))
        limit = max(1, min(optional_int_param(params.get("limit")) or 100, 100))
        timeout = optional_int_param(params.get("timeout"))
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
            allowed_updates=allowed_updates(params.get("allowed_updates")),
            timeout_seconds=timeout_seconds,
        )
        await db.commit()
        return telegram_ok(updates)
    if method_key == "setwebhook":
        webhook_url = optional_str(params.get("url"))
        if webhook_url is None:
            return _telegram_error_response("Bad Request: url is required", 400)
        webhook_error = await _validate_telegram_webhook_url(webhook_url)
        if webhook_error is not None:
            return webhook_error
        _set_link_config(
            agent.link,
            {
                "telegram_webhook": {
                    "url": webhook_url,
                    "secret_token": optional_str(params.get("secret_token")),
                },
            },
        )
        await db.commit()
        return telegram_ok(True)
    if method_key == "deletewebhook":
        config = dict(agent.link.config) if isinstance(agent.link.config, dict) else {}
        config.pop("telegram_webhook", None)
        agent.link.config = config
        if _telegram_boolean_param_is_true(params.get("drop_pending_updates")):
            await drop_pending_telegram_updates(
                db,
                account=account,
                bot_agent_link_id=agent.link.id,
            )
        await db.commit()
        return telegram_ok(True)
    if method_key == "getwebhookinfo":
        config = agent.link.config if isinstance(agent.link.config, dict) else {}
        webhook = config.get("telegram_webhook")
        webhook_url = webhook.get("url") if isinstance(webhook, dict) else ""
        return telegram_ok(
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
        commands = _telegram_json_parameter(params.get("commands"))
        try:
            _telegram_physical_commands(commands if _is_object_list(commands) else [])
        except ValueError:
            return _telegram_error_response(
                "Bad Request: merged command list exceeds 100 commands",
                400,
            )
        previous_shadow = _telegram_command_shadow(agent.link)
        _store_telegram_commands(agent.link, params=params)
        fanout_error = await _reconcile_telegram_commands_for_link(
            db,
            account=account,
            link=agent.link,
            previous_shadow=previous_shadow,
            provider_options=_telegram_command_provider_options(params),
        )
        if fanout_error is not None:
            return fanout_error
        await db.commit()
        return telegram_ok(True)
    if method_key == "deletemycommands":
        command_error = await _validate_telegram_command_scope(
            db,
            account=account,
            bot_agent_link_id=agent.link.id,
            params=params,
        )
        if command_error is not None:
            return command_error
        previous_shadow = _telegram_command_shadow(agent.link)
        _delete_telegram_commands(agent.link, params=params)
        fanout_error = await _reconcile_telegram_commands_for_link(
            db,
            account=account,
            link=agent.link,
            previous_shadow=previous_shadow,
            provider_options=_telegram_command_provider_options(params),
        )
        if fanout_error is not None:
            return fanout_error
        await db.commit()
        return telegram_ok(True)
    if method_key == "getmycommands":
        command_error = await _validate_telegram_command_scope(
            db,
            account=account,
            bot_agent_link_id=agent.link.id,
            params=params,
        )
        if command_error is not None:
            return command_error
        return telegram_ok(_get_telegram_commands(agent.link, params=params))

    profile_result = await _handle_telegram_profile_shadow(
        db, account, agent.link, method_key, params
    )
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

    outbound_error = await _authorize_telegram_chat_method(
        db,
        account=account,
        bot_agent_link_id=agent.link.id,
        method_key=method_key,
        params=params,
    )
    if outbound_error is not None:
        return outbound_error
    chat_id = optional_str(params.get("chat_id"))
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
        db,
        account=account,
        bot_agent_link_id=agent.link.id,
        method=method,
        request=request,
        raw_body=raw_body,
    )


@router.get(
    "/file/bot/{routing_id}/{file_path:path}",
    include_in_schema=False,
    response_model=None,
)
@router.get(
    "/file/bot{routing_id}/{file_path:path}",
    include_in_schema=False,
    response_model=None,
)
async def telegram_file_api(
    routing_id: str,
    file_path: str,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
):
    agent, _agent_token = await _resolve_telegram_agent(
        db,
        routing_id=routing_id,
        authorization=authorization,
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
    return _telegram_proxy_response(response)


async def _resolve_telegram_agent(
    db: AsyncSession,
    *,
    routing_id: str,
    authorization: str | None,
) -> tuple[ChannelAgentContext, str]:
    if authorization is None:
        raise _telegram_agent_auth_error()
    agent_token = _telegram_bearer_token(authorization)
    agent = await resolve_channel_agent_by_token(
        db,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        token=agent_token,
    )
    account_key = channel_runtime_account_key(agent.account.id)
    expected_routing_id = channel_runtime_placeholder_token(
        CHANNEL_PROVIDER_TELEGRAM,
        account_key,
    )
    if not hmac.compare_digest(routing_id, expected_routing_id):
        raise _telegram_agent_auth_error()
    return agent, agent_token


def _telegram_bearer_token(authorization: str) -> str:
    scheme, separator, value = authorization.partition(" ")
    if separator and scheme.lower() == "bearer" and value.strip():
        return value.strip()
    raise _telegram_agent_auth_error()


def _telegram_agent_auth_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="invalid telegram agent authorization",
        headers={"WWW-Authenticate": "Bearer"},
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

    payload = await _telegram_json_object(request)
    _ensure_telegram_bot_command_entities(payload)
    chat = telegram_chat_from_update(payload)
    if chat is None:
        return TelegramWebhookResponse(ok=True)

    external_chat_id, external_chat_type, external_chat_name = chat
    text = telegram_text_from_update(payload)
    command = parse_channel_control_command(text)
    provider_event_id = telegram_event_id_from_update(payload)
    provider_event_scope = telegram_event_scope_from_update(payload)
    external_user_id = telegram_external_user_id_from_update(payload)
    if await channel_control_command_event_was_handled(
        db,
        account=account,
        external_chat_id=external_chat_id,
        provider_event_id=provider_event_id,
        provider_event_scope=provider_event_scope,
        command=command,
    ):
        existing = await find_existing_inbound_provider_event(
            db,
            account=account,
            external_chat_id=external_chat_id,
            provider_event_id=provider_event_id,
            provider_event_scope=provider_event_scope,
        )
        return TelegramWebhookResponse(
            ok=True,
            binding_id=existing.binding_id if existing is not None else None,
        )
    previous_link_id: UUID | None = None
    if command is not None and command.kind in {"pair", "unpair"}:
        previous_binding = (
            await db.execute(
                select(ChannelBinding)
                .where(
                    ChannelBinding.account_id == account.id,
                    ChannelBinding.external_chat_id == external_chat_id,
                )
                .order_by(
                    (ChannelBinding.status == BINDING_STATUS_ACTIVE).desc(),
                    ChannelBinding.created_at.desc(),
                )
                .limit(1)
            )
        ).scalar_one_or_none()
        if previous_binding is not None:
            previous_link_id = previous_binding.bot_agent_link_id
    binding_result = await resolve_inbound_binding(
        db,
        account=account,
        external_chat_id=external_chat_id,
        external_chat_type=external_chat_type,
        external_chat_name=external_chat_name,
        external_user_id=external_user_id,
        text=text,
        command=command,
    )
    messages = await record_inbound_messages_for_bindings(
        db,
        account=account,
        binding_result=binding_result,
        external_chat_id=external_chat_id,
        provider_message_id=telegram_message_id_from_update(payload),
        provider_event_id=provider_event_id,
        provider_event_scope=provider_event_scope,
        text=text,
        payload=payload,
        suppress_duplicate_event=True,
        require_active_authority=not binding_result.command_handled,
    )
    if not messages:
        existing = await find_existing_inbound_provider_event(
            db,
            account=account,
            external_chat_id=external_chat_id,
            provider_event_id=provider_event_id,
            provider_event_scope=provider_event_scope,
        )
        if existing is not None:
            return TelegramWebhookResponse(ok=True, binding_id=existing.binding_id)
    message = messages[0][0] if messages else None
    for routed_message, binding in messages:
        await record_telegram_update_references(
            db,
            account=account,
            binding=binding,
            message=routed_message,
            payload=payload,
        )
    await db.commit()
    reply = await send_control_command_reply(
        db,
        account=account,
        external_chat_id=external_chat_id,
        telegram_message_thread_id=telegram_message_thread_id_from_update(payload),
        telegram_direct_messages_topic_id=telegram_direct_messages_topic_id_from_update(payload),
        command=command,
        binding_result=binding_result,
    )
    if reply is None:
        await _send_telegram_unpaired_tutorial(
            db,
            account=account,
            external_chat_id=external_chat_id,
            external_chat_type=external_chat_type,
            external_user_id=external_user_id,
            payload=payload,
            command=command,
            binding_result=binding_result,
        )
    await db.commit()
    if binding_result.paired or binding_result.unpaired:
        await _reconcile_telegram_link_state_after_binding_change(
            db,
            account=account,
            binding=binding_result.binding,
            previous_link_id=previous_link_id,
            paired=binding_result.paired,
            unpaired=binding_result.unpaired,
        )
        await db.commit()
    if message is not None and message.binding_id and not binding_result.command_handled:
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
        binding_id=message.binding_id if message is not None else None,
    )


async def _send_telegram_unpaired_tutorial(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    external_chat_id: str,
    external_chat_type: str | None,
    external_user_id: str | None,
    payload: _TelegramJsonObject,
    command: ChannelControlCommand | None,
    binding_result: InboundBindingResult,
) -> bool:
    message = payload.get("message")
    if (
        not isinstance(message, dict)
        or command is not None
        or binding_result.binding is not None
        or binding_result.bindings
    ):
        return False
    sender = message.get("from")
    if isinstance(sender, dict) and sender.get("is_bot") is True:
        return False

    direct_messages_topic_id = telegram_direct_messages_topic_id_from_update(payload)
    if external_chat_type == "private":
        cooldown_scope = f"private:{external_chat_id}"
    elif external_chat_type == "direct_messages" and direct_messages_topic_id is not None:
        cooldown_scope = f"direct_messages:{external_chat_id}:{direct_messages_topic_id}"
    else:
        return False

    marker: dict[str, JsonValue] = {
        "kind": _TELEGRAM_UNPAIRED_TUTORIAL_KIND,
        "scope": cooldown_scope,
    }
    try:
        async with db.begin_nested():
            await lock_channel_binding_identity(
                db,
                account_id=account.id,
                external_chat_id=external_chat_id,
            )
            active_binding = await find_binding(
                db,
                account=account,
                external_chat_id=external_chat_id,
            )
            if active_binding is not None and (
                external_chat_type != "direct_messages"
                or binding_is_controlled_by_actor(
                    active_binding,
                    external_user_id=external_user_id,
                )
            ):
                return False
            if account.visibility == CHANNEL_VISIBILITY_PUBLIC and account.user_id is None:
                now = datetime.now(UTC)
                runtime_marker = await find_platform_channel_runtime_marker(
                    db,
                    account=account,
                    kind=_TELEGRAM_UNPAIRED_TUTORIAL_KIND,
                    scope=cooldown_scope,
                )
                if (
                    runtime_marker is not None
                    and runtime_marker.outcome == "sent"
                    and runtime_marker.updated_at + TELEGRAM_UNPAIRED_TUTORIAL_COOLDOWN > now
                ):
                    return False
                await send_platform_unbound_channel_message(
                    account=account,
                    external_chat_id=external_chat_id,
                    text=TELEGRAM_UNPAIRED_TUTORIAL,
                    telegram_message_thread_id=telegram_message_thread_id_from_update(payload),
                    telegram_direct_messages_topic_id=direct_messages_topic_id,
                )
                record_platform_channel_runtime_marker(
                    db,
                    account=account,
                    marker=runtime_marker,
                    kind=_TELEGRAM_UNPAIRED_TUTORIAL_KIND,
                    scope=cooldown_scope,
                    outcome="sent",
                    occurred_at=datetime.now(UTC),
                )
                await db.flush()
                return True
            recent_tutorial = await db.scalar(
                select(ChannelMessage.id)
                .where(
                    ChannelMessage.account_id == account.id,
                    ChannelMessage.direction == MESSAGE_DIRECTION_OUTBOUND,
                    ChannelMessage.external_chat_id == external_chat_id,
                    ChannelMessage.created_at
                    >= datetime.now(UTC) - TELEGRAM_UNPAIRED_TUTORIAL_COOLDOWN,
                    ChannelMessage.payload.contains({"clawdi_system": marker}),
                )
                .limit(1)
            )
            if recent_tutorial is not None:
                return False
            tutorial = await send_telegram_message(
                db,
                account=account,
                external_chat_id=external_chat_id,
                text=TELEGRAM_UNPAIRED_TUTORIAL,
                bind_to_existing=False,
                message_thread_id=telegram_message_thread_id_from_update(payload),
                direct_messages_topic_id=direct_messages_topic_id,
            )
            tutorial_payload = dict(tutorial.payload) if isinstance(tutorial.payload, dict) else {}
            tutorial_payload["clawdi_system"] = marker
            tutorial.payload = tutorial_payload
            await db.flush()
            return True
    except HTTPException as exc:
        log.warning(
            "telegram_unpaired_tutorial_failed account_id=%s chat_id=%s status=%s",
            account.id,
            external_chat_id,
            exc.status_code,
        )
    except Exception:
        log.exception(
            "telegram_unpaired_tutorial_failed account_id=%s chat_id=%s",
            account.id,
            external_chat_id,
        )
    return False


def _telegram_error_response(description: str, error_code: int) -> JSONResponse:
    return JSONResponse(
        status_code=error_code,
        content=telegram_error(description, error_code),
    )


async def _deliver_telegram_agent_webhook_for_binding(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    binding: ChannelBinding | None,
    payload: _TelegramJsonObject,
) -> bool:
    if binding is None:
        return False
    authority = (
        await db.execute(
            select(ChannelBinding, ChannelAccount, ChannelBotAgentLink)
            .join(
                ChannelAccount,
                ChannelAccount.id == ChannelBinding.account_id,
            )
            .join(
                ChannelBotAgentLink,
                ChannelBotAgentLink.id == ChannelBinding.bot_agent_link_id,
            )
            .where(
                ChannelBinding.id == binding.id,
                ChannelBinding.account_id == account.id,
                ChannelBotAgentLink.account_id == account.id,
            )
            .execution_options(populate_existing=True)
            # The binding row is the data-plane fence. Account and Link
            # retirement archive this row in the same transaction, while
            # locking either parent here would invert the retirement order.
            .with_for_update(of=ChannelBinding)
        )
    ).one_or_none()
    if authority is None:
        return False
    current_binding, current_account, current_link = authority
    if (
        current_binding.status != BINDING_STATUS_ACTIVE
        or current_account.status != CHANNEL_STATUS_ACTIVE
        or current_account.archived_at is not None
    ):
        return False
    if current_link.status != BOT_AGENT_LINK_STATUS_ACTIVE or current_link.archived_at is not None:
        await record_inactive_bot_agent_link_event(
            db,
            account=current_account,
            binding=current_binding,
            link=current_link,
        )
        return False
    if not await bot_agent_link_has_strict_v2_authority(
        db,
        link=current_link,
    ) or not await bot_agent_link_has_provider_cardinality_capability(
        db,
        account=current_account,
        link=current_link,
    ):
        return False
    return await deliver_telegram_agent_webhook(current_link, payload)


async def _validate_telegram_webhook_url(url: str) -> JSONResponse | None:
    try:
        await validate_agent_webhook_url(url)
    except HTTPException as exc:
        return _telegram_error_response(f"Bad Request: {exc.detail}", 400)
    return None


def _set_link_config(link: ChannelBotAgentLink, updates: _TelegramJsonObject) -> None:
    config = dict(link.config) if isinstance(link.config, dict) else {}
    config.update(updates)
    link.config = config


def _telegram_json_parameter(value: object) -> object:
    if not isinstance(value, str) or not value.strip().startswith(("{", "[")):
        return value
    try:
        return _JSON_VALUE_ADAPTER.validate_json(value)
    except ValidationError:
        return value


def _is_object_list(value: object) -> TypeGuard[list[object]]:
    return isinstance(value, list)


def _is_object_mapping(value: object) -> TypeGuard[Mapping[object, object]]:
    return isinstance(value, Mapping)


def _json_object_or_none(value: object) -> dict[str, JsonValue] | None:
    try:
        return _JSON_OBJECT_ADAPTER.validate_python(value)
    except ValidationError:
        return None


def _telegram_response_json(response: httpx.Response) -> JsonValue | None:
    try:
        return _JSON_VALUE_ADAPTER.validate_json(response.content)
    except ValidationError:
        return None


def _telegram_json_value(value: object) -> JsonValue:
    try:
        return _JSON_VALUE_ADAPTER.validate_python(value)
    except ValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="invalid telegram parameter",
        ) from exc


async def _telegram_request_params(request: Request) -> _TelegramParams:
    raw_params = await request_params(request)
    params: _TelegramParams = {}
    for key, value in raw_params.items():
        if isinstance(value, UploadFile):
            params[key] = value
            continue
        params[key] = _telegram_json_value(value)
    return params


async def _telegram_json_object(request: Request) -> _TelegramJsonObject:
    return _JSON_OBJECT_ADAPTER.validate_python(await json_object(request))


class _TelegramJsonObjectPairs(list[tuple[str, object]]):
    pass


async def _telegram_duplicate_security_parameter(
    request: Request,
    raw_body: bytes,
    params: _TelegramParams,
) -> str | None:
    content_type = request.headers.get("content-type", "").lower()
    is_form = "application/x-www-form-urlencoded" in content_type
    is_multipart = "multipart/form-data" in content_type
    values: list[tuple[str, object]] = list(request.query_params.multi_items())
    if request.method != "GET":
        if is_form or is_multipart:
            values.extend((await request.form()).multi_items())
        else:
            duplicate_key = _telegram_json_duplicate_security_key(raw_body)
            if duplicate_key is not None:
                return duplicate_key
            values.extend(params.items())

    seen: set[str] = set()
    for key, value in values:
        if key in seen and key in _TELEGRAM_UNIQUE_TOP_LEVEL_PARAMETER_NAMES:
            return key
        seen.add(key)
        if isinstance(value, str) and value.strip().startswith(("{", "[")):
            duplicate_key = _telegram_json_duplicate_security_key(value, parameter_name=key)
            if duplicate_key is not None:
                return duplicate_key
    return None


def _telegram_json_duplicate_security_key(
    value: str | bytes,
    *,
    parameter_name: str | None = None,
) -> str | None:
    try:
        parsed = json.loads(value, object_pairs_hook=_TelegramJsonObjectPairs)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return _telegram_duplicate_security_key_in_value(
        parsed,
        parameter_name=parameter_name,
        request_root=parameter_name is None,
    )


def _telegram_duplicate_security_key_in_value(
    value: object,
    *,
    parameter_name: str | None,
    request_root: bool = False,
) -> str | None:
    if isinstance(value, _TelegramJsonObjectPairs):
        unique_names = (
            _TELEGRAM_UNIQUE_TOP_LEVEL_PARAMETER_NAMES
            if request_root
            else _TELEGRAM_FILE_FIELD_NAMES
            | _TELEGRAM_UNIQUE_NESTED_PARAMETER_NAMES.get(parameter_name or "", frozenset())
        )
        seen: set[str] = set()
        for key, item in value:
            if key in seen and key in unique_names:
                return key
            seen.add(key)
            duplicate_key = _telegram_duplicate_security_key_in_value(
                item,
                parameter_name=key,
            )
            if duplicate_key is not None:
                return duplicate_key
    elif _is_object_list(value):
        for item in value:
            duplicate_key = _telegram_duplicate_security_key_in_value(
                item,
                parameter_name=parameter_name,
            )
            if duplicate_key is not None:
                return duplicate_key
    return None


def _telegram_command_scope_key(params: _TelegramParams) -> str:
    scope = _json_object_or_none(_telegram_json_parameter(params.get("scope")))
    if scope is None:
        return "default"
    scope_type = optional_str(scope.get("type"))
    if scope_type in _TELEGRAM_BROAD_COMMAND_SCOPE_TYPES:
        return "default" if scope_type == "default" else scope_type
    chat_id = optional_str(scope.get("chat_id"))
    if scope_type in {"chat", "chat_administrators"} and chat_id:
        return f"{scope_type}:{chat_id}"
    user_id = optional_str(scope.get("user_id"))
    if scope_type == "chat_member" and chat_id and user_id:
        return f"chat_member:{chat_id}:{user_id}"
    return json.dumps(scope, sort_keys=True, separators=(",", ":"))


def _ensure_telegram_bot_command_entities(update: _TelegramJsonObject) -> None:
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


def _telegram_language_code(params: _TelegramParams) -> str:
    return optional_str(params.get("language_code")) or ""


async def _validate_telegram_command_scope(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID,
    params: _TelegramParams,
) -> JSONResponse | None:
    raw_scope = params.get("scope")
    if raw_scope is None:
        return None
    scope = _json_object_or_none(_telegram_json_parameter(raw_scope))
    if scope is None:
        return _telegram_error_response("Bad Request: invalid scope", 400)
    scope_type = optional_str(scope.get("type"))
    if scope_type in _TELEGRAM_BROAD_COMMAND_SCOPE_TYPES:
        return None
    if scope_type not in _TELEGRAM_CHAT_COMMAND_SCOPE_TYPES:
        return _telegram_error_response("Bad Request: invalid scope", 400)
    chat_id = optional_str(scope.get("chat_id"))
    if chat_id is None:
        return _telegram_error_response("Bad Request: invalid scope", 400)
    if scope_type == "chat_member" and optional_str(scope.get("user_id")) is None:
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


def _store_telegram_commands(link: ChannelBotAgentLink, *, params: _TelegramParams) -> None:
    commands = _telegram_json_parameter(params.get("commands"))
    stored_commands = _telegram_command_objects(commands)
    config = dict(link.config) if isinstance(link.config, dict) else {}
    command_shadow = _telegram_command_shadow(link)
    command_shadow[_telegram_command_shadow_key(params)] = stored_commands
    config["telegram_agent_commands"] = _JSON_VALUE_ADAPTER.validate_python(command_shadow)
    link.config = config


def _telegram_command_objects(value: object) -> _TelegramCommands:
    if not _is_object_list(value):
        return []
    commands: _TelegramCommands = []
    for item in value:
        command = _json_object_or_none(item)
        if command is not None:
            commands.append(command)
    return commands


def _delete_telegram_commands(link: ChannelBotAgentLink, *, params: _TelegramParams) -> None:
    config = dict(link.config) if isinstance(link.config, dict) else {}
    shadow = config.get("telegram_agent_commands")
    command_shadow = dict(shadow) if isinstance(shadow, dict) else {}
    command_shadow.pop(_telegram_command_shadow_key(params), None)
    config["telegram_agent_commands"] = command_shadow
    link.config = config


def _get_telegram_commands(
    link: ChannelBotAgentLink,
    *,
    params: _TelegramParams,
) -> _TelegramCommands:
    config = link.config if isinstance(link.config, dict) else {}
    shadow = config.get("telegram_agent_commands")
    command_shadow = shadow if isinstance(shadow, dict) else {}
    commands = command_shadow.get(_telegram_command_shadow_key(params))
    if isinstance(commands, list):
        return _telegram_command_objects(commands)
    return [dict(command) for command in _TELEGRAM_RESERVED_COMMANDS]


def _telegram_command_shadow(
    link: ChannelBotAgentLink,
) -> dict[str, _TelegramCommands]:
    config = link.config if isinstance(link.config, dict) else {}
    shadow = config.get("telegram_agent_commands")
    if not isinstance(shadow, dict):
        return {}
    return {
        key: _telegram_command_objects(commands)
        for key, commands in shadow.items()
        if isinstance(commands, list)
    }


def _telegram_physical_commands(agent_commands: Sequence[object] | None) -> _TelegramCommands:
    """Merge service and Link command ownership into one physical projection."""
    merged = [dict(command) for command in _TELEGRAM_RESERVED_COMMANDS]
    seen = set(_TELEGRAM_RESERVED_COMMAND_NAMES)
    for command in agent_commands or []:
        parsed_command = _json_object_or_none(command)
        if parsed_command is None:
            continue
        name = parsed_command.get("command")
        if isinstance(name, str) and name in seen:
            continue
        if isinstance(name, str):
            seen.add(name)
        merged.append(parsed_command)
    if len(merged) > 100:
        raise ValueError("telegram command projection exceeds provider limit")
    return merged


def _telegram_command_shadow_key(params: _TelegramParams) -> str:
    return f"{_telegram_command_scope_key(params)}:{_telegram_language_code(params)}"


def _telegram_shadow_commands(
    shadow: dict[str, _TelegramCommands],
    *,
    scope_key: str,
    language_code: str,
) -> _TelegramCommands | None:
    return shadow.get(f"{scope_key}:{language_code}")


def _telegram_resolve_shadow_commands(
    shadow: dict[str, _TelegramCommands],
    candidates: list[tuple[str, str]],
) -> _TelegramCommands | None:
    for scope_key, language_code in candidates:
        commands = _telegram_shadow_commands(
            shadow,
            scope_key=scope_key,
            language_code=language_code,
        )
        if commands is not None:
            return commands
    return None


def _telegram_binding_command_targets(
    shadow: dict[str, _TelegramCommands],
    binding: ChannelBinding,
) -> list[_TelegramJsonObject]:
    """Resolve Telegram's documented scope/language precedence for one chat."""
    languages = sorted(
        {
            language_code
            for key in shadow
            for _, language_code in [_telegram_command_shadow_parts(key)]
            if language_code
        }
    )
    chat_id = binding.external_chat_id
    chat_type = (binding.external_chat_type or "").lower()
    is_group = chat_type in {"group", "supergroup"}
    projections: list[_TelegramJsonObject] = []

    def add_resolved(
        *,
        scope: _TelegramJsonObject,
        language_code: str,
        scope_precedence: list[str],
    ) -> None:
        candidates: list[tuple[str, str]] = []
        for scope_key in scope_precedence:
            if language_code:
                candidates.append((scope_key, language_code))
            candidates.append((scope_key, ""))
        commands = _telegram_resolve_shadow_commands(shadow, candidates)
        if commands is None:
            return
        payload: _TelegramJsonObject = {
            "agent_commands": _JSON_VALUE_ADAPTER.validate_python(commands),
            "scope": scope,
        }
        if language_code:
            payload["language_code"] = language_code
        projections.append(payload)

    language_variants = ["", *languages]
    if is_group:
        for language_code in language_variants:
            add_resolved(
                scope={"type": "chat_administrators", "chat_id": chat_id},
                language_code=language_code,
                scope_precedence=[
                    f"chat_administrators:{chat_id}",
                    f"chat:{chat_id}",
                    "all_chat_administrators",
                    "all_group_chats",
                    "default",
                ],
            )
            add_resolved(
                scope={"type": "chat", "chat_id": chat_id},
                language_code=language_code,
                scope_precedence=[f"chat:{chat_id}", "all_group_chats", "default"],
            )
    else:
        for language_code in language_variants:
            add_resolved(
                scope={"type": "chat", "chat_id": chat_id},
                language_code=language_code,
                scope_precedence=[f"chat:{chat_id}", "all_private_chats", "default"],
            )

    for key, commands in sorted(shadow.items()):
        scope_key, language_code = _telegram_command_shadow_parts(key)
        parts = scope_key.split(":")
        if len(parts) != 3 or parts[0] != "chat_member" or parts[1] != chat_id:
            continue
        payload: _TelegramJsonObject = {
            "agent_commands": _JSON_VALUE_ADAPTER.validate_python(commands),
            "scope": {
                "type": "chat_member",
                "chat_id": chat_id,
                "user_id": parts[2],
            },
        }
        if language_code:
            payload["language_code"] = language_code
        projections.append(payload)
    return projections


def _telegram_materialize_command_target(target: _TelegramJsonObject) -> _TelegramJsonObject:
    agent_commands = target.get("agent_commands")
    payload: _TelegramJsonObject = {
        "commands": _JSON_VALUE_ADAPTER.validate_python(
            _telegram_physical_commands(
                agent_commands if isinstance(agent_commands, list) else None
            )
        ),
        "scope": target["scope"],
    }
    language_code = target.get("language_code")
    if isinstance(language_code, str) and language_code:
        payload["language_code"] = language_code
    return payload


def _telegram_projection_identity(payload: _TelegramJsonObject) -> str:
    return json.dumps(
        [payload.get("scope"), payload.get("language_code", "")],
        sort_keys=True,
        separators=(",", ":"),
    )


def _telegram_command_provider_options(params: _TelegramParams) -> _TelegramJsonObject:
    return {
        key: _telegram_json_value(_telegram_json_parameter(value))
        for key, value in params.items()
        if key not in {"commands", "scope", "language_code"}
    }


async def _reconcile_telegram_commands_for_link(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    link: ChannelBotAgentLink,
    previous_shadow: dict[str, _TelegramCommands] | None = None,
    provider_options: _TelegramJsonObject | None = None,
) -> Response | None:
    if not account.encrypted_provider_token or not account.provider_token_nonce:
        return None
    result = await db.execute(
        select(ChannelBinding).where(
            ChannelBinding.account_id == account.id,
            ChannelBinding.bot_agent_link_id == link.id,
            ChannelBinding.status == BINDING_STATUS_ACTIVE,
        )
    )
    desired_shadow = _telegram_command_shadow(link)
    reconciliations: list[
        tuple[
            dict[str, _TelegramJsonObject],
            dict[str, _TelegramJsonObject],
            dict[str, _TelegramJsonObject],
        ]
    ] = []
    for binding in result.scalars().all():
        desired_targets = {
            _telegram_projection_identity(target): target
            for target in _telegram_binding_command_targets(desired_shadow, binding)
        }
        try:
            desired = {
                identity: _telegram_materialize_command_target(target)
                for identity, target in desired_targets.items()
            }
        except ValueError:
            return _telegram_error_response(
                "Bad Request: merged command list exceeds 100 commands",
                400,
            )
        previous = {
            _telegram_projection_identity(target): target
            for target in _telegram_binding_command_targets(previous_shadow or {}, binding)
        }
        reconciliations.append((desired, desired_targets, previous))
    for desired, desired_targets, previous in reconciliations:
        for identity in sorted(desired):
            if desired_targets.get(identity) == previous.get(identity) and not provider_options:
                continue
            response = await _post_telegram_bot_payload(
                account=account,
                method="setMyCommands",
                payload={**(provider_options or {}), **desired[identity]},
            )
            if not _telegram_provider_call_succeeded(response):
                return _telegram_proxy_response(response)
        for identity in sorted(previous.keys() - desired.keys()):
            stale = previous[identity]
            payload = {"scope": stale["scope"]}
            if language_code := stale.get("language_code"):
                payload["language_code"] = language_code
            response = await _post_telegram_bot_payload(
                account=account,
                method="deleteMyCommands",
                payload={**(provider_options or {}), **payload},
            )
            if not _telegram_provider_call_succeeded(response):
                return _telegram_proxy_response(response)
    return None


async def _reconcile_telegram_link_state_after_binding_change(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    binding: ChannelBinding | None,
    previous_link_id: UUID | None,
    paired: bool,
    unpaired: bool,
) -> None:
    if binding is None or not (paired or unpaired):
        return
    await lock_channel_binding_identity(
        db,
        account_id=account.id,
        external_chat_id=binding.external_chat_id,
    )
    await db.refresh(binding)
    if paired and binding.status != BINDING_STATUS_ACTIVE:
        return
    if unpaired and binding.status != BINDING_STATUS_ARCHIVED:
        return
    current_link_id = binding.bot_agent_link_id if paired else None
    if previous_link_id is not None and previous_link_id != current_link_id:
        previous_link = await db.get(ChannelBotAgentLink, previous_link_id)
        if previous_link is not None:
            await _clear_telegram_commands_for_binding(
                account=account,
                link=previous_link,
                binding=binding,
            )
    if paired:
        await _replay_telegram_commands_on_pair(db, account=account, binding=binding)
    await _reconcile_telegram_menu_button_after_binding_change(
        db,
        account=account,
        binding=binding,
        paired=paired,
    )


async def _clear_telegram_commands_for_binding(
    *,
    account: ChannelAccount,
    link: ChannelBotAgentLink,
    binding: ChannelBinding,
) -> bool:
    if not account.encrypted_provider_token or not account.provider_token_nonce:
        return True
    succeeded = True
    targets = _telegram_binding_command_targets(_telegram_command_shadow(link), binding)
    for target in targets:
        payload: _TelegramJsonObject = {"scope": target["scope"]}
        if language_code := target.get("language_code"):
            payload["language_code"] = language_code
        try:
            response = await _post_telegram_bot_payload(
                account=account,
                method="deleteMyCommands",
                payload=payload,
            )
        except Exception:
            log.exception(
                "telegram_binding_command_cleanup_failed account_id=%s binding_id=%s",
                account.id,
                binding.id,
            )
            succeeded = False
            continue
        if not _telegram_provider_call_succeeded(response):
            succeeded = False
    return succeeded


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
    for target in _telegram_binding_command_targets(
        _telegram_command_shadow(link),
        binding,
    ):
        try:
            payload = _telegram_materialize_command_target(target)
        except ValueError:
            log.warning(
                "telegram_pair_command_replay_skipped_oversized_projection "
                "account_id=%s binding_id=%s",
                account.id,
                binding.id,
            )
            continue
        try:
            await _post_telegram_bot_payload(
                account=account,
                method="setMyCommands",
                payload=payload,
            )
        except HTTPException:
            return


async def _reconcile_telegram_menu_button_after_binding_change(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    binding: ChannelBinding,
    paired: bool,
) -> bool:
    if (
        not _telegram_binding_supports_menu_button(binding)
        or not account.encrypted_provider_token
        or not account.provider_token_nonce
    ):
        return True
    menu_button: _TelegramJsonObject = {"type": "default"}
    if paired:
        link = await db.get(ChannelBotAgentLink, binding.bot_agent_link_id)
        if link is not None and link.status == BOT_AGENT_LINK_STATUS_ACTIVE:
            menu_button = _telegram_menu_button_value(
                link,
                chat_id=binding.external_chat_id,
            )
    try:
        response = await _post_telegram_bot_payload(
            account=account,
            method="setChatMenuButton",
            payload={
                "chat_id": binding.external_chat_id,
                "menu_button": menu_button,
            },
        )
    except Exception:
        log.exception(
            "telegram_binding_menu_reconcile_failed account_id=%s binding_id=%s",
            account.id,
            binding.id,
        )
        return False
    return _telegram_provider_call_succeeded(response)


async def reconcile_telegram_binding_unpair_from_ui(
    *,
    db: AsyncSession,
    account: ChannelAccount,
    link: ChannelBotAgentLink,
    binding: ChannelBinding,
) -> TelegramBindingUnpairOutcome:
    """Best-effort provider cleanup after the binding archive is durable."""
    await lock_channel_binding_identity(
        db,
        account_id=account.id,
        external_chat_id=binding.external_chat_id,
    )
    await db.refresh(binding)
    if binding.status != BINDING_STATUS_ARCHIVED or binding.bot_agent_link_id != link.id:
        return TelegramBindingUnpairOutcome(
            notification_sent=True,
            commands_cleared=True,
            menu_reset=True,
        )
    commands_cleared = await _clear_telegram_commands_for_binding(
        account=account,
        link=link,
        binding=binding,
    )
    menu_reset = await _reconcile_telegram_menu_button_after_binding_change(
        db=db,
        account=account,
        binding=binding,
        paired=False,
    )
    notification_sent = False
    try:
        response = await _post_telegram_bot_payload(
            account=account,
            method="sendMessage",
            payload={
                "chat_id": binding.external_chat_id,
                "text": TELEGRAM_UI_UNPAIR_REPLY,
            },
        )
        notification_sent = _telegram_provider_call_succeeded(response)
    except Exception:
        log.exception(
            "telegram_binding_unpair_notification_failed account_id=%s binding_id=%s",
            account.id,
            binding.id,
        )
        notification_sent = False
    return TelegramBindingUnpairOutcome(
        notification_sent=notification_sent,
        commands_cleared=commands_cleared,
        menu_reset=menu_reset,
    )


async def reconcile_telegram_link_unlink(
    *,
    db: AsyncSession,
    account: ChannelAccount,
    link: ChannelBotAgentLink,
    bindings: list[ChannelBinding],
) -> bool:
    """Clear per-chat physical Bot API state for a durably archived Link."""
    succeeded = True
    for binding in bindings:
        await lock_channel_binding_identity(
            db,
            account_id=account.id,
            external_chat_id=binding.external_chat_id,
        )
        await db.refresh(binding)
        if binding.status != BINDING_STATUS_ARCHIVED or binding.bot_agent_link_id != link.id:
            continue
        commands_cleared = await _clear_telegram_commands_for_binding(
            account=account,
            link=link,
            binding=binding,
        )
        menu_reset = await _reconcile_telegram_menu_button_after_binding_change(
            db=db,
            account=account,
            binding=binding,
            paired=False,
        )
        succeeded = succeeded and commands_cleared and menu_reset
    if succeeded:
        config = dict(link.config) if isinstance(link.config, dict) else {}
        config.pop("telegram_agent_commands", None)
        config.pop("telegram_bot_profile", None)
        config.pop("telegram_webhook", None)
        link.config = config
    return succeeded


def _telegram_provider_call_succeeded(response: httpx.Response) -> bool:
    if response.status_code >= 400:
        return False
    payload = _telegram_response_json(response)
    return isinstance(payload, dict) and payload.get("ok") is not False


def _telegram_command_shadow_parts(key: str) -> tuple[str, str]:
    scope_key, separator, language_code = key.rpartition(":")
    if not separator:
        return key, ""
    return scope_key, language_code


async def _post_telegram_bot_payload(
    *,
    account: ChannelAccount,
    method: str,
    payload: _TelegramJsonObject,
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
    db: AsyncSession,
    account: ChannelAccount,
    link: ChannelBotAgentLink,
    method_key: str,
    params: _TelegramParams,
) -> _TelegramJsonObject | Response | None:
    if method_key == "setchatmenubutton":
        return await _set_telegram_chat_menu_button(db, account, link, params)
    if method_key == "getchatmenubutton":
        return await _get_telegram_chat_menu_button(db, account, link, params)
    if method_key in {
        "setmyname",
        "setmydescription",
        "setmyshortdescription",
        "setmydefaultadministratorrights",
    }:
        value_result = _telegram_profile_set_value(method_key, params)
        if value_result is None:
            return _telegram_error_response(
                f"Bad Request: {_telegram_profile_required_hint(method_key)}",
                400,
            )
        field_key, value = value_result
        _set_telegram_profile_value(link, params=params, field_key=field_key, value=value)
        return telegram_ok(True)

    if method_key in {
        "getmyname",
        "getmydescription",
        "getmyshortdescription",
        "getmydefaultadministratorrights",
    }:
        allow_legacy_fallback = await _telegram_profile_legacy_fallback_is_safe(
            db, account_id=link.account_id
        )
        return telegram_ok(
            _telegram_profile_get_value(
                account,
                link,
                method_key,
                params,
                allow_legacy_fallback=allow_legacy_fallback,
            )
        )
    return None


async def _set_telegram_chat_menu_button(
    db: AsyncSession,
    account: ChannelAccount,
    link: ChannelBotAgentLink,
    params: _TelegramParams,
) -> _TelegramJsonObject | Response:
    raw_menu_button = params.get("menu_button", {"type": "default"})
    menu_button = _normalize_telegram_menu_button(raw_menu_button)
    if menu_button is None:
        return _telegram_error_response("Bad Request: invalid menu_button", 400)
    chat_id = optional_str(params.get("chat_id"))
    bindings: list[ChannelBinding]
    if chat_id is not None:
        binding = await find_binding(
            db,
            account=account,
            external_chat_id=chat_id,
            bot_agent_link_id=link.id,
        )
        if binding is None:
            return _telegram_error_response("Forbidden: bot was blocked by the user", 403)
        if not _telegram_binding_supports_menu_button(binding):
            return _telegram_error_response(
                "Bad Request: chat_id must identify a private chat", 400
            )
        bindings = [binding]
    else:
        result = await db.execute(
            select(ChannelBinding).where(
                ChannelBinding.account_id == account.id,
                ChannelBinding.bot_agent_link_id == link.id,
                ChannelBinding.status == BINDING_STATUS_ACTIVE,
            )
        )
        bindings = [
            binding
            for binding in result.scalars().all()
            if _telegram_binding_supports_menu_button(binding)
        ]

    if account.encrypted_provider_token and account.provider_token_nonce:
        provider_params: _TelegramJsonObject = {
            key: _telegram_json_value(_telegram_json_parameter(value))
            for key, value in params.items()
        }
        for binding in bindings:
            response = await _post_telegram_bot_payload(
                account=account,
                method="setChatMenuButton",
                payload={
                    **provider_params,
                    "chat_id": binding.external_chat_id,
                    "menu_button": menu_button,
                },
            )
            if not _telegram_provider_call_succeeded(response):
                return _telegram_proxy_response(response)

    field_key = _telegram_menu_button_field_key(chat_id)
    _set_telegram_profile_value(link, params={}, field_key=field_key, value=menu_button)
    return telegram_ok(True)


def _normalize_telegram_menu_button(value: object) -> _TelegramJsonObject | None:
    parsed = _json_object_or_none(_telegram_json_parameter(value))
    if parsed is None:
        return None
    return parsed if optional_str(parsed.get("type")) is not None else None


async def _get_telegram_chat_menu_button(
    db: AsyncSession,
    account: ChannelAccount,
    link: ChannelBotAgentLink,
    params: _TelegramParams,
) -> _TelegramJsonObject | JSONResponse:
    chat_id = optional_str(params.get("chat_id"))
    if chat_id is not None:
        binding = await find_binding(
            db,
            account=account,
            external_chat_id=chat_id,
            bot_agent_link_id=link.id,
        )
        if binding is None:
            return _telegram_error_response("Forbidden: bot was blocked by the user", 403)
        if not _telegram_binding_supports_menu_button(binding):
            return _telegram_error_response(
                "Bad Request: chat_id must identify a private chat", 400
            )
    return telegram_ok(_telegram_menu_button_value(link, chat_id=chat_id))


def _telegram_profile_set_value(
    method_key: str,
    params: _TelegramParams,
) -> tuple[str, JsonValue] | None:
    if method_key == "setmyname":
        value = params.get("name")
        return ("name", value) if isinstance(value, str) else None
    if method_key == "setmydescription":
        value = params.get("description")
        return ("description", value) if isinstance(value, str) else None
    if method_key == "setmyshortdescription":
        value = params.get("short_description")
        return ("short_description", value) if isinstance(value, str) else None
    if method_key == "setmydefaultadministratorrights":
        if "rights" not in params:
            return None
        rights = _json_object_or_none(_telegram_json_parameter(params.get("rights")))
        if rights is None:
            return None
        field_key = (
            "default_admin_rights:channels"
            if _telegram_boolean_param_is_true(params.get("for_channels"))
            else "default_admin_rights:groups"
        )
        return field_key, rights
    return None


def _telegram_profile_required_hint(method_key: str) -> str:
    return {
        "setmyname": "name is required",
        "setmydescription": "description is required",
        "setmyshortdescription": "short_description is required",
        "setmydefaultadministratorrights": "rights is required",
    }.get(method_key, "invalid profile request")


def _set_telegram_profile_value(
    link: ChannelBotAgentLink,
    *,
    params: _TelegramParams,
    field_key: str,
    value: JsonValue,
) -> None:
    config = dict(link.config) if isinstance(link.config, dict) else {}
    profile = config.get("telegram_bot_profile")
    profile_shadow = dict(profile) if isinstance(profile, dict) else {}
    profile_shadow[_telegram_profile_key(params, field_key)] = value
    config["telegram_bot_profile"] = profile_shadow
    link.config = config


def _telegram_profile_get_value(
    account: ChannelAccount,
    link: ChannelBotAgentLink,
    method_key: str,
    params: _TelegramParams,
    *,
    allow_legacy_fallback: bool,
) -> _TelegramJsonObject:
    field_key = {
        "getmyname": "name",
        "getmydescription": "description",
        "getmyshortdescription": "short_description",
        "getmydefaultadministratorrights": (
            "default_admin_rights:channels"
            if _telegram_boolean_param_is_true(params.get("for_channels"))
            else "default_admin_rights:groups"
        ),
    }[method_key]
    link_config = link.config if isinstance(link.config, dict) else {}
    profile = link_config.get("telegram_bot_profile")
    profile_shadow = profile if isinstance(profile, dict) else {}
    profile_key = _telegram_profile_key(params, field_key)
    stored = profile_shadow.get(profile_key)
    if stored is None and allow_legacy_fallback:
        account_config = account.config if isinstance(account.config, dict) else {}
        legacy_profile = account_config.get("telegram_bot_profile")
        if isinstance(legacy_profile, dict):
            stored = legacy_profile.get(profile_key)
    if method_key == "getmyname":
        return {"name": stored if isinstance(stored, str) else ""}
    if method_key == "getmydescription":
        return {"description": stored if isinstance(stored, str) else ""}
    if method_key == "getmyshortdescription":
        return {"short_description": stored if isinstance(stored, str) else ""}
    if method_key == "getmydefaultadministratorrights":
        return stored if isinstance(stored, dict) else {}
    return stored if isinstance(stored, dict) else {}


async def _telegram_profile_legacy_fallback_is_safe(
    db: AsyncSession,
    *,
    account_id: UUID,
) -> bool:
    result = await db.execute(
        select(ChannelBotAgentLink.id)
        .where(
            ChannelBotAgentLink.account_id == account_id,
            ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
            ChannelBotAgentLink.archived_at.is_(None),
        )
        .limit(2)
    )
    return len(result.scalars().all()) == 1


def _telegram_profile_key(params: _TelegramParams, field_key: str) -> str:
    return f"{field_key}:{_telegram_language_code(params)}"


def _telegram_menu_button_field_key(chat_id: str | None) -> str:
    return "menu_button:default" if chat_id is None else f"menu_button:chat:{chat_id}"


def _telegram_menu_button_value(
    link: ChannelBotAgentLink,
    *,
    chat_id: str | None,
) -> _TelegramJsonObject:
    config = link.config if isinstance(link.config, dict) else {}
    profile = config.get("telegram_bot_profile")
    shadow = profile if isinstance(profile, dict) else {}
    if chat_id is not None:
        chat_value = shadow.get(_telegram_profile_key({}, _telegram_menu_button_field_key(chat_id)))
        if isinstance(chat_value, dict):
            return dict(chat_value)
    default_value = shadow.get(_telegram_profile_key({}, _telegram_menu_button_field_key(None)))
    return dict(default_value) if isinstance(default_value, dict) else {"type": "default"}


def _telegram_binding_supports_menu_button(binding: ChannelBinding) -> bool:
    chat_type = (binding.external_chat_type or "private").lower()
    return chat_type in {"private", "dm"}


async def _handle_telegram_get_file(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID,
    params: _TelegramParams,
    raw_body: bytes,
    request: Request,
) -> Response:
    file_id = optional_str(params.get("file_id"))
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
    response_payload: JsonValue | None = None
    if 200 <= response.status_code < 300:
        response_payload = _telegram_response_json(response)
    result = response_payload.get("result") if isinstance(response_payload, dict) else None
    file_path = result.get("file_path") if isinstance(result, dict) else None
    if (
        isinstance(response_payload, dict)
        and response_payload.get("ok") is True
        and isinstance(file_path, str)
        and file_path
    ):
        try:
            await record_channel_agent_reference(
                db,
                account=account,
                ref_kind=TELEGRAM_REF_FILE_PATH,
                ref_value=file_path,
                bot_agent_link_id=bot_agent_link_id,
                metadata={"file_id": file_id},
            )
            await db.commit()
        except Exception:
            log.exception(
                "telegram_reference_recording_failed account_id=%s link_id=%s method=getFile",
                account.id,
                bot_agent_link_id,
            )
            await _rollback_telegram_reference_recording(
                db,
                account_id=account.id,
                bot_agent_link_id=bot_agent_link_id,
                method="getFile",
            )
    return _telegram_proxy_response(response)


async def _handle_telegram_callback_answer(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID,
    method: str,
    params: _TelegramParams,
    raw_body: bytes,
    request: Request,
) -> Response:
    callback_query_id = optional_str(params.get("callback_query_id"))
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
    return _telegram_proxy_response(response)


async def _authorize_telegram_chat_method(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID,
    method_key: str,
    params: _TelegramParams,
) -> JSONResponse | None:
    if method_key not in _TELEGRAM_CHAT_SCOPED_METHODS:
        return _telegram_error_response("Forbidden: method is not available to this bot", 403)

    business_connection_id = optional_str(params.get("business_connection_id"))
    if business_connection_id is not None:
        return _telegram_error_response(
            "Forbidden: business_connection_id is not bound to this bot",
            403,
        )
    inline_message_id = optional_str(params.get("inline_message_id"))
    if inline_message_id is not None:
        return _telegram_error_response(
            "Forbidden: inline_message_id is not bound to this bot",
            403,
        )
    if _telegram_boolean_param_is_true(params.get("allow_paid_broadcast")):
        return _telegram_error_response(
            "Forbidden: paid broadcasts are not available to this bot",
            403,
        )

    chat_id = optional_str(params.get("chat_id"))
    if chat_id is None:
        return _telegram_error_response("Forbidden: method requires a bound chat_id", 403)
    binding = await find_binding(
        db,
        account=account,
        external_chat_id=chat_id,
        bot_agent_link_id=bot_agent_link_id,
    )
    if binding is None:
        return _telegram_error_response("Forbidden: bot was blocked by the user", 403)
    if (
        binding.external_chat_type == "direct_messages"
        and "message_thread_id" in params
        and "direct_messages_topic_id" in params
    ):
        return _telegram_error_response(
            "Bad Request: direct message topic is specified more than once",
            400,
        )
    if binding.external_chat_type == "direct_messages":
        topic_value = params.get(
            "message_thread_id",
            params.get("direct_messages_topic_id"),
        )
        if topic_value is None and method_key in _TELEGRAM_DIRECT_TOPIC_SEND_METHODS:
            return _telegram_error_response(
                "Bad Request: direct message topic is required",
                400,
            )
        if topic_value is not None:
            topic_id = optional_int_param(topic_value)
            if topic_id is None or topic_id <= 0:
                return _telegram_error_response(
                    "Bad Request: invalid direct message topic",
                    400,
                )
            if binding.paired_external_user_id != str(topic_id):
                return _telegram_error_response(
                    "Forbidden: direct message topic is not bound to this bot",
                    403,
                )

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

    message_references, message_reference_error = _telegram_message_references(
        method_key,
        params,
        chat_id=chat_id,
    )
    if message_reference_error is not None:
        return _telegram_error_response(f"Bad Request: {message_reference_error}", 400)
    for ref_chat_id, message_id in message_references:
        ref_binding = await find_binding(
            db,
            account=account,
            external_chat_id=ref_chat_id,
            bot_agent_link_id=bot_agent_link_id,
        )
        if (
            ref_binding is not None
            and ref_binding.external_chat_type == "direct_messages"
            and not await channel_agent_reference_exists(
                db,
                account=account,
                ref_kind=TELEGRAM_REF_MESSAGE_ID,
                ref_value=telegram_message_reference_value(ref_chat_id, message_id),
                bot_agent_link_id=bot_agent_link_id,
            )
        ):
            return _telegram_error_response(
                "Forbidden: message_id is not bound to this bot",
                403,
            )

    callback_query_id = optional_str(params.get("callback_query_id"))
    if callback_query_id is not None and not await channel_agent_reference_exists(
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

    file_ids, file_error = _telegram_outbound_file_references(method_key, params)
    if file_error is not None:
        return _telegram_error_response(f"Bad Request: {file_error}", 400)
    for file_id in file_ids:
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
    return None


def _telegram_outbound_file_references(
    method_key: str,
    params: _TelegramParams,
) -> tuple[set[str], str | None]:
    del method_key
    references: set[str] = set()
    stack: list[object] = [params]
    while stack:
        current = _telegram_json_parameter(stack.pop())
        if _is_object_list(current):
            stack.extend(current)
            continue
        if not _is_object_mapping(current):
            continue
        for field_name, value in current.items():
            parsed = _telegram_json_parameter(value)
            if (
                isinstance(field_name, str)
                and field_name in _TELEGRAM_FILE_FIELD_NAMES
                and isinstance(parsed, str)
            ):
                file_reference = parsed.strip()
                if (
                    file_reference
                    and not file_reference.startswith("attach://")
                    and "://" not in file_reference
                ):
                    references.add(file_reference)
            elif _is_object_mapping(parsed) or _is_object_list(parsed):
                stack.append(parsed)
    return references, None


def _referenced_telegram_chat_ids(params: _TelegramParams) -> set[str]:
    chat_ids: set[str] = set()
    for path in _TELEGRAM_REFERENCED_CHAT_PATHS:
        chat_id = optional_str(_telegram_param_at_path(params, path))
        if chat_id is not None:
            chat_ids.add(chat_id)
    return chat_ids


def _telegram_message_references(
    method_key: str,
    params: _TelegramParams,
    *,
    chat_id: str,
) -> tuple[set[tuple[str, int]], str | None]:
    source_chat_id = optional_str(params.get("from_chat_id"))
    primary_reference_chat_id = (
        source_chat_id
        if method_key in _TELEGRAM_SOURCE_MESSAGE_METHODS and source_chat_id is not None
        else chat_id
    )
    references: set[tuple[str, int]] = set()
    if "message_id" in params:
        message_id = optional_int_param(params.get("message_id"))
        if message_id is None or message_id <= 0:
            return references, "invalid message_id"
        references.add((primary_reference_chat_id, message_id))
    if "message_ids" in params:
        message_ids = _telegram_json_parameter(params.get("message_ids"))
        if not _is_object_list(message_ids) or not message_ids:
            return references, "invalid message_ids"
        for value in message_ids:
            message_id = optional_int_param(value)
            if message_id is None or message_id <= 0:
                return references, "invalid message_ids"
            references.add((primary_reference_chat_id, message_id))

    reply_parameters = _json_object_or_none(
        _telegram_json_parameter(params.get("reply_parameters"))
    )
    if reply_parameters is not None and "message_id" in reply_parameters:
        message_id = optional_int_param(reply_parameters.get("message_id"))
        reply_chat_id = optional_str(reply_parameters.get("chat_id")) or chat_id
        if message_id is None or message_id <= 0:
            return references, "invalid reply_parameters"
        references.add((reply_chat_id, message_id))
    return references, None


def _telegram_param_at_path(params: _TelegramParams, path: tuple[str, ...]) -> object:
    value: object = params
    for key in path:
        value = _telegram_json_parameter(value)
        if not _is_object_mapping(value):
            return None
        value = value.get(key)
    return value


def _telegram_boolean_param_is_true(value: object) -> bool:
    if value is True or value == 1:
        return True
    return isinstance(value, str) and value.strip().lower() in {"1", "true", "yes"}


async def _proxy_telegram_bot_method(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID,
    method: str,
    request: Request,
    raw_body: bytes,
) -> Response:
    request_params = await _telegram_request_params(request)
    if request.method != "GET":
        request_params = {**dict(request.query_params), **request_params}
    chat_id = optional_str(request_params.get("chat_id"))
    translate_direct_topic = False
    if chat_id is not None:
        binding = await find_binding(
            db,
            account=account,
            external_chat_id=chat_id,
            bot_agent_link_id=bot_agent_link_id,
        )
        translate_direct_topic = (
            binding is not None
            and binding.external_chat_type == "direct_messages"
            and method.lower() in _TELEGRAM_DIRECT_TOPIC_SEND_METHODS
            and "message_thread_id" in request_params
            and "direct_messages_topic_id" not in request_params
        )
    response = await _telegram_provider_response(
        account=account,
        method=method,
        request=request,
        raw_body=raw_body,
        translate_direct_topic=translate_direct_topic,
    )
    if 200 <= response.status_code < 300:
        payload = _telegram_response_json(response)
        if isinstance(payload, dict) and payload.get("ok") is True:
            file_ids = telegram_file_ids(payload.get("result"))
            message_references = _telegram_result_message_references(
                payload.get("result"),
                fallback_chat_id=chat_id,
            )
            if file_ids or message_references:
                try:
                    for file_id in sorted(file_ids):
                        await record_channel_agent_reference(
                            db,
                            account=account,
                            bot_agent_link_id=bot_agent_link_id,
                            ref_kind=TELEGRAM_REF_FILE_ID,
                            ref_value=file_id,
                        )
                    for ref_chat_id, message_id in sorted(message_references):
                        await record_channel_agent_reference(
                            db,
                            account=account,
                            bot_agent_link_id=bot_agent_link_id,
                            ref_kind=TELEGRAM_REF_MESSAGE_ID,
                            ref_value=telegram_message_reference_value(ref_chat_id, message_id),
                        )
                    await db.commit()
                except Exception:
                    log.exception(
                        "telegram_reference_recording_failed account_id=%s link_id=%s method=%s",
                        account.id,
                        bot_agent_link_id,
                        method,
                    )
                    await _rollback_telegram_reference_recording(
                        db,
                        account_id=account.id,
                        bot_agent_link_id=bot_agent_link_id,
                        method=method,
                    )
    return _telegram_proxy_response(response)


async def _rollback_telegram_reference_recording(
    db: AsyncSession,
    *,
    account_id: UUID,
    bot_agent_link_id: UUID,
    method: str,
) -> None:
    try:
        await db.rollback()
    except Exception:
        log.exception(
            "telegram_reference_recording_rollback_failed account_id=%s link_id=%s method=%s",
            account_id,
            bot_agent_link_id,
            method,
        )


def _telegram_result_message_references(
    value: JsonValue,
    *,
    fallback_chat_id: str | None,
) -> set[tuple[str, int]]:
    references: set[tuple[str, int]] = set()
    stack: list[JsonValue] = [value]
    while stack:
        current = stack.pop()
        if isinstance(current, list):
            stack.extend(current)
            continue
        if not isinstance(current, dict):
            continue
        message_id = optional_int_param(current.get("message_id"))
        chat = current.get("chat")
        result_chat_id = (
            optional_str(chat.get("id")) if isinstance(chat, dict) else fallback_chat_id
        )
        if message_id is not None and message_id > 0 and result_chat_id is not None:
            references.add((result_chat_id, message_id))
        stack.extend(current.values())
    return references


async def _telegram_provider_response(
    *,
    account: ChannelAccount,
    method: str,
    request: Request,
    raw_body: bytes,
    translate_direct_topic: bool = False,
) -> httpx.Response:
    provider_token = decrypt_provider_token(account)
    base_url = settings.channel_telegram_api_base_url.strip()
    await _validate_telegram_provider_base_url(base_url)
    url = httpx.URL(f"{base_url.rstrip('/')}/bot{provider_token}/{method}")
    headers: dict[str, str] = {}
    content_type = request.headers.get("content-type")
    if content_type:
        headers["content-type"] = content_type
    query_string = request.scope.get("query_string", b"")
    if translate_direct_topic:
        query_string = _rename_telegram_urlencoded_field(
            query_string,
            old_name="message_thread_id",
            new_name="direct_messages_topic_id",
        )
        raw_body = _telegram_direct_topic_request_body(raw_body, content_type or "")
    if query_string:
        url = url.copy_with(query=query_string)
    try:
        with track_proxy_latency("telegram", method):
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.request(
                    request.method,
                    url,
                    content=raw_body if raw_body else None,
                    headers=headers,
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


def _telegram_direct_topic_request_body(raw_body: bytes, content_type: str) -> bytes:
    if not raw_body:
        return raw_body
    lowered = content_type.lower()
    if "multipart/form-data" in lowered:
        return _rename_telegram_multipart_field(
            raw_body,
            content_type,
            old_name="message_thread_id",
            new_name="direct_messages_topic_id",
        )
    if "application/x-www-form-urlencoded" in lowered:
        return _rename_telegram_urlencoded_field(
            raw_body,
            old_name="message_thread_id",
            new_name="direct_messages_topic_id",
        )
    if "application/json" in lowered or raw_body.lstrip().startswith(b"{"):
        try:
            value = json.loads(raw_body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return raw_body
        if not isinstance(value, dict) or "message_thread_id" not in value:
            return raw_body
        return _rename_telegram_json_object_field(
            raw_body,
            old_name="message_thread_id",
            new_name="direct_messages_topic_id",
        )
    return raw_body


def _rename_telegram_json_object_field(
    value: bytes,
    *,
    old_name: str,
    new_name: str,
) -> bytes:
    depth = 0
    expect_top_level_key = False
    index = 0
    while index < len(value):
        byte = value[index]
        if byte == ord('"'):
            start = index
            index += 1
            escaped = False
            while index < len(value):
                current = value[index]
                if current == ord('"') and not escaped:
                    break
                if current == ord("\\") and not escaped:
                    escaped = True
                else:
                    escaped = False
                index += 1
            if index >= len(value):
                return value
            if expect_top_level_key and depth == 1:
                try:
                    decoded_key = json.loads(value[start : index + 1])
                except (UnicodeDecodeError, json.JSONDecodeError):
                    return value
                if decoded_key == old_name:
                    return value[:start] + json.dumps(new_name).encode("ascii") + value[index + 1 :]
                expect_top_level_key = False
        elif byte in (ord("{"), ord("[")):
            depth += 1
            if depth == 1 and byte == ord("{"):
                expect_top_level_key = True
        elif byte in (ord("}"), ord("]")):
            depth -= 1
        elif byte == ord(",") and depth == 1:
            expect_top_level_key = True
        index += 1
    return value


def _rename_telegram_urlencoded_field(
    value: bytes,
    *,
    old_name: str,
    new_name: str,
) -> bytes:
    rewritten: list[bytes] = []
    for field in value.split(b"&"):
        encoded_name, separator, encoded_value = field.partition(b"=")
        try:
            decoded_name = unquote_plus(encoded_name.decode("ascii"))
        except UnicodeDecodeError:
            decoded_name = ""
        if decoded_name == old_name:
            encoded_name = new_name.encode("ascii")
        rewritten.append(encoded_name + separator + encoded_value)
    return b"&".join(rewritten)


def _rename_telegram_multipart_field(
    raw_body: bytes,
    content_type: str,
    *,
    old_name: str,
    new_name: str,
) -> bytes:
    boundary_match = re.search(r'boundary=(?:"([^"]+)"|([^;\s]+))', content_type)
    if boundary_match is None:
        return raw_body
    boundary = boundary_match.group(1) or boundary_match.group(2)
    separator = f"--{boundary}".encode("ascii")
    parts = raw_body.split(separator)
    old_marker = re.compile(
        rb'(?i)(?<![A-Za-z0-9_-])name="' + re.escape(old_name.encode("ascii")) + rb'"'
    )
    new_marker = f'name="{new_name}"'.encode("ascii")
    rewritten = [parts[0]]
    for part in parts[1:]:
        header_end = part.find(b"\r\n\r\n")
        if header_end < 0:
            rewritten.append(part)
            continue
        header_lines = part[:header_end].split(b"\r\n")
        headers = b"\r\n".join(
            old_marker.sub(new_marker, line)
            if line.lower().startswith(b"content-disposition:")
            else line
            for line in header_lines
        )
        rewritten.append(headers + part[header_end:])
    return separator.join(rewritten)


async def _validate_telegram_provider_base_url(base_url: str) -> None:
    try:
        await validate_channel_http_url(base_url, label="telegram api base url")
    except UnsafeOutboundUrlError as exc:
        outbound_errors.labels(channel="telegram", method="provider_url").inc()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="telegram api base url must be a public https URL",
        ) from exc


def _telegram_passthrough_headers(response: httpx.Response) -> dict[str, str]:
    headers = response.headers
    passthrough: dict[str, str] = {}
    for key in (
        "content-type",
        "content-length",
        "cache-control",
        "retry-after",
        "x-correlation-id",
        "traceparent",
        "tracestate",
    ):
        value = headers.get(key)
        if value:
            passthrough[key] = value
    for key, value in headers.items():
        normalized_key = key.lower()
        if normalized_key.startswith(("ratelimit-", "x-ratelimit-")) and value:
            passthrough[normalized_key] = value
    provider_request_id = headers.get("x-request-id")
    if provider_request_id:
        passthrough["x-telegram-request-id"] = provider_request_id
    return passthrough


def _telegram_proxy_response(response: httpx.Response) -> Response:
    return Response(
        content=response.content,
        status_code=response.status_code,
        headers=_telegram_passthrough_headers(response),
    )
