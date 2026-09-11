from __future__ import annotations

import asyncio
import contextlib
import ssl
from types import SimpleNamespace

import httpcore._async.http11 as http11
import httpx
import pytest
import pytest_asyncio

from app.services import channels
from tests.test_safe_public_http import _write_local_tls_certificate


@pytest_asyncio.fixture
async def tls_provider(tmp_path, monkeypatch):
    certificate, key = _write_local_tls_certificate(tmp_path, "localhost")
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certificate, key)
    monkeypatch.setenv("SSL_CERT_FILE", str(certificate))
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
        monkeypatch.delenv(name, raising=False)
    await channels.close_channel_provider_http_client()
    original_client = httpx.AsyncClient

    def bounded_client(**kwargs):
        limits = kwargs.get("limits")
        if limits is not None:
            # Guard the opt-in Limits constructor's otherwise-unbounded defaults.
            assert limits.max_connections == 100
            assert limits.max_keepalive_connections == 20
        return original_client(**kwargs)

    monkeypatch.setattr(channels.httpx, "AsyncClient", bounded_client)
    state = SimpleNamespace(connections=0, requests=0, mode="keep")
    close_peer, peer_closed = asyncio.Event(), asyncio.Event()
    tasks = set()

    async def handle(reader, writer):
        task = asyncio.current_task()
        tasks.add(task)
        state.connections += 1
        try:
            while True:
                headers = await reader.readuntil(b"\r\n\r\n")
                length = 0
                for line in headers.split(b"\r\n"):
                    if line.lower().startswith(b"content-length:"):
                        length = int(line.split(b":", 1)[1])
                if length:
                    await reader.readexactly(length)
                state.requests += 1
                if state.mode == "stall":
                    await asyncio.Event().wait()
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                await writer.drain()
                if state.mode == "close":
                    await close_peer.wait()
                    return
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()
            with contextlib.suppress(ConnectionError, TimeoutError):
                await writer.wait_closed()
            peer_closed.set()
            tasks.discard(task)

    server = await asyncio.start_server(
        handle, "127.0.0.1", 0, ssl=context, ssl_shutdown_timeout=0.1
    )
    address = server.sockets[0].getsockname()
    try:
        yield (
            channels.get_channel_provider_http_client(),
            f"https://localhost:{address[1]}/",
            state,
            close_peer,
            peer_closed,
        )
    finally:
        await channels.close_channel_provider_http_client()
        server.close()
        await server.wait_closed()
        remaining = list(tasks)
        for task in remaining:
            task.cancel()
        await asyncio.gather(*remaining, return_exceptions=True)


async def test_provider_tls_connection_survives_short_idle_gap_but_expires(
    tls_provider, monkeypatch
):
    client, url, state, _, _ = tls_provider
    clock = [100.0]
    # Change only httpcore's expiry clock, not asyncio's timeout/scheduling clock.
    monkeypatch.setattr(http11, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    assert (await client.get(url)).status_code == 200
    clock[0] += 6
    assert (await client.get(url)).status_code == 200
    assert state.connections == 1
    clock[0] += 31
    assert (await client.get(url)).status_code == 200
    assert state.connections == 2
    assert state.requests == 3


async def test_provider_reconnects_when_server_closes_idle_tls(tls_provider):
    client, url, state, close_peer, peer_closed = tls_provider
    state.mode = "close"
    assert (await client.get(url)).status_code == 200
    close_peer.set()
    await asyncio.wait_for(peer_closed.wait(), 1)
    state.mode = "keep"
    assert (await client.get(url)).status_code == 200
    assert state.connections == 2


async def test_provider_does_not_retry_a_timed_out_mutation(tls_provider):
    client, url, state, _, _ = tls_provider
    state.mode = "stall"
    with pytest.raises(httpx.ReadTimeout):
        # Bound the stalled response without racing local TLS setup under CI load.
        await client.post(url, json={"message": "test"}, timeout=httpx.Timeout(5.0, read=0.1))
    assert state.connections == 1
    assert state.requests == 1
