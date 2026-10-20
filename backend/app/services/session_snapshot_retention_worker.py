from __future__ import annotations

import asyncio
import logging
import re
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import delete, exists, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.session import Session, SessionSnapshotGcCandidate
from app.services.file_store import S3FileStore, get_file_store

log = logging.getLogger(__name__)
SNAPSHOT_PREFIX = "session-snapshots/v1/"
SNAPSHOT_RETENTION = timedelta(days=1)
_SNAPSHOT_KEY = re.compile(
    r"session-snapshots/v1/(?P<user>[0-9a-f-]{36})/(?P<session>[0-9a-f-]{36})/"
    r"[0-9a-f]{64}-(?P<attempt>[0-9a-f-]{36})\.json"
)


def _snapshot_session_id(key: str) -> UUID | None:
    match = _SNAPSHOT_KEY.fullmatch(key)
    if match is None:
        return None
    try:
        UUID(match["user"])
        UUID(match["attempt"])
        return UUID(match["session"])
    except ValueError:
        return None


class SessionSnapshotRetentionWorker:
    """Sweep one bounded page of old unpublished/superseded S3 snapshots."""

    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        file_store: S3FileStore | None = None,
        poll_interval_seconds: float = 300,
    ) -> None:
        self._sessionmaker = sessionmaker
        configured = file_store if file_store is not None else get_file_store()
        self._file_store = configured if isinstance(configured, S3FileStore) else None
        self._poll_interval_seconds = poll_interval_seconds
        self._start_after = ""

    async def _referenced(self, db: AsyncSession, key: str, session_id: UUID) -> bool:
        # Snapshot keys encode their one owning Session. Use its primary key,
        # never a scan of every Session for each listed object. Shares copy
        # bytes into session-share-sources/, outside this collector's prefix.
        return bool(
            await db.scalar(
                select(exists().where(Session.id == session_id, Session.file_key == key))
            )
        )

    async def run_once(self, *, now: datetime | None = None, dry_run: bool = False) -> int:
        store = self._file_store
        if store is None:
            return 0
        async with self._sessionmaker() as db:
            # Safe during mixed-version rollout before the expand-only migration.
            if await db.scalar(select(func.to_regclass("session_snapshot_gc_candidates"))) is None:
                return 0
        observed_at = now or datetime.now(UTC)
        cutoff = observed_at - SNAPSHOT_RETENTION
        listed = await store.list_objects(
            SNAPSHOT_PREFIX, start_after=self._start_after, limit=1000
        )
        for item in listed:
            if not item.key.startswith(SNAPSHOT_PREFIX) or item.key <= self._start_after:
                raise ValueError("Object listing escaped the snapshot sweep cursor")
            # A day-old attempt can no longer publish: publication is bounded
            # to two minutes. Start a separate, durable reader grace only once
            # the key is observed unreferenced, regardless of its object age.
            session_id = _snapshot_session_id(item.key)
            if not dry_run and session_id is not None and item.last_modified < cutoff:
                async with self._sessionmaker() as db:
                    if await self._referenced(db, item.key, session_id):
                        await db.execute(
                            delete(SessionSnapshotGcCandidate).where(
                                SessionSnapshotGcCandidate.file_key == item.key
                            )
                        )
                    else:
                        await db.execute(
                            insert(SessionSnapshotGcCandidate)
                            .values(file_key=item.key, unreferenced_at=observed_at)
                            .on_conflict_do_nothing()
                        )
                    await db.commit()
            self._start_after = item.key
        if len(listed) < 1000:
            self._start_after = ""

        # Process durable candidates even when their objects were already
        # deleted before a previous DB failure; S3 deletion is idempotent.
        async with self._sessionmaker() as db:
            due = list(
                await db.scalars(
                    select(SessionSnapshotGcCandidate.file_key)
                    .where(SessionSnapshotGcCandidate.unreferenced_at <= cutoff)
                    .order_by(
                        SessionSnapshotGcCandidate.unreferenced_at,
                        SessionSnapshotGcCandidate.file_key,
                    )
                    .limit(1000)
                )
            )
        candidates = 0
        for key in due:
            session_id = _snapshot_session_id(key)
            if session_id is None:
                continue
            async with self._sessionmaker() as db:
                referenced = await self._referenced(db, key, session_id)
            if not referenced:
                if not dry_run:
                    await store.delete(key)
                candidates += 1
            if not dry_run:
                async with self._sessionmaker() as db:
                    await db.execute(
                        delete(SessionSnapshotGcCandidate).where(
                            SessionSnapshotGcCandidate.file_key == key
                        )
                    )
                    await db.commit()
        return candidates

    async def run_forever(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            try:
                async with asyncio.timeout(60):
                    removed = await self.run_once()
                if removed:
                    log.info("session_snapshot_sweep deleted=%d", removed)
            except Exception:
                # Avoid object keys or provider diagnostics in periodic logs.
                log.warning("session_snapshot_sweep_failed")
            try:
                await asyncio.wait_for(stop.wait(), timeout=self._poll_interval_seconds)
            except TimeoutError:
                pass
