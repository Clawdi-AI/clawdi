"""Settings secret-masking + MCP bridge JWT verification.

These cover two small-but-sharp security edges: secrets stored via PATCH
/api/settings must come back masked on GET, and the MCP bridge endpoint
must reject requests without a valid HS256 token.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import pytest
from httpx import ASGITransport

from app.core.config import settings
from app.main import app


@pytest.mark.asyncio
async def test_settings_patch_masks_sensitive_keys_on_read(client: httpx.AsyncClient, monkeypatch):
    # Settings save now refuses `memory_provider=mem0` when the
    # `[mem0]` extra isn't installed (the prod-default since the
    # package was never declared). Stub `mem0_available()` so this
    # masking test can still exercise the secret-handling path.
    import app.services.memory_provider as mp

    monkeypatch.setattr(mp, "_mem0_available_cached", None)
    monkeypatch.setattr(mp, "mem0_available", lambda: True)
    import app.routes.settings as st

    monkeypatch.setattr(st, "mem0_available", lambda: True)

    r = await client.patch(
        "/api/settings",
        json={"settings": {"memory_provider": "mem0", "mem0_api_key": "mem0_live_supersecret"}},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "updated"}

    body = (await client.get("/api/settings")).json()
    assert body["memory_provider"] == "mem0"
    # Secret fields must be masked — the actual key value must never be returned.
    masked = body["mem0_api_key"]
    assert masked != "mem0_live_supersecret"
    # The mask sentinel defined in app.routes.settings._SECRET_MASK.
    assert masked == "••••••••"


@pytest.mark.asyncio
async def test_settings_patch_merges_rather_than_replaces(client: httpx.AsyncClient):
    await client.patch("/api/settings", json={"settings": {"a": 1, "b": 2}})
    await client.patch("/api/settings", json={"settings": {"b": 99}})
    body = (await client.get("/api/settings")).json()
    # "a" must survive the second patch — PATCH semantics are merge, not replace.
    assert body["a"] == 1
    assert body["b"] == 99


@pytest.mark.asyncio
async def test_project_migration_banner_dismiss_persists(client: httpx.AsyncClient):
    """The post-migration banner dismiss flow uses the existing
    /api/settings PATCH/GET — we don't add a dedicated endpoint.
    The dashboard writes `project_migration_banner_dismissed_at`
    (ISO timestamp) when the user closes the banner; subsequent
    reads return it so the banner stays hidden across sessions /
    devices. Lock the contract here so a refactor of /api/settings
    can't accidentally drop arbitrary-key support and silently
    revive the banner forever."""
    # Initial state: key absent → banner should show client-side.
    body = (await client.get("/api/settings")).json()
    assert "project_migration_banner_dismissed_at" not in body

    # Dashboard dismisses the banner.
    dismissed_at = "2026-04-29T08:30:00Z"
    r = await client.patch(
        "/api/settings",
        json={"settings": {"project_migration_banner_dismissed_at": dismissed_at}},
    )
    assert r.status_code == 200, r.text

    # Subsequent reads (any device) see the dismissed timestamp.
    body = (await client.get("/api/settings")).json()
    assert body["project_migration_banner_dismissed_at"] == dismissed_at


@pytest.mark.asyncio
async def test_connector_mcp_config_points_at_composio_bridge(monkeypatch):
    from app.core.auth import AuthContext, get_auth
    from app.models.user import User
    from app.services.composio import verify_mcp_bridge_token

    async def fake_auth() -> AuthContext:
        return AuthContext(
            user=User(
                email="mcp-config-test@clawdi.local",
                name="MCP Config Test",
                clerk_id="clerk_user_123",
            )
        )

    monkeypatch.setattr(settings, "composio_api_key", "composio_test_key")
    monkeypatch.setattr(settings, "public_api_url", "https://api.example.test/")

    app.dependency_overrides[get_auth] = fake_auth
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            r = await ac.get("/api/connectors/mcp-config")
    finally:
        app.dependency_overrides.clear()

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mcp_url"] == "https://api.example.test/api/mcp/composio"
    assert verify_mcp_bridge_token(body["mcp_token"]) == "clerk_user_123"


@pytest.mark.asyncio
async def test_mcp_bridge_rejects_missing_and_invalid_tokens():
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        r_missing = await ac.post("/api/mcp/composio", json={"method": "tools/list"})
        assert r_missing.status_code == 401, r_missing.text

        r_bad = await ac.post(
            "/api/mcp/composio",
            json={"method": "tools/list"},
            headers={"Authorization": "Bearer not.a.valid.jwt"},
        )
        assert r_bad.status_code == 401, r_bad.text


@pytest.mark.asyncio
async def test_mcp_composio_bridge_forwards_json_rpc_with_user_scoped_session(monkeypatch):
    from app.routes import mcp_bridge
    from app.services.composio import ComposioMcpSession, create_mcp_bridge_token

    seen: dict = {}

    async def fake_session(user_id: str) -> ComposioMcpSession:
        seen["user_id"] = user_id
        return ComposioMcpSession(
            url="https://app.composio.dev/tool_router/v3/trs_test/mcp",
            headers={"x-session": "trs_test"},
            expires_at=datetime.now(UTC) + timedelta(minutes=30),
        )

    async def fake_forward(session: ComposioMcpSession, body):
        seen["session"] = session
        seen["body"] = body
        return {
            "jsonrpc": "2.0",
            "id": body["id"],
            "result": {
                "tools": [
                    {
                        "name": "COMPOSIO_SEARCH_TOOLS",
                        "description": "Search Composio tools",
                        "inputSchema": {
                            "type": "object",
                            "properties": {"query": {"type": "string"}},
                            "required": ["query"],
                        },
                    }
                ]
            },
        }

    monkeypatch.setattr(mcp_bridge, "get_tool_router_mcp_session", fake_session)
    monkeypatch.setattr(mcp_bridge, "_forward_composio_mcp_request", fake_forward)

    token = create_mcp_bridge_token("clerk_user_123")
    payload = {"jsonrpc": "2.0", "id": 7, "method": "tools/list", "params": {}}
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        r = await ac.post(
            "/api/mcp/composio",
            json=payload,
            headers={"Authorization": f"Bearer {token}"},
        )

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["result"]["tools"][0]["name"] == "COMPOSIO_SEARCH_TOOLS"
    assert body["result"]["tools"][0]["inputSchema"]["properties"]["query"]["type"] == "string"
    assert seen["user_id"] == "clerk_user_123"
    assert seen["body"] == payload


@pytest.mark.asyncio
async def test_mcp_composio_bridge_sends_api_key_accept_and_parses_sse(monkeypatch):
    from app.routes import mcp_bridge
    from app.services.composio import ComposioMcpSession

    seen: dict = {}

    class FakeResponse:
        status_code = 200
        is_success = True
        headers = {"content-type": "text/event-stream"}
        text = (
            "event: message\n"
            'data: {"jsonrpc":"2.0","id":9,"result":{"tools":[{"name":"COMPOSIO_SEARCH_TOOLS",'
            '"inputSchema":{"type":"object","properties":{"query":{"type":"string"}}}}]}}\n\n'
            "event: done\n"
            "data: [DONE]\n\n"
        )

    class FakeAsyncClient:
        def __init__(self, *, timeout: float):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url: str, *, json: dict, headers: dict):
            seen["url"] = url
            seen["json"] = json
            seen["headers"] = headers
            return FakeResponse()

    monkeypatch.setattr(settings, "composio_api_key", "composio_test_key")
    monkeypatch.setattr(mcp_bridge.httpx, "AsyncClient", FakeAsyncClient)

    session = ComposioMcpSession(
        url="https://backend.composio.dev/tool_router/trs_test/mcp",
        headers={},
        expires_at=datetime.now(UTC) + timedelta(minutes=30),
    )
    result = await mcp_bridge._forward_composio_mcp_request(
        session,
        {"jsonrpc": "2.0", "id": 9, "method": "tools/list", "params": {}},
    )

    assert seen["headers"]["Accept"] == "application/json, text/event-stream"
    assert seen["headers"]["x-api-key"] == "composio_test_key"
    assert result["result"]["tools"][0]["name"] == "COMPOSIO_SEARCH_TOOLS"
    assert result["result"]["tools"][0]["inputSchema"]["properties"]["query"]["type"] == "string"


@pytest.mark.asyncio
async def test_create_tool_router_mcp_session_uses_composio_v31_api(monkeypatch):
    from app.services import composio

    requests: list[dict] = []

    class FakeResponse:
        status_code = 201
        is_success = True

        def raise_for_status(self):
            return None

        def json(self):
            return {
                "session_id": "trs_test",
                "mcp": {
                    "type": "http",
                    "url": "https://app.composio.dev/tool_router/v3/trs_test/mcp",
                    "headers": {"x-session": "trs_test"},
                },
            }

    class FakeAsyncClient:
        def __init__(self, *, timeout: float):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url: str, *, headers: dict, json: dict):
            requests.append({"url": url, "headers": headers, "json": json})
            return FakeResponse()

    monkeypatch.setattr(settings, "composio_api_key", "composio_test_key")
    monkeypatch.setattr(settings, "composio_api_base_url", "https://backend.composio.dev/")
    monkeypatch.setattr(composio.httpx, "AsyncClient", FakeAsyncClient)

    now = datetime(2026, 5, 24, tzinfo=UTC)
    session = await composio._create_tool_router_mcp_session("clerk_user_123", now=now)

    assert requests == [
        {
            "url": "https://backend.composio.dev/api/v3.1/tool_router/session",
            "headers": {"x-api-key": "composio_test_key"},
            "json": {"user_id": "clerk_user_123"},
        }
    ]
    assert session.url == "https://app.composio.dev/tool_router/v3/trs_test/mcp"
    assert session.headers == {"x-session": "trs_test"}
    assert session.expires_at == now + timedelta(minutes=30)
