from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from urllib.parse import parse_qs, urlsplit
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker
from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosedError

import app.services.discord_gateway_worker as discord_gateway_worker_module
from app.routes.channel_routers import discord as discord_router
from app.services.discord_gateway_worker import (
    DiscordGatewayWorker,
    GatewayFrame,
    _GatewayState,
    discord_gateway_close_code,
    discord_gateway_uri,
    parse_gateway_frame,
)


@dataclass
class _ObservedGatewayExchange:
    request_path: str | None = None
    origin: str | None = None
    authorization: str | None = None
    authentication: GatewayFrame | None = None
    heartbeat: GatewayFrame | None = None


def _gateway_json(frame: GatewayFrame) -> str:
    return json.dumps(frame, separators=(",", ":"))


async def _consumer_lease_backend_pid(engine: AsyncEngine, lock_key: int) -> int:
    lock_class = (lock_key >> 32) & 0xFFFF_FFFF
    lock_object = lock_key & 0xFFFF_FFFF
    async with engine.connect() as observer:
        backend_pid = await observer.scalar(
            text(
                """
                SELECT pid
                FROM pg_locks
                WHERE locktype = 'advisory'
                  AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
                  AND classid::bigint = :lock_class
                  AND objid::bigint = :lock_object
                  AND objsubid = 1
                  AND granted
                """
            ),
            {"lock_class": lock_class, "lock_object": lock_object},
        )
    assert isinstance(backend_pid, int)
    return backend_pid


async def _legacy_consumer_lease_lock_key(
    engine: AsyncEngine,
    account_id: UUID,
    link_id: UUID,
) -> int:
    lock_name = f"discord-agent-gateway:{account_id}:{link_id}"
    async with engine.connect() as observer:
        lock_key = await observer.scalar(
            text("SELECT hashtextextended(:lock_name, 0)"),
            {"lock_name": lock_name},
        )
    assert isinstance(lock_key, int) and not isinstance(lock_key, bool)
    return lock_key


@pytest.mark.asyncio
async def test_synthetic_gateway_consumer_lease_preserves_legacy_key_without_transaction(
    engine: AsyncEngine,
) -> None:
    account_id = UUID("00000000-0000-4000-8000-000000000910")
    link_id = UUID("00000000-0000-4000-8000-000000000911")
    legacy_lock_key = await _legacy_consumer_lease_lock_key(engine, account_id, link_id)

    async with discord_router._discord_gateway_consumer_lease(
        account_id=account_id,
        bot_agent_link_id=link_id,
        lock_engine=engine,
        liveness_interval_seconds=60,
    ) as acquired:
        assert acquired is True
        backend_pid = await _consumer_lease_backend_pid(engine, legacy_lock_key)
        async with engine.connect() as observer:
            state, transaction_started_at = (
                await observer.execute(
                    text("SELECT state, xact_start FROM pg_stat_activity WHERE pid = :pid"),
                    {"pid": backend_pid},
                )
            ).one()

        assert state == "idle"
        assert transaction_started_at is None


@pytest.mark.asyncio
async def test_synthetic_gateway_consumer_lease_rejects_lock_contention(
    engine: AsyncEngine,
) -> None:
    account_id = UUID("00000000-0000-4000-8000-000000000912")
    link_id = UUID("00000000-0000-4000-8000-000000000913")

    async with discord_router._discord_gateway_consumer_lease(
        account_id=account_id,
        bot_agent_link_id=link_id,
        lock_engine=engine,
        liveness_interval_seconds=60,
    ) as first_acquired:
        async with discord_router._discord_gateway_consumer_lease(
            account_id=account_id,
            bot_agent_link_id=link_id,
            lock_engine=engine,
            liveness_interval_seconds=60,
        ) as second_acquired:
            assert first_acquired is True
            assert second_acquired is False


@pytest.mark.asyncio
async def test_synthetic_gateway_consumer_lease_unlocks_on_normal_exit(
    engine: AsyncEngine,
) -> None:
    account_id = UUID("00000000-0000-4000-8000-000000000914")
    link_id = UUID("00000000-0000-4000-8000-000000000915")

    async with discord_router._discord_gateway_consumer_lease(
        account_id=account_id,
        bot_agent_link_id=link_id,
        lock_engine=engine,
        liveness_interval_seconds=60,
    ) as acquired:
        assert acquired is True

    async with discord_router._discord_gateway_consumer_lease(
        account_id=account_id,
        bot_agent_link_id=link_id,
        lock_engine=engine,
        liveness_interval_seconds=60,
    ) as reacquired:
        assert reacquired is True


@pytest.mark.asyncio
async def test_synthetic_gateway_consumer_lease_unlocks_when_cancelled(
    engine: AsyncEngine,
) -> None:
    account_id = UUID("00000000-0000-4000-8000-000000000916")
    link_id = UUID("00000000-0000-4000-8000-000000000917")
    entered = asyncio.Event()

    async def hold_lease() -> None:
        async with discord_router._discord_gateway_consumer_lease(
            account_id=account_id,
            bot_agent_link_id=link_id,
            lock_engine=engine,
            liveness_interval_seconds=60,
        ) as acquired:
            assert acquired is True
            entered.set()
            await asyncio.Future()

    holder = asyncio.create_task(hold_lease())
    await asyncio.wait_for(entered.wait(), timeout=1)
    holder.cancel()
    with pytest.raises(asyncio.CancelledError):
        await holder

    async with discord_router._discord_gateway_consumer_lease(
        account_id=account_id,
        bot_agent_link_id=link_id,
        lock_engine=engine,
        liveness_interval_seconds=60,
    ) as reacquired:
        assert reacquired is True


@pytest.mark.asyncio
async def test_synthetic_gateway_consumer_stops_when_lease_connection_is_lost(
    engine: AsyncEngine,
) -> None:
    account_id = UUID("00000000-0000-4000-8000-000000000918")
    link_id = UUID("00000000-0000-4000-8000-000000000919")
    legacy_lock_key = await _legacy_consumer_lease_lock_key(engine, account_id, link_id)
    entered = asyncio.Event()

    async def hold_lease() -> None:
        async with discord_router._discord_gateway_consumer_lease(
            account_id=account_id,
            bot_agent_link_id=link_id,
            lock_engine=engine,
            liveness_interval_seconds=0.01,
        ) as acquired:
            assert acquired is True
            entered.set()
            await asyncio.Future()

    holder = asyncio.create_task(hold_lease())
    try:
        await asyncio.wait_for(entered.wait(), timeout=1)
        backend_pid = await _consumer_lease_backend_pid(engine, legacy_lock_key)
        async with engine.connect() as observer:
            terminated = await observer.scalar(
                text("SELECT pg_terminate_backend(:pid)"),
                {"pid": backend_pid},
            )
        assert terminated is True

        with pytest.raises(
            discord_router._DiscordGatewayConsumerLeaseLost,
            match="lease connection lost",
        ):
            await asyncio.wait_for(holder, timeout=2)
    finally:
        if not holder.done():
            holder.cancel()
            await asyncio.gather(holder, return_exceptions=True)


@pytest.mark.asyncio
async def test_terminal_discord_auth_close_waits_for_account_revision_change(
    engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    account_id = UUID("00000000-0000-4000-8000-000000000907")
    worker = DiscordGatewayWorker(
        async_sessionmaker(engine, expire_on_commit=False),
        lock_engine=engine,
    )
    attempts = 0
    rearmed = asyncio.Event()

    async def run_account(_account_id, _stop, state):
        nonlocal attempts
        attempts += 1
        state.account_revision = f"revision-{attempts}"
        if attempts == 1:
            raise ConnectionClosedError(None, None, None)
        rearmed.set()
        await asyncio.Future()

    monkeypatch.setattr(worker, "_run_account_with_lock", run_account)
    monkeypatch.setattr(
        discord_gateway_worker_module, "discord_gateway_close_code", lambda _exc: 4004
    )
    stop = asyncio.Event()

    worker._sync_tasks({account_id: "revision-1"}, stop)
    first_task = worker._tasks[account_id]
    await asyncio.wait_for(first_task, timeout=1)
    worker._sync_tasks({account_id: "revision-1"}, stop)

    assert attempts == 1
    assert account_id not in worker._tasks
    assert worker._terminal_account_revisions == {account_id: "revision-1"}

    worker._sync_tasks({account_id: "revision-2"}, stop)
    try:
        await asyncio.wait_for(rearmed.wait(), timeout=1)
        assert attempts == 2
        assert worker._terminal_account_revisions == {}
    finally:
        await worker.stop()


@pytest.mark.asyncio
async def test_transient_discord_gateway_failures_use_bounded_exponential_backoff(
    engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    worker = DiscordGatewayWorker(
        async_sessionmaker(engine, expire_on_commit=False),
        lock_engine=engine,
        reconnect_initial_seconds=1,
        reconnect_max_seconds=4,
    )
    stop = asyncio.Event()
    attempts = 0
    delays: list[float] = []

    async def run_account(_account_id, _stop, _state):
        nonlocal attempts
        attempts += 1
        if attempts == 5:
            stop.set()
            return True
        raise OSError("temporary DNS failure")

    async def record_delay(_stop, timeout_seconds: float) -> None:
        delays.append(timeout_seconds)

    monkeypatch.setattr(worker, "_run_account_with_lock", run_account)
    monkeypatch.setattr(discord_gateway_worker_module, "_sleep_until_stop", record_delay)

    await worker._run_account_forever(uuid4(), stop)

    assert delays == [1, 2, 4, 4, 1]


@pytest.mark.parametrize("resume", [False, True], ids=["identify", "resume"])
@pytest.mark.asyncio
async def test_real_websockets_discord_gateway_transport_contract(
    engine: AsyncEngine,
    resume: bool,
) -> None:
    observed = _ObservedGatewayExchange()
    initial_sequence = 17 if resume else None

    async def gateway_server(websocket: ServerConnection) -> None:
        request = websocket.request
        if request is None:
            raise AssertionError("websockets server did not expose the handshake request")
        observed.request_path = request.path
        observed.origin = request.headers.get("Origin")
        observed.authorization = request.headers.get("Authorization")

        await websocket.send(_gateway_json({"op": 10, "d": {"heartbeat_interval": 3_600_000}}))
        observed.authentication = parse_gateway_frame(await websocket.recv())

        await websocket.send(_gateway_json({"op": 1, "d": None}))
        observed.heartbeat = parse_gateway_frame(await websocket.recv())
        await websocket.send(_gateway_json({"op": 11, "d": None}))
        await websocket.send(
            _gateway_json(
                {
                    "op": 0,
                    "t": "READY",
                    "s": 42,
                    "d": {
                        "session_id": "next-session",
                        "resume_gateway_url": "wss://gateway.discord.gg/resume",
                    },
                }
            )
        )
        await websocket.close(code=4009, reason="session timed out")

    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    worker = DiscordGatewayWorker(sessionmaker, lock_engine=engine)
    state = _GatewayState(
        sequence=initial_sequence,
        session_id="existing-session" if resume else None,
        resume_gateway_url="wss://gateway.discord.gg/resume" if resume else None,
    )

    async with serve(gateway_server, "127.0.0.1", 0) as server:
        sockets = server.sockets
        if not sockets:
            raise AssertionError("websockets server did not bind a socket")
        address = sockets[0].getsockname()
        if not isinstance(address, tuple) or len(address) < 2 or not isinstance(address[1], int):
            raise AssertionError("websockets server returned an invalid socket address")
        uri = discord_gateway_uri(f"ws://127.0.0.1:{address[1]}/gateway?compress=zlib-stream")

        with pytest.raises(ConnectionClosedError) as raised:
            await worker._run_gateway_session(
                account_id=uuid4(),
                stop=asyncio.Event(),
                state=state,
                uri=uri,
                token="discord-contract-token",
                intents=513,
                resume=resume,
            )

    request_url = urlsplit(observed.request_path or "")
    assert request_url.path == "/gateway"
    assert parse_qs(request_url.query) == {
        "compress": ["zlib-stream"],
        "encoding": ["json"],
        "v": ["10"],
    }
    assert observed.origin is None
    assert observed.authorization is None
    if resume:
        assert observed.authentication == {
            "op": 6,
            "d": {
                "token": "discord-contract-token",
                "session_id": "existing-session",
                "seq": 17,
            },
        }
    else:
        assert observed.authentication == {
            "op": 2,
            "d": {
                "token": "discord-contract-token",
                "intents": 513,
                "properties": {
                    "os": "linux",
                    "browser": "clawdi",
                    "device": "clawdi",
                },
            },
        }
    assert observed.heartbeat == {"op": 1, "d": initial_sequence}
    assert state.sequence == 42
    assert state.session_id == "next-session"
    assert state.resume_gateway_url == "wss://gateway.discord.gg/resume"
    assert state.heartbeat_acknowledged is True
    assert discord_gateway_close_code(raised.value) == 4009
    assert raised.value.rcvd is not None
    assert raised.value.rcvd.reason == "session timed out"
