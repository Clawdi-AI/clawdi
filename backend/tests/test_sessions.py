"""Session ingestion — batch create de-duplicates and respects user scope."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import httpx
import pytest


async def _register_env(client: httpx.AsyncClient) -> str:
    r = await client.post(
        "/api/environments",
        json={
            "machine_id": "test-machine-1",
            "machine_name": "Test Mac",
            "agent_type": "claude-code",
            "agent_version": "0.1.0",
            "os": "darwin",
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


@pytest.mark.asyncio
async def test_environment_register_is_idempotent(client: httpx.AsyncClient):
    first = await _register_env(client)
    second = await _register_env(client)
    # Same (user, machine_id, agent_type) must return the same environment row,
    # not create a duplicate.
    assert first == second


@pytest.mark.asyncio
async def test_session_batch_dedupes_by_local_session_id(client: httpx.AsyncClient):
    env_id = await _register_env(client)
    started = datetime.now(UTC).isoformat()
    payload = {
        "sessions": [
            {
                "environment_id": env_id,
                "local_session_id": "sess-abc",
                "started_at": started,
                "message_count": 3,
                "model": "claude-opus-4",
            },
            {
                "environment_id": env_id,
                "local_session_id": "sess-xyz",
                "started_at": started,
                "message_count": 7,
                "model": "claude-sonnet-4",
            },
        ]
    }
    r = await client.post("/api/sessions/batch", json=payload)
    assert r.status_code == 200, r.text
    assert r.json() == {"synced": 2}

    # Re-posting identical rows should sync 0 — dedupe is by local_session_id,
    # which is the client's offline idempotency key.
    r2 = await client.post("/api/sessions/batch", json=payload)
    assert r2.json() == {"synced": 0}

    listing = (await client.get("/api/sessions")).json()
    assert listing["total"] == 2
    assert {s["local_session_id"] for s in listing["items"]} == {"sess-abc", "sess-xyz"}


@pytest.mark.asyncio
async def test_sessions_list_supports_pagination_and_search(client: httpx.AsyncClient):
    env_id = await _register_env(client)
    started = datetime.now(UTC).isoformat()
    sessions = [
        {
            "environment_id": env_id,
            "local_session_id": f"sess-pagination-{i:02d}",
            "started_at": started,
            "message_count": i,
            "model": "claude-opus-4",
            "summary": f"Debug run number {i}" if i % 2 == 0 else f"Ship feature {i}",
        }
        for i in range(30)
    ]
    await client.post("/api/sessions/batch", json={"sessions": sessions})

    # Default page size (25) caps the first response — paging state is surfaced
    # so the frontend can render a "Page 1 of N" indicator.
    r = await client.get("/api/sessions")
    body = r.json()
    assert body["total"] == 30
    assert body["page"] == 1
    assert body["page_size"] == 25
    assert len(body["items"]) == 25

    # Second page returns the tail.
    r = await client.get("/api/sessions?page=2&page_size=25")
    assert len(r.json()["items"]) == 5

    # `q` filters against summary/project/local_session_id via ILIKE.
    r = await client.get("/api/sessions?q=ship")
    items = r.json()["items"]
    assert len(items) > 0
    assert all("Ship feature" in s["summary"] for s in items)

    # Invalid sort key should be rejected by the regex-constrained param.
    r = await client.get("/api/sessions?sort=summary")
    assert r.status_code == 422

    # `tokens` is a synthetic sort — the backend resolves it to
    # `input_tokens + output_tokens` so the display column and sort agree.
    r = await client.get("/api/sessions?sort=tokens&order=desc&page_size=5")
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_global_search_returns_hits_across_types(client: httpx.AsyncClient):
    env_id = await _register_env(client)
    started = datetime.now(UTC).isoformat()
    await client.post(
        "/api/sessions/batch",
        json={
            "sessions": [
                {
                    "environment_id": env_id,
                    "local_session_id": "sess-searchable",
                    "started_at": started,
                    "message_count": 1,
                    "summary": "Investigate alpha bug in billing",
                    "model": "claude-opus-4",
                }
            ]
        },
    )
    await client.post("/api/vault", json={"slug": "alpha-keys", "name": "alpha-keys"})

    r = await client.get("/api/search?q=alpha")
    assert r.status_code == 200
    body = r.json()
    types = {hit["type"] for hit in body["results"]}
    # Session summary matched, vault slug matched.
    assert "session" in types
    assert "vault" in types
    # Every hit has the fields the UI depends on to render.
    for hit in body["results"]:
        assert hit["title"]
        assert hit["href"].startswith("/")


@pytest.mark.asyncio
async def test_session_batch_rejects_unowned_environment_id(client: httpx.AsyncClient):
    """A stale environment_id (deleted env, prod reset, leaked across accounts)
    must not slip through batch insert. The 400 carries a structured `code`
    so the CLI can react automatically."""
    payload = {
        "sessions": [
            {
                "environment_id": str(uuid.uuid4()),  # never registered
                "local_session_id": "stale-1",
                "started_at": datetime.now(UTC).isoformat(),
                "message_count": 1,
                "model": "claude-opus-4",
            }
        ]
    }
    r = await client.post("/api/sessions/batch", json=payload)
    assert r.status_code == 400, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "unknown_environment"
    assert "clawdi setup" in detail["message"]
    # Listing must show 0 sessions — the whole batch is rejected, not partially
    # accepted. Half-accept would silently drop the user's data.
    listing = (await client.get("/api/sessions")).json()
    assert listing["total"] == 0


@pytest.mark.asyncio
async def test_session_batch_rejects_malformed_uuid_with_422_not_500(client: httpx.AsyncClient):
    """Malformed environment_id used to crash the route with a 500. Pydantic's
    UUID validation now catches it as a 422 before ever entering the handler."""
    payload = {
        "sessions": [
            {
                "environment_id": "not-a-real-uuid",
                "local_session_id": "x",
                "started_at": datetime.now(UTC).isoformat(),
                "message_count": 1,
            }
        ]
    }
    r = await client.post("/api/sessions/batch", json=payload)
    assert r.status_code == 422
