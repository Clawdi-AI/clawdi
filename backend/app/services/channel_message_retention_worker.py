from __future__ import annotations

import asyncio
import logging
from datetime import timedelta

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import settings
from app.services.channels import prune_channel_messages

log = logging.getLogger(__name__)


class ChannelMessageRetentionWorker:
    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        poll_interval_seconds: float = 60 * 60,
        delivered_retention_days: int | None = None,
        unbound_retention_hours: int | None = None,
        batch_size: int | None = None,
    ) -> None:
        self._sessionmaker = sessionmaker
        self._poll_interval_seconds = poll_interval_seconds
        self._delivered_retention = timedelta(
            days=delivered_retention_days
            if delivered_retention_days is not None
            else settings.channel_message_retention_days
        )
        self._unbound_retention = timedelta(
            hours=unbound_retention_hours
            if unbound_retention_hours is not None
            else settings.channel_unbound_message_retention_hours
        )
        self._batch_size = (
            batch_size if batch_size is not None else settings.channel_message_cleanup_batch_size
        )

    async def run_once(self) -> int:
        async with self._sessionmaker() as db:
            deleted = await prune_channel_messages(
                db,
                delivered_retention=self._delivered_retention,
                unbound_retention=self._unbound_retention,
                limit=self._batch_size,
            )
            await db.commit()
            return deleted

    async def run_forever(self, stop: asyncio.Event | None = None) -> None:
        stop_event = stop or asyncio.Event()
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
