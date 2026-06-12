from __future__ import annotations

import asyncio
import logging

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.services.channels import prune_channel_messages

log = logging.getLogger(__name__)


class ChannelMessageRetentionWorker:
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
            deleted = await prune_channel_messages(db)
            await db.commit()
            return deleted

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
            except Exception as exc:  # noqa: BLE001 - cleanup must not stop channel workers.
                log.exception("channel message retention worker failed: %s", exc)
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=self._poll_interval_seconds)
            except TimeoutError:
                pass
