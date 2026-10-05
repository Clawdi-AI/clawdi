"""Observe real PostgreSQL lock waits before releasing a test's lock holder."""

import asyncio

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker


async def wait_for_lock_wait(
    sessionmaker: async_sessionmaker[AsyncSession],
    backend_pid: int,
    *,
    timeout: float = 5,
    query_pattern: str | None = None,
    blocker_pid: int | None = None,
) -> None:
    async with asyncio.timeout(timeout), sessionmaker() as observer:
        while True:
            waiting = await observer.scalar(
                text(
                    """
                    SELECT EXISTS (
                        SELECT 1 FROM pg_stat_activity
                        WHERE pid = :backend_pid
                          AND state = 'active'
                          AND wait_event_type = 'Lock'
                          AND (CAST(:query_pattern AS text) IS NULL OR query LIKE :query_pattern)
                          AND (CAST(:blocker_pid AS integer) IS NULL
                               OR :blocker_pid = ANY(pg_blocking_pids(pid)))
                    )
                    """
                ),
                {
                    "backend_pid": backend_pid,
                    "query_pattern": query_pattern,
                    "blocker_pid": blocker_pid,
                },
            )
            if waiting is True:
                return
            await observer.rollback()
            await asyncio.sleep(0.01)
