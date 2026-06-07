from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel import (
    CHANNEL_PROVIDER_WHATSAPP,
    MESSAGE_DIRECTION_INBOUND,
    ChannelAccount,
    ChannelDebugEvent,
    ChannelMessage,
)

DEFAULT_DEBUG_EVENT_LIMIT = 100
MAX_DEBUG_EVENT_LIMIT = 1000
MAX_DEBUG_STRING = 500
SECRET_KEY_RE = re.compile(
    r"(token|secret|password|authorization|auth|key|credential|cookie)",
    re.I,
)


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
    details: dict[str, Any] | None = None,
) -> ChannelDebugEvent | None:
    try:
        now = datetime.now(UTC)
        async with db.begin_nested():
            event = ChannelDebugEvent(
                account_id=account.id if account is not None else None,
                user_id=user_id,
                provider=_normalize(provider),
                external_chat_id=_truncate(external_chat_id, 300),
                direction=direction,
                stage=_truncate(stage, 80) or "unknown",
                outcome=outcome,
                request_id=_truncate(request_id, 120),
                status_code=status_code,
                error=_truncate(error, MAX_DEBUG_STRING),
                details=_sanitize_details(details) if details is not None else None,
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
) -> list[dict[str, Any]]:
    accounts = (
        await db.execute(
            select(ChannelAccount)
            .where(
                ChannelAccount.user_id == user_id,
                ChannelAccount.archived_at.is_(None),
            )
            .order_by(ChannelAccount.provider, ChannelAccount.name)
        )
    ).scalars().all()
    health: list[dict[str, Any]] = []
    for account in accounts:
        item = {
            "accountId": str(account.id),
            "provider": account.provider,
            "name": account.name,
            "pendingInbox": await _pending_inbox_count(db, account=account),
            "lastEvent": _debug_event_response(
                await _last_event(db, account=account, error_only=False)
            ),
            "lastError": _debug_event_response(
                await _last_event(db, account=account, error_only=True)
            ),
        }
        if account.provider == CHANNEL_PROVIDER_WHATSAPP:
            from app.services.whatsapp_shared_runtime import (
                whatsapp_shared_bot_transport_status,
            )

            item["nativeTransport"] = whatsapp_shared_bot_transport_status(
                account.id
            ).as_dict()
        health.append(item)
    return health


def channel_debug_event_response(event: ChannelDebugEvent) -> dict[str, Any]:
    return _debug_event_response(event) or {}


def _debug_event_response(event: ChannelDebugEvent | None) -> dict[str, Any] | None:
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
        "error": event.error,
        "details": event.details,
    }


async def _pending_inbox_count(db: AsyncSession, *, account: ChannelAccount) -> int:
    result = await db.execute(
        select(ChannelMessage.id).where(
            ChannelMessage.account_id == account.id,
            ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
            ChannelMessage.binding_id.is_not(None),
            ChannelMessage.delivered_at.is_(None),
        )
    )
    return len(result.scalars().all())


async def _last_event(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    error_only: bool,
) -> ChannelDebugEvent | None:
    query = select(ChannelDebugEvent).where(ChannelDebugEvent.account_id == account.id)
    if error_only:
        query = query.where(
            (ChannelDebugEvent.outcome == "failure") | ChannelDebugEvent.error.is_not(None)
        )
    query = query.order_by(ChannelDebugEvent.created_at.desc(), ChannelDebugEvent.id.desc()).limit(
        1
    )
    result = await db.execute(query)
    return result.scalar_one_or_none()


def _sanitize_details(value: Any, *, depth: int = 0) -> Any:
    if depth > 4:
        return "[truncated]"
    if value is None or isinstance(value, (int, float, bool)):
        return value
    if isinstance(value, str):
        return _truncate(value, MAX_DEBUG_STRING)
    if isinstance(value, list):
        return [_sanitize_details(item, depth=depth + 1) for item in value[:20]]
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, child in list(value.items())[:40]:
            key_str = str(key)
            out[key_str] = (
                "[redacted]"
                if SECRET_KEY_RE.search(key_str)
                else _sanitize_details(child, depth=depth + 1)
            )
        return out
    return _truncate(str(value), MAX_DEBUG_STRING)


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
