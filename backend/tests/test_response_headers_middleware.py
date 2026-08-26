from __future__ import annotations

import httpx
import pytest
from starlette.types import Message, Receive, Scope, Send

from app.core.config import settings
from app.middleware.request_id import RequestIDMiddleware
from app.middleware.security_headers import SecurityHeadersMiddleware


@pytest.mark.asyncio
async def test_request_id_propagates_through_scope_and_response() -> None:
    seen_request_id: str | None = None

    async def inner(scope: Scope, _receive: Receive, send: Send) -> None:
        nonlocal seen_request_id
        seen_request_id = scope["state"]["request_id"]
        await send(
            {
                "type": "http.response.start",
                "status": 204,
                "headers": [(b"x-request-id", b"inner-value")],
            }
        )
        await send({"type": "http.response.body", "body": b""})

    app = RequestIDMiddleware(inner)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/", headers={"X-Correlation-ID": "  caller-id  "})

    assert seen_request_id == "caller-id"
    assert response.headers["X-Request-ID"] == "caller-id"


@pytest.mark.asyncio
async def test_security_headers_preserve_existing_values(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "environment", "production")

    async def inner(_scope: Scope, _receive: Receive, send: Send) -> None:
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"x-frame-options", b"SAMEORIGIN")],
            }
        )
        await send({"type": "http.response.body", "body": b"ok"})

    app = SecurityHeadersMiddleware(inner)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/")

    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "SAMEORIGIN"
    assert response.headers["Referrer-Policy"] == "strict-origin-when-cross-origin"
    assert response.headers["Strict-Transport-Security"] == ("max-age=31536000; includeSubDomains")


@pytest.mark.asyncio
async def test_response_header_middleware_passes_non_http_scopes_through() -> None:
    seen: list[str] = []

    async def inner(scope: Scope, _receive: Receive, _send: Send) -> None:
        seen.append(scope["type"])

    app = SecurityHeadersMiddleware(RequestIDMiddleware(inner))

    async def receive() -> Message:
        return {"type": "lifespan.shutdown"}

    async def send(_message: Message) -> None:
        return None

    await app({"type": "lifespan", "asgi": {"version": "3.0"}, "state": {}}, receive, send)

    assert seen == ["lifespan"]
