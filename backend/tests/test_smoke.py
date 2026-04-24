"""Smoke tests — the most load-bearing paths end-to-end.

Purpose: CI catches the worst regressions before targeted coverage exists for
every feature. Each test hits the real FastAPI stack against a real Postgres.
"""

from __future__ import annotations

import httpx
import pytest
from httpx import ASGITransport

from app.main import app


@pytest.mark.asyncio
async def test_openapi_available(client: httpx.AsyncClient):
    """App boots and the OpenAPI schema is reachable."""
    r = await client.get("/openapi.json")
    assert r.status_code == 200
    assert "paths" in r.json()


@pytest.mark.asyncio
async def test_health_endpoint(client: httpx.AsyncClient):
    r = await client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_unauthenticated_request_rejected():
    """Protected endpoints reject requests without a bearer token."""
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        r = await ac.get("/api/memories")
    # HTTPBearer returns 403 when the Authorization header is absent.
    assert r.status_code in (401, 403), r.text


@pytest.mark.asyncio
async def test_list_memories_empty(client: httpx.AsyncClient):
    """A fresh user sees an empty memories list, not an error."""
    r = await client.get("/api/memories")
    assert r.status_code == 200, r.text
    assert r.json() == []


@pytest.mark.asyncio
async def test_create_and_list_memory(client: httpx.AsyncClient):
    """Creating a memory round-trips through the full provider + list path."""
    r = await client.post(
        "/api/memories",
        json={"content": "smoke test memory", "category": "fact"},
    )
    assert r.status_code in (200, 201), r.text

    r = await client.get("/api/memories")
    assert r.status_code == 200
    items = r.json()
    assert any("smoke test memory" in (m.get("content") or m.get("text") or "") for m in items), (
        items
    )
