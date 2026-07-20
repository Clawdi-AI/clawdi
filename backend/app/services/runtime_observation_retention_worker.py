from __future__ import annotations

import asyncio
import logging

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.services.runtime_observation import expire_runtime_observation_payloads

log = logging.getLogger(__name__)


class RuntimeObservationRetentionWorker:
    """Run bounded inbox retention without coupling cleanup to API traffic."""

    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        poll_interval_seconds: float = 60 * 60,
    ) -> None:
        self._sessionmaker = sessionmaker
        self._poll_interval_seconds = poll_interval_seconds

    async def run_once(self) -> int:
        async with self._sessionmaker() as db:
            compacted = await expire_runtime_observation_payloads(db)
            await db.commit()
            return compacted

    async def run_forever(self, stop: asyncio.Event | None = None) -> None:
        stop_event = stop or asyncio.Event()
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=self._poll_interval_seconds)
            return
        except TimeoutError:
            pass
        while not stop_event.is_set():
            try:
                await self.run_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - cleanup must not stop other workers.
                log.exception("runtime observation retention worker failed: %s", exc)
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=self._poll_interval_seconds)
            except TimeoutError:
                pass
