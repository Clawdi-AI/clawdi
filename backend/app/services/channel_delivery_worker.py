from __future__ import annotations

import asyncio
import logging
import uuid
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.services.channels import claim_next_channel_delivery, deliver_channel_delivery

log = logging.getLogger(__name__)


class ChannelDeliveryWorker:
    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        worker_id: str | None = None,
        poll_interval_seconds: float = 1.0,
    ) -> None:
        self._sessionmaker = sessionmaker
        self._worker_id = worker_id or f"channel-delivery-{uuid.uuid4()}"
        self._poll_interval_seconds = poll_interval_seconds

    async def run_once(self) -> UUID | None:
        async with self._sessionmaker() as db:
            delivery = await claim_next_channel_delivery(db, worker_id=self._worker_id)
            if delivery is None:
                await db.rollback()
                return None
            delivery_id = delivery.id
            await deliver_channel_delivery(db, delivery=delivery)
            await db.commit()
            return delivery_id

    async def run_forever(self, stop: asyncio.Event | None = None) -> None:
        stop_event = stop or asyncio.Event()
        while not stop_event.is_set():
            try:
                delivery_id = await self.run_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - worker must keep polling after one bad job.
                log.exception("channel delivery worker failed: %s", exc)
                delivery_id = None
            if delivery_id is None:
                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=self._poll_interval_seconds)
                except TimeoutError:
                    pass


async def run_channel_delivery_once(
    sessionmaker: async_sessionmaker[AsyncSession],
) -> UUID | None:
    return await ChannelDeliveryWorker(sessionmaker).run_once()
