"""Upstream reproducer: close(timeout) must cover cancellation acknowledgement."""

import asyncio
from contextlib import asynccontextmanager

import asyncpg
import pytest


@asynccontextmanager
async def _paused_tcp_proxy(host: str, port: int):
    """Pause existing traffic and newly opened CancelRequest connections."""
    gate = asyncio.Event()
    gate.set()
    tasks = set()

    async def relay(reader, writer):
        try:
            while data := await reader.read(65536):
                await gate.wait()
                writer.write(data)
                await writer.drain()
            await gate.wait()
        finally:
            writer.close()
            await writer.wait_closed()

    async def forward(reader, writer):
        remote_reader, remote_writer = await asyncio.open_connection(host, port)
        await asyncio.gather(
            relay(reader, remote_writer), relay(remote_reader, writer), return_exceptions=True
        )

    def accept(reader, writer):
        task = asyncio.create_task(forward(reader, writer))
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    server = await asyncio.start_server(accept, "127.0.0.1", 0)
    try:
        yield server.sockets[0].getsockname()[1], gate
    finally:
        gate.set()
        server.close()
        await server.wait_closed()
        if tasks:
            await asyncio.wait_for(asyncio.gather(*tuple(tasks)), timeout=5)


@pytest.mark.xfail(
    strict=True,
    raises=AssertionError,
    reason="asyncpg 0.31.0 applies close timeout only after unbounded cancellation waits",
)
async def test_asyncpg_close_timeout_covers_stalled_cancellation(engine):
    # This is an unresolved upstream contract, not a guarantee of the SSE fix.
    # See asyncpg v0.31.0 asyncpg/protocol/protocol.pyx: Protocol.close().
    url = engine.url.set(drivername="postgresql")
    if url.host is None:
        pytest.skip("The TCP stall reproducer requires a TCP PostgreSQL URL")
    observer = await asyncpg.connect(url.render_as_string(hide_password=False), ssl=False)
    try:
        async with _paused_tcp_proxy(url.host, url.port or 5432) as (port, gate):
            proxied = url.set(host="127.0.0.1", port=port)
            connection = await asyncpg.connect(
                proxied.render_as_string(hide_password=False),
                ssl=False,
                server_settings={"statement_timeout": "1s"},
            )
            pid = connection.get_server_pid()
            query = asyncio.create_task(connection.execute("SELECT pg_sleep(30)"))
            close_task = None
            try:
                async with asyncio.timeout(5):
                    while (
                        await observer.fetchval(
                            "SELECT wait_event FROM pg_stat_activity WHERE pid=$1", pid
                        )
                        != "PgSleep"
                    ):
                        await asyncio.sleep(0.01)
                gate.clear()
                query.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await query
                close_task = asyncio.create_task(connection.close(timeout=0.05))
                # Observe without cancelling close ourselves: a stalled close
                # needs its network restored before the reproducer can clean up.
                done, _pending = await asyncio.wait({close_task}, timeout=0.5)
                if close_task in done:
                    with pytest.raises(TimeoutError):
                        await close_task
            finally:
                gate.set()
                if not query.done():
                    query.cancel()
                await asyncio.gather(query, return_exceptions=True)
                if close_task is not None:
                    results = await asyncio.wait_for(
                        asyncio.gather(close_task, return_exceptions=True), 5
                    )
                    outcome = results[0]
                    if isinstance(outcome, BaseException) and not isinstance(outcome, TimeoutError):
                        raise outcome
                else:
                    await connection.close(timeout=2)
                async with asyncio.timeout(3):
                    while await observer.fetchval(
                        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=$1)", pid
                    ):
                        await asyncio.sleep(0.01)
            assert close_task in done, "close(timeout=0.05) is still waiting after 0.5s"
    finally:
        await observer.close()
