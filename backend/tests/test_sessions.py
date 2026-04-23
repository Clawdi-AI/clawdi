"""Session ingestion — batch create de-duplicates and respects user scope."""

from __future__ import annotations

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
    assert {s["local_session_id"] for s in listing} == {"sess-abc", "sess-xyz"}
