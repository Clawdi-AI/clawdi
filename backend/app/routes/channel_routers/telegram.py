from __future__ import annotations

import hmac
import json
import logging
import re
from dataclasses import dataclass
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
from starlette.datastructures import UploadFile

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
    ChannelAgentContext,
    channel_agent_reference_exists,
    channel_runtime_account_key,
    channel_runtime_placeholder_token,
    decrypt_provider_token,
    drop_pending_telegram_updates,
    find_binding,
    find_existing_inbound_provider_event,
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
    telegram_event_id_from_update,
    telegram_external_user_id_from_update,
    telegram_file_ids,
    telegram_message_id_from_update,
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


# Keep this list explicit. Telegram ignores parameters it doesn't use, so the
# presence of a bound chat_id must never authorize an unknown method.
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
        "sendinvoice",
        "sendlivephoto",
        "sendlocation",
        "sendmediagroup",
        "sendmessage",
        "sendmessagedraft",
        "sendpaidmedia",
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


@dataclass(frozen=True)
class TelegramBindingUnpairOutcome:
    notification_sent: bool
    commands_cleared: bool
    menu_reset: bool


@dataclass(frozen=True)
class _TelegramFilePolicy:
    allow_file_id: bool
    allow_url: bool


_TELEGRAM_REUSABLE_FILE = _TelegramFilePolicy(allow_file_id=True, allow_url=True)
_TELEGRAM_REUSABLE_FILE_NO_URL = _TelegramFilePolicy(allow_file_id=True, allow_url=False)
_TELEGRAM_UPLOAD_ONLY_FILE = _TelegramFilePolicy(allow_file_id=False, allow_url=False)
_TELEGRAM_UPLOAD_ONLY_THUMBNAIL_FIELDS = {
    "thumbnail": _TELEGRAM_UPLOAD_ONLY_FILE,
    # The pinned Bot API source still accepts the legacy alias.
    "thumb": _TELEGRAM_UPLOAD_ONLY_FILE,
}

# Telegram file arguments are method- and field-specific. In particular,
# thumbnails are upload-only while video covers are reusable. Keep these
# shapes explicit so Bot API additions require an isolation review.
_TELEGRAM_TOP_LEVEL_FILE_FIELDS = {
    "sendanimation": {
        "animation": _TELEGRAM_REUSABLE_FILE,
        **_TELEGRAM_UPLOAD_ONLY_THUMBNAIL_FIELDS,
    },
    "sendaudio": {
        "audio": _TELEGRAM_REUSABLE_FILE,
        **_TELEGRAM_UPLOAD_ONLY_THUMBNAIL_FIELDS,
    },
    "senddocument": {
        "document": _TELEGRAM_REUSABLE_FILE,
        **_TELEGRAM_UPLOAD_ONLY_THUMBNAIL_FIELDS,
    },
    "sendlivephoto": {
        "live_photo": _TELEGRAM_REUSABLE_FILE_NO_URL,
        "photo": _TELEGRAM_REUSABLE_FILE_NO_URL,
    },
    "sendphoto": {"photo": _TELEGRAM_REUSABLE_FILE},
    "sendsticker": {"sticker": _TELEGRAM_REUSABLE_FILE},
    "sendvideo": {
        "video": _TELEGRAM_REUSABLE_FILE,
        **_TELEGRAM_UPLOAD_ONLY_THUMBNAIL_FIELDS,
        "cover": _TELEGRAM_REUSABLE_FILE,
    },
    "sendvideonote": {
        "video_note": _TELEGRAM_REUSABLE_FILE_NO_URL,
        **_TELEGRAM_UPLOAD_ONLY_THUMBNAIL_FIELDS,
    },
    "sendvoice": {"voice": _TELEGRAM_REUSABLE_FILE},
    "setchatphoto": {"photo": _TELEGRAM_UPLOAD_ONLY_FILE},
}

_TELEGRAM_INPUT_MEDIA_FILE_FIELDS = {
    "animation": {
        "media": _TELEGRAM_REUSABLE_FILE,
        **_TELEGRAM_UPLOAD_ONLY_THUMBNAIL_FIELDS,
    },
    "audio": {
        "media": _TELEGRAM_REUSABLE_FILE,
        **_TELEGRAM_UPLOAD_ONLY_THUMBNAIL_FIELDS,
    },
    "document": {
        "media": _TELEGRAM_REUSABLE_FILE,
        **_TELEGRAM_UPLOAD_ONLY_THUMBNAIL_FIELDS,
    },
    "live_photo": {
        "media": _TELEGRAM_REUSABLE_FILE_NO_URL,
        "photo": _TELEGRAM_REUSABLE_FILE_NO_URL,
    },
    "photo": {"media": _TELEGRAM_REUSABLE_FILE},
    "sticker": {
        "media": _TELEGRAM_REUSABLE_FILE,
        **_TELEGRAM_UPLOAD_ONLY_THUMBNAIL_FIELDS,
    },
    "video": {
        "media": _TELEGRAM_REUSABLE_FILE,
        **_TELEGRAM_UPLOAD_ONLY_THUMBNAIL_FIELDS,
        "cover": _TELEGRAM_REUSABLE_FILE,
    },
    "voice_note": {"media": _TELEGRAM_REUSABLE_FILE},
}

_TELEGRAM_PAID_MEDIA_FILE_FIELDS = {
    media_type: _TELEGRAM_INPUT_MEDIA_FILE_FIELDS[media_type]
    for media_type in ("live_photo", "photo", "video")
}

_TELEGRAM_STANDARD_INPUT_MEDIA_TYPES = frozenset(
    {"animation", "audio", "document", "live_photo", "photo", "video"}
)
_TELEGRAM_MEDIA_GROUP_TYPES = frozenset({"audio", "document", "live_photo", "photo", "video"})
_TELEGRAM_POLL_MEDIA_TYPES = frozenset(
    {"animation", "audio", "document", "live_photo", "location", "photo", "venue", "video"}
)
_TELEGRAM_POLL_OPTION_MEDIA_TYPES = frozenset(
    {"animation", "link", "live_photo", "location", "photo", "sticker", "venue", "video"}
)
_TELEGRAM_RICH_MEDIA_TYPES = frozenset({"animation", "audio", "photo", "video", "voice_note"})
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


@dataclass(frozen=True)
class _TelegramNestedMediaPolicy:
    parameter_names: tuple[str, ...]
    allowed_types: frozenset[str]
    file_fields_by_type: dict[str, dict[str, _TelegramFilePolicy]]


_TELEGRAM_NESTED_MEDIA_POLICIES = {
    "sendmediagroup": (
        _TelegramNestedMediaPolicy(
            ("media",),
            _TELEGRAM_MEDIA_GROUP_TYPES,
            _TELEGRAM_INPUT_MEDIA_FILE_FIELDS,
        ),
    ),
    "sendpaidmedia": (
        _TelegramNestedMediaPolicy(
            ("media",),
            frozenset(_TELEGRAM_PAID_MEDIA_FILE_FIELDS),
            _TELEGRAM_PAID_MEDIA_FILE_FIELDS,
        ),
    ),
    "sendpoll": (
        _TelegramNestedMediaPolicy(
            ("media", "explanation_media"),
            _TELEGRAM_POLL_MEDIA_TYPES,
            _TELEGRAM_INPUT_MEDIA_FILE_FIELDS,
        ),
        _TelegramNestedMediaPolicy(
            ("options",),
            _TELEGRAM_POLL_OPTION_MEDIA_TYPES,
            _TELEGRAM_INPUT_MEDIA_FILE_FIELDS,
        ),
    ),
    **{
        method: (
            _TelegramNestedMediaPolicy(
                ("media",),
                _TELEGRAM_STANDARD_INPUT_MEDIA_TYPES,
                _TELEGRAM_INPUT_MEDIA_FILE_FIELDS,
            ),
        )
        for method in ("editmessagemedia", "editephemeralmessagemedia")
    },
    **{
        method: (
            _TelegramNestedMediaPolicy(
                ("rich_message",),
                _TELEGRAM_RICH_MEDIA_TYPES,
                _TELEGRAM_INPUT_MEDIA_FILE_FIELDS,
            ),
        )
        for method in ("editmessagetext", "sendrichmessage", "sendrichmessagedraft")
    },
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
) -> dict[str, Any]:
    agent, _agent_token = await _resolve_telegram_agent(
        db,
        routing_id=routing_id,
        authorization=authorization,
    )
    account = agent.account
    raw_body = await request.body()
    params = await _request_params(request)
    duplicate_parameter = await _telegram_duplicate_parameter(request, raw_body, params)
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
        return _telegram_ok(_telegram_me(account))
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
    return Response(
        content=response.content,
        status_code=response.status_code,
        media_type=response.headers.get("content-type", "application/octet-stream"),
        headers=_telegram_passthrough_headers(response),
    )


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

    payload = await _json_object(request)
    _ensure_telegram_bot_command_entities(payload)
    chat = telegram_chat_from_update(payload)
    if chat is None:
        return TelegramWebhookResponse(ok=True)

    external_chat_id, external_chat_type, external_chat_name = chat
    text = telegram_text_from_update(payload)
    command = parse_pair_command(text)
    provider_event_id = telegram_event_id_from_update(payload)
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
    if command is not None:
        existing = await find_existing_inbound_provider_event(
            db,
            account=account,
            external_chat_id=external_chat_id,
            provider_event_id=provider_event_id,
        )
        if existing is not None:
            return TelegramWebhookResponse(ok=True, binding_id=existing.binding_id)
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
    if command is not None:
        existing = await find_existing_inbound_provider_event(
            db,
            account=account,
            external_chat_id=external_chat_id,
            provider_event_id=provider_event_id,
        )
        if existing is not None:
            return TelegramWebhookResponse(ok=True, binding_id=existing.binding_id)

    messages = await record_inbound_messages_for_bindings(
        db,
        account=account,
        binding_result=binding_result,
        external_chat_id=external_chat_id,
        provider_message_id=telegram_message_id_from_update(payload),
        provider_event_id=provider_event_id,
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
        telegram_message_thread_id=telegram_message_thread_id_from_update(payload),
        command=command,
        binding_result=binding_result,
    )
    if reply is not None:
        await db.commit()
    await _reconcile_telegram_link_state_after_binding_change(
        db,
        account=account,
        binding=binding_result.binding,
        previous_link_id=previous_link_id,
        paired=binding_result.paired,
        unpaired=binding_result.unpaired,
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


def _telegram_json_parameter(value: Any) -> Any:
    if not isinstance(value, str) or not value.strip().startswith(("{", "[")):
        return value
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


class _DuplicateTelegramJsonKey(ValueError):
    pass


async def _telegram_duplicate_parameter(
    request: Request,
    raw_body: bytes,
    params: dict[str, Any],
) -> str | None:
    content_type = request.headers.get("content-type", "").lower()
    is_form = "application/x-www-form-urlencoded" in content_type
    is_multipart = "multipart/form-data" in content_type
    values = list(request.query_params.multi_items())
    if request.method != "GET":
        if is_form or is_multipart:
            values.extend((await request.form()).multi_items())
        else:
            if _telegram_json_has_duplicate_key(raw_body):
                return "JSON key"
            values.extend(params.items())

    seen: set[str] = set()
    for key, value in values:
        if key in seen:
            return key
        seen.add(key)
        if (
            isinstance(value, str)
            and value.strip().startswith(("{", "["))
            and _telegram_json_has_duplicate_key(value)
        ):
            return key
    return None


def _telegram_json_has_duplicate_key(value: str | bytes) -> bool:
    def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, item in pairs:
            if key in result:
                raise _DuplicateTelegramJsonKey
            result[key] = item
        return result

    try:
        json.loads(value, object_pairs_hook=unique_object)
    except _DuplicateTelegramJsonKey:
        return True
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False
    return False


def _telegram_command_scope_key(params: dict[str, Any]) -> str:
    scope = _telegram_json_parameter(params.get("scope"))
    if not isinstance(scope, dict):
        return "default"
    scope_type = _optional_str(scope.get("type"))
    if scope_type in _TELEGRAM_BROAD_COMMAND_SCOPE_TYPES:
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
    raw_scope = params.get("scope")
    if raw_scope is None:
        return None
    scope = _telegram_json_parameter(raw_scope)
    if not isinstance(scope, dict):
        return _telegram_error_response("Bad Request: invalid scope", 400)
    scope_type = _optional_str(scope.get("type"))
    if scope_type in _TELEGRAM_BROAD_COMMAND_SCOPE_TYPES:
        return None
    if scope_type not in _TELEGRAM_CHAT_COMMAND_SCOPE_TYPES:
        return _telegram_error_response("Bad Request: invalid scope", 400)
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
    commands = _telegram_json_parameter(params.get("commands"))
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

    scope = _telegram_json_parameter(params.get("scope"))
    scope_type = _optional_str(scope.get("type")) if isinstance(scope, dict) else None
    if isinstance(scope, dict) and scope_type not in _TELEGRAM_BROAD_COMMAND_SCOPE_TYPES:
        response = await _post_telegram_bot_payload(
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
        response = await _post_telegram_bot_payload(
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
    config = link.config if isinstance(link.config, dict) else {}
    shadow = config.get("telegram_agent_commands")
    if not isinstance(shadow, dict):
        return True
    cleared: set[str] = set()
    succeeded = True
    for key in shadow:
        if not isinstance(key, str):
            continue
        scope_key, language_code = _telegram_command_shadow_parts(key)
        scope = _telegram_command_scope_for_binding(binding, scope_key=scope_key)
        if scope is None:
            continue
        identity = json.dumps([scope, language_code], sort_keys=True, separators=(",", ":"))
        if identity in cleared:
            continue
        cleared.add(identity)
        payload: dict[str, Any] = {"scope": scope}
        if language_code:
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
    config = link.config if isinstance(link.config, dict) else {}
    shadow = config.get("telegram_agent_commands")
    if not isinstance(shadow, dict):
        return
    for key, commands in shadow.items():
        if not isinstance(key, str) or not isinstance(commands, list):
            continue
        scope_key, language_code = _telegram_command_shadow_parts(key)
        if scope_key not in _TELEGRAM_BROAD_COMMAND_SCOPE_TYPES:
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
    menu_button: dict[str, Any] = {"type": "default"}
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


def _telegram_provider_call_succeeded(response: httpx.Response) -> bool:
    if response.status_code >= 400:
        return False
    return _telegram_response_json(response).get("ok") is not False


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


def _telegram_command_scope_for_binding(
    binding: ChannelBinding,
    *,
    scope_key: str,
) -> dict[str, Any] | None:
    broad_scope = _telegram_command_fanout_scope(binding, scope_key=scope_key)
    if broad_scope is not None:
        return broad_scope
    parts = scope_key.split(":")
    if len(parts) == 2 and parts[0] in {"chat", "chat_administrators"}:
        if parts[1] == binding.external_chat_id:
            return {"type": parts[0], "chat_id": parts[1]}
        return None
    if len(parts) == 3 and parts[0] == "chat_member":
        if parts[1] == binding.external_chat_id:
            return {"type": "chat_member", "chat_id": parts[1], "user_id": parts[2]}
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
        commands = _telegram_json_parameter(params.get("commands"))
        payload["commands"] = commands if isinstance(commands, list) else []
    return payload


async def _post_telegram_bot_payload(
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
    db: AsyncSession,
    account: Any,
    link: ChannelBotAgentLink,
    method_key: str,
    params: dict[str, Any],
) -> dict[str, Any] | JSONResponse | None:
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
        return _telegram_ok(True)

    if method_key in {
        "getmyname",
        "getmydescription",
        "getmyshortdescription",
        "getmydefaultadministratorrights",
    }:
        allow_legacy_fallback = await _telegram_profile_legacy_fallback_is_safe(
            db, account_id=link.account_id
        )
        return _telegram_ok(
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
    params: dict[str, Any],
) -> dict[str, Any] | JSONResponse:
    raw_menu_button = params.get("menu_button", {"type": "default"})
    menu_button = _normalize_telegram_menu_button(raw_menu_button)
    if menu_button is None:
        return _telegram_error_response("Bad Request: invalid menu_button", 400)
    chat_id = _optional_str(params.get("chat_id"))
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
        for binding in bindings:
            response = await _post_telegram_bot_payload(
                account=account,
                method="setChatMenuButton",
                payload={
                    "chat_id": binding.external_chat_id,
                    "menu_button": menu_button,
                },
            )
            if response.status_code >= 400:
                return JSONResponse(
                    status_code=response.status_code,
                    content=_telegram_response_json(response),
                )

    field_key = _telegram_menu_button_field_key(chat_id)
    _set_telegram_profile_value(link, params={}, field_key=field_key, value=menu_button)
    return _telegram_ok(True)


def _normalize_telegram_menu_button(value: Any) -> dict[str, Any] | None:
    value = _telegram_json_parameter(value)
    if not isinstance(value, dict):
        return None
    button_type = _optional_str(value.get("type"))
    if button_type in {"default", "commands"}:
        return {"type": button_type}
    if button_type != "web_app":
        return None
    text = _optional_str(value.get("text"))
    web_app = value.get("web_app")
    url = _optional_str(web_app.get("url")) if isinstance(web_app, dict) else None
    if text is None or url is None or not url.lower().startswith("https://"):
        return None
    try:
        parsed_url = httpx.URL(url)
    except httpx.InvalidURL:
        return None
    if parsed_url.scheme != "https" or not parsed_url.host:
        return None
    return {"type": "web_app", "text": text, "web_app": {"url": url}}


async def _get_telegram_chat_menu_button(
    db: AsyncSession,
    account: ChannelAccount,
    link: ChannelBotAgentLink,
    params: dict[str, Any],
) -> dict[str, Any] | JSONResponse:
    chat_id = _optional_str(params.get("chat_id"))
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
    return _telegram_ok(_telegram_menu_button_value(link, chat_id=chat_id))


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
    params: dict[str, Any],
    field_key: str,
    value: Any,
) -> None:
    config = dict(link.config) if isinstance(link.config, dict) else {}
    profile = config.get("telegram_bot_profile")
    profile_shadow = dict(profile) if isinstance(profile, dict) else {}
    profile_shadow[_telegram_profile_key(params, field_key)] = value
    config["telegram_bot_profile"] = profile_shadow
    link.config = config


def _telegram_profile_get_value(
    account: Any,
    link: ChannelBotAgentLink,
    method_key: str,
    params: dict[str, Any],
    *,
    allow_legacy_fallback: bool,
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


def _telegram_profile_key(params: dict[str, Any], field_key: str) -> str:
    return f"{field_key}:{_telegram_language_code(params)}"


def _telegram_menu_button_field_key(chat_id: str | None) -> str:
    return "menu_button:default" if chat_id is None else f"menu_button:chat:{chat_id}"


def _telegram_menu_button_value(
    link: ChannelBotAgentLink,
    *,
    chat_id: str | None,
) -> dict[str, Any]:
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


async def _authorize_telegram_chat_method(
    db: AsyncSession,
    *,
    account: Any,
    bot_agent_link_id: UUID,
    method_key: str,
    params: dict[str, Any],
) -> JSONResponse | None:
    if method_key not in _TELEGRAM_CHAT_SCOPED_METHODS:
        return _telegram_error_response("Forbidden: method is not available to this bot", 403)

    business_connection_id = _optional_str(params.get("business_connection_id"))
    if business_connection_id is not None:
        return _telegram_error_response(
            "Forbidden: business_connection_id is not bound to this bot",
            403,
        )
    inline_message_id = _optional_str(params.get("inline_message_id"))
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

    callback_query_id = _optional_str(params.get("callback_query_id"))
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
    params: dict[str, Any],
) -> tuple[set[str], str | None]:
    references: set[str] = set()
    modeled_top_level_fields = set(_TELEGRAM_TOP_LEVEL_FILE_FIELDS.get(method_key, {}))

    for field_name, policy in _TELEGRAM_TOP_LEVEL_FILE_FIELDS.get(method_key, {}).items():
        if field_name in params and not _collect_telegram_file_reference(
            params[field_name], policy, references
        ):
            return references, f"invalid {field_name}"

    for nested_policy in _TELEGRAM_NESTED_MEDIA_POLICIES.get(method_key, ()):
        modeled_top_level_fields.update(
            _TELEGRAM_FILE_FIELD_NAMES & set(nested_policy.parameter_names)
        )
        for parameter_name in nested_policy.parameter_names:
            if parameter_name in params and not _collect_telegram_nested_media_references(
                params[parameter_name], nested_policy, references
            ):
                return references, f"invalid {parameter_name} media"

    unmodeled_fields = (params.keys() & _TELEGRAM_FILE_FIELD_NAMES) - modeled_top_level_fields
    if unmodeled_fields:
        return references, f"unmodeled media field {sorted(unmodeled_fields)[0]}"
    return references, None


def _collect_telegram_file_reference(
    value: Any,
    policy: _TelegramFilePolicy,
    references: set[str],
) -> bool:
    if isinstance(value, UploadFile):
        return True
    if not isinstance(value, str):
        return False
    value = value.strip()
    if not value:
        return False
    if value.startswith("attach://"):
        return bool(value.removeprefix("attach://"))
    if _telegram_media_url(value):
        return policy.allow_url
    if "://" in value or not policy.allow_file_id:
        return False
    references.add(value)
    return True


def _telegram_media_url(value: str) -> bool:
    try:
        parsed = httpx.URL(value)
    except httpx.InvalidURL:
        return False
    return parsed.scheme in {"http", "https"} and parsed.host is not None


def _collect_telegram_nested_media_references(
    value: Any,
    policy: _TelegramNestedMediaPolicy,
    references: set[str],
) -> bool:
    value = _telegram_json_parameter(value)
    if not isinstance(value, (dict, list)):
        return False
    stack = [value]
    while stack:
        current = stack.pop()
        if isinstance(current, list):
            stack.extend(current)
            continue
        if not isinstance(current, dict):
            continue

        media_type = _optional_str(current.get("type"))
        if (
            media_type is not None
            and "media" in current
            and not isinstance(current["media"], (str, UploadFile))
        ):
            return False
        direct_file_fields = {
            field_name
            for field_name in current.keys() & _TELEGRAM_FILE_FIELD_NAMES
            if isinstance(current[field_name], (str, UploadFile))
        }
        if direct_file_fields:
            file_fields = policy.file_fields_by_type.get(media_type or "")
            if media_type not in policy.allowed_types or file_fields is None:
                return False
            if direct_file_fields - file_fields.keys():
                return False
            for field_name, file_policy in file_fields.items():
                if field_name in current and not _collect_telegram_file_reference(
                    current[field_name], file_policy, references
                ):
                    return False
        stack.extend(current.values())
    return True


def _referenced_telegram_chat_ids(params: dict[str, Any]) -> set[str]:
    chat_ids: set[str] = set()
    for path in _TELEGRAM_REFERENCED_CHAT_PATHS:
        chat_id = _optional_str(_telegram_param_at_path(params, path))
        if chat_id is not None:
            chat_ids.add(chat_id)
    return chat_ids


def _telegram_param_at_path(params: dict[str, Any], path: tuple[str, ...]) -> Any:
    value: Any = params
    for key in path:
        value = _telegram_json_parameter(value)
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def _telegram_boolean_param_is_true(value: Any) -> bool:
    if value is True or value == 1:
        return True
    return isinstance(value, str) and value.strip().lower() == "true"


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
    db: AsyncSession,
    *,
    account: Any,
    bot_agent_link_id: UUID,
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
    if 200 <= response.status_code < 300:
        try:
            payload = response.json()
        except ValueError:
            payload = None
        if isinstance(payload, dict) and payload.get("ok") is True:
            file_ids = telegram_file_ids(payload.get("result"))
            for file_id in sorted(file_ids):
                await record_channel_agent_reference(
                    db,
                    account=account,
                    bot_agent_link_id=bot_agent_link_id,
                    ref_kind=TELEGRAM_REF_FILE_ID,
                    ref_value=file_id,
                )
            if file_ids:
                await db.commit()
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
