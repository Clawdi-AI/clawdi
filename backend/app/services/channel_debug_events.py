from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TypeGuard
from uuid import UUID

from pydantic import JsonValue
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel import (
    BINDING_STATUS_ACTIVE,
    BOT_AGENT_LINK_STATUS_ACTIVE,
    CHANNEL_PROVIDER_DISCORD,
    CHANNEL_PROVIDER_TELEGRAM,
    CHANNEL_PROVIDER_WHATSAPP,
    CHANNEL_STATUS_ACTIVE,
    MESSAGE_DIRECTION_INBOUND,
    ChannelAccount,
    ChannelBinding,
    ChannelBotAgentLink,
    ChannelDebugEvent,
    ChannelMessage,
)

DEFAULT_DEBUG_EVENT_LIMIT = 100
MAX_DEBUG_EVENT_LIMIT = 1000
MAX_DEBUG_STRING = 500
PUBLIC_CHANNEL_DELIVERY_ERROR = "channel_delivery_failed"
PUBLIC_CHANNEL_OPERATION_ERROR = "channel_operation_failed"
PUBLIC_CHANNEL_DELIVERY_ERROR_CODES = frozenset(
    {
        "channel_account_inactive",
        "channel_agent_link_archived",
        "channel_agent_link_authority_missing",
        "channel_agent_link_update_contended",
        "channel_binding_inactive",
        "channel_delivery_failed",
        "channel_message_missing",
        "channel_provider_credential_unavailable",
        "channel_provider_rate_limited",
        "channel_provider_rejected",
        "channel_provider_unreachable",
    }
)
SECRET_KEY_RE = re.compile(
    r"(token|secret|password|authorization|auth|key|credential|cookie)",
    re.I,
)
_PUBLIC_SAFE_CODE_RE = re.compile(r"^[a-z0-9][a-z0-9_.:-]{0,119}$", re.I)
_PUBLIC_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_.:@/-]{1,300}$")
_PUBLIC_SAFE_SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
_PUBLIC_SAFE_SHA256_KEYS = frozenset({"clientstaticsha256"})
_PUBLIC_SAFE_DETAIL_STRING_KEYS = frozenset(
    {
        "direction",
        "event_type",
        "method",
        "operation",
        "outcome",
        "provider",
        "reason",
        "stage",
        "state",
        "status",
        "binding_status",
        "bot_agent_link_status",
        "link_status",
    }
)
_PUBLIC_SAFE_DETAIL_ENUMS = {
    "jiddescription": frozenset(
        {
            "invalid",
            "missing",
            "server=broadcast device=false",
            "server=broadcast device=true",
            "server=g.us device=false",
            "server=g.us device=true",
            "server=lid device=false",
            "server=lid device=true",
            "server=newsletter device=false",
            "server=newsletter device=true",
            "server=s.whatsapp.net device=false",
            "server=s.whatsapp.net device=true",
        }
    ),
    "runtime": frozenset({"baileys_noise", "baileys_websocket"}),
}


@dataclass(frozen=True)
class ChannelDebugEventFilters:
    user_id: UUID
    account_id: UUID | None = None
    provider: str | None = None
    external_chat_id: str | None = None
    direction: str | None = None
    stage: str | None = None
    outcome: str | None = None
    limit: int | None = None


async def record_channel_debug_event(
    db: AsyncSession,
    *,
    account: ChannelAccount | None,
    user_id: UUID,
    provider: str,
    direction: str,
    stage: str,
    outcome: str,
    external_chat_id: str | None = None,
    request_id: str | None = None,
    status_code: int | None = None,
    error: str | None = None,
    details: Mapping[str, object] | None = None,
) -> ChannelDebugEvent | None:
    try:
        now = datetime.now(UTC)
        normalized_provider = _normalize(provider)
        minimize_stored_diagnostics = normalized_provider in {
            CHANNEL_PROVIDER_TELEGRAM,
            CHANNEL_PROVIDER_DISCORD,
            CHANNEL_PROVIDER_WHATSAPP,
        }
        async with db.begin_nested():
            event = ChannelDebugEvent(
                account_id=account.id if account is not None else None,
                user_id=user_id,
                provider=normalized_provider,
                external_chat_id=_truncate(external_chat_id, 300),
                direction=direction,
                stage=_truncate(stage, 80) or "unknown",
                outcome=outcome,
                request_id=_truncate(request_id, 120),
                status_code=status_code,
                error=(
                    public_channel_operation_error(error)
                    if minimize_stored_diagnostics
                    else _truncate(error, MAX_DEBUG_STRING)
                ),
                details=(
                    public_channel_debug_details(details)
                    if minimize_stored_diagnostics
                    else _sanitize_details(details)
                    if details is not None
                    else None
                ),
                created_at=now,
                updated_at=now,
            )
            db.add(event)
            await db.flush()
        return event
    except Exception:  # noqa: BLE001 - debug logging must not affect channel delivery.
        return None


async def list_channel_debug_events(
    db: AsyncSession,
    filters: ChannelDebugEventFilters,
) -> list[ChannelDebugEvent]:
    query = select(ChannelDebugEvent).where(ChannelDebugEvent.user_id == filters.user_id)
    if filters.account_id is not None:
        query = query.where(ChannelDebugEvent.account_id == filters.account_id)
    if filters.provider:
        query = query.where(ChannelDebugEvent.provider == _normalize(filters.provider))
    if filters.external_chat_id:
        query = query.where(ChannelDebugEvent.external_chat_id == filters.external_chat_id)
    if filters.direction:
        query = query.where(ChannelDebugEvent.direction == filters.direction)
    if filters.stage:
        query = query.where(ChannelDebugEvent.stage == filters.stage)
    if filters.outcome:
        query = query.where(ChannelDebugEvent.outcome == filters.outcome)
    query = query.order_by(ChannelDebugEvent.created_at.desc(), ChannelDebugEvent.id.desc()).limit(
        _clamp_limit(filters.limit)
    )
    result = await db.execute(query)
    return list(result.scalars().all())


async def channel_debug_health(
    db: AsyncSession,
    *,
    user_id: UUID,
) -> list[dict[str, JsonValue]]:
    accounts = (
        (
            await db.execute(
                select(ChannelAccount)
                .where(
                    ChannelAccount.user_id == user_id,
                    ChannelAccount.archived_at.is_(None),
                )
                .order_by(ChannelAccount.provider, ChannelAccount.name)
            )
        )
        .scalars()
        .all()
    )
    account_ids = [account.id for account in accounts]
    pending_inbox_by_account = await _pending_inbox_stats_by_account(
        db,
        account_ids=account_ids,
        user_id=user_id,
    )
    last_event_by_account = await _last_events_by_account(
        db,
        account_ids=account_ids,
        user_id=user_id,
        error_only=False,
    )
    last_error_by_account = await _last_events_by_account(
        db,
        account_ids=account_ids,
        user_id=user_id,
        error_only=True,
    )
    health: list[dict[str, JsonValue]] = []
    for account in accounts:
        pending_inbox, oldest_pending_inbox_at = pending_inbox_by_account.get(
            account.id,
            (0, None),
        )
        item: dict[str, JsonValue] = {
            "accountId": str(account.id),
            "provider": account.provider,
            "name": account.name,
            "pendingInbox": pending_inbox,
            "oldestPendingInboxAt": (
                oldest_pending_inbox_at.isoformat() if oldest_pending_inbox_at is not None else None
            ),
            "lastEvent": _debug_event_response(last_event_by_account.get(account.id)),
            "lastError": _debug_event_response(last_error_by_account.get(account.id)),
        }
        if account.provider == CHANNEL_PROVIDER_WHATSAPP:
            from app.services.whatsapp_provider_bridge import (
                whatsapp_provider_transport_status,
            )

            item["nativeTransport"] = whatsapp_provider_transport_status(account.id).as_dict()
        health.append(item)
    return health


def channel_debug_event_response(event: ChannelDebugEvent) -> dict[str, JsonValue]:
    return _debug_event_response(event) or {}


def _debug_event_response(event: ChannelDebugEvent | None) -> dict[str, JsonValue] | None:
    if event is None:
        return None
    return {
        "id": str(event.id),
        "createdAt": event.created_at.isoformat(),
        "accountId": str(event.account_id) if event.account_id is not None else None,
        "provider": event.provider,
        "externalChatId": event.external_chat_id,
        "direction": event.direction,
        "stage": event.stage,
        "outcome": event.outcome,
        "requestId": event.request_id,
        "status": event.status_code,
        "error": public_channel_operation_error(event.error),
        "details": public_channel_debug_details(event.details),
    }


def public_channel_operation_error(error: str | None) -> str | None:
    return PUBLIC_CHANNEL_OPERATION_ERROR if error is not None else None


def public_channel_delivery_error(error: str | None) -> str | None:
    if error is None:
        return None
    return error if error in PUBLIC_CHANNEL_DELIVERY_ERROR_CODES else PUBLIC_CHANNEL_DELIVERY_ERROR


def public_channel_debug_details(
    value: object,
    *,
    key: str | None = None,
    depth: int = 0,
) -> JsonValue:
    """Return user-safe debug structure without provider or exception strings."""
    if depth > 4:
        return "[truncated]"
    if value is None or isinstance(value, (int, float, bool)):
        return value
    if isinstance(value, str):
        if key is None:
            return "[redacted]"
        normalized_key = key.lower().replace("-", "_")
        if SECRET_KEY_RE.search(normalized_key):
            return "[redacted]"
        if normalized_key == "id" or normalized_key.endswith("_id"):
            return value if _PUBLIC_SAFE_ID_RE.fullmatch(value) else "[redacted]"
        if normalized_key in _PUBLIC_SAFE_SHA256_KEYS:
            return value if _PUBLIC_SAFE_SHA256_RE.fullmatch(value) else "[redacted]"
        if value in _PUBLIC_SAFE_DETAIL_ENUMS.get(normalized_key, ()):
            return value
        if normalized_key in _PUBLIC_SAFE_DETAIL_STRING_KEYS and _PUBLIC_SAFE_CODE_RE.fullmatch(
            value
        ):
            return value
        return "[redacted]"
    if _is_object_list(value):
        return [public_channel_debug_details(item, key=key, depth=depth + 1) for item in value[:20]]
    if _is_object_mapping(value):
        out: dict[str, JsonValue] = {}
        for child_key, child in list(value.items())[:40]:
            key_str = str(child_key)
            out[key_str] = (
                "[redacted]"
                if SECRET_KEY_RE.search(key_str)
                else public_channel_debug_details(
                    child,
                    key=key_str,
                    depth=depth + 1,
                )
            )
        return out
    return "[redacted]"


def public_channel_debug_details_response(
    value: Mapping[str, object] | None,
) -> dict[str, object] | None:
    """Return user-safe object details for typed public response schemas."""
    if value is None:
        return None
    details: dict[str, object] = {}
    for child_key, child in list(value.items())[:40]:
        key = str(child_key)
        details[key] = (
            "[redacted]"
            if SECRET_KEY_RE.search(key)
            else public_channel_debug_details(child, key=key, depth=1)
        )
    return details


async def _pending_inbox_stats_by_account(
    db: AsyncSession,
    *,
    account_ids: list[UUID],
    user_id: UUID,
) -> dict[UUID, tuple[int, datetime | None]]:
    if not account_ids:
        return {}
    rows = await db.execute(
        select(
            ChannelMessage.account_id,
            func.count(ChannelMessage.id),
            func.min(ChannelMessage.created_at),
        )
        .join(
            ChannelBinding,
            and_(
                ChannelBinding.id == ChannelMessage.binding_id,
                ChannelBinding.account_id == ChannelMessage.account_id,
                ChannelBinding.bot_agent_link_id == ChannelMessage.bot_agent_link_id,
                ChannelBinding.user_id == ChannelMessage.user_id,
            ),
        )
        .join(
            ChannelBotAgentLink,
            and_(
                ChannelBotAgentLink.id == ChannelMessage.bot_agent_link_id,
                ChannelBotAgentLink.account_id == ChannelMessage.account_id,
            ),
        )
        .join(ChannelAccount, ChannelAccount.id == ChannelMessage.account_id)
        .where(
            ChannelMessage.account_id.in_(account_ids),
            ChannelMessage.user_id == user_id,
            ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
            ChannelMessage.binding_id.is_not(None),
            ChannelMessage.delivered_at.is_(None),
            ChannelBinding.status == BINDING_STATUS_ACTIVE,
            ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
            ChannelBotAgentLink.archived_at.is_(None),
            ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
            ChannelAccount.archived_at.is_(None),
        )
        .group_by(ChannelMessage.account_id)
    )
    return {
        account_id: (int(count), oldest_pending_at)
        for account_id, count, oldest_pending_at in rows.all()
    }


async def _last_events_by_account(
    db: AsyncSession,
    *,
    account_ids: list[UUID],
    user_id: UUID,
    error_only: bool,
) -> dict[UUID, ChannelDebugEvent]:
    if not account_ids:
        return {}
    filters = [
        ChannelDebugEvent.account_id.in_(account_ids),
        ChannelDebugEvent.user_id == user_id,
    ]
    if error_only:
        filters.append(
            or_(
                ChannelDebugEvent.outcome == "failure",
                ChannelDebugEvent.error.is_not(None),
            )
        )
    ranked = (
        select(
            ChannelDebugEvent.id.label("event_id"),
            func.row_number()
            .over(
                partition_by=ChannelDebugEvent.account_id,
                order_by=(ChannelDebugEvent.created_at.desc(), ChannelDebugEvent.id.desc()),
            )
            .label("row_number"),
        )
        .where(*filters)
        .subquery()
    )
    events = (
        (
            await db.execute(
                select(ChannelDebugEvent)
                .join(ranked, ranked.c.event_id == ChannelDebugEvent.id)
                .where(ranked.c.row_number == 1)
            )
        )
        .scalars()
        .all()
    )
    return {event.account_id: event for event in events if event.account_id is not None}


def _sanitize_details(value: object, *, depth: int = 0) -> JsonValue:
    if depth > 4:
        return "[truncated]"
    if value is None or isinstance(value, (int, float, bool)):
        return value
    if isinstance(value, str):
        return _truncate(value, MAX_DEBUG_STRING)
    if _is_object_list(value):
        return [_sanitize_details(item, depth=depth + 1) for item in value[:20]]
    if _is_object_mapping(value):
        out: dict[str, JsonValue] = {}
        for key, child in list(value.items())[:40]:
            key_str = str(key)
            out[key_str] = (
                "[redacted]"
                if SECRET_KEY_RE.search(key_str)
                else _sanitize_details(child, depth=depth + 1)
            )
        return out
    return _truncate(str(value), MAX_DEBUG_STRING)


def _is_object_list(value: object) -> TypeGuard[list[object]]:
    return isinstance(value, list)


def _is_object_mapping(value: object) -> TypeGuard[Mapping[object, object]]:
    return isinstance(value, Mapping)


def _normalize(value: str) -> str:
    return value.strip().lower()


def _truncate(value: str | None, max_length: int) -> str | None:
    if value is None:
        return None
    if len(value) <= max_length:
        return value
    if max_length <= 3:
        return value[:max_length]
    return f"{value[: max_length - 3]}..."


def _clamp_limit(value: int | None) -> int:
    if value is None:
        return DEFAULT_DEBUG_EVENT_LIMIT
    return max(1, min(MAX_DEBUG_EVENT_LIMIT, value))
