"""Real PostgreSQL ownership and pool boundaries with an isolated provider transport."""

import asyncio
import json
from contextlib import asynccontextmanager
from uuid import UUID, uuid4

import pytest
import pytest_asyncio
from sqlalchemy import delete, text, update
from sqlalchemy.ext.asyncio import async_sessionmaker
from websockets.exceptions import ConnectionClosedError
from websockets.frames import Close

from app.core.config import settings
from app.core.database import _create_engine
from app.models.channel import ChannelAccount
from app.services import discord_advisory_session as locks
from app.services import discord_gateway_worker as gateway
from app.services.vault_crypto import encrypt
from app.workers import channels


async def eventually(predicate):
    async with asyncio.timeout(5):
        while not predicate():
            await asyncio.sleep(0.01)


class Transport:
    def __init__(self):
        self.frames = asyncio.Queue()
        self.frames.put_nowait(json.dumps({"op": 10, "d": {"heartbeat_interval": 100}}))
        self.sent = []
        self.closed = False
        self.account_id = None

    async def recv(self):
        frame = await self.frames.get()
        if isinstance(frame, Exception):
            raise frame
        return frame

    async def send(self, message):
        frame = json.loads(message)
        self.sent.append(frame)
        if frame["op"] in {2, 6}:
            self.account_id = UUID(frame["d"]["token"])
            self.frames.put_nowait(
                json.dumps(
                    {
                        "op": 0,
                        "t": "READY" if frame["op"] == 2 else "RESUMED",
                        "s": 17,
                        "d": {
                            "session_id": str(self.account_id),
                            "resume_gateway_url": "wss://gateway.discord.gg/resume",
                        },
                    }
                )
            )
        elif frame["op"] == 1:
            self.frames.put_nowait('{"op":11}')

    async def close(self, *, code, reason):
        self.closed = True


class Network:
    def __init__(self):
        self.transports = []

    @asynccontextmanager
    async def connect(self, uri, **kwargs):
        assert uri.startswith("wss://gateway.discord.gg/")
        transport = Transport()
        self.transports.append(transport)
        try:
            yield transport
        finally:
            transport.closed = True


@pytest_asyncio.fixture
async def provider(engine, monkeypatch):
    monkeypatch.setattr(settings, "db_pool_timeout", 0.1)
    ordinary = _create_engine(pool_size=2, max_overflow=0)
    accounts = [uuid4() for _ in range(4)]
    async with async_sessionmaker(engine)() as db:
        for account_id in accounts:
            ciphertext, nonce = encrypt(str(account_id))
            db.add(
                ChannelAccount(
                    id=account_id,
                    provider="discord",
                    name=f"resource-boundary-{account_id}",
                    user_id=None,
                    visibility="public",
                    status="active",
                    encrypted_provider_token=ciphertext,
                    provider_token_nonce=nonce,
                    webhook_secret_hash="test-only",
                    config={"gateway_enabled": True},
                )
            )
        await db.commit()
    network = Network()
    worker = gateway.DiscordGatewayWorker(
        async_sessionmaker(ordinary, expire_on_commit=False),
        scan_interval_seconds=0.02,
        reconnect_initial_seconds=0.02,
        reconnect_max_seconds=0.1,
        lock_liveness_interval_seconds=0.02,
        lock_liveness_timeout_seconds=0.2,
        connect_factory=network.connect,
    )
    try:
        yield ordinary, accounts, network, worker
    finally:
        await worker.stop()
        async with async_sessionmaker(engine)() as db:
            await db.execute(delete(ChannelAccount).where(ChannelAccount.id.in_(accounts)))
            await db.commit()
        await ordinary.dispose()


async def lock_pid(engine, account_id):
    key = gateway.discord_gateway_advisory_lock_key(account_id)
    async with engine.connect() as db:
        return await db.scalar(
            text("""
            SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
              AND classid::bigint = :high AND objid::bigint = :low AND objsubid = 1
        """),
            {"high": key >> 32, "low": key & 0xFFFFFFFF},
        )


async def legacy_can_claim(engine, account_id):
    # Exactly the released per-account key and SQL, on another PG session.
    key = gateway.discord_gateway_advisory_lock_key(account_id)
    async with engine.connect() as db:
        acquired = await gateway.try_advisory_lock(db, key)
        if acquired:
            assert await gateway.release_advisory_lock(db, key)
        return acquired


async def archive(engine, account_id):
    async with engine.begin() as db:
        await db.execute(
            update(ChannelAccount).where(ChannelAccount.id == account_id).values(status="inactive")
        )


async def connected(network, count=4):
    await eventually(
        lambda: (
            len(network.transports) == count
            and all(
                any(frame == {"op": 1, "d": 17} for frame in transport.sent)
                for transport in network.transports
            )
        )
    )


@pytest.mark.parametrize("shutdown", ["stop", "event", "cancel"])
async def test_more_accounts_than_pool_and_no_reentrant_scan_locks(provider, engine, shutdown):
    ordinary, accounts, network, worker = provider
    stop = asyncio.Event()
    runner = None
    try:
        assert await worker.run_once(stop) == 4
        await connected(network)
        assert ordinary.pool.checkedout() == 1
        pids = {await lock_pid(engine, account_id) for account_id in accounts}
        assert len(pids) == 1 and None not in pids
        async with ordinary.connect() as db:
            assert await db.scalar(text("SELECT 1")) == 1
        for _ in range(4):
            assert await worker.run_once(stop) == 4
        for account_id in accounts:
            assert not await legacy_can_claim(engine, account_id)

        await archive(engine, accounts[0])
        await worker.run_once(stop)
        removed = next(t for t in network.transports if t.account_id == accounts[0])
        await eventually(lambda: removed.closed and worker._tasks[accounts[0]].done())
        # A single release must suffice after repeated scans, while the same
        # session still owns the other three keys (not a disconnect shortcut).
        assert await legacy_can_claim(engine, accounts[0])
        assert {await lock_pid(engine, account_id) for account_id in accounts[1:]} == pids
        if shutdown == "stop":
            await worker.stop()
        else:
            runner = asyncio.create_task(worker.run_forever(stop))
            await asyncio.sleep(0.05)
            if shutdown == "event":
                stop.set()
                await asyncio.wait_for(runner, 5)
            else:
                runner.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await asyncio.wait_for(runner, 5)
        assert all(t.closed for t in network.transports)
        for account_id in accounts:
            assert await legacy_can_claim(engine, account_id)
        async with ordinary.connect() as db:
            assert await db.scalar(text("SELECT pg_backend_pid()")) not in pids
    finally:
        stop.set()
        if runner is not None:
            runner.cancel()
            await asyncio.gather(runner, return_exceptions=True)


async def test_lock_session_loss_stops_every_transport_and_reconnects_with_resume(provider, engine):
    _, accounts, network, worker = provider
    await worker.run_once()
    await connected(network)
    old_transports = list(network.transports)
    old_tasks = list(worker._tasks.values())
    pid = await lock_pid(engine, accounts[0])
    assert isinstance(pid, int)
    async with engine.connect() as db:
        # PID comes from this test's random key; never target a shared database.
        assert await db.scalar(
            text("""
            SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE pid = :pid AND datname = current_database() AND pid <> pg_backend_pid()
        """),
            {"pid": pid},
        )
    await eventually(
        lambda: all(t.closed for t in old_transports) and all(t.done() for t in old_tasks)
    )
    for account_id in accounts:
        assert await legacy_can_claim(engine, account_id)
    assert await worker.run_once() == 4
    await connected(network, 8)
    for transport in network.transports[4:]:
        authentication = next(frame for frame in transport.sent if frame["op"] in {2, 6})
        assert authentication == {
            "op": 6,
            "d": {
                "token": str(transport.account_id),
                "session_id": str(transport.account_id),
                "seq": 17,
            },
        }
    replacement_pids = {await lock_pid(engine, account_id) for account_id in accounts}
    assert (
        len(replacement_pids) == 1 and None not in replacement_pids and pid not in replacement_pids
    )


async def test_real_scan_pool_timeout_recovers_without_cancelling_taskgroup(
    provider,
    engine,
    monkeypatch,
    caplog,
):
    ordinary, accounts, network, worker = provider
    await worker.run_once()
    await connected(network)
    sibling_cancelled = asyncio.Event()

    class Sibling:
        async def run_forever(self, stop):
            try:
                await stop.wait()
            except asyncio.CancelledError:
                sibling_cancelled.set()
                raise

    async def no_listener():
        pass

    monkeypatch.setattr(channels, "build_channel_workers", lambda: (worker, Sibling()))
    monkeypatch.setattr(channels, "start_postgres_listener", no_listener)
    monkeypatch.setattr(channels, "stop_postgres_listener", no_listener)
    stop = asyncio.Event()
    runner = None
    try:
        async with ordinary.connect():
            runner = asyncio.create_task(channels.run_channel_workers(stop))
            await eventually(lambda: "discord gateway account scan failed" in caplog.text)
            assert not runner.done() and not sibling_cancelled.is_set()
            assert all(not t.closed for t in network.transports)
            await archive(engine, accounts[0])
        removed = next(t for t in network.transports if t.account_id == accounts[0])
        await eventually(lambda: removed.closed)
        assert not runner.done() and not sibling_cancelled.is_set()
        stop.set()
        await asyncio.wait_for(runner, 5)
    finally:
        stop.set()
        if runner is not None:
            runner.cancel()
            await asyncio.gather(runner, return_exceptions=True)


@pytest.mark.parametrize("fault", ["sql_error", "cancel"])
async def test_uncertain_unlock_fences_siblings_and_never_pools_session(
    provider,
    engine,
    monkeypatch,
    fault,
):
    ordinary, accounts, network, worker = provider
    await worker.run_once()
    await connected(network)
    pid = await lock_pid(engine, accounts[0])
    original_release = locks.release_advisory_lock
    releasing = asyncio.Event()
    session = worker._locks._session
    assert session is not None

    async def interrupted_release(connection, key):
        if key == gateway.discord_gateway_advisory_lock_key(accounts[0]):
            releasing.set()
            if fault == "sql_error":
                await connection.execute(text("SELECT 1 / 0"))
            else:
                await connection.execute(text("SELECT pg_sleep(10)"))
        return await original_release(connection, key)

    monkeypatch.setattr(locks, "release_advisory_lock", interrupted_release)
    await archive(engine, accounts[0])
    await worker.run_once()
    await asyncio.wait_for(releasing.wait(), 2)
    if fault == "cancel":
        worker._tasks[accounts[0]].cancel()
    await eventually(
        lambda: (
            session.failure is not None
            and all(t.closed for t in network.transports)
            and all(t.done() for t in worker._tasks.values())
        )
    )
    await worker.stop()
    monkeypatch.setattr(locks, "release_advisory_lock", original_release)
    for account_id in accounts:
        assert await legacy_can_claim(engine, account_id)
    async with ordinary.connect() as db:
        assert await db.scalar(text("SELECT pg_backend_pid()")) != pid


async def test_cancelled_claim_waiter_does_not_invalidate_sibling_ownership(provider, engine):
    _, accounts, network, worker = provider
    async with worker._locks._serial:
        await worker.run_once()
        task = worker._tasks[accounts[0]]
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not worker._locks.failed
        assert all(not task.done() for key, task in worker._tasks.items() if key != accounts[0])
    await worker.run_once()
    await connected(network)
    assert len({await lock_pid(engine, account_id) for account_id in accounts}) == 1


async def test_ping_deadline_includes_serial_wait_and_stops_transports(provider):
    _, _, network, worker = provider
    await worker.run_once()
    await connected(network)
    async with worker._locks._serial:
        await eventually(lambda: worker._locks.failed and all(t.closed for t in network.transports))
    await worker.stop()


async def test_repeated_stop_cancellation_finishes_session_cleanup(provider, engine, monkeypatch):
    _, accounts, network, worker = provider
    await worker.run_once()
    await connected(network)
    started, release = asyncio.Event(), asyncio.Event()
    original_close = worker._close_lock_session

    async def delayed_close():
        started.set()
        await release.wait()
        await original_close()

    monkeypatch.setattr(worker, "_close_lock_session", delayed_close)
    stopping = asyncio.create_task(worker.stop())
    try:
        await started.wait()
        stopping.cancel()
        await asyncio.sleep(0)
        stopping.cancel()
        await asyncio.sleep(0)
        assert not stopping.done()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(stopping, 5)
        assert all(t.closed for t in network.transports)
        for account_id in accounts:
            assert await legacy_can_claim(engine, account_id)
    finally:
        release.set()
        await asyncio.gather(stopping, return_exceptions=True)


async def test_terminal_close_survives_unlock_failure_and_session_recovery(provider, monkeypatch):
    _, accounts, network, worker = provider
    await worker.run_once()
    await connected(network)
    account_id = accounts[0]
    original_release = locks.release_advisory_lock

    async def failed_unlock(connection, key):
        if key == gateway.discord_gateway_advisory_lock_key(account_id):
            await connection.execute(text("SELECT 1 / 0"))
        return await original_release(connection, key)

    monkeypatch.setattr(locks, "release_advisory_lock", failed_unlock)
    transport = next(t for t in network.transports if t.account_id == account_id)
    transport.frames.put_nowait(
        ConnectionClosedError(Close(4004, "test invalid token"), None, None)
    )
    await eventually(lambda: all(t.done() for t in worker._tasks.values()))
    assert account_id in worker._terminal_account_revisions
    monkeypatch.setattr(locks, "release_advisory_lock", original_release)
    await worker.run_once()
    await connected(network, 7)
    assert all(t.account_id != account_id for t in network.transports[4:])
    assert all(t.closed for t in network.transports[:4])
