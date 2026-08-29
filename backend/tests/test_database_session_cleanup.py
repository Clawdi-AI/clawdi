from __future__ import annotations

import anyio
from sqlalchemy import text

from app.core import database


async def test_cancelled_session_context_returns_connection_before_exit_completes() -> None:
    pool = database.engine.sync_engine.pool
    checked_out_before = pool.checkedout()
    exit_completed = False
    with anyio.CancelScope() as cancel_scope:
        async with database.async_session_factory() as session:
            await session.execute(text("SELECT 1"))
            assert pool.checkedout() == checked_out_before + 1
            cancel_scope.cancel()
        exit_completed = True

    assert exit_completed
    assert pool.checkedout() == checked_out_before
