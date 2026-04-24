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
