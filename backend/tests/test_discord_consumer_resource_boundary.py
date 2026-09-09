"""Consumer leases use the lifespan-owned Discord session, not one pool slot per Link."""

import asyncio
import json
import os
import sys
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import text

from app.core.config import settings
from app.core.database import _create_engine
from app.routes.channel_routers import discord
from app.services import discord_advisory_session as advisory


async def eventually(predicate):
    async with asyncio.timeout(5):
        while not predicate():
            await asyncio.sleep(0.01)


@pytest_asyncio.fixture
async def consumer(monkeypatch):
    monkeypatch.setattr(settings, "db_pool_timeout", 0.1)
    ordinary = _create_engine(pool_size=2, max_overflow=0)
    locks = advisory.DiscordAdvisorySession(
        ordinary, liveness_interval_seconds=0.02, liveness_timeout_seconds=0.2
    )
    try:
        yield ordinary, locks
    finally:
        await locks.close()
        await ordinary.dispose()


def lease(locks, identity):
    account_id, link_id = identity
    return discord._discord_gateway_consumer_lease(
        account_id=account_id, bot_agent_link_id=link_id, lock_session=locks
    )


async def hold(locks, identity, ready, stop):
    async with lease(locks, identity) as acquired:
        assert acquired
        ready.set()
        await stop.wait()


async def attempt(locks, identity):
    async with lease(locks, identity) as acquired:
        return acquired


async def peer_claim(engine, identity):
    account_id, link_id = identity
    async with engine.connect() as connection:
        key = await connection.scalar(
            text("SELECT hashtextextended(:name, 0)"),
            {"name": f"discord-agent-gateway:{account_id}:{link_id}"},
        )
        acquired = await advisory.try_advisory_lock(connection, key)
        if acquired:
            assert await advisory.release_advisory_lock(connection, key)
        return acquired


async def subprocess_claim(identity):
    # A separate Python process executes the released consumer SQL/key. It has
    # no shared Python ownership map and only contacts the disposable test PG.
    code = """
import asyncio, asyncpg, json, os, sys
async def main():
    db = await asyncpg.connect(os.environ['DATABASE_URL'].replace('+asyncpg', ''))
    try:
        key = await db.fetchval('SELECT hashtextextended($1, 0)', sys.argv[1])
        acquired = await db.fetchval('SELECT pg_try_advisory_lock($1)', key)
        if acquired:
            assert await db.fetchval('SELECT pg_advisory_unlock($1)', key)
        print(json.dumps(acquired))
    finally:
        await db.close()
asyncio.run(main())
"""
    account_id, link_id = identity
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        code,
        f"discord-agent-gateway:{account_id}:{link_id}",
        env=os.environ.copy(),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), 5)
        assert process.returncode == 0, stderr.decode()
        return json.loads(stdout)
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


async def test_consumer_more_links_than_pool_local_and_cross_process_exclusion(consumer):
    ordinary, locks = consumer
    identities = [(uuid4(), uuid4()) for _ in range(4)]
    stop = asyncio.Event()
    ready = [asyncio.Event() for _ in identities]
    tasks = [
        asyncio.create_task(hold(locks, identity, entered, stop))
        for identity, entered in zip(identities, ready, strict=True)
    ]
    try:
        await asyncio.wait_for(asyncio.gather(*(event.wait() for event in ready)), 5)
        assert ordinary.pool.checkedout() == 1
        async with ordinary.connect() as connection:
            assert await connection.scalar(text("SELECT 1")) == 1
        # This task differs from all four lease owners; PostgreSQL's reentrant
        # success on the shared session must not admit a duplicate owner.
        assert await attempt(locks, identities[0]) is False
        assert await subprocess_claim(identities[0]) is False
        stop.set()
        await asyncio.wait_for(asyncio.gather(*tasks), 5)
        assert await subprocess_claim(identities[0]) is True
        await locks.close()
        assert ordinary.pool.checkedout() == 0
        assert locks._session is None
    finally:
        stop.set()
        await asyncio.gather(*tasks, return_exceptions=True)


async def test_live_failed_pg_session_is_retired_without_new_claim_or_shutdown(
    consumer,
    engine,
):
    ordinary, locks = consumer
    identities = [(uuid4(), uuid4()) for _ in range(3)]
    ready = [asyncio.Event() for _ in identities]
    tasks = [
        asyncio.create_task(hold(locks, identity, entered, asyncio.Event()))
        for identity, entered in zip(identities, ready, strict=True)
    ]
    unrelated = asyncio.create_task(asyncio.Event().wait())
    try:
        await asyncio.wait_for(asyncio.gather(*(event.wait() for event in ready)), 5)
        session = locks._session
        assert session is not None
        async with locks._connection(session) as connection:
            pid = await connection.scalar(text("SELECT pg_backend_pid()"))
        # An actual SQL error leaves this PostgreSQL backend alive, holding its
        # session-level keys until the component explicitly retires it.
        with pytest.raises(advisory.DiscordAdvisorySessionLost):
            async with locks._connection(session) as connection:
                await connection.execute(text("SELECT 1 / 0"))
        assert not session.connection.invalidated
        results = await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), 5)
        assert all(
            isinstance(result, discord._DiscordGatewayConsumerLeaseLost) for result in results
        )
        assert not unrelated.done()
        await eventually(lambda: locks._session is None and ordinary.pool.checkedout() == 0)
        for identity in identities:
            assert await peer_claim(engine, identity)
        async with engine.connect() as connection:
            assert (
                await connection.scalar(
                    text("SELECT count(*) FROM pg_stat_activity WHERE pid = :pid"), {"pid": pid}
                )
                == 0
            )
        assert session.retirement is not None and session.retirement.done()
    finally:
        unrelated.cancel()
        for task in tasks:
            task.cancel()
        await asyncio.gather(unrelated, *tasks, return_exceptions=True)


async def test_cancelled_consumer_claim_waiter_does_not_cancel_owner(consumer):
    _, locks = consumer
    ready, stop = asyncio.Event(), asyncio.Event()
    owner = asyncio.create_task(hold(locks, (uuid4(), uuid4()), ready, stop))
    waiter = None
    try:
        await asyncio.wait_for(ready.wait(), 5)
        async with locks._serial:
            waiter = asyncio.create_task(attempt(locks, (uuid4(), uuid4())))
            await asyncio.sleep(0)
            waiter.cancel()
            with pytest.raises(asyncio.CancelledError):
                await waiter
            assert not locks.failed and not owner.done()
        stop.set()
        await owner
    finally:
        stop.set()
        await asyncio.gather(
            owner, *([waiter] if waiter is not None else []), return_exceptions=True
        )


async def test_close_fences_claim_after_pg_success_before_local_registration(
    consumer,
    engine,
    monkeypatch,
):
    ordinary, locks = consumer
    identity = (uuid4(), uuid4())
    claimed, proceed = asyncio.Event(), asyncio.Event()
    original = advisory.try_advisory_lock

    async def paused_claim(connection, key):
        result = await original(connection, key)
        assert result
        claimed.set()
        await proceed.wait()
        return result

    monkeypatch.setattr(advisory, "try_advisory_lock", paused_claim)
    claimant = asyncio.create_task(attempt(locks, identity))
    closing = None
    try:
        await asyncio.wait_for(claimed.wait(), 5)
        closing = asyncio.create_task(locks.close())
        await eventually(lambda: locks._session is not None and locks._session.closing)
        proceed.set()
        with pytest.raises(discord._DiscordGatewayConsumerLeaseLost):
            await asyncio.wait_for(claimant, 5)
        await asyncio.wait_for(closing, 5)
        assert ordinary.pool.checkedout() == 0 and locks._session is None
        monkeypatch.setattr(advisory, "try_advisory_lock", original)
        assert await peer_claim(engine, identity)
    finally:
        proceed.set()
        await asyncio.gather(
            claimant, *([closing] if closing is not None else []), return_exceptions=True
        )


async def test_lease_owner_cannot_close_or_recover_its_own_session(consumer):
    _, locks = consumer
    identity = (uuid4(), uuid4())
    async with lease(locks, identity) as acquired:
        assert acquired
        with pytest.raises(advisory.DiscordAdvisorySessionLost, match="owns no lease"):
            await locks.close()
        assert not locks._closed

    # Failure recovery checks the real caller before acquiring the lifecycle
    # gate, including when automatic retirement already waits for that owner.
    async def owner():
        async with lease(locks, identity):
            session = locks._session
            assert session is not None
            try:
                async with locks._connection(session) as connection:
                    await connection.execute(text("SELECT 1 / 0"))
            except advisory.DiscordAdvisorySessionLost:
                with pytest.raises(advisory.DiscordAdvisorySessionLost, match="owns no lease"):
                    await locks.claim(f"discord-agent-gateway:{uuid4()}:{uuid4()}")

    with pytest.raises(discord._DiscordGatewayConsumerLeaseLost):
        await asyncio.wait_for(asyncio.create_task(owner()), 5)
