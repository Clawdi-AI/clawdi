"""Smoke tests — the most load-bearing paths end-to-end.

Purpose: CI catches the worst regressions before targeted coverage exists for
every feature. Each test hits the real FastAPI stack against a real Postgres.
"""

from __future__ import annotations

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy.exc import TimeoutError as SQLAlchemyTimeoutError

from app.core.database import get_session
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
async def test_readiness_endpoint(client: httpx.AsyncClient):
    r = await client.get("/ready")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_liveness_survives_database_pool_exhaustion():
    async def exhausted_session():
        raise SQLAlchemyTimeoutError("private pool state")
        yield

    previous_overrides = dict(app.dependency_overrides)
    app.dependency_overrides[get_session] = exhausted_session
    try:
        transport = ASGITransport(app=app, raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            health = await ac.get("/health")
            ready = await ac.get("/ready")
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous_overrides)

    assert health.status_code == 200
    assert health.json() == {"status": "ok"}
    assert ready.status_code == 503
    assert ready.json() == {"detail": "Database capacity temporarily unavailable"}
    assert ready.headers["Retry-After"] == "1"
    assert ready.headers["Cache-Control"] == "no-store"
    assert "private pool state" not in ready.text


@pytest.mark.asyncio
async def test_unauthenticated_request_rejected():
    """Protected endpoints reject requests without a bearer token."""
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        r = await ac.get("/v1/memories")
    # HTTPBearer returns 403 when the Authorization header is absent.
    assert r.status_code in (401, 403), r.text


@pytest.mark.asyncio
async def test_list_memories_empty(client: httpx.AsyncClient):
    """A fresh user sees an empty paginated memories page, not an error."""
    r = await client.get("/v1/memories")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["items"] == []
    assert body["total"] == 0
    assert body["page"] == 1


@pytest.mark.asyncio
async def test_create_and_list_memory(client: httpx.AsyncClient):
    """Creating a memory round-trips through the full provider + list path."""
    r = await client.post(
        "/v1/memories",
        json={"content": "smoke test memory", "category": "fact"},
    )
    assert r.status_code in (200, 201), r.text

    r = await client.get("/v1/memories")
    assert r.status_code == 200
    items = r.json()["items"]
    assert any("smoke test memory" in (m.get("content") or m.get("text") or "") for m in items), (
        items
    )


@pytest.mark.asyncio
async def test_create_memory_rejects_likely_secret(client: httpx.AsyncClient):
    r = await client.post(
        "/v1/memories",
        json={
            "content": "OpenAI key is sk-abcdefghijklmnopqrstuvwxyz123456",
            "category": "fact",
        },
    )
    assert r.status_code == 400, r.text
    body = r.json()
    assert body["detail"]["code"] == "memory_secret_rejected"
    assert "vault set" in body["detail"]["message"]
