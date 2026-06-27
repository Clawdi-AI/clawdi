from __future__ import annotations

import logging

import pytest
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.middleware.request_timing import RequestTimingMiddleware


def _scope(*, path: str = "/api/sessions", query_string: bytes = b"secret=value") -> Scope:
    return {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": query_string,
        "headers": [],
        "client": ("127.0.0.1", 12345),
        "server": ("testserver", 80),
        "state": {"request_id": "req_test"},
    }


def _receive() -> Receive:
    sent = False

    async def receive() -> Message:
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": b"", "more_body": False}

    return receive


async def _collect(app: ASGIApp, scope: Scope) -> list[Message]:
    messages: list[Message] = []

    async def send(message: Message) -> None:
        messages.append(message)

    await app(scope, _receive(), send)
    return messages


@pytest.mark.asyncio
async def test_request_timing_adds_process_time_header():
    async def inner(_scope: Scope, _receive: Receive, send: Send) -> None:
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    messages = await _collect(RequestTimingMiddleware(inner, slow_ms=750), _scope())
    start = next(message for message in messages if message["type"] == "http.response.start")
    headers = dict(start["headers"])

    assert b"x-process-time-ms" in headers
    assert float(headers[b"x-process-time-ms"]) >= 0


@pytest.mark.asyncio
async def test_request_timing_logs_errors_without_query_string(caplog: pytest.LogCaptureFixture):
    async def inner(_scope: Scope, _receive: Receive, send: Send) -> None:
        await send({"type": "http.response.start", "status": 500, "headers": []})
        await send({"type": "http.response.body", "body": b"error"})

    caplog.set_level(logging.WARNING, logger="app.middleware.request_timing")
    await _collect(
        RequestTimingMiddleware(inner, slow_ms=750),
        _scope(path="/api/sessions", query_string=b"token=secret"),
    )

    assert "request_error method=GET path=/api/sessions status=500" in caplog.text
    assert "request_id=req_test" in caplog.text
    assert "token=secret" not in caplog.text
