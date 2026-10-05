from __future__ import annotations

import asyncio
import logging

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.services.runtime_observation import expire_runtime_observation_payloads

log = logging.getLogger(__name__)


class RuntimeObservationRetentionWorker:
    """Drain eligible inbox payloads in bounded, committed batches."""

    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        poll_interval_seconds: float = 60 * 60,
        drain_pause_seconds: float = 0.5,
    ) -> None:
        self._sessionmaker = sessionmaker
        self._poll_interval_seconds = poll_interval_seconds
        self._drain_pause_seconds = drain_pause_seconds

    async def run_once(self) -> int:
        async with self._sessionmaker() as db:
            compacted = await expire_runtime_observation_payloads(db)
            await db.commit()
            return compacted

    async def run_forever(self, stop: asyncio.Event | None = None) -> None:
        stop_event = stop or asyncio.Event()
        while not stop_event.is_set():
            try:
                compacted = await self.run_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - cleanup must not stop other workers.
                log.exception("runtime observation retention worker failed: %s", exc)
                compacted = 0
            pause_seconds = (
                self._drain_pause_seconds if compacted > 0 else self._poll_interval_seconds
            )
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=pause_seconds)
            except TimeoutError:
                pass
