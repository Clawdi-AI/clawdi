"""Signal-only wakeups for committed channel work."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings

CHANNEL_DELIVERIES_ENQUEUED = "channel_deliveries_enqueued"
CHANNEL_INBOUND_MESSAGES_ENQUEUED = "channel_inbound_messages_enqueued"


class ChannelWakeup:
    """Process-local keyed subscription for PostgreSQL notifications."""

    def __init__(self) -> None:
        self._waiters: dict[str, set[asyncio.Event]] = {}

    def subscribe(self, key: str) -> asyncio.Event:
        waiter = asyncio.Event()
        self._waiters.setdefault(key, set()).add(waiter)
        return waiter

    def unsubscribe(self, key: str, waiter: asyncio.Event) -> None:
        waiters = self._waiters.get(key)
        if waiters is None:
            return
        waiters.discard(waiter)
        if not waiters:
            del self._waiters[key]

    def signal(self, key: str) -> None:
        for waiter in self._waiters.get(key, ()):
            waiter.set()


channel_deliveries_enqueued = ChannelWakeup()
channel_inbound_messages_enqueued = ChannelWakeup()


async def wait_for_channel_inbound_messages[T](
    fetch: Callable[[], Awaitable[list[T]]],
    *,
    account_id: str,
    timeout_seconds: int | float | None,
    fallback_poll_seconds: float | None = None,
    wakeup: ChannelWakeup | None = None,
) -> list[T]:
    """Wait without holding a DB session, with a bounded notification-loss fallback."""

    timeout = max(0.0, min(float(timeout_seconds or 0), 30.0))
    configured_fallback = (
        settings.channel_long_poll_interval_seconds
        if fallback_poll_seconds is None
        else fallback_poll_seconds
    )
    fallback = max(0.001, float(configured_fallback))
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    source = wakeup or channel_inbound_messages_enqueued
    notified = source.subscribe(account_id)
    try:
        while True:
            # Clearing before the query is load-bearing. A commit notification
            # during or immediately after the query remains set and forces a
            # recheck, closing the query-to-wait lost-wakeup window.
            notified.clear()
            values = await fetch()
            if values or timeout == 0 or loop.time() >= deadline:
                return values
            if notified.is_set():
                continue
            try:
                await asyncio.wait_for(
                    notified.wait(),
                    timeout=min(fallback, max(0.0, deadline - loop.time())),
                )
            except TimeoutError:
                pass
    finally:
        source.unsubscribe(account_id, notified)


async def notify_channel_delivery_enqueued(db: AsyncSession) -> None:
    """Wake delivery workers after the surrounding transaction commits."""
    await _notify_channel_work_enqueued(
        db,
        CHANNEL_DELIVERIES_ENQUEUED,
        CHANNEL_DELIVERIES_ENQUEUED,
    )


async def notify_channel_inbound_message_enqueued(db: AsyncSession, *, account_id: str) -> None:
    """Wake inbox consumers after the surrounding transaction commits."""
    await _notify_channel_work_enqueued(db, CHANNEL_INBOUND_MESSAGES_ENQUEUED, account_id)


async def _notify_channel_work_enqueued(db: AsyncSession, channel: str, key: str) -> None:
    await db.execute(
        text("SELECT pg_notify(:channel, :key)"),
        {"channel": channel, "key": key},
    )
