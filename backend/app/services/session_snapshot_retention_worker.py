from __future__ import annotations

import asyncio
import logging
import re
from datetime import UTC, datetime, timedelta

from sqlalchemy import exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.session import Session
from app.models.session_share import SessionShare
from app.services.file_store import S3FileStore, get_file_store

log = logging.getLogger(__name__)
SNAPSHOT_PREFIX = "session-snapshots/v1/"
SNAPSHOT_RETENTION = timedelta(days=1)
_SNAPSHOT_KEY = re.compile(
    r"session-snapshots/v1/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f]{64}-[0-9a-f-]{36}\.json"
)


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

    async def run_once(self, *, now: datetime | None = None, dry_run: bool = False) -> int:
        store = self._file_store
        if store is None:
            return 0
        cutoff = (now or datetime.now(UTC)) - SNAPSHOT_RETENTION
        listed = await store.list_objects(
            SNAPSHOT_PREFIX, start_after=self._start_after, limit=1000
        )
        candidates = 0
        for item in listed:
            if not item.key.startswith(SNAPSHOT_PREFIX) or item.key <= self._start_after:
                raise ValueError("Object listing escaped the snapshot sweep cursor")
            # Advance after processing so failures retry from this object.
            if _SNAPSHOT_KEY.fullmatch(item.key) and item.last_modified < cutoff:
                async with self._sessionmaker() as db:
                    referenced = await db.scalar(
                        select(
                            or_(
                                exists().where(Session.file_key == item.key),
                                exists().where(
                                    SessionShare.snapshot_file_key == item.key,
                                    or_(
                                        SessionShare.revoked_at.is_(None),
                                        SessionShare.revoked_at >= cutoff,
                                    ),
                                ),
                            )
                        )
                    )
                # This key is unique to one attempt; its bounded publish phase
                # cannot publish a day-old object. No DB connection across S3.
                if referenced is False:
                    if not dry_run:
                        await store.delete(item.key)
                    candidates += 1
            self._start_after = item.key
        if len(listed) < 1000:
            self._start_after = ""
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
