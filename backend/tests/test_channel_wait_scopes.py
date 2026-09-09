"""Real PG hint compatibility for protocol-specific and unscoped inbox waits."""

import asyncio
import time

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import settings
from app.routes.channel_routers import whatsapp
from app.services import channels, sync_events
from app.services.channel_wakeups import (
    channel_inbound_messages_enqueued as wakeup,
)
from app.services.channel_wakeups import (
    notify_channel_inbound_message_enqueued,
)
from tests.test_channel_inbox import _add_message, _create_account_and_binding

pytestmark = pytest.mark.committed_db


@pytest.mark.parametrize("protocol", ["telegram", "whatsapp", "inbox", "unscoped_inbox"])
async def test_protocol_wait_hint_compatibility(
    db_session, seed_user, channel_agent, monkeypatch, protocol
):
    monkeypatch.setattr(settings, "channel_long_poll_max_seconds", 30.0)
    monkeypatch.setattr(settings, "channel_long_poll_interval_seconds", 5.0)
    account, binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider="whatsapp" if protocol == "whatsapp" else "telegram",
        chat_id="scope-fixture",
    )
    await db_session.commit()
    account_id, link_id = account.id, binding.bot_agent_link_id
    account_key = str(account_id)
    engine = create_async_engine(settings.database_url, pool_size=8, max_overflow=0, pool_timeout=5)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(whatsapp, "async_session_factory", sessions)
    empty_page = asyncio.Event()
    original_wait = channels.wait_for_channel_inbound_messages

    async def observed_wait(fetch, **kwargs):
        async def observed_fetch():
            page = await fetch()
            if not page.items and not page.progressed:
                empty_page.set()
            return page

        return await original_wait(observed_fetch, **kwargs)

    monkeypatch.setattr(channels, "wait_for_channel_inbound_messages", observed_wait)
    monkeypatch.setattr(whatsapp, "wait_for_channel_inbound_messages", observed_wait)

    async def wait(after_sequence, offset):
        if protocol == "telegram":
            return await channels.wait_for_telegram_updates(
                sessions,
                account_id=account_id,
                bot_agent_link_id=link_id,
                offset=offset,
                limit=100,
                timeout_seconds=30,
            )
        if protocol == "whatsapp":
            return await whatsapp._wait_whatsapp_websocket_inbox(
                account_id=account_id,
                bot_agent_link_id=link_id,
                after_sequence=after_sequence,
            )
        return await channels.wait_for_channel_inbox_events(
            sessions,
            account_id=account_id,
            bot_agent_link_id=None if protocol == "unscoped_inbox" else link_id,
            after_sequence=after_sequence,
            limit=100,
            timeout_seconds=30,
        )

    async def start_wait(after_sequence, offset):
        empty_page.clear()
        pending = asyncio.create_task(wait(after_sequence, offset))
        try:
            async with asyncio.timeout(5):
                await empty_page.wait()
                while engine.pool.checkedout():
                    await asyncio.sleep(0.005)
            assert not pending.done()
            return pending
        except BaseException:
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
            raise

    original_callback = sync_events._on_channel_inbound_message_enqueued
    legacy_seen = asyncio.Event()

    def legacy_callback(_pid, _channel, payload):
        # Exact released raw-key matching; an extended payload is unknown.
        wakeup.signal(payload)
        legacy_seen.set()

    pending = None
    after_sequence = 0
    try:
        for index, kind in enumerate(["link", "account", "legacy_callback"]):
            monkeypatch.setattr(
                sync_events,
                "_on_channel_inbound_message_enqueued",
                legacy_callback if kind == "legacy_callback" else original_callback,
            )
            await sync_events.start_postgres_listener()
            pending = await start_wait(after_sequence, index + 1)
            payload = {"update_id": index + 1, "message": {"text": "fixture"}}
            message = await _add_message(
                db_session,
                account=account,
                binding=binding,
                text="fixture",
                payload=payload,
            )
            await notify_channel_inbound_message_enqueued(
                db_session,
                account_id=account_key,
                bot_agent_link_id=None if kind == "account" else str(link_id),
            )
            await db_session.commit()
            started = time.perf_counter()
            if kind == "legacy_callback":
                await asyncio.wait_for(legacy_seen.wait(), 2)
                assert not pending.done()
            values = await asyncio.wait_for(pending, 7)
            pending = None
            assert len(values) == 1
            assert (values[0] if protocol == "telegram" else values[0].payload) == payload
            after_sequence = message.inbox_sequence
            if kind == "legacy_callback":
                print(
                    f"PROTOCOL_FALLBACK protocol={protocol} "
                    f"seconds={time.perf_counter() - started:.3f}"
                )
            await sync_events.stop_postgres_listener()
        # Park a real empty DB poll, then cancel without retaining pool slots or subscriptions.
        pending = await start_wait(after_sequence, 4)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
        pending = None
        assert engine.pool.checkedout() == 0
        assert account_key not in wakeup._waiters
        assert account_key not in wakeup._scoped_waiters
    finally:
        if pending is not None:
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
        await sync_events.stop_postgres_listener()
        await engine.dispose()
