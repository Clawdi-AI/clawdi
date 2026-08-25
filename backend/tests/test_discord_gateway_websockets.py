from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from urllib.parse import parse_qs, urlsplit
from uuid import UUID, uuid4

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker
from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosedError

import app.services.discord_gateway_worker as discord_gateway_worker_module
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
