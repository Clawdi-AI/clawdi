"""Settings secret-masking + MCP proxy JWT verification.

These cover two small-but-sharp security edges: secrets stored via PATCH
/api/settings must come back masked on GET, and the MCP proxy endpoint
must reject requests without a valid HS256 token.
"""

from __future__ import annotations

import httpx
import pytest
from httpx import ASGITransport

from app.main import app


@pytest.mark.asyncio
async def test_settings_patch_masks_sensitive_keys_on_read(client: httpx.AsyncClient):
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
async def test_scope_migration_banner_dismiss_persists(client: httpx.AsyncClient):
    """The post-migration banner dismiss flow uses the existing
    /api/settings PATCH/GET — we don't add a dedicated endpoint.
    The dashboard writes `scope_migration_banner_dismissed_at`
    (ISO timestamp) when the user closes the banner; subsequent
    reads return it so the banner stays hidden across sessions /
    devices. Lock the contract here so a refactor of /api/settings
    can't accidentally drop arbitrary-key support and silently
    revive the banner forever."""
    # Initial state: key absent → banner should show client-side.
    body = (await client.get("/api/settings")).json()
    assert "scope_migration_banner_dismissed_at" not in body

    # Dashboard dismisses the banner.
    dismissed_at = "2026-04-29T08:30:00Z"
    r = await client.patch(
        "/api/settings",
        json={"settings": {"scope_migration_banner_dismissed_at": dismissed_at}},
    )
    assert r.status_code == 200, r.text

    # Subsequent reads (any device) see the dismissed timestamp.
    body = (await client.get("/api/settings")).json()
    assert body["scope_migration_banner_dismissed_at"] == dismissed_at


@pytest.mark.asyncio
async def test_mcp_proxy_rejects_missing_and_invalid_tokens():
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        r_missing = await ac.post("/api/mcp/proxy", json={"method": "tools/list"})
        assert r_missing.status_code == 401, r_missing.text

        r_bad = await ac.post(
            "/api/mcp/proxy",
            json={"method": "tools/list"},
            headers={"Authorization": "Bearer not.a.valid.jwt"},
        )
        assert r_bad.status_code == 401, r_bad.text


@pytest.mark.asyncio
async def test_mcp_proxy_accepts_signed_token_for_unknown_method():
    """A correctly-signed token makes it past auth; unknown methods return a
    JSON-RPC error (not 401)."""
    from app.services.composio import create_proxy_token

    token = create_proxy_token("00000000-0000-0000-0000-000000000000")
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        r = await ac.post(
            "/api/mcp/proxy",
            json={"jsonrpc": "2.0", "id": 1, "method": "does/not/exist"},
            headers={"Authorization": f"Bearer {token}"},
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["error"]["code"] == -32601
