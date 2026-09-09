"""Opt-in bounded real PostgreSQL / Uvicorn / TCP Gateway fanout measurement."""

import asyncio
import json
import math
import os
import socket
import time
from contextlib import AsyncExitStack
from uuid import UUID, uuid4

import pytest
import uvicorn
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from websockets.asyncio.client import connect

from app.core.config import settings
from app.main import app
from app.models.channel import MESSAGE_DIRECTION_INBOUND, ChannelBinding, ChannelMessage
from app.routes.channel_routers import discord, shared
from app.services.channel_wakeups import notify_channel_inbound_message_enqueued
from app.services.discord_advisory_session import DiscordAdvisorySession
from app.services.sync_events import start_postgres_listener, stop_postgres_listener
from tests.conftest import create_env_with_project, create_test_hosted_runtime_state
from tests.test_channels import (
    _create_paired_discord_channel,
    _reset_discord_gateway_sessions,
    _seed_existing_channel_link,
)
from tests.test_channels import (
    _verified_discord_guild_membership as _verified_discord_guild_membership,
)

pytestmark = [
    pytest.mark.committed_db,
    pytest.mark.usefixtures("channel_agent"),
    pytest.mark.skipif(os.getenv("CLAWDI_FANOUT_LOAD") != "1", reason="bounded opt-in load"),
]


def distribution(values):
    ordered = sorted(values)
    return {
        "n": len(values),
        "p50": round(ordered[math.ceil(len(values) * 0.5) - 1], 3),
        "p95": round(ordered[math.ceil(len(values) * 0.95) - 1], 3),
        "max": round(ordered[-1], 3),
    }


@pytest.mark.parametrize("consumers", [1, 4, 16, 32])
async def test_gateway_fanout(client, db_session, monkeypatch, consumers):
    _reset_discord_gateway_sessions(monkeypatch)
    monkeypatch.setattr(settings, "discord_gateway_poll_interval_seconds", 1.0)
    created = await _create_paired_discord_channel(client, name=f"fanout-{uuid4().hex}")
    account_id = UUID(created["id"])
    binding = (
        await db_session.scalars(
            select(ChannelBinding).where(ChannelBinding.account_id == account_id)
        )
    ).one()
    tokens = [created["agent_token"]]
    for index in range(1, consumers):
        agent = await create_env_with_project(
            db_session,
            user_id=binding.user_id,
            machine_id=f"fanout-{uuid4().hex}",
            machine_name="Fanout fixture",
            agent_type="openclaw",
        )
        await create_test_hosted_runtime_state(db_session, agent, runtime_name="openclaw")
        link, token = await _seed_existing_channel_link(
            db_session, account_id=str(account_id), agent=agent
        )
        db_session.add(
            ChannelBinding(
                account_id=account_id,
                bot_agent_link_id=link.id,
                user_id=binding.user_id,
                external_chat_id=f"idle-guild-{index}",
                external_chat_type="guild",
            )
        )
        tokens.append(token)
    await db_session.commit()
    engine = create_async_engine(settings.database_url, pool_size=8, max_overflow=0, pool_timeout=5)
    monkeypatch.setattr(
        discord, "async_session_factory", async_sessionmaker(engine, expire_on_commit=False)
    )
    locks = DiscordAdvisorySession(engine)
    monkeypatch.setattr(app.state, "discord_gateway_locks", locks, raising=False)
    sql_count = 0
    pool_timeouts = 0
    empty_by_link = {}
    original = discord.dequeue_discord_gateway_events

    async def observed(*args, **kwargs):
        values = await original(*args, **kwargs)
        if not values:
            key = str(kwargs["bot_agent_link_id"])
            empty_by_link[key] = empty_by_link.get(key, 0) + 1
        return values

    def sql(*_args):
        nonlocal sql_count
        sql_count += 1

    # Observe loop exceptions as well as ordinary query errors; never log parameters.
    from sqlalchemy.exc import TimeoutError as PoolTimeout

    async def checked(*args, **kwargs):
        nonlocal pool_timeouts
        try:
            return await observed(*args, **kwargs)
        except PoolTimeout:
            pool_timeouts += 1
            raise

    async def provider(**_kwargs):
        return shared.DiscordProviderResult(
            content=json.dumps(
                {
                    "id": "discord-chan-1",
                    "guild_id": "discord-guild-1",
                    "type": 0,
                    "name": "fixture",
                }
            ).encode(),
            status_code=200,
            media_type="application/json",
        )

    monkeypatch.setattr(discord, "dequeue_discord_gateway_events", checked)
    monkeypatch.setattr(discord, "request_discord_provider", provider)
    event.listen(engine.sync_engine, "before_cursor_execute", sql)
    server = uvicorn.Server(
        uvicorn.Config(app, lifespan="off", log_level="critical", access_log=False)
    )
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    server_task = asyncio.create_task(server.serve(sockets=[listener]))
    lags = []

    async def probe():
        while True:
            start = time.perf_counter()
            await asyncio.sleep(0.01)
            lags.append(max(0, (time.perf_counter() - start - 0.01) * 1000))

    probe_task = None
    try:
        async with asyncio.timeout(90):
            await start_postgres_listener()
            while not server.started:
                await asyncio.sleep(0.01)
            async with AsyncExitStack() as stack:
                sockets = []

                async def receive(ws):
                    return json.loads(await asyncio.wait_for(ws.recv(), 5))

                for token in tokens:
                    ws = await stack.enter_async_context(
                        connect(f"ws://127.0.0.1:{port}/v1/channels/discord/gateway")
                    )
                    assert (await receive(ws))["op"] == 10
                    await ws.send(json.dumps({"op": 2, "d": {"token": token, "intents": 0}}))
                    assert (await receive(ws))["t"] == "READY"
                    assert (await receive(ws))["t"] == "GUILD_CREATE"
                    if not sockets:
                        assert (await receive(ws))["t"] == "CHANNEL_CREATE"
                    sockets.append(ws)
                await asyncio.sleep(0.2)
                assert len(empty_by_link) == consumers
                target = sockets[0]
                probe_task = asyncio.create_task(probe())
                for mode, batches, batch_size, interval in [
                    ("fixed", 12, 1, 0.25),
                    ("steady", 24, 1, 0.1),
                    ("burst", 6, 4, 0.4),
                ]:
                    samples = []
                    lags.clear()
                    before_sql, before_empty = sql_count, sum(empty_by_link.values())
                    start_cpu, start_wall = time.process_time(), time.perf_counter()
                    for batch in range(batches):
                        await asyncio.sleep(
                            max(0, start_wall + (batch + 1) * interval - time.perf_counter())
                        )
                        messages = []
                        for item in range(batch_size):
                            identity = f"{mode}-{batch}-{item}"
                            message = ChannelMessage(
                                account_id=account_id,
                                bot_agent_link_id=UUID(created["agent_link_id"]),
                                binding_id=binding.id,
                                user_id=binding.user_id,
                                direction=MESSAGE_DIRECTION_INBOUND,
                                external_chat_id=binding.external_chat_id,
                                provider_message_id=identity,
                                payload={
                                    "t": "MESSAGE_CREATE",
                                    "d": {
                                        "id": identity,
                                        "channel_id": "discord-chan-1",
                                        "guild_id": "discord-guild-1",
                                        "content": "synthetic",
                                        "author": {"id": "fixture"},
                                    },
                                },
                            )
                            db_session.add(message)
                            messages.append(message)
                        await db_session.flush()
                        await notify_channel_inbound_message_enqueued(
                            db_session,
                            account_id=str(account_id),
                            bot_agent_link_id=created["agent_link_id"],
                        )
                        await db_session.commit()
                        committed = time.perf_counter()
                        for message in messages:
                            dispatch = await receive(target)
                            samples.append((time.perf_counter() - committed) * 1000)
                            assert dispatch["t"] == "MESSAGE_CREATE"
                            assert dispatch["d"]["id"] == message.provider_message_id
                        await target.send(json.dumps({"op": 1, "d": dispatch["s"]}))
                        assert (await receive(target))["op"] == 11
                    # Include trailing idle rechecks in SQL/CPU attribution.
                    await asyncio.sleep(0.15)
                    print(
                        "FANOUT",
                        json.dumps(
                            {
                                "consumers": consumers,
                                "mode": mode,
                                "latency_ms": distribution(samples),
                                "sql_per_message": round(
                                    (sql_count - before_sql) / len(samples), 3
                                ),
                                "empty_queries": sum(empty_by_link.values()) - before_empty,
                                "pool_timeouts": pool_timeouts,
                                "loop_lag_ms": distribution(lags),
                                "cpu_ms": round((time.process_time() - start_cpu) * 1000, 3),
                                "wall_s": round(time.perf_counter() - start_wall, 3),
                            }
                        ),
                        flush=True,
                    )
                    for message in messages:
                        await db_session.refresh(message)
                        assert message.delivered_at is not None
                # A queued foreign dispatch fails this idle Link heartbeat check.
                for ws in sockets[1:]:
                    await ws.send(json.dumps({"op": 1, "d": None}))
                    assert (await receive(ws))["op"] == 11
    finally:
        if probe_task is not None:
            probe_task.cancel()
            await asyncio.gather(probe_task, return_exceptions=True)
        server.should_exit = True
        try:
            await asyncio.wait_for(server_task, 10)
        finally:
            listener.close()
            await stop_postgres_listener()
            await locks.close()
            await engine.dispose()
