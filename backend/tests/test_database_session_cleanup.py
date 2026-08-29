from __future__ import annotations

import asyncio

import pytest

from app.core import database


class _BlockingSession:
    def __init__(self) -> None:
        self.close_started = asyncio.Event()
        self.close_release = asyncio.Event()
        self.closed = asyncio.Event()

    async def __aenter__(self) -> _BlockingSession:
        return self

    async def __aexit__(self, *_args: object) -> None:
        close_task = asyncio.create_task(self.close())
        await asyncio.shield(close_task)

    async def close(self) -> None:
        self.close_started.set()
        await self.close_release.wait()
        self.closed.set()


async def test_cancelled_dependency_waits_for_session_close(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = _BlockingSession()
    monkeypatch.setattr(database, "async_session_factory", lambda: session)
    dependency = database.get_session()
    assert await anext(dependency) is session

    cleanup = asyncio.create_task(dependency.aclose())
    await session.close_started.wait()
    cleanup.cancel()
    await asyncio.sleep(0)

    assert not cleanup.done()
    session.close_release.set()
    with pytest.raises(asyncio.CancelledError):
        await cleanup
    assert session.closed.is_set()
