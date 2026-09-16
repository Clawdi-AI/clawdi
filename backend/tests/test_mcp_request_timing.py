"""Real route timing with synthetic authority and no external providers."""

import logging
from uuid import UUID

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth_short_session
from app.core.database import get_session
from app.middleware import request_timing
from app.models.user import User
from app.routes import mcp_bridge


@pytest.mark.asyncio
async def test_mcp_batch_timing_preserves_results_order_and_private_inputs(monkeypatch, caplog):
    clock = [0.0]
    monkeypatch.setattr(request_timing.time, "perf_counter", lambda: clock[0])
    read_json = mcp_bridge._read_request_json

    async def body_read(request):
        clock[0] += 0.007
        return await read_json(request)

    monkeypatch.setattr(mcp_bridge, "_read_request_json", body_read)
    auth = AuthContext(
        user=User(id=UUID(int=1), clerk_id="private-tenant", email="test@test.invalid")
    )

    async def authority():
        clock[0] += 0.011
        return auth

    async def database():
        async with AsyncSession() as db:
            yield db

    calls = []

    async def connector(name, arguments, *, auth):
        calls.append((name, arguments))
        clock[0] += 0.023
        return {"content": [{"type": "text", "text": "private-result"}], "isError": False}

    monkeypatch.setattr(mcp_bridge, "_tool_connector_call", connector)
    app = FastAPI()
    app.include_router(mcp_bridge.router, prefix="/v1")
    app.add_middleware(request_timing.RequestTimingMiddleware, slow_ms=1)
    app.dependency_overrides[get_auth_short_session] = authority
    app.dependency_overrides[get_session] = database
    body = [
        {"id": 1, "method": "ping"},
        {"method": "notifications/initialized"},
        {"id": 2, "method": "private-method\nforged=1"},
        {
            "id": 3,
            "method": "tools/call",
            "params": {"name": "private-tool", "arguments": {"secret": "private-argument"}},
        },
        {"id": 4, "method": "tools/call", "params": {"name": "private-tool", "arguments": {}}},
        ["private-nested"],
        "private-invalid",
    ]
    caplog.set_level(logging.WARNING, logger=request_timing.__name__)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post("/v1/mcp/clawdi", json=body)
    result = {"content": [{"type": "text", "text": "private-result"}], "isError": False}
    assert response.json() == [
        {"jsonrpc": "2.0", "id": 1, "result": {}},
        {"jsonrpc": "2.0", "id": 2, "error": {"code": -32601, "message": "Method not found"}},
        {"jsonrpc": "2.0", "id": 3, "result": result},
        {"jsonrpc": "2.0", "id": 4, "result": result},
    ]
    assert calls == [("private-tool", {"secret": "private-argument"}), ("private-tool", {})]
    assert "pre_handler_ms=11.0" in caplog.text
    assert "mcp_body_read_ms=7.0" in caplog.text
    assert "mcp_dispatch_ms=46.0" in caplog.text
    assert "mcp_method=mixed mcp_tool_category=mixed" in caplog.text
    assert "private-" not in caplog.text
    assert "forged" not in caplog.text


@pytest.mark.parametrize(
    "body,expected",
    [
        ({"method": "tools/list"}, ("tools/list", "catalog")),
        ({"method": "tools/call", "params": {"name": "memory_extract"}}, ("tools/call", "native")),
        ({"method": "tools/call", "params": {"name": "private-tool"}}, ("tools/call", "connector")),
        (
            {"method": "tools/call", "params": {"name": "memory_extract", "arguments": [1]}},
            ("tools/call", "unknown"),
        ),
        ({"method": ["private-method"]}, ("unknown", "unknown")),
        ({"method": "notifications/private"}, ("unknown", "unknown")),
        ([], ("unknown", "unknown")),
        ([{"method": "ping"}, {"method": "ping"}], ("ping", "none")),
    ],
)
def test_mcp_classification_is_bounded(body, expected):
    assert mcp_bridge._mcp_classification(body) == expected


@pytest.mark.parametrize("outcome", ["slow", "error", "failure"])
@pytest.mark.asyncio
async def test_mcp_log_boundary_rejects_untrusted_classifications(caplog, outcome):
    async def inner(scope, receive, send):
        scope["state"]["_request_mcp_classification"] = ("private-method", "private-tool")
        if outcome == "failure":
            raise RuntimeError("synthetic failure")
        await send(
            {
                "type": "http.response.start",
                "status": 500 if outcome == "error" else 200,
                "headers": [],
            }
        )
        await send({"type": "http.response.body", "body": b""})

    async def receive():
        return {"type": "http.request", "body": b""}

    async def send(message):
        pass

    caplog.set_level(logging.WARNING, logger=request_timing.__name__)
    app = request_timing.RequestTimingMiddleware(inner, slow_ms=0.000001)
    scope = {"type": "http", "path": "/v1/mcp/clawdi", "method": "POST"}
    if outcome == "failure":
        with pytest.raises(RuntimeError):
            await app(scope, receive, send)
    else:
        await app(scope, receive, send)
    assert "request_" in caplog.text
    assert "private-" not in caplog.text
