"""Budget accounting for XTrace memory ingestion."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, time
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.xtrace_ingest import XTraceMemoryIngest


@dataclass(frozen=True)
class XTraceBudgetDecision:
    allowed: bool
    limit: int
    used: int
    requested: int
    remaining: int

    def as_response(self) -> dict[str, int | bool]:
        return {
            "allowed": self.allowed,
            "limit": self.limit,
            "used": self.used,
            "requested": self.requested,
            "remaining": self.remaining,
        }


async def decide_xtrace_user_budget(
    db: AsyncSession,
    *,
    user_id: UUID,
    requested_messages: int,
) -> XTraceBudgetDecision | None:
    limit = max(0, settings.xtrace_memory_daily_message_budget_per_user)
    if limit == 0:
        return None

    used = await xtrace_user_daily_message_usage(db, user_id=user_id)
    requested = max(0, requested_messages)
    remaining = max(0, limit - used)
    return XTraceBudgetDecision(
        allowed=used + requested <= limit,
        limit=limit,
        used=used,
        requested=requested,
        remaining=remaining,
    )


async def xtrace_user_daily_message_usage(db: AsyncSession, *, user_id: UUID) -> int:
    start = datetime.combine(datetime.now(UTC).date(), time.min, tzinfo=UTC)
    rows = (
        (
            await db.execute(
                select(XTraceMemoryIngest.response).where(
                    XTraceMemoryIngest.user_id == user_id,
                    XTraceMemoryIngest.created_at >= start,
                )
            )
        )
        .scalars()
        .all()
    )
    return sum(_accounted_messages(response) for response in rows)


def xtrace_cost_metadata(
    *,
    estimated_source_messages: int,
    estimated_xtrace_messages: int,
    payload_message_count: int | None = None,
    accounted_xtrace_messages: int | None = None,
    message_hashes: list[str] | None = None,
) -> dict[str, Any]:
    cost: dict[str, Any] = {
        "estimated_source_messages": estimated_source_messages,
        "estimated_xtrace_messages": estimated_xtrace_messages,
        "accounted_xtrace_messages": max(
            0,
            accounted_xtrace_messages
            if accounted_xtrace_messages is not None
            else estimated_xtrace_messages,
        ),
    }
    if payload_message_count is not None:
        cost["payload_message_count"] = max(0, payload_message_count)

    metadata: dict[str, Any] = {"cost": cost}
    if message_hashes is not None:
        metadata["message_hashes"] = message_hashes
    return metadata


def _accounted_messages(response: Any) -> int:
    if not isinstance(response, dict):
        return 0
    clawdi = response.get("_clawdi")
    if not isinstance(clawdi, dict):
        return 0
    cost = clawdi.get("cost")
    if not isinstance(cost, dict):
        return 0
    for key in ("accounted_xtrace_messages", "payload_message_count", "estimated_xtrace_messages"):
        value = cost.get(key)
        if isinstance(value, int):
            return max(0, value)
        if isinstance(value, float):
            return max(0, int(value))
    return 0
