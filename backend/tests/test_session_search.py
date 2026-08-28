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
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.session import Session, SessionMessageSearch
from app.services.session_search import (
    SearchableSessionMessage,
    rebuild_session_search_index,
    replace_snapshot_search_index,
)


async def _register_env(client: httpx.AsyncClient) -> str:
    r = await client.post(
        "/v1/environments",
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
    r = await client.post("/v1/sessions/batch", json={"sessions": [payload]})
    assert r.status_code == 200, r.text

    if upload and messages:
        body_bytes = json.dumps(messages).encode("utf-8")
        uploaded = await client.post(
            f"/v1/sessions/{local_session_id}/upload",
            files={
                "file": (
                    f"{local_session_id}.json",
                    body_bytes,
                    "application/json",
                )
            },
        )
        assert uploaded.status_code == 200, uploaded.text

    listing = (await client.get(f"/v1/sessions?q={local_session_id}")).json()
    return next(s["id"] for s in listing["items"] if s["local_session_id"] == local_session_id)


@pytest.mark.asyncio
async def test_trgm_search_handles_typos(client: httpx.AsyncClient):
    """`?q=athentication` should still surface a session whose summary
    contains 'authentication'. ILIKE wouldn't match the typo; pg_trgm
    similarity catches it because most trigrams overlap."""
    env_id = await _register_env(client)
    await _push_session(
        client, env_id, local_session_id="auth-1", summary="user authentication migration"
    )
    await _push_session(client, env_id, local_session_id="dns-1", summary="DNS cache poisoning")

    # Typo: drop the 'u' in "authentication".
    r = await client.get("/v1/sessions?q=athentication")
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

    r = await client.get("/v1/sessions?q=oauth+token+refresh&sort=relevance")
    items = r.json()["items"]
    # The exact-match summary must appear first; below-threshold
    # rows ("UI polish") shouldn't appear at all.
    assert items[0]["summary"] == "oauth token refresh bug"
    assert all(s["summary"] != "UI polish" for s in items)


@pytest.mark.asyncio
async def test_snapshot_message_search_tracks_current_content_and_escapes_wildcards(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    from app.routes import sessions as session_routes

    env_id = await _register_env(client)
    local_id = "snapshot-body-search"
    original = [
        {
            "role": "assistant",
            "content": "Original needle\x00%_ and slash\\needle stay literal",
        }
    ]
    session_id = await _push_session(
        client,
        env_id,
        local_session_id=local_id,
        messages=original,
        upload=True,
    )
    await _push_session(
        client,
        env_id,
        local_session_id="snapshot-body-search-decoy",
        messages=[{"role": "user", "content": "A separate ordinary message"}],
        upload=True,
    )

    matched = (await client.get("/v1/sessions", params={"q": "Original needle"})).json()
    assert [item["local_session_id"] for item in matched["items"]] == [local_id]
    assert matched["items"][0]["search_match"] == {
        "role": "assistant",
        "excerpt": original[0]["content"].replace("\x00", "\ufffd"),
        "anchor": {
            "kind": "snapshot_offset",
            "position": 0,
            "revision": (
                "snapshot:" + hashlib.sha256(json.dumps(original).encode("utf-8")).hexdigest()
            ),
        },
    }
    fuzzy = (await client.get("/v1/sessions", params={"q": "Orginal needle"})).json()
    assert [item["local_session_id"] for item in fuzzy["items"]] == [local_id]
    literal = (await client.get("/v1/sessions", params={"q": "%_"})).json()
    assert [item["local_session_id"] for item in literal["items"]] == [local_id]
    backslash = (await client.get("/v1/sessions", params={"q": "slash\\needle"})).json()
    assert [item["local_session_id"] for item in backslash["items"]] == [local_id]
    stored = await client.get(f"/v1/sessions/{session_id}/messages")
    assert stored.status_code == 200, stored.text
    assert stored.json()["items"][0]["content"] == original[0]["content"]

    replacement = [{"role": "user", "content": "Replacement body is now authoritative"}]
    await _push_session(
        client,
        env_id,
        local_session_id=local_id,
        messages=replacement,
        upload=False,
    )
    stale = (await client.get("/v1/sessions", params={"q": "Original needle"})).json()
    assert all(item["search_match"] is None for item in stale["items"])

    await _push_session(
        client,
        env_id,
        local_session_id=local_id,
        messages=replacement,
        upload=True,
    )
    current = (await client.get("/v1/sessions", params={"q": "authoritative"})).json()
    assert [item["local_session_id"] for item in current["items"]] == [local_id]
    assert current["items"][0]["search_match"] == {
        "role": "user",
        "excerpt": replacement[0]["content"],
        "anchor": {
            "kind": "snapshot_offset",
            "position": 0,
            "revision": (
                "snapshot:" + hashlib.sha256(json.dumps(replacement).encode("utf-8")).hexdigest()
            ),
        },
    }

    session = (
        await db_session.execute(select(Session).where(Session.local_session_id == local_id))
    ).scalar_one()
    await db_session.execute(
        delete(SessionMessageSearch).where(SessionMessageSearch.session_id == session.id)
    )
    session.search_index_revision = None
    await db_session.commit()
    await rebuild_session_search_index(db_session, session, session_routes.file_store)
    await db_session.commit()
    rebuilt = (await client.get("/v1/sessions", params={"q": "authoritative"})).json()
    assert [item["local_session_id"] for item in rebuilt["items"]] == [local_id]


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_rebuild_does_not_replace_a_newer_revision_after_object_read(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    engine,
) -> None:
    env_id = await _register_env(client)
    local_id = "snapshot-search-rebuild-race"
    original = [{"role": "user", "content": "old backfill content"}]
    await _push_session(
        client,
        env_id,
        local_session_id=local_id,
        messages=original,
        upload=True,
    )
    session = (
        await db_session.execute(select(Session).where(Session.local_session_id == local_id))
    ).scalar_one()
    session.search_index_revision = None
    await db_session.commit()

    replacement_content = "new upload remains searchable"
    replacement = [
        SearchableSessionMessage(position=0, role="assistant", content=replacement_content)
    ]
    replacement_hash = hashlib.sha256(
        json.dumps([{"role": "assistant", "content": replacement_content}]).encode("utf-8")
    ).hexdigest()
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    class RacingFileStore:
        async def get(self, _key: str) -> bytes:
            async with session_factory() as writer:
                current = (
                    await writer.execute(
                        select(Session).where(Session.id == session.id).with_for_update()
                    )
                ).scalar_one()
                current.content_hash = replacement_hash
                await replace_snapshot_search_index(
                    writer,
                    current,
                    replacement_hash,
                    replacement,
                )
                await writer.commit()
            return json.dumps(original).encode("utf-8")

    async with session_factory() as backfill_db:
        stale = await backfill_db.get(Session, session.id)
        assert stale is not None
        rebuilt = await rebuild_session_search_index(backfill_db, stale, RacingFileStore())
        await backfill_db.commit()
    assert rebuilt is False

    async with session_factory() as verification_db:
        current = await verification_db.get(Session, session.id)
        documents = list(
            (
                await verification_db.execute(
                    select(SessionMessageSearch.content).where(
                        SessionMessageSearch.session_id == session.id
                    )
                )
            ).scalars()
        )
    assert current is not None
    assert current.search_index_revision == f"snapshot:{replacement_hash}"
    assert documents == [replacement_content]


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
    items = (await client.get("/v1/sessions?model=claude-sonnet-4-6")).json()["items"]
    ids = {s["local_session_id"] for s in items}
    assert ids == {"m1", "m3"}

    # Filter by tag — AND semantics: must include BOTH tags.
    items = (await client.get("/v1/sessions?tag=security&tag=audit")).json()["items"]
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
    items = (await client.get("/v1/sessions?min_messages=3")).json()["items"]
    assert {s["local_session_id"] for s in items} == {"big-pr"}

    # has_pr=true → only big-pr.
    items = (await client.get("/v1/sessions?has_pr=true")).json()["items"]
    assert {s["local_session_id"] for s in items} == {"big-pr"}

    # has_pr=false → only small (and any other no-PR sessions).
    items = (await client.get("/v1/sessions?has_pr=false")).json()["items"]
    assert "small" in {s["local_session_id"] for s in items}
    assert "big-pr" not in {s["local_session_id"] for s in items}
