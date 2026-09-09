"""Bounded ABBA comparison through real authenticated ASGI getUpdates requests."""

import asyncio
import json
import os
import time
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import event, select
from sqlalchemy.exc import TimeoutError as PoolTimeout
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import settings
from app.core.database import get_session
from app.main import app
from app.models.channel import ChannelBinding, ChannelBotAgentLink, ChannelMessage
from app.routes.channel_routers import telegram
from app.services import channels, sync_events
from app.services.channel_wakeups import channel_inbound_messages_enqueued as wakeup
from tests.conftest import create_env_with_project, create_test_hosted_runtime_state
from tests.test_channel_fanout_load import distribution
from tests.test_channel_inbox import _create_account_and_binding
from tests.test_channels import _seed_existing_channel_link, _telegram_bot_path

pytestmark = [
    pytest.mark.committed_db,
    pytest.mark.skipif(os.getenv("CLAWDI_FANOUT_LOAD") != "1", reason="bounded opt-in load"),
]


async def eventually(predicate):
    async with asyncio.timeout(5):
        while not predicate():
            await asyncio.sleep(0.005)


@pytest.mark.parametrize("consumers", [1, 4, 16, 33])
async def test_telegram_fanout(db_session, seed_user, channel_agent, monkeypatch, consumers):
    monkeypatch.setattr(settings, "channel_long_poll_max_seconds", 30.0)
    monkeypatch.setattr(settings, "channel_long_poll_interval_seconds", 5.0)
    account, binding = await _create_account_and_binding(
        db_session, user=seed_user, agent=channel_agent, provider="telegram", chat_id="42"
    )
    link = await db_session.get(ChannelBotAgentLink, binding.bot_agent_link_id)
    tokens = [channels.generate_agent_token("telegram")]
    channels.store_agent_link_token(link, tokens[0])
    for index in range(1, consumers):
        agent = await create_env_with_project(
            db_session,
            user_id=seed_user.id,
            machine_id=f"tg-load-{uuid4().hex}",
            machine_name="Telegram load fixture",
            agent_type="openclaw",
        )
        await create_test_hosted_runtime_state(db_session, agent, runtime_name="openclaw")
        idle_link, token = await _seed_existing_channel_link(
            db_session, account_id=str(account.id), agent=agent
        )
        db_session.add(
            ChannelBinding(
                account_id=account.id,
                bot_agent_link_id=idle_link.id,
                user_id=seed_user.id,
                external_chat_id=str(42 + index),
                external_chat_type="private",
            )
        )
        tokens.append(token)
    await db_session.commit()
    account_key, target_key = str(account.id), str(binding.bot_agent_link_id)
    url = _telegram_bot_path({"id": account_key}, "getUpdates")
    engine = create_async_engine(settings.database_url, pool_size=8, max_overflow=0, pool_timeout=5)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(telegram, "async_session_factory", sessions)
    sql_count = 0
    pool_timeouts = 0
    active_sessions = set()
    empty_counts = {}
    progress_pages = 0
    original_dequeue = channels.dequeue_telegram_updates
    original_wait = channels.wait_for_channel_inbound_messages

    async def request_session():
        nonlocal pool_timeouts
        async with sessions() as session:
            assert session not in active_sessions
            active_sessions.add(session)
            try:
                yield session
            except PoolTimeout:
                pool_timeouts += 1
                raise
            finally:
                active_sessions.remove(session)

    # Only replace the session dependency. The route still resolves the bearer,
    # account routing ID, Link and strict runtime authority against real PG.
    app.dependency_overrides[get_session] = request_session

    async def observed_dequeue(*args, **kwargs):
        nonlocal progress_pages
        page = await original_dequeue(*args, **kwargs)
        if page.progressed:
            progress_pages += 1
        if not page.items and not page.progressed:
            key = str(kwargs["bot_agent_link_id"])
            empty_counts[key] = empty_counts.get(key, 0) + 1
        return page

    async def account_wait(fetch, **kwargs):
        # The pre-change waiting path: no Link scope. Keep the exact same fetch,
        # SQL, offsets, transaction boundaries and production fallback settings.
        kwargs.pop("bot_agent_link_id", None)
        return await original_wait(fetch, **kwargs)

    def count_sql(*_args):
        nonlocal sql_count
        sql_count += 1

    monkeypatch.setattr(channels, "dequeue_telegram_updates", observed_dequeue)
    event.listen(engine.sync_engine, "before_cursor_execute", count_sql)
    lags = []

    async def probe():
        while True:
            started = time.perf_counter()
            await asyncio.sleep(0.01)
            lags.append(max(0, (time.perf_counter() - started - 0.01) * 1000))

    tasks = set()
    probe_task = None
    next_update = 1000
    try:
        async with asyncio.timeout(90):
            await sync_events.start_postgres_listener()
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                invalid = await client.post(
                    url, headers={"Authorization": "Bearer invalid"}, json={"timeout": 0}
                )
                assert invalid.status_code == 401

                def poll(token, offset=None, timeout=30):
                    task = asyncio.create_task(
                        client.post(
                            url,
                            headers={"Authorization": f"Bearer {token}"},
                            json={
                                "timeout": timeout,
                                "offset": offset,
                                "allowed_updates": ["message"],
                            },
                        )
                    )
                    tasks.add(task)
                    return task

                order = ["account", "link", "link", "account"]
                if consumers in (4, 33):
                    order = ["link", "account", "account", "link"]
                for block, strategy in enumerate(order):
                    monkeypatch.setattr(
                        channels,
                        "wait_for_channel_inbound_messages",
                        account_wait if strategy == "account" else original_wait,
                    )
                    empty_counts.clear()
                    idle = [poll(token) for token in tokens[1:]]
                    target = poll(tokens[0], next_update)
                    await eventually(
                        lambda: len(empty_counts) == consumers and engine.pool.checkedout() == 0
                    )
                    assert len(active_sessions) == consumers
                    probe_task = asyncio.create_task(probe())
                    for mode, batches, size, interval in [
                        ("steady", 8, 1, 0.75),
                        ("burst", 4, 3, 0.4),
                    ]:
                        samples = []
                        response_samples = []
                        before_progress = progress_pages
                        message_ids = []
                        lags.clear()
                        before_sql, before_empty = sql_count, sum(empty_counts.values())
                        cpu, started = time.process_time(), time.perf_counter()
                        for batch in range(batches):
                            await asyncio.sleep(
                                max(0, started + (batch + 1) * interval - time.perf_counter())
                            )
                            payloads = []
                            for _ in range(size):
                                payload = {
                                    "update_id": next_update,
                                    "message": {
                                        "message_id": next_update,
                                        "chat": {"id": 42, "type": "private"},
                                        "text": "synthetic payload",
                                        "entities": [],
                                    },
                                }
                                message = await channels.record_inbound_message(
                                    db_session,
                                    account=account,
                                    binding=binding,
                                    external_chat_id="42",
                                    provider_message_id=str(next_update),
                                    text=None,
                                    payload=payload,
                                )
                                message_ids.append(message.id)
                                payloads.append(payload)
                                next_update += 1
                            await db_session.commit()
                            committed = time.perf_counter()
                            response = await asyncio.wait_for(target, 7)
                            elapsed = (time.perf_counter() - committed) * 1000
                            assert response.status_code == 200
                            assert response.json() == {"ok": True, "result": payloads}
                            samples.extend([elapsed] * size)
                            response_samples.append(round(elapsed, 3))
                            tasks.remove(target)
                            previous_empty = empty_counts[target_key]
                            target = poll(tokens[0], next_update)
                            await eventually(
                                lambda: (
                                    empty_counts[target_key] > previous_empty
                                    and engine.pool.checkedout() == 0
                                )
                            )
                            assert not any(task.done() for task in idle)
                        await asyncio.sleep(0.15)
                        print(
                            "TELEGRAM_FANOUT",
                            json.dumps(
                                {
                                    "consumers": consumers,
                                    "strategy": strategy,
                                    "block": block,
                                    "mode": mode,
                                    "latency_ms": distribution(samples),
                                    "sql_per_message": round(
                                        (sql_count - before_sql) / len(samples), 3
                                    ),
                                    "empty_queries": sum(empty_counts.values()) - before_empty,
                                    "progress_pages": progress_pages - before_progress,
                                    "response_latency_ms": response_samples,
                                    "pool_timeouts": pool_timeouts,
                                    "loop_lag_ms": distribution(lags),
                                    "cpu_ms": round((time.process_time() - cpu) * 1000, 3),
                                    "wall_s": round(time.perf_counter() - started, 3),
                                }
                            ),
                            flush=True,
                        )
                        # The next offset request durably acknowledges every earlier update.
                        receipts = (
                            await db_session.scalars(
                                select(ChannelMessage.delivered_at).where(
                                    ChannelMessage.id.in_(message_ids)
                                )
                            )
                        ).all()
                        assert len(receipts) == len(message_ids) and all(receipts)
                    for task in tasks:
                        task.cancel()
                    results = await asyncio.gather(*tasks, return_exceptions=True)
                    assert all(isinstance(result, asyncio.CancelledError) for result in results)
                    tasks.clear()
                    probe_task.cancel()
                    await asyncio.gather(probe_task, return_exceptions=True)
                    probe_task = None
                    assert not active_sessions and engine.pool.checkedout() == 0
                    assert account_key not in wakeup._waiters
                    assert account_key not in wakeup._scoped_waiters
                    for token in tokens:
                        response = await client.post(
                            url,
                            headers={"Authorization": f"Bearer {token}"},
                            json={"timeout": 0, "offset": next_update},
                        )
                        assert response.status_code == 200 and response.json()["result"] == []
    finally:
        for task in tasks:
            task.cancel()
        if probe_task is not None:
            probe_task.cancel()
        await asyncio.gather(
            *tasks, *([probe_task] if probe_task is not None else []), return_exceptions=True
        )
        await sync_events.stop_postgres_listener()
        await engine.dispose()
