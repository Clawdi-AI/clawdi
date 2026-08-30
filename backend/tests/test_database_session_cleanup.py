from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import event, text

from app.core import database


async def test_externally_cancelled_dependency_waits_for_session_close() -> None:
    pool = database.engine.sync_engine.pool
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
