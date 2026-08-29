"""Recall counting — bump `Memory.access_count` when agents retrieve memories.

The counter owns a short-lived database session and never raises. REST
searches schedule it as a FastAPI background task; MCP searches await it
before returning so their tool result and recall count stay in step. In
both paths a failed UPDATE can never break search.

Kill switch: `MEMORY_RECALL_COUNTING=false` disables counting entirely
(no deploy needed) if the extra write per agent search ever matters.
"""

from __future__ import annotations

import logging
from uuid import UUID

from pydantic import JsonValue
from sqlalchemy import update

from app.core.config import settings
from app.core.database import async_session_factory
from app.models.memory import Memory

log = logging.getLogger(__name__)


def recall_counting_enabled() -> bool:
    return settings.memory_recall_counting


async def bump_recall_counts(user_id: UUID, memory_ids: list[UUID]) -> None:
    """Increment access_count for the given memories. Never raises.

    The task owns a short-lived session from the process-wide bounded pool;
    it never reuses the request session or creates an engine per recall.
    """
    if not memory_ids:
        return
    try:
        async with async_session_factory() as db:
            await db.execute(
                update(Memory)
                .where(Memory.user_id == user_id, Memory.id.in_(memory_ids))
                .values(access_count=Memory.access_count + 1)
            )
            await db.commit()
    except Exception:  # noqa: BLE001 — counting must never break anything
        log.warning("memory_recall_count_failed user=%s n=%d", user_id, len(memory_ids))


def recall_ids_from_hits(hits: list[dict[str, JsonValue]]) -> list[UUID]:
    """Parse memory ids out of provider hits; unparseable ids are skipped
    (Mem0-backed hits may carry non-UUID ids — they have no local row to
    count against anyway)."""
    ids: list[UUID] = []
    for m in hits:
        try:
            ids.append(UUID(str(m["id"])))
        except (KeyError, ValueError):
            continue
    return ids
