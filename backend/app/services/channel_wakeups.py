"""Signal-only wakeups for committed channel work."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings

CHANNEL_DELIVERIES_ENQUEUED = "channel_deliveries_enqueued"
CHANNEL_INBOUND_MESSAGES_ENQUEUED = "channel_inbound_messages_enqueued"


class ChannelWakeup:
    """Process-local keyed subscription for PostgreSQL notifications."""

    def __init__(self) -> None:
        self._waiters: dict[str, set[asyncio.Event]] = {}
        self._scoped_waiters: dict[str, dict[str, set[asyncio.Event]]] = {}

    def subscribe(self, key: str, *, scope: str | None = None) -> asyncio.Event:
        waiter = asyncio.Event()
        if scope is None:
            self._waiters.setdefault(key, set()).add(waiter)
        else:
            self._scoped_waiters.setdefault(key, {}).setdefault(scope, set()).add(waiter)
        return waiter

    def unsubscribe(self, key: str, waiter: asyncio.Event, *, scope: str | None = None) -> None:
        subscriptions = self._waiters if scope is None else self._scoped_waiters.get(key, {})
        subscription_key = key if scope is None else scope
        waiters = subscriptions.get(subscription_key)
        if waiters is None:
            return
        waiters.discard(waiter)
        if not waiters:
            del subscriptions[subscription_key]
        if scope is not None and not subscriptions:
            self._scoped_waiters.pop(key, None)

    def signal(self, key: str, *, scope: str | None = None) -> None:
        for waiter in self._waiters.get(key, ()):
            waiter.set()
        scopes = self._scoped_waiters.get(key, {})
        # An account-only hint also wakes scoped consumers during mixed deployments.
        groups = scopes.values() if scope is None else (scopes.get(scope, set()),)
        for waiters in groups:
            for waiter in waiters:
                waiter.set()

    def signal_all(self) -> None:
        """Reconcile subscribers after a listener connection loses notifications."""
        for key in self._waiters.keys() | self._scoped_waiters.keys():
            self.signal(key)


channel_deliveries_enqueued = ChannelWakeup()
channel_inbound_messages_enqueued = ChannelWakeup()


@dataclass(frozen=True)
class ChannelInboxPage[T]:
    items: list[T]
    progressed: bool = False


async def wait_for_channel_inbound_messages[T](
    fetch: Callable[[], Awaitable[ChannelInboxPage[T]]],
    *,
    account_id: str,
    bot_agent_link_id: str | None = None,
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
    notified = source.subscribe(account_id, scope=bot_agent_link_id)
    try:
        while True:
            # Clearing before the query is load-bearing. A commit notification
            # during or immediately after the query remains set and forces a
            # recheck, closing the query-to-wait lost-wakeup window.
            notified.clear()
            page = await fetch()
            if page.items or timeout == 0 or loop.time() >= deadline:
                return page.items
            if page.progressed:
                # The caller committed a consumed page, not an empty queue.
                # Yield for cancellation/fairness; the request deadline bounds
                # repeated progress, while timeout=0 retains its single-page limit.
                await asyncio.sleep(0)
                continue
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
        source.unsubscribe(account_id, notified, scope=bot_agent_link_id)


async def notify_channel_delivery_enqueued(db: AsyncSession) -> None:
    """Wake delivery workers after the surrounding transaction commits."""
    await _notify_channel_work_enqueued(
        db,
        CHANNEL_DELIVERIES_ENQUEUED,
        CHANNEL_DELIVERIES_ENQUEUED,
    )


async def notify_channel_inbound_message_enqueued(
    db: AsyncSession, *, account_id: str, bot_agent_link_id: str | None = None
) -> None:
    """Wake inbox consumers after commit; old listeners retain their polling fallback."""
    key = account_id if bot_agent_link_id is None else f"{account_id}:{bot_agent_link_id}"
    await _notify_channel_work_enqueued(db, CHANNEL_INBOUND_MESSAGES_ENQUEUED, key)


async def _notify_channel_work_enqueued(db: AsyncSession, channel: str, key: str) -> None:
    await db.execute(
        text("SELECT pg_notify(:channel, :key)"),
        {"channel": channel, "key": key},
    )
