"""BodySizeLimitMiddleware — declares-too-big requests get 413
before the route's body-parser runs.

Ground-truth verification by mounting the middleware on a tiny
Starlette app: any in-app side effect we observe is proof the
request was passed through the middleware. We assert the
oversized-Content-Length path doesn't reach the handler at all.
"""

from __future__ import annotations

import httpx
import pytest
from httpx import ASGITransport
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from app.middleware.body_size_limit import BodySizeLimitMiddleware


def _build_app(*, max_bytes: int) -> tuple[Starlette, list[bool]]:
    handler_called = []

    async def echo(request: Request) -> JSONResponse:
        handler_called.append(True)
        return JSONResponse({"ok": True})

    app = Starlette(routes=[Route("/echo", echo, methods=["POST", "GET"])])
    app.add_middleware(BodySizeLimitMiddleware, max_bytes=max_bytes)
    return app, handler_called


@pytest.mark.asyncio
async def test_413_when_content_length_over_cap():
    """Declared Content-Length > cap → 413 BEFORE handler runs."""
    app, handler_called = _build_app(max_bytes=1024)
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as ac:
        r = await ac.post(
            "/echo",
            content=b"x" * 2048,
            headers={"content-type": "application/octet-stream"},
        )
    assert r.status_code == 413, r.text
    assert "too large" in r.json()["detail"].lower()
    # Critical: handler must NOT have run.
    assert handler_called == []


@pytest.mark.asyncio
async def test_passthrough_when_content_length_at_cap():
    """Right at the cap (= cap, not >): handler runs."""
    app, handler_called = _build_app(max_bytes=1024)
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as ac:
        r = await ac.post("/echo", content=b"x" * 1024)
    assert r.status_code == 200
    assert handler_called == [True]


@pytest.mark.asyncio
async def test_get_requests_skip_the_check():
    """GET has no body envelope to enforce against — middleware passes through."""
    app, handler_called = _build_app(max_bytes=10)
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as ac:
        r = await ac.get("/echo")
    assert r.status_code == 200
    assert handler_called == [True]


@pytest.mark.asyncio
async def test_chunked_under_cap_passes_through():
    """No Content-Length but body fits under the cap →
    middleware streams + replays cleanly to the handler."""
    app, handler_called = _build_app(max_bytes=10)
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as ac:
        # httpx auto-sets content-length when content is bytes; we
        # bypass that by sending an explicit async stream.
        async def stream():
            yield b"abc"

        r = await ac.post("/echo", content=stream())
    assert r.status_code == 200
    assert handler_called == [True]


@pytest.mark.asyncio
async def test_chunked_over_cap_rejected_mid_stream():
    """No Content-Length, body exceeds cap → middleware rejects
    via the streaming counter even though no header was declared.
    This is the DR7 hole: FastAPI's `UploadFile` parser would
    otherwise spool the entire body before any handler-level cap
    fires."""

    inner_called = []

    async def inner_app(scope, receive, send):
        # Read the full body so we can prove the inner app's read
        # got truncated (or never completed).
        body = b""
        more = True
        while more:
            msg = await receive()
            if msg.get("type") == "http.disconnect":
                break
            body += msg.get("body", b"")
            more = msg.get("more_body", False)
        inner_called.append(len(body))
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    middleware = BodySizeLimitMiddleware(inner_app, max_bytes=10)

    # Synthetic chunked POST: three 10-byte chunks (30 bytes total),
    # no Content-Length header.
    chunks_to_send = [b"x" * 10, b"x" * 10, b"x" * 10]
    chunk_idx = 0

    async def receive():
        nonlocal chunk_idx
        if chunk_idx < len(chunks_to_send):
            chunk = chunks_to_send[chunk_idx]
            chunk_idx += 1
            return {
                "type": "http.request",
                "body": chunk,
                "more_body": chunk_idx < len(chunks_to_send),
            }
        return {"type": "http.request", "body": b"", "more_body": False}

    sent: list[dict] = []

    async def send_msg(message):
        sent.append(message)

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/upload",
        "headers": [],  # no content-length
    }

    await middleware(scope, receive, send_msg)

    # The middleware MUST have sent the 413 itself.
    statuses = [m.get("status") for m in sent if m.get("type") == "http.response.start"]
    assert 413 in statuses, f"expected 413, got {statuses}"

    # If the inner app got dispatched at all, it should NOT have
    # successfully read the full body (30 bytes). It either never
    # ran or got disconnected mid-read.
    if inner_called:
        assert inner_called[0] < 30, (
            f"inner app read {inner_called[0]} bytes; should have been disconnected"
        )


@pytest.mark.asyncio
async def test_malformed_content_length_falls_through():
    """A non-numeric Content-Length is left for the underlying
    parser to reject — middleware passes through. Drive the
    middleware directly with a synthetic ASGI scope so the
    contract is observable without httpx normalizing the header."""

    inner_called = []

    async def inner_app(scope, receive, send):
        # Proves the middleware passed the request to us instead
        # of short-circuiting with a 413.
        inner_called.append(True)
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    middleware = BodySizeLimitMiddleware(inner_app, max_bytes=10)

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/echo",
        "headers": [(b"content-length", b"not-a-number")],
    }

    sent_messages: list[dict] = []

    async def fake_receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def fake_send(message):
        sent_messages.append(message)

    await middleware(scope, fake_receive, fake_send)

    assert inner_called == [True], "middleware must call the inner app on malformed header"
    # Inner app's 200 response should be the only thing on the wire.
    statuses = [m.get("status") for m in sent_messages if m["type"] == "http.response.start"]
    assert statuses == [200]


@pytest.mark.asyncio
async def test_lifespan_scope_passes_through():
    """Non-HTTP scopes (lifespan, websocket) MUST go straight to
    the inner app — the middleware only filters HTTP requests."""

    inner_called = []

    async def inner_app(scope, receive, send):
        inner_called.append(scope["type"])

    middleware = BodySizeLimitMiddleware(inner_app, max_bytes=10)

    async def noop_receive():
        return {}

    async def noop_send(_):
        return None

    await middleware({"type": "lifespan"}, noop_receive, noop_send)
    assert inner_called == ["lifespan"]
