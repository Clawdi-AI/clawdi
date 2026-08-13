"""Signal-only wakeups for committed channel work."""

from __future__ import annotations

import asyncio

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

CHANNEL_DELIVERIES_ENQUEUED = "channel_deliveries_enqueued"
CHANNEL_INBOUND_MESSAGES_ENQUEUED = "channel_inbound_messages_enqueued"


class ChannelWakeup:
    """Process-local broadcast subscription for PostgreSQL notifications."""

    def __init__(self) -> None:
        self._waiters: set[asyncio.Event] = set()

    def subscribe(self) -> asyncio.Event:
        waiter = asyncio.Event()
        self._waiters.add(waiter)
        return waiter

    def unsubscribe(self, waiter: asyncio.Event) -> None:
        self._waiters.discard(waiter)

    def signal(self) -> None:
        for waiter in self._waiters:
            waiter.set()


channel_deliveries_enqueued = ChannelWakeup()
channel_inbound_messages_enqueued = ChannelWakeup()


async def notify_channel_delivery_enqueued(db: AsyncSession) -> None:
    """Wake delivery workers after the surrounding transaction commits."""
    await _notify_channel_work_enqueued(db, CHANNEL_DELIVERIES_ENQUEUED)


async def notify_channel_inbound_message_enqueued(db: AsyncSession) -> None:
    """Wake inbox consumers after the surrounding transaction commits."""
    await _notify_channel_work_enqueued(db, CHANNEL_INBOUND_MESSAGES_ENQUEUED)


async def _notify_channel_work_enqueued(db: AsyncSession, channel: str) -> None:
    await db.execute(
        text("SELECT pg_notify(:channel, '')"),
        {"channel": channel},
    )
