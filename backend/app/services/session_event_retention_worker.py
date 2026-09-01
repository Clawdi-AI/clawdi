from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import and_, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.session import Session, SessionEventChunk, SessionEventGeneration
from app.models.session_share import SessionShare
from app.services.file_store import FileStore, get_file_store

log = logging.getLogger(__name__)

STAGING_RETENTION = timedelta(days=1)
SUPERSEDED_RETENTION = timedelta(days=7)


class SessionEventRetentionWorker:
    """Delete abandoned and superseded immutable event generations."""

    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        file_store: FileStore | None = None,
        poll_interval_seconds: float = 60 * 60,
    ) -> None:
        self._sessionmaker = sessionmaker
        self._file_store = file_store or get_file_store()
        self._poll_interval_seconds = poll_interval_seconds

    async def run_once(self, *, now: datetime | None = None) -> UUID | None:
        current_time = now or datetime.now(UTC)
        async with self._sessionmaker() as db:
            generation = (
                await db.execute(
                    select(SessionEventGeneration)
                    .join(Session, Session.id == SessionEventGeneration.session_id)
                    .where(
                        SessionEventGeneration.id.is_distinct_from(Session.event_generation_id),
                        ~exists().where(
                            SessionShare.event_generation_id == SessionEventGeneration.id,
                            SessionShare.revoked_at.is_(None),
                        ),
                        or_(
                            and_(
                                SessionEventGeneration.status == "staging",
                                SessionEventGeneration.created_at
                                < current_time - STAGING_RETENTION,
                            ),
                            and_(
                                SessionEventGeneration.status == "committed",
                                SessionEventGeneration.superseded_at.is_not(None),
                                SessionEventGeneration.superseded_at
                                < current_time - SUPERSEDED_RETENTION,
                            ),
                        ),
                    )
                    .order_by(
                        SessionEventGeneration.superseded_at.asc().nulls_first(),
                        SessionEventGeneration.created_at,
                        SessionEventGeneration.id,
                    )
                    .limit(1)
                    .with_for_update(of=SessionEventGeneration, skip_locked=True)
                )
            ).scalar_one_or_none()
            if generation is None:
                await db.rollback()
                return None

            file_keys = list(
                (
                    await db.execute(
                        select(SessionEventChunk.file_key).where(
                            SessionEventChunk.generation_id == generation.id
                        )
                    )
                ).scalars()
            )
            for file_key in file_keys:
                await self._file_store.delete(file_key)
            generation_id = generation.id
            await db.delete(generation)
            await db.commit()
            return generation_id

    async def run_forever(self, stop: asyncio.Event | None = None) -> None:
        stop_event = stop or asyncio.Event()
        while not stop_event.is_set():
            try:
                deleted = await self.run_once()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - cleanup must remain retryable.
                log.exception("session event retention worker failed")
                deleted = None
            if deleted is not None:
                continue
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=self._poll_interval_seconds)
            except TimeoutError:
                pass


__all__ = ["SessionEventRetentionWorker"]
