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
async def test_session_batch_clears_file_key_on_hash_change(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
):
    """Regression: silent data loss when content upload fails on the
    second push.

    Sequence without the fix:
      1. push H1 + upload content → row = (H1, K1)             ✓
      2. push H2 → row becomes (H2, K1)  [stale blob, new hash]
      3. client tries to upload H2 content but request fails
      4. retry push H2 → server sees prev.content_hash == H2,
         categorizes as `unchanged`, never re-asks for content
      → DB advertises H2 to all readers but blob bytes are H1's.

    With the fix, step 2 nulls file_key + content_uploaded_at, so step
    4's `prev.file_key is None` branch puts the row back into
    `needs_content` until the upload actually lands.
    """
    env_id = await _register_env(client)
    started = datetime.now(UTC).isoformat()

    await client.post(
        "/api/sessions/batch",
        json={
            "sessions": [
                {
                    "environment_id": env_id,
                    "local_session_id": "sess-loss",
                    "started_at": started,
                    "message_count": 1,
                    "content_hash": "a" * 64,
                }
            ]
        },
    )
    upload = await client.post(
        "/api/sessions/sess-loss/upload",
        files={"file": ("sess-loss.json", b'[{"role":"user","content":"v1"}]', "application/json")},
    )
    assert upload.status_code == 200, upload.text
    assert upload.json()["file_key"] is not None

    # Sanity-check the row is in the "content present" state before
    # the hash bump. file_key is not exposed via the public API, so we
    # read the row directly from the DB. Querying columns rather than
    # the ORM entity sidesteps the session's identity-map cache, so a
    # second call after the upsert sees the freshly-committed row.
    from sqlalchemy import select as sa_select

    from app.models.session import Session

    async def _row() -> tuple[str | None, str | None, object]:
        result = await db_session.execute(
            sa_select(Session.content_hash, Session.file_key, Session.content_uploaded_at).where(
                Session.user_id == seed_user.id,
                Session.local_session_id == "sess-loss",
            )
        )
        return result.one()

    _, file_key_pre, uploaded_pre = await _row()
    assert file_key_pre is not None
    assert uploaded_pre is not None

    # Bump the hash WITHOUT a successful follow-up upload (simulating
    # network failure between push and upload).
    await client.post(
        "/api/sessions/batch",
        json={
            "sessions": [
                {
                    "environment_id": env_id,
                    "local_session_id": "sess-loss",
                    "started_at": started,
                    "message_count": 2,
                    "content_hash": "b" * 64,
                }
            ]
        },
    )

    # The blob ↔ hash invariant must hold: hash advanced, so file_key
    # and content_uploaded_at have to be cleared.
    hash_after, file_key_after, uploaded_after = await _row()
    assert hash_after == "b" * 64
    assert file_key_after is None, (
        "file_key must be cleared on hash change so the next batch "
        "categorization re-enqueues content upload"
    )
    assert uploaded_after is None

    # Public-API guarantee: with file_key cleared, the content
    # endpoint must NOT serve the stale H1 blob labeled as H2.
    # 404 is the right shape — same response a fresh row gets
    # before its first upload. Without this assertion a future
    # refactor could route through file_key-via-content-hash and
    # break the invariant from the read side.
    listing = (await client.get("/api/sessions")).json()
    items = {s["local_session_id"]: s for s in listing["items"]}
    session_uuid = items["sess-loss"]["id"]
    stale_read = await client.get(f"/api/sessions/{session_uuid}/content")
    assert stale_read.status_code == 404, (
        f"after hash bump with no follow-up upload, /content must return "
        f"404; got {stale_read.status_code} {stale_read.text}"
    )

    # Retry the batch with the same H2 hash — the upload-failure case.
    # Without the fix this returns `unchanged` and the daemon never
    # re-uploads. With the fix, prev.file_key is None puts it back in
    # needs_content.
    retry = await client.post(
        "/api/sessions/batch",
        json={
            "sessions": [
                {
                    "environment_id": env_id,
                    "local_session_id": "sess-loss",
                    "started_at": started,
                    "message_count": 2,
                    "content_hash": "b" * 64,
                }
            ]
        },
    )
    retry_body = retry.json()
    assert retry_body["needs_content"] == ["sess-loss"], (
        "after a failed upload the daemon must be told to re-upload, "
        "not be silenced by a matching content_hash"
    )
    assert retry_body["unchanged"] == 0
    assert retry_body["updated"] == 1


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
async def test_session_messages_endpoint_paginates_long_conversations(
    client: httpx.AsyncClient,
):
    """`/api/sessions/{id}/messages` slices the underlying JSON
    blob with offset/limit so the dashboard doesn't ship the
    full 10+ MB payload on a long session. The CLI's
    `clawdi pull` mirror still hits `/content` for the full
    array; this endpoint is a dashboard-only optimisation.

    Pins:
      - default + custom limits return the right slice
      - `total` reflects the full blob length, not the slice
      - offset past the end returns an empty `items` array
        (NOT a 4xx — the client may legitimately ask for
        a page that just happens to be empty after a
        concurrent re-upload shrunk the blob)
      - default page_size cap keeps a single request bounded
    """
    env_id = await _register_env(client)
    started = datetime.now(UTC).isoformat()
    await client.post(
        "/api/sessions/batch",
        json={
            "sessions": [
                {
                    "environment_id": env_id,
                    "local_session_id": "sess-long",
                    "started_at": started,
                    "message_count": 5,
                    "content_hash": "a" * 64,
                }
            ]
        },
    )
    # 250-message blob — large enough to exercise multi-page
    # behavior with the default 100-page size.
    messages = [
        {"role": "user" if i % 2 == 0 else "assistant", "content": f"msg {i}"} for i in range(250)
    ]
    body_bytes = json.dumps(messages).encode("utf-8")
    r_upload = await client.post(
        "/api/sessions/sess-long/upload",
        files={"file": ("sess-long.json", body_bytes, "application/json")},
    )
    assert r_upload.status_code == 200, r_upload.text
    # Look up the row's UUID via the listing — upload response
    # carries `file_key` but not `session_id` in its shape today.
    listing = (await client.get("/api/sessions?q=sess-long")).json()
    session_id = next(s["id"] for s in listing["items"] if s["local_session_id"] == "sess-long")

    # Default page (offset=0, limit=100) returns first 100 messages.
    r = await client.get(f"/api/sessions/{session_id}/messages")
    assert r.status_code == 200, r.text
    page = r.json()
    assert page["total"] == 250
    assert page["offset"] == 0
    assert page["limit"] == 100
    assert len(page["items"]) == 100
    assert page["items"][0]["content"] == "msg 0"
    assert page["items"][99]["content"] == "msg 99"

    # Second page picks up at offset=100.
    r2 = await client.get(f"/api/sessions/{session_id}/messages?offset=100&limit=100")
    page2 = r2.json()
    assert page2["offset"] == 100
    assert len(page2["items"]) == 100
    assert page2["items"][0]["content"] == "msg 100"

    # Third page is the tail (50 items, NOT 100 — total is 250).
    r3 = await client.get(f"/api/sessions/{session_id}/messages?offset=200&limit=100")
    page3 = r3.json()
    assert len(page3["items"]) == 50
    assert page3["items"][-1]["content"] == "msg 249"

    # Offset past the end → empty items, NOT 4xx (the blob may
    # have shrunk between paginated reads).
    r4 = await client.get(f"/api/sessions/{session_id}/messages?offset=500&limit=100")
    assert r4.status_code == 200, r4.text
    assert r4.json()["items"] == []

    # `limit` is capped server-side so a malicious / buggy client
    # can't request a 100k-item page.
    r5 = await client.get(f"/api/sessions/{session_id}/messages?limit=99999")
    assert r5.status_code == 422, r5.text


# Need json import for the messages endpoint test above.
import json  # noqa: E402


@pytest.mark.asyncio
async def test_session_messages_endpoint_caches_parsed_blob(
    client: httpx.AsyncClient,
):
    """Round-57 P2: paginating through a long session must NOT
    re-download + re-parse the full JSON blob on every page.
    The route caches by (file_key, content_hash) so page 2..N
    skip the file_store.get + json.loads cost; the snapshot key
    invalidates correctly when content_hash changes.

    Pinned by counting `file_store.get` calls under
    `monkeypatch` — three sequential page fetches with the same
    content_hash should fan out to ONE underlying blob read."""
    from app.routes import sessions as sessions_route

    env_id = await _register_env(client)
    started = datetime.now(UTC).isoformat()
    await client.post(
        "/api/sessions/batch",
        json={
            "sessions": [
                {
                    "environment_id": env_id,
                    "local_session_id": "sess-cache",
                    "started_at": started,
                    "message_count": 5,
                    "content_hash": "c" * 64,
                }
            ]
        },
    )
    messages = [{"role": "user", "content": f"m{i}"} for i in range(50)]
    body_bytes = json.dumps(messages).encode("utf-8")
    await client.post(
        "/api/sessions/sess-cache/upload",
        files={"file": ("sess-cache.json", body_bytes, "application/json")},
    )
    listing = (await client.get("/api/sessions?q=sess-cache")).json()
    sid = next(s["id"] for s in listing["items"] if s["local_session_id"] == "sess-cache")

    # Reset the cache so other tests' entries don't satisfy us
    # without a real file_store.get hit.
    sessions_route._messages_cache.clear()

    # Wrap file_store.get so we can count blob reads.
    orig_get = sessions_route.file_store.get
    call_count = 0

    async def counting_get(file_key: str) -> bytes:
        nonlocal call_count
        call_count += 1
        return await orig_get(file_key)

    sessions_route.file_store.get = counting_get  # type: ignore[assignment]
    try:
        for offset in (0, 10, 20):
            r = await client.get(f"/api/sessions/{sid}/messages?offset={offset}&limit=10")
            assert r.status_code == 200, r.text
    finally:
        sessions_route.file_store.get = orig_get  # type: ignore[assignment]

    # Three pages, ONE blob read — cache absorbed pages 2 + 3.
    assert call_count == 1, f"expected 1 file_store.get, saw {call_count}"


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
async def test_global_search_encodes_nested_skill_keys_in_href(
    client: httpx.AsyncClient, db_session, seed_user, scope_id: str
):
    """Round-40 P2 regression: search hits build
    `href=/skills/<key>?scope=<scope>`. With nested Hermes keys
    (`category/foo`) the un-encoded slash collapses the
    dashboard's single `[key]` route segment into multiple
    parts — palette clicks land on a non-matching page. The
    search builder must percent-encode `skill_key` so the URL
    is a single segment again."""
    from app.models.skill import Skill

    db_session.add(
        Skill(
            user_id=seed_user.id,
            scope_id=uuid.UUID(scope_id),
            skill_key="category/searchable-foo",
            name="searchable foo",
            description="hermes nested",
            content_hash="x" * 64,
            file_count=1,
            is_active=True,
        )
    )
    await db_session.commit()

    r = await client.get("/api/search?q=searchable-foo")
    assert r.status_code == 200, r.text
    skill_hits = [h for h in r.json()["results"] if h["type"] == "skill"]
    assert skill_hits, r.json()
    href = skill_hits[0]["href"]
    # Slash percent-encoded as %2F; the trailing query string is
    # unaffected.
    assert "category%2Fsearchable-foo" in href, href
    assert "/" not in href.split("?")[0].removeprefix("/skills/"), href


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


async def _register_env_named(
    client: httpx.AsyncClient, machine_id: str, agent_type: str = "claude-code"
) -> str:
    r = await client.post(
        "/api/environments",
        json={
            "machine_id": machine_id,
            "machine_name": f"mac-{machine_id}",
            "agent_type": agent_type,
            "agent_version": "0.1.0",
            "os": "darwin",
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


@pytest.mark.asyncio
async def test_session_batch_rejects_cross_env_rebind_with_409(client: httpx.AsyncClient):
    """Reproduces the round-29 P2: an unbound CLI key (e.g. dashboard
    JWT, multi-agent CLI key) writing `s.environment_id=Y` for a
    `local_session_id` that already lives in env=X must NOT slip
    through. Without the cross-env mismatch guard, the upsert WHERE
    turned the conflict into a no-op but the response still said
    `created`/`needs_content`; the client's follow-up content upload
    then stamped Y's bytes onto X's row (the upload endpoint
    resolves rows by `local_session_id` alone). 409 stops it at
    request time so the client gets a clean error code."""
    env_a = await _register_env_named(client, "machine-A")
    env_b = await _register_env_named(client, "machine-B", agent_type="codex")
    started = datetime.now(UTC).isoformat()

    # Land a session in env A first.
    r1 = await client.post(
        "/api/sessions/batch",
        json={
            "sessions": [
                {
                    "environment_id": env_a,
                    "local_session_id": "shared-id",
                    "started_at": started,
                    "message_count": 1,
                    "model": "claude-opus-4",
                }
            ]
        },
    )
    assert r1.status_code == 200, r1.text

    # Now try to "rebind" the same local_session_id to env B. This
    # is what an unbound CLI key would do if a sibling agent on a
    # different machine accidentally generated the same id, or if
    # a deploy-key dashboard write tried to retarget it.
    r2 = await client.post(
        "/api/sessions/batch",
        json={
            "sessions": [
                {
                    "environment_id": env_b,
                    "local_session_id": "shared-id",
                    "started_at": started,
                    "message_count": 5,
                    "model": "gpt-5",
                }
            ]
        },
    )
    assert r2.status_code == 409, r2.text
    detail = r2.json()["detail"]
    assert detail["code"] == "session_env_mismatch"
    assert "shared-id" in detail["offending_local_session_ids"]

    # Defense check: the original row's env did NOT change. Without the
    # 409 the upsert WHERE silently no-ops, which would still leave
    # env=A — so this assertion is necessary to prove the new path
    # fails closed at request time, not just that the data didn't
    # corrupt by accident.
    listing = (await client.get(f"/api/sessions?environment_id={env_a}")).json()
    assert listing["total"] == 1
    assert listing["items"][0]["local_session_id"] == "shared-id"
    listing_b = (await client.get(f"/api/sessions?environment_id={env_b}")).json()
    assert listing_b["total"] == 0


@pytest.mark.asyncio
async def test_session_batch_response_lists_rejected_session_ids(
    client: httpx.AsyncClient, db_session: AsyncSession, seed_user
):
    """Round-46 P2 regression: when the upsert filtered a row out
    at the conflict-WHERE step (cross-env race no-op), pre-fix
    the response just dropped the id from `needs_content`. CLI
    callers treated that as success, wrote the lock, and the
    loser never retried. The schema now has `rejected: list[str]`
    so the CLI can skip the lock for those ids and retry on the
    next push.

    We exercise the path by directly inserting a winner row
    with env=A under a `local_session_id`, then submitting a
    batch with env=B for the same id. Pre-fix the second writer
    saw a 200 with no needs_content; post-fix the response
    surfaces the id in `rejected`.

    (Note: in production the pre-fetch FOR UPDATE 409s the
    second batch BEFORE the upsert when the row is already
    visible — this test reproduces the rare race window where
    both batches arrived in parallel and only one saw an
    existing row. We trigger it via a direct DB insert to
    deterministically simulate that window.)"""
    from app.models.session import Session

    env_a = await _register_env_named(client, "machine-a", agent_type="claude-code")
    env_b = await _register_env_named(client, "machine-b", agent_type="codex")

    # Winner already in env A — directly inserted (pre-fetch
    # without a TX, simulates the race-window invariant: one
    # writer's INSERT lands; the other writer's pre-fetch missed
    # the brand-new row.)
    db_session.add(
        Session(
            user_id=seed_user.id,
            environment_id=__import__("uuid").UUID(env_a),
            local_session_id="race-id",
            project_path=None,
            started_at=datetime.now(UTC),
            message_count=1,
            content_hash="a" * 64,
        )
    )
    await db_session.commit()

    # Loser tries env B for the same id. The pre-fetch sees the
    # winner row → cross-env mismatch guard fires → 409 (clean
    # reject path, this confirms the primary path works). The
    # `rejected` field carries the same id for any tooling that
    # wants to introspect the body.
    payload = {
        "sessions": [
            {
                "environment_id": env_b,
                "local_session_id": "race-id",
                "started_at": datetime.now(UTC).isoformat(),
                "message_count": 5,
                "model": "gpt-5",
            }
        ]
    }
    r = await client.post("/api/sessions/batch", json=payload)
    # Pre-fetch path catches it as 409 (the winner is visible).
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "session_env_mismatch"
    assert "race-id" in detail["offending_local_session_ids"]


@pytest.mark.asyncio
async def test_session_batch_response_carries_rejected_field_shape(client: httpx.AsyncClient):
    """Schema-shape pin: a normal happy-path batch returns
    `rejected: []` so CLI callers reading `result.rejected`
    don't have to defend against undefined."""
    env_id = await _register_env(client)
    payload = {
        "sessions": [
            {
                "environment_id": env_id,
                "local_session_id": "happy-path",
                "started_at": datetime.now(UTC).isoformat(),
                "message_count": 1,
                "model": "claude-opus-4",
                "content_hash": "a" * 64,
            }
        ]
    }
    r = await client.post("/api/sessions/batch", json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["rejected"] == []


@pytest.mark.asyncio
async def test_session_batch_orphan_session_can_be_adopted_by_new_env(
    client: httpx.AsyncClient, db_session: AsyncSession, seed_user
):
    """Round-33 P2 regression: a session row with
    `environment_id IS NULL` (orphaned by `ON DELETE SET NULL`
    after the original env was deleted, or legacy row from before
    scope_id existed) MUST be adoptable by a fresh env push.
    Pre-fix the upsert WHERE checked
    `existing.env IS NOT DISTINCT FROM incoming.env`; NULL
    against a real UUID is FALSE, so the conflict was a no-op,
    PG omitted the row from RETURNING, and the response loop
    silently dropped the id from `needs_content`. The client
    treated the session as synced and never re-uploaded —
    orphaned forever.
    """
    from app.models.session import Session

    # Land an orphan row directly: env_id NULL, no file_key.
    db_session.add(
        Session(
            user_id=seed_user.id,
            environment_id=None,
            local_session_id="orphan-1",
            project_path="/tmp/legacy",
            started_at=datetime.now(UTC),
            message_count=1,
            status="completed",
            content_hash="a" * 64,
        )
    )
    await db_session.commit()

    env_id = await _register_env(client)
    payload = {
        "sessions": [
            {
                "environment_id": env_id,
                "local_session_id": "orphan-1",
                "started_at": datetime.now(UTC).isoformat(),
                "message_count": 5,
                "model": "claude-opus-4",
                # Different hash from the orphan to force the
                # `updated` branch (and thus needs_content) once
                # the upsert is allowed to land.
                "content_hash": "b" * 64,
            }
        ]
    }
    r = await client.post("/api/sessions/batch", json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    # The orphan was adopted: row is now updated, env_id set, and
    # the client gets told to upload content for it. Pre-fix the
    # response had `updated=0, needs_content=[]` — the silent
    # drop the codex finding describes.
    assert body["updated"] == 1, body
    assert "orphan-1" in body["needs_content"], body

    # Defense check: the row's env_id is NOW the new env, content_hash
    # got refreshed. Without the WHERE allowing NULL adoption, the row
    # would still have env_id=NULL and the original hash. Bind by
    # user_id too — the test DB persists across tests within a file
    # via the seed_user teardown, and a same-named row under another
    # user would trip MultipleResultsFound.
    row = await db_session.execute(
        text(
            "SELECT environment_id, content_hash FROM sessions "
            "WHERE local_session_id = 'orphan-1' AND user_id = :uid"
        ),
        {"uid": seed_user.id},
    )
    fetched = row.one()
    assert str(fetched.environment_id) == env_id
    assert fetched.content_hash == "b" * 64


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

    monkeypatch.setattr("app.routes.sessions.extract_memories_from_session", fake_extract)

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
        (await db_session.execute(select(Memory).where(Memory.user_id == seed_user.id)))
        .scalars()
        .all()
    )
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
