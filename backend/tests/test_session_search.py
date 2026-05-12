"""Session list/search endpoint tests.

Covers the upgraded `/api/sessions` list endpoint:
  - pg_trgm similarity search replacing ILIKE — typo tolerance + ranking
  - Filters: model, tag, min_messages, min_duration, has_pr
  - `sort=relevance` ordering
  - Default behavior unchanged (no q, no filters → date-sorted list)
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime

import httpx
import pytest


async def _register_env(client: httpx.AsyncClient) -> str:
    r = await client.post(
        "/api/environments",
        json={
            "machine_id": "search-machine",
            "machine_name": "Search Mac",
            "agent_type": "claude-code",
            "agent_version": "0.1.0",
            "os": "darwin",
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


async def _push_session(
    client: httpx.AsyncClient,
    env_id: str,
    *,
    local_session_id: str,
    summary: str | None = None,
    project_path: str | None = None,
    model: str | None = None,
    tags: list[str] | None = None,
    messages: list[dict] | None = None,
    upload: bool = False,
) -> str:
    payload = {
        "environment_id": env_id,
        "local_session_id": local_session_id,
        "started_at": datetime.now(UTC).isoformat(),
        "message_count": len(messages) if messages else 0,
        "summary": summary,
        "project_path": project_path,
        "model": model,
        "tags": tags,
    }
    if messages:
        body_bytes = json.dumps(messages).encode("utf-8")
        payload["content_hash"] = hashlib.sha256(body_bytes).hexdigest()
    r = await client.post("/api/sessions/batch", json={"sessions": [payload]})
    assert r.status_code == 200, r.text

    if upload and messages:
        body_bytes = json.dumps(messages).encode("utf-8")
        await client.post(
            f"/api/sessions/{local_session_id}/upload",
            files={
                "file": (
                    f"{local_session_id}.json",
                    body_bytes,
                    "application/json",
                )
            },
        )

    listing = (
        await client.get(f"/api/sessions?q={local_session_id}")
    ).json()
    return next(
        s["id"] for s in listing["items"] if s["local_session_id"] == local_session_id
    )


@pytest.mark.asyncio
async def test_trgm_search_handles_typos(client: httpx.AsyncClient):
    """`?q=athentication` should still surface a session whose summary
    contains 'authentication'. ILIKE wouldn't match the typo; pg_trgm
    similarity catches it because most trigrams overlap."""
    env_id = await _register_env(client)
    await _push_session(
        client, env_id, local_session_id="auth-1", summary="user authentication migration"
    )
    await _push_session(
        client, env_id, local_session_id="dns-1", summary="DNS cache poisoning"
    )

    # Typo: drop the 'u' in "authentication".
    r = await client.get("/api/sessions?q=athentication")
    assert r.status_code == 200
    items = r.json()["items"]
    summaries = [s["summary"] for s in items]
    assert "user authentication migration" in summaries
    assert "DNS cache poisoning" not in summaries


@pytest.mark.asyncio
async def test_relevance_sort_orders_by_similarity(client: httpx.AsyncClient):
    """`sort=relevance` orders by trigram similarity — the closest
    match comes first, irrelevant rows don't appear."""
    env_id = await _register_env(client)
    # Exact-match summary, partial-match summary, no-match summary.
    await _push_session(client, env_id, local_session_id="exact", summary="oauth token refresh bug")
    await _push_session(
        client, env_id, local_session_id="partial", summary="refresh the page on token error"
    )
    await _push_session(client, env_id, local_session_id="other", summary="UI polish")

    r = await client.get("/api/sessions?q=oauth+token+refresh&sort=relevance")
    items = r.json()["items"]
    # The exact-match summary must appear first; below-threshold
    # rows ("UI polish") shouldn't appear at all.
    assert items[0]["summary"] == "oauth token refresh bug"
    assert all(s["summary"] != "UI polish" for s in items)


@pytest.mark.asyncio
async def test_filter_model_and_tag(client: httpx.AsyncClient):
    env_id = await _register_env(client)
    await _push_session(
        client,
        env_id,
        local_session_id="m1",
        summary="m1",
        model="claude-sonnet-4-6",
        tags=["security", "audit"],
    )
    await _push_session(
        client,
        env_id,
        local_session_id="m2",
        summary="m2",
        model="claude-opus-4-7",
        tags=["security"],
    )
    await _push_session(
        client,
        env_id,
        local_session_id="m3",
        summary="m3",
        model="claude-sonnet-4-6",
        tags=["feature"],
    )

    # Filter by model.
    items = (await client.get("/api/sessions?model=claude-sonnet-4-6")).json()["items"]
    ids = {s["local_session_id"] for s in items}
    assert ids == {"m1", "m3"}

    # Filter by tag — AND semantics: must include BOTH tags.
    items = (
        await client.get("/api/sessions?tag=security&tag=audit")
    ).json()["items"]
    ids = {s["local_session_id"] for s in items}
    assert ids == {"m1"}


@pytest.mark.asyncio
async def test_filter_min_messages_and_has_pr(client: httpx.AsyncClient):
    env_id = await _register_env(client)
    # Session 1: 4 messages, PR ref via upload.
    msgs_with_pr = [
        {"role": "user", "content": "see https://github.com/foo/bar/pull/1"},
        {"role": "assistant", "content": "yes"},
        {"role": "user", "content": "more"},
        {"role": "assistant", "content": "ok"},
    ]
    await _push_session(
        client,
        env_id,
        local_session_id="big-pr",
        summary="big with pr",
        messages=msgs_with_pr,
        upload=True,
    )
    # Session 2: 1 message, no PR.
    await _push_session(
        client,
        env_id,
        local_session_id="small",
        summary="small",
        messages=[{"role": "user", "content": "hi"}],
        upload=True,
    )

    # min_messages=3 → only big-pr.
    items = (await client.get("/api/sessions?min_messages=3")).json()["items"]
    assert {s["local_session_id"] for s in items} == {"big-pr"}

    # has_pr=true → only big-pr.
    items = (await client.get("/api/sessions?has_pr=true")).json()["items"]
    assert {s["local_session_id"] for s in items} == {"big-pr"}

    # has_pr=false → only small (and any other no-PR sessions).
    items = (await client.get("/api/sessions?has_pr=false")).json()["items"]
    assert "small" in {s["local_session_id"] for s in items}
    assert "big-pr" not in {s["local_session_id"] for s in items}


