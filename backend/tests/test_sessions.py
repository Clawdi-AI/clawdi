"""Session ingestion — batch create de-duplicates and respects user scope."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import httpx
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


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
async def test_session_batch_upserts_and_returns_needs_content(client: httpx.AsyncClient):
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
                "content_hash": "a" * 64,
            },
            {
                "environment_id": env_id,
                "local_session_id": "sess-xyz",
                "started_at": started,
                "message_count": 7,
                "model": "claude-sonnet-4",
                "content_hash": "b" * 64,
            },
        ]
    }
    r = await client.post("/api/sessions/batch", json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    # Both rows are brand new — no `file_key` yet, so both must be in
    # needs_content and counted as `created`.
    assert body["created"] == 2
    assert body["updated"] == 0
    assert body["unchanged"] == 0
    assert set(body["needs_content"]) == {"sess-abc", "sess-xyz"}

    # Listing the rows surfaces the metadata we just upserted.
    listing = (await client.get("/api/sessions")).json()
    assert listing["total"] == 2
    assert {s["local_session_id"] for s in listing["items"]} == {"sess-abc", "sess-xyz"}


@pytest.mark.asyncio
async def test_session_batch_unchanged_when_hash_matches_and_content_uploaded(
    client: httpx.AsyncClient,
):
    env_id = await _register_env(client)
    started = datetime.now(UTC).isoformat()
    body_bytes = b'[{"role":"user","content":"hi"}]'
    import hashlib

    expected_hash = hashlib.sha256(body_bytes).hexdigest()

    # 1. First push declares the hash; row is new, content needed.
    first = await client.post(
        "/api/sessions/batch",
        json={
            "sessions": [
                {
                    "environment_id": env_id,
                    "local_session_id": "sess-stable",
                    "started_at": started,
                    "message_count": 1,
                    "content_hash": expected_hash,
                }
            ]
        },
    )
    assert first.json()["needs_content"] == ["sess-stable"]

    # 2. Upload content. The endpoint hashes the bytes and stores it on
    # the row, so subsequent batches with the same hash will be unchanged.
    upload = await client.post(
        "/api/sessions/sess-stable/upload",
        files={"file": ("sess-stable.json", body_bytes, "application/json")},
    )
    assert upload.status_code == 200, upload.text
    assert upload.json()["content_hash"] == expected_hash

    # 3. Re-push with the same hash → unchanged, content not requested.
    second = await client.post(
        "/api/sessions/batch",
        json={
            "sessions": [
                {
                    "environment_id": env_id,
                    "local_session_id": "sess-stable",
                    "started_at": started,
                    "message_count": 1,
                    "content_hash": expected_hash,
                }
            ]
        },
    )
    body = second.json()
    assert body["unchanged"] == 1
    assert body["created"] == 0
    assert body["updated"] == 0
    assert body["needs_content"] == []


@pytest.mark.asyncio
async def test_unchanged_repush_does_not_bump_updated_at(client: httpx.AsyncClient):
    """The dashboard sorts by `updated_at`. A re-push of unchanged sessions
    (e.g. empty client cache, fresh machine restoring from cloud) must NOT
    refresh `updated_at` — that would reshuffle the entire list to
    "everything happened just now" and bury the user's actual recent work.
    """
    env_id = await _register_env(client)
    started = datetime.now(UTC).isoformat()
    body_bytes = b'[{"role":"user","content":"hi"}]'
    import asyncio
    import hashlib

    expected_hash = hashlib.sha256(body_bytes).hexdigest()

    # Initial push + content upload.
    await client.post(
        "/api/sessions/batch",
        json={
            "sessions": [
                {
                    "environment_id": env_id,
                    "local_session_id": "sess-quiet",
                    "started_at": started,
                    "message_count": 1,
                    "content_hash": expected_hash,
                }
            ]
        },
    )
    await client.post(
        "/api/sessions/sess-quiet/upload",
        files={"file": ("sess-quiet.json", body_bytes, "application/json")},
    )

    before = (await client.get("/api/sessions")).json()
    before_ts = next(
        s["updated_at"] for s in before["items"] if s["local_session_id"] == "sess-quiet"
    )

    # Sleep long enough that any wall-clock bump would be visible at
    # millisecond resolution.
    await asyncio.sleep(0.05)

    # Re-push with identical hash — server should treat as unchanged
    # and leave updated_at alone.
    await client.post(
        "/api/sessions/batch",
        json={
            "sessions": [
                {
                    "environment_id": env_id,
                    "local_session_id": "sess-quiet",
                    "started_at": started,
                    "message_count": 1,
                    "content_hash": expected_hash,
                }
            ]
        },
    )

    after = (await client.get("/api/sessions")).json()
    after_ts = next(
        s["updated_at"] for s in after["items"] if s["local_session_id"] == "sess-quiet"
    )
    assert after_ts == before_ts, "updated_at must not advance for unchanged re-push"


@pytest.mark.asyncio
async def test_session_batch_hash_change_triggers_needs_content(
    client: httpx.AsyncClient,
):
    env_id = await _register_env(client)
    started = datetime.now(UTC).isoformat()

    # Insert + upload some content.
    await client.post(
        "/api/sessions/batch",
        json={
            "sessions": [
                {
                    "environment_id": env_id,
                    "local_session_id": "sess-mut",
                    "started_at": started,
                    "message_count": 1,
                    "content_hash": "a" * 64,
                }
            ]
        },
    )
    await client.post(
        "/api/sessions/sess-mut/upload",
        files={"file": ("sess-mut.json", b'[{"role":"user","content":"v1"}]', "application/json")},
    )

    # Re-push with a DIFFERENT hash — simulates the user appending a message.
    r = await client.post(
        "/api/sessions/batch",
        json={
            "sessions": [
                {
                    "environment_id": env_id,
                    "local_session_id": "sess-mut",
                    "started_at": started,
                    "message_count": 2,
                    "content_hash": "c" * 64,
                }
            ]
        },
    )
    body = r.json()
    assert body["needs_content"] == ["sess-mut"]
    assert body["created"] == 0
    assert body["updated"] == 1
    assert body["unchanged"] == 0

    # Metadata refreshed too (message_count went 1 → 2).
    listing = (await client.get("/api/sessions")).json()
    items = {s["local_session_id"]: s for s in listing["items"]}
    assert items["sess-mut"]["message_count"] == 2
    assert items["sess-mut"]["content_hash"] == "c" * 64


@pytest.mark.asyncio
async def test_session_upload_records_content_hash_and_uploaded_at(
    client: httpx.AsyncClient,
):
    """Round-trip the upload endpoint: hash the bytes, write to the file
    store, persist the hash and timestamp on the row."""
    env_id = await _register_env(client)
    started = datetime.now(UTC).isoformat()
    await client.post(
        "/api/sessions/batch",
        json={
            "sessions": [
                {
                    "environment_id": env_id,
                    "local_session_id": "sess-up",
                    "started_at": started,
                    "message_count": 1,
                    "content_hash": "deadbeef" * 8,
                }
            ]
        },
    )

    body_bytes = b'[{"role":"user","content":"x"}]'
    r = await client.post(
        "/api/sessions/sess-up/upload",
        files={"file": ("sess-up.json", body_bytes, "application/json")},
    )
    assert r.status_code == 200, r.text
    payload = r.json()

    import hashlib

    assert payload["content_hash"] == hashlib.sha256(body_bytes).hexdigest()
    assert payload["status"] == "uploaded"
    assert payload["file_key"].startswith("sessions/")


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


@pytest.mark.asyncio
async def test_delete_environment_orphans_sessions_via_fk(
    client: httpx.AsyncClient, db_session: AsyncSession
):
    """Deleting an environment must keep historical sessions but null out
    the FK so the list query renders them as unlabeled — never 500.
    The FK + ON DELETE SET NULL is what makes this safe under concurrent
    deletion (the previous SELECT-then-INSERT race could create orphans
    that violated invariants the codebase implicitly relied on).

    This test asserts at *both* layers:
      1. HTTP — the dashboard list endpoint returns the row with null
         agent label (could pass without an FK, just via outerjoin).
      2. Raw SQL — `sessions.environment_id IS NULL` after delete. This
         is what proves `ON DELETE SET NULL` actually fired; without the
         FK the column would still hold the deleted UUID."""
    env_id = await _register_env(client)
    started = datetime.now(UTC).isoformat()
    await client.post(
        "/api/sessions/batch",
        json={
            "sessions": [
                {
                    "environment_id": env_id,
                    "local_session_id": "keep-me",
                    "started_at": started,
                    "message_count": 1,
                    "summary": "should survive deletion",
                }
            ]
        },
    )

    r = await client.delete(f"/api/environments/{env_id}")
    assert r.status_code == 204, r.text

    listing = (await client.get("/api/sessions")).json()
    assert listing["total"] == 1
    item = listing["items"][0]
    assert item["local_session_id"] == "keep-me"
    assert item["agent_type"] is None
    assert item["machine_name"] is None

    # The decisive check: after the DELETE, the session's environment_id
    # column is NULL (not the deleted UUID). This only happens because the
    # FK has ON DELETE SET NULL — without the constraint, the column would
    # still hold the now-dangling reference. Filter by the deleted env_id
    # so prior test runs (the test DB doesn't fully clean between runs)
    # don't pollute the count.
    row = (
        await db_session.execute(
            text(
                "SELECT environment_id FROM sessions "
                "WHERE local_session_id = :sid "
                "ORDER BY created_at DESC LIMIT 1"
            ),
            {"sid": "keep-me"},
        )
    ).one()
    assert row.environment_id is None


@pytest.mark.asyncio
async def test_delete_environment_404_for_unknown(client: httpx.AsyncClient):
    r = await client.delete(f"/api/environments/{uuid.uuid4()}")
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# POST /api/sessions/{local_session_id}/extract
# ---------------------------------------------------------------------------


async def _seed_session_with_content(
    client: httpx.AsyncClient, local_id: str, *, content: bytes | None = None
) -> str:
    """Register env + create a session row + upload content. Returns
    `local_session_id` (path key for the extract endpoint)."""
    env_id = await _register_env(client)
    started = datetime.now(UTC).isoformat()
    await client.post(
        "/api/sessions/batch",
        json={
            "sessions": [
                {
                    "environment_id": env_id,
                    "local_session_id": local_id,
                    "started_at": started,
                    "message_count": 2,
                    "content_hash": "c" * 64,
                }
            ]
        },
    )
    body = content or b'[{"role":"user","content":"hi"},{"role":"assistant","content":"hello"}]'
    await client.post(
        f"/api/sessions/{local_id}/upload",
        files={"file": (f"{local_id}.json", body, "application/json")},
    )
    return local_id


@pytest.mark.asyncio
async def test_extract_creates_memories_linked_to_session(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
):
    """Happy path: stub the LLM call to return 2 memories; assert they
    land in the DB with `source="session"` and `source_session_id` set."""
    from app.core.config import settings as app_settings
    from app.models.memory import Memory
    from app.services import memory_extraction

    monkeypatch.setattr(app_settings, "llm_api_key", "test-key")

    async def fake_extract(messages, *, project_path, client, model):
        return [
            memory_extraction.ExtractedMemory(
                content="User prefers bun over npm", category="preference", tags=["tooling"]
            ),
            memory_extraction.ExtractedMemory(
                content="Adopted Drizzle for type inference", category="decision", tags=[]
            ),
        ]

    monkeypatch.setattr(
        "app.routes.sessions.extract_memories_from_session", fake_extract
    )

    local_id = "sess-extract-1"
    await _seed_session_with_content(client, local_id)

    r = await client.post(f"/api/sessions/{local_id}/extract")
    assert r.status_code == 200, r.text
    assert r.json() == {"memories_created": 2}

    # Verify the rows landed with the right source + linkage.
    # Scope the lookup to this test's user — Memory has no FK cascade so
    # rows from other tests can outlive their user fixture.
    from sqlalchemy import select

    rows = (
        await db_session.execute(select(Memory).where(Memory.user_id == seed_user.id))
    ).scalars().all()
    assert len(rows) == 2
    assert {m.source for m in rows} == {"session"}
    assert all(m.source_session_id is not None for m in rows)
    contents = {m.content for m in rows}
    assert "User prefers bun over npm" in contents


@pytest.mark.asyncio
async def test_extract_503_when_not_configured(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    """503 with a clear hint when the deployment hasn't supplied an LLM
    key — onboarding skill watches for this to skip the step cleanly."""
    from app.core.config import settings as app_settings

    monkeypatch.setattr(app_settings, "llm_api_key", "")

    local_id = "sess-extract-noconf"
    await _seed_session_with_content(client, local_id)

    r = await client.post(f"/api/sessions/{local_id}/extract")
    assert r.status_code == 503
    assert "not configured" in r.json()["detail"].lower()
