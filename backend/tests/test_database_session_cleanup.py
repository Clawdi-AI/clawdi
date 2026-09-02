from __future__ import annotations

import asyncio
import hashlib
import secrets
from datetime import UTC, datetime

import anyio
import httpx
import pytest
from sqlalchemy import event, text
from sqlalchemy.pool import QueuePool

from app.core import database
from app.main import app
from app.models.api_key import ApiKey
from app.models.user import User


def _database_pool() -> QueuePool:
    pool = database.engine.sync_engine.pool
    assert isinstance(pool, QueuePool)
    return pool


async def test_externally_cancelled_dependency_waits_for_session_close() -> None:
    pool = _database_pool()
    checked_out_before = pool.checkedout()
    connection_checked_out = asyncio.Event()
    close_started = asyncio.Event()
    checked_out_at_request_finish: int | None = None

    def mark_close_started(_connection: object) -> None:
        close_started.set()

    async def run_request() -> None:
        nonlocal checked_out_at_request_finish
        dependency = database.get_session()
        session = await anext(dependency)
        try:
            await session.execute(text("SELECT 1"))
            assert pool.checkedout() == checked_out_before + 1
            connection_checked_out.set()
            await asyncio.Event().wait()
        finally:
            try:
                await dependency.aclose()
            finally:
                checked_out_at_request_finish = pool.checkedout()

    event.listen(database.engine.sync_engine, "rollback", mark_close_started)
    request_task = asyncio.create_task(run_request())
    try:
        await connection_checked_out.wait()
        assert request_task.cancel("disconnect")
        await close_started.wait()
        assert not request_task.done()
        assert request_task.cancel("disconnect-again")

        with pytest.raises(asyncio.CancelledError, match="disconnect-again"):
            await request_task
    finally:
        event.remove(database.engine.sync_engine, "rollback", mark_close_started)
        if not request_task.done():
            request_task.cancel()
            await asyncio.gather(request_task, return_exceptions=True)

    assert checked_out_at_request_finish == checked_out_before
    assert pool.checkedout() == checked_out_before


async def test_anyio_level_cancellation_still_returns_connection() -> None:
    pool = _database_pool()
    checked_out_before = pool.checkedout()
    rollback_started = asyncio.Event()

    def mark_rollback(_connection: object) -> None:
        rollback_started.set()

    async def run_cancelled_cleanup() -> None:
        dependency = database.get_session()
        session = await anext(dependency)
        await session.execute(text("SELECT 1"))
        assert pool.checkedout() == checked_out_before + 1

        with anyio.CancelScope() as cancel_scope:
            cancel_scope.cancel()
            await dependency.aclose()
            assert pool.checkedout() == checked_out_before

    event.listen(database.engine.sync_engine, "rollback", mark_rollback)
    try:
        await asyncio.wait_for(run_cancelled_cleanup(), timeout=2)
    finally:
        event.remove(database.engine.sync_engine, "rollback", mark_rollback)

    assert rollback_started.is_set()
    assert pool.checkedout() == checked_out_before


async def test_exceptional_dependency_exit_rolls_back_and_returns_connection() -> None:
    pool = _database_pool()
    checked_out_before = pool.checkedout()
    rollback_started = asyncio.Event()

    def mark_rollback(_connection: object) -> None:
        rollback_started.set()

    dependency = database.get_session()
    session = await anext(dependency)
    event.listen(database.engine.sync_engine, "rollback", mark_rollback)
    try:
        await session.execute(text("SELECT 1"))
        assert pool.checkedout() == checked_out_before + 1
        with pytest.raises(RuntimeError, match="handler failed"):
            try:
                raise RuntimeError("handler failed")
            finally:
                await dependency.aclose()
    finally:
        event.remove(database.engine.sync_engine, "rollback", mark_rollback)

    assert rollback_started.is_set()
    assert pool.checkedout() == checked_out_before


@pytest.mark.committed_db
@pytest.mark.parametrize("surface", ["mcp", "connectors"])
async def test_external_connector_wait_does_not_hold_auth_transaction(
    surface: str,
    db_session,
    seed_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.core.config import settings
    from app.routes import connectors, mcp_bridge

    raw_key = f"clawdi_{secrets.token_urlsafe(24)}"
    db_session.add(
        ApiKey(
            user_id=seed_user.id,
            key_hash=hashlib.sha256(raw_key.encode()).hexdigest(),
            key_prefix=raw_key[:16],
            label=f"{surface}-lifecycle-test",
            last_used_at=datetime.now(UTC),
            scopes=None,
        )
    )
    await db_session.commit()

    connector_started = asyncio.Event()
    auth_rolled_back = asyncio.Event()
    release_connector = asyncio.Event()

    async def blocked_connector_call(_user_id: str) -> list[dict[str, object]]:
        connector_started.set()
        await release_connector.wait()
        return []

    def mark_auth_rollback(_connection: object) -> None:
        auth_rolled_back.set()

    monkeypatch.setattr(settings, "composio_api_key", "test-composio-key")
    if surface == "mcp":
        monkeypatch.setattr(mcp_bridge, "get_tool_router_mcp_tools", blocked_connector_call)
    else:
        monkeypatch.setattr(connectors, "get_connected_accounts", blocked_connector_call)
    pool = _database_pool()
    checked_out_before = pool.checkedout()
    event.listen(database.engine.sync_engine, "rollback", mark_auth_rollback)
    request_task: asyncio.Task[httpx.Response] | None = None
    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            headers = {"Authorization": f"Bearer {raw_key}"}
            if surface == "mcp":
                request_task = asyncio.create_task(
                    client.post(
                        "/v1/mcp/clawdi",
                        headers=headers,
                        json={
                            "jsonrpc": "2.0",
                            "id": 1,
                            "method": "tools/list",
                            "params": {},
                        },
                    )
                )
            else:
                request_task = asyncio.create_task(client.get("/v1/connectors", headers=headers))
            await asyncio.wait_for(connector_started.wait(), timeout=2)

            assert auth_rolled_back.is_set()
            assert pool.checkedout() == checked_out_before

            assert request_task.cancel("client-disconnect")
            with pytest.raises(asyncio.CancelledError, match="client-disconnect"):
                await request_task
    finally:
        event.remove(database.engine.sync_engine, "rollback", mark_auth_rollback)
        release_connector.set()
        if request_task is not None and not request_task.done():
            request_task.cancel()
            await asyncio.gather(request_task, return_exceptions=True)

    assert pool.checkedout() == checked_out_before
