from __future__ import annotations

import logging

import pytest
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.middleware.request_timing import RequestTimingMiddleware


def _scope(*, path: str = "/v1/sessions", query_string: bytes = b"secret=value") -> Scope:
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
        _scope(path="/v1/sessions", query_string=b"token=secret"),
    )

    assert "request_error method=GET path=/v1/sessions status=500" in caplog.text
    assert "request_id=req_test" in caplog.text
    assert "token=secret" not in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("path", "expected_path"),
    [
        (
            "/v1/channels/telegram/bot123456:secret/getMe",
            "/v1/channels/telegram/bot[redacted]/getMe",
        ),
        (
            "/api/channels/telegram/bot/123456:secret/sendMessage",
            "/api/channels/telegram/bot/[redacted]/sendMessage",
        ),
        (
            "/v1/channels/telegram/file/bot123456:secret/documents/file.txt",
            "/v1/channels/telegram/file/bot[redacted]/documents/file.txt",
        ),
        (
            "/v1/channels/discord/v10/interactions/123/123456:secret/callback",
            "/v1/channels/discord/v10/interactions/123/[redacted]/callback",
        ),
        (
            "/api/channels/discord/api/v10/webhooks/123/123456:secret/messages/@original",
            "/api/channels/discord/api/v10/webhooks/123/[redacted]/messages/@original",
        ),
        (
            "/v1/channels/discord/api/v10/webhooks/123/123456:secret",
            "/v1/channels/discord/api/v10/webhooks/123/[redacted]",
        ),
        (
            "/api/channels/discord/v10/interactions/123/123456:secret/callback",
            "/api/channels/discord/v10/interactions/123/[redacted]/callback",
        ),
        (
            "/v1/channels/discord/gateway/123456:secret",
            "/v1/channels/discord/gateway/[redacted]",
        ),
        (
            "/v1/channels/discord/v10/channels/123/messages",
            "/v1/channels/discord/v10/channels/123/messages",
        ),
    ],
)
@pytest.mark.parametrize("outcome", ["slow", "error", "exception"])
async def test_request_timing_redacts_channel_routing_credentials(
    caplog: pytest.LogCaptureFixture,
    path: str,
    expected_path: str,
    outcome: str,
):
    async def inner(_scope: Scope, _receive: Receive, send: Send) -> None:
        assert _scope["path"] == path
        if outcome == "exception":
            raise RuntimeError("synthetic failure")
        await send(
            {
                "type": "http.response.start",
                "status": 200 if outcome == "slow" else 500,
                "headers": [],
            }
        )
        await send({"type": "http.response.body", "body": b"error"})

    caplog.set_level(logging.WARNING, logger="app.middleware.request_timing")
    app = RequestTimingMiddleware(inner, slow_ms=0.000_001)
    if outcome == "exception":
        with pytest.raises(RuntimeError, match="synthetic failure"):
            await _collect(app, _scope(path=path))
    else:
        await _collect(app, _scope(path=path))

    assert f"path={expected_path}" in caplog.text
    assert "123456:secret" not in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path",
    [
        "/v1/sync/events",
        "/api/sync/events",
        "/v1/channels/telegram/bot123456:secret/getUpdates",
    ],
)
async def test_request_timing_does_not_warn_for_successful_long_request(
    caplog: pytest.LogCaptureFixture,
    path: str,
):
    async def inner(_scope: Scope, _receive: Receive, send: Send) -> None:
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    caplog.set_level(logging.WARNING, logger="app.middleware.request_timing")
    await _collect(
        RequestTimingMiddleware(inner, slow_ms=0.000_001),
        _scope(path=path),
    )

    assert caplog.text == ""


@pytest.mark.parametrize(
    ("outcome", "expected_event", "expected_stages"),
    [
        ("slow", "request_slow", (11, 23, 37)),
        ("fast", None, (11, 23, 37)),
        ("auth_error", "request_error", (11, None, None)),
        ("validation_failure", "request_failed", (11, 23, None)),
        ("provider_error", "request_error", (11, 23, 37)),
        ("cancel", None, (11, 23, 37)),
    ],
)
async def test_telegram_route_stage_timings(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    outcome: str,
    expected_event: str | None,
    expected_stages: tuple[int | None, ...],
):
    import asyncio
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from uuid import uuid4

    import httpx
    from fastapi import FastAPI, HTTPException
    from sqlalchemy.ext.asyncio import AsyncSession

    from app.core.database import get_session
    from app.middleware import request_timing
    from app.routes.channel_routers import telegram

    elapsed = 0.0
    monkeypatch.setattr(request_timing.time, "perf_counter", lambda: elapsed)
    db = AsyncMock(spec=AsyncSession)
    account = SimpleNamespace(
        id=uuid4(), encrypted_provider_token="encrypted", provider_token_nonce="nonce"
    )

    async def resolve(*_args, **_kwargs):
        nonlocal elapsed
        elapsed += 0.011
        if outcome == "auth_error":
            raise HTTPException(500, "test auth failure")
        return SimpleNamespace(account=account, link=SimpleNamespace(id=uuid4())), "token"

    async def validate(_url):
        nonlocal elapsed
        elapsed += 0.023
        if outcome == "validation_failure":
            raise RuntimeError("test validation failure")

    async def provider(request: httpx.Request) -> httpx.Response:
        nonlocal elapsed
        db.rollback.assert_awaited_once()
        elapsed += 0.037
        if outcome == "provider_error":
            raise httpx.ConnectError("test connection failure")
        if outcome == "cancel":
            raise asyncio.CancelledError
        return httpx.Response(200, json={"ok": True, "result": True})

    monkeypatch.setattr(telegram, "_resolve_telegram_agent", resolve)
    monkeypatch.setattr(telegram, "_validate_telegram_provider_base_url", validate)
    monkeypatch.setattr(telegram, "decrypt_provider_token", lambda _account: "provider-secret")
    app = FastAPI()
    app.include_router(telegram.router, prefix="/v1")
    app.dependency_overrides[get_session] = lambda: db
    scope = _scope(path="/v1/channels/telegram/botrouting-secret/getMe")
    caplog.set_level(logging.WARNING, logger="app.middleware.request_timing")
    async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as upstream:
        monkeypatch.setattr(telegram, "get_channel_provider_http_client", lambda: upstream)
        timed = RequestTimingMiddleware(app, slow_ms=100 if outcome == "fast" else 50)
        if outcome == "validation_failure":
            with pytest.raises(RuntimeError, match="test validation failure"):
                await _collect(timed, scope)
        elif outcome == "cancel":
            with pytest.raises(asyncio.CancelledError):
                await _collect(timed, scope)
        else:
            messages = await _collect(timed, scope)
            assert messages[0]["status"] == (
                500 if outcome == "auth_error" else 502 if outcome == "provider_error" else 200
            )

    stages = ("channel_auth_ms", "channel_url_validation_ms", "channel_provider_ms")
    timings = scope["state"]["_channel_stage_timings"]
    assert timings == pytest.approx(
        {stage: value for stage, value in zip(stages, expected_stages) if value is not None}
    )
    records = [r.getMessage() for r in caplog.records if r.name == request_timing.__name__]
    if expected_event is None:
        assert records == []
    else:
        assert len(records) == 1
        assert records[0].startswith(expected_event + " ")
        for stage, value in zip(stages, expected_stages):
            if value is None:
                assert stage not in records[0]
            else:
                assert f"{stage}={value:.1f}" in records[0]
        assert "bot[redacted]/getMe" in records[0]
    assert "routing-secret" not in caplog.text
    assert "provider-secret" not in caplog.text
    assert "secret=value" not in caplog.text


async def test_request_timing_isolates_stage_state_and_filters_fields(caplog):
    from app.middleware.request_timing import _CHANNEL_TIMING_STATE

    inherited = {"channel_auth_ms": 999.0}
    scope = _scope()
    scope["state"][_CHANNEL_TIMING_STATE] = inherited

    async def inner(scope: Scope, _receive: Receive, send: Send) -> None:
        timings = scope["state"][_CHANNEL_TIMING_STATE]
        assert timings == {}
        assert timings is not inherited
        timings.update(
            channel_auth_ms=float("nan"),
            channel_url_validation_ms=float("inf"),
            channel_provider_ms="secret",
            unknown="secret",
        )
        await send({"type": "http.response.start", "status": 500, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    caplog.set_level(logging.WARNING, logger="app.middleware.request_timing")
    await _collect(RequestTimingMiddleware(inner, slow_ms=750), scope)
    assert "request_error" in caplog.text
    assert "channel_" not in caplog.text
    assert "unknown" not in caplog.text
    assert "secret" not in caplog.text
    assert inherited == {"channel_auth_ms": 999.0}
