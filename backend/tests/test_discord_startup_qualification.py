"""Discord Gateway startup ordering, retries and durable receipts over real TCP/PG."""

import asyncio
import json
import socket
import time
from uuid import UUID, uuid4

import httpx
import pytest
import uvicorn
from fastapi import HTTPException, WebSocket, WebSocketDisconnect
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosedError

from app.main import app
from app.models.channel import ChannelAccount, ChannelBinding, ChannelBindingAlias, ChannelMessage
from app.routes.channel_routers import discord, shared
from app.services.discord_advisory_session import DiscordAdvisorySession
from app.services.discord_rate_limiter import DiscordRateLimiter
from tests.test_channels import _create_paired_discord_channel, _reset_discord_gateway_sessions
from tests.test_channels import (
    _verified_discord_guild_membership as _verified_discord_guild_membership,
)

pytestmark = [pytest.mark.committed_db, pytest.mark.usefixtures("channel_agent")]


@pytest.mark.parametrize(
    "status_code,raised",
    [(401, False), (403, False), (404, False), (401, True), (404, True), (429, True)],
)
async def test_startup_retries_only_rate_limits(monkeypatch, status_code, raised):
    calls = 0

    async def request(**_kwargs):
        nonlocal calls
        calls += 1
        if raised and calls == 1:
            raise HTTPException(status_code=status_code, headers={"Retry-After": "0.1"})
        return shared.DiscordProviderResult(
            content=b'{"id":"channel","guild_id":"guild","type":0}',
            status_code=200 if status_code == 429 else status_code,
            media_type="application/json",
        )

    monkeypatch.setattr(discord, "request_discord_provider", request)
    result = await discord._discord_gateway_startup_channels(ChannelAccount(), {"channel": "guild"})
    assert calls == (2 if status_code == 429 else 1)
    assert list(result) == (["channel"] if status_code == 429 else [])


@pytest.mark.parametrize(
    "count,delay,slow,contention,fault",
    [
        (1, 0.03, False, False, None),
        (10, 0.03, False, False, None),
        (100, 0.03, False, False, None),
        (10, 0.03, True, False, None),
        (100, 0.001, False, True, None),
        (10, 0.001, False, False, "provider_once"),
        (10, 0.001, False, False, "persistent"),
        (10, 0.001, False, False, "long_retry"),
        (10, 0.001, False, False, "disconnect"),
        (10, 0.001, False, False, "partial_ready"),
        (1, 0.001, False, False, "nan"),
        (1, 0.001, False, False, "inf"),
    ],
)
async def test_startup_snapshot(
    client, db_session, engine, monkeypatch, count, delay, slow, contention, fault
):
    store = _reset_discord_gateway_sessions(monkeypatch)
    if fault in {"persistent", "long_retry", "disconnect", "nan", "inf"}:
        monkeypatch.setattr(discord, "_DISCORD_GATEWAY_STARTUP_TIMEOUT_SECONDS", 0.35)
    target = "100000000000000001"
    guild = "200000000000000001"
    created = await _create_paired_discord_channel(
        client, name=f"startup-{uuid4().hex}", channel_id=target, guild_id=guild
    )
    account_id = UUID(created["id"])
    binding = (
        await db_session.scalars(
            select(ChannelBinding).where(ChannelBinding.account_id == account_id)
        )
    ).one()
    for index in range(1, count):
        db_session.add(
            ChannelBindingAlias(
                account_id=account_id,
                bot_agent_link_id=binding.bot_agent_link_id,
                binding_id=binding.id,
                user_id=binding.user_id,
                alias_external_chat_id=str(int(target) + index),
                alias_kind="discord_channel",
            )
        )
    message = ChannelMessage(
        account_id=account_id,
        bot_agent_link_id=binding.bot_agent_link_id,
        binding_id=binding.id,
        user_id=binding.user_id,
        direction="inbound",
        external_chat_id=binding.external_chat_id,
        provider_message_id="synthetic-target",
        payload={
            "t": "MESSAGE_CREATE",
            "d": {
                "id": "synthetic-target",
                "channel_id": target,
                "guild_id": guild,
                "content": "synthetic",
                "author": {"id": "300000000000000001"},
            },
        },
    )
    db_session.add(message)
    await db_session.commit()
    monkeypatch.setattr(
        discord, "async_session_factory", async_sessionmaker(engine, expire_on_commit=False)
    )
    locks = DiscordAdvisorySession(engine)
    monkeypatch.setattr(app.state, "discord_gateway_locks", locks, raising=False)
    clock_offset = 0.0
    limiter = DiscordRateLimiter(now=lambda: time.monotonic() + clock_offset)
    monkeypatch.setattr(shared, "discord_rate_limiter", limiter)
    paths = []
    statuses = []
    active = peak = 0
    first = True
    original_send = WebSocket.send_json

    async def send_json(websocket, data, mode="text"):
        if fault == "partial_ready" and not recovering and data.get("t") == "GUILD_CREATE":
            raise WebSocketDisconnect()
        await original_send(websocket, data, mode=mode)

    monkeypatch.setattr(WebSocket, "send_json", send_json)
    entered = asyncio.Event()
    attempts = []
    recovering = False
    snapshot = []
    original_authority = discord._discord_gateway_authority

    async def authority(*args, **kwargs):
        result = await original_authority(*args, **kwargs)
        if not snapshot:
            snapshot.extend(result[1])
        return result

    monkeypatch.setattr(discord, "_discord_gateway_authority", authority)

    async def transport(request):
        nonlocal active, peak, first
        active += 1
        peak = max(peak, active)
        paths.append(request.url.path)
        attempts.append(time.perf_counter())
        attempt = len(attempts)
        entered.set()
        pause = (
            10.0 if fault == "disconnect" and not recovering else (0.5 if slow and first else delay)
        )
        first = False
        try:
            await asyncio.sleep(pause)
            if (
                not recovering
                and fault not in {None, "partial_ready"}
                and (
                    fault in {"persistent", "long_retry", "disconnect", "nan", "inf"}
                    or attempt == 1
                )
            ):
                retry = {"long_retry": "30", "nan": "nan", "inf": "inf"}.get(fault, "0.2")
                return httpx.Response(
                    429,
                    headers={"Retry-After": retry, "X-RateLimit-Global": "true"},
                    json={"global": True},
                )
            return httpx.Response(
                200,
                json={
                    "id": request.url.path.rsplit("/", 1)[-1],
                    "guild_id": guild,
                    "type": 0,
                    "name": "synthetic",
                },
            )
        finally:
            active -= 1

    async def provider(**kwargs):
        result = await shared.request_discord_provider(**kwargs)
        statuses.append(result.status_code)
        return result

    monkeypatch.setattr(discord, "request_discord_provider", provider)
    server = uvicorn.Server(
        uvicorn.Config(app, lifespan="off", log_level="critical", access_log=False)
    )
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    server_task = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            monkeypatch.setattr(shared, "get_channel_provider_http_client", lambda: http)
            async with asyncio.timeout(15):
                while not server.started:
                    await asyncio.sleep(0.01)
                if contention:
                    account = await db_session.get(ChannelAccount, account_id)
                    for _ in range(10):
                        await shared.request_discord_provider(
                            account=account, method="GET", path="users/@me"
                        )
                    paths.clear()
                async with connect(f"ws://127.0.0.1:{port}/v1/channels/discord/gateway") as ws:
                    assert json.loads(await ws.recv())["op"] == 10
                    started = time.perf_counter()
                    await ws.send(
                        json.dumps({"op": 2, "d": {"token": created["agent_token"], "intents": 0}})
                    )
                    if fault in {
                        "persistent",
                        "long_retry",
                        "disconnect",
                        "nan",
                        "inf",
                        "partial_ready",
                    }:
                        if fault == "partial_ready":
                            partial = json.loads(await ws.recv())
                            assert partial["t"] == "READY"
                            failed_session = partial["d"]["session_id"]
                        else:
                            await entered.wait()
                            # Heartbeats must be consumed during GET/retry waits.
                            await ws.send(json.dumps({"op": 1, "d": None}))
                            assert json.loads(await asyncio.wait_for(ws.recv(), 0.2)) == {
                                "op": 11,
                                "d": None,
                            }
                            failed_session = next(iter(store._entries))
                        if fault in {"disconnect", "partial_ready"}:
                            await ws.close()
                        else:
                            with pytest.raises(ConnectionClosedError) as closed:
                                await ws.recv()
                            assert closed.value.rcvd.code == 1013
                            assert time.perf_counter() - started < 1.0
                        async with asyncio.timeout(1):
                            while store._entries:
                                await asyncio.sleep(0.01)
                        assert active == 0
                        assert len(paths) <= (
                            count
                            if fault == "partial_ready"
                            else (8 if fault == "persistent" else 4)
                        )
                        await db_session.refresh(message)
                        assert message.delivered_at is None
                        # Failed startup is not resumable, but a fresh IDENTIFY
                        # still receives the original unacknowledged durable row.
                        if fault in {"nan", "inf"}:
                            return
                        recovering = True
                        clock_offset += 31.0
                        async with connect(
                            f"ws://127.0.0.1:{port}/v1/channels/discord/gateway"
                        ) as retry_ws:
                            assert json.loads(await retry_ws.recv())["op"] == 10
                            await retry_ws.send(
                                json.dumps(
                                    {
                                        "op": 6,
                                        "d": {
                                            "token": created["agent_token"],
                                            "session_id": failed_session,
                                            "seq": 0,
                                        },
                                    }
                                )
                            )
                            assert json.loads(await retry_ws.recv()) == {"op": 9, "d": False}
                            await retry_ws.send(
                                json.dumps(
                                    {"op": 2, "d": {"token": created["agent_token"], "intents": 0}}
                                )
                            )
                            retry_frames = []
                            while not retry_frames or retry_frames[-1].get("t") != "MESSAGE_CREATE":
                                retry_frames.append(json.loads(await retry_ws.recv()))
                            assert [
                                f["d"]["id"] for f in retry_frames if f.get("t") == "CHANNEL_CREATE"
                            ] == snapshot
                            await db_session.refresh(message)
                            assert message.delivered_at is None
                        return
                    ready = json.loads(await ws.recv())
                    frames = [ready]
                    while frames[-1].get("t") != "MESSAGE_CREATE":
                        frames.append(json.loads(await ws.recv()))
                    message_ms = (time.perf_counter() - started) * 1000
                    await db_session.refresh(message)
                    assert message.delivered_at is None
                    await ws.send(json.dumps({"op": 1, "d": frames[-1]["s"]}))
                    assert json.loads(await ws.recv())["op"] == 11
                    await db_session.refresh(message)
                    assert message.delivered_at is not None
                projected = [f["d"]["id"] for f in frames if f.get("t") == "CHANNEL_CREATE"]
                assert active == 0
                assert ready["t"] == "READY" and ready["d"]["private_channels"] == []
                assert frames[1]["t"] == "GUILD_CREATE"
                assert projected == snapshot
                assert frames[-1]["d"] == message.payload["d"]
                assert [frame["d"] for frame in frames if frame.get("t") == "CHANNEL_CREATE"] == [
                    {"id": channel_id, "guild_id": guild, "type": 0, "name": "synthetic"}
                    for channel_id in snapshot
                ]
                assert statuses.count(200) == count
                assert peak == min(4, count)
                if fault in {"nan", "inf", "provider_once"}:
                    assert attempts[-1] - attempts[0] >= (0.9 if fault in {"nan", "inf"} else 0.19)
                if count == 100 and delay == 0.03:
                    assert message_ms < 2500
    finally:
        server.should_exit = True
        try:
            await asyncio.wait_for(server_task, 10)
        finally:
            listener.close()
            await locks.close()
