"""Public share-route tests.

Covers the UUID-keyed public routes and the access matrix
(anon / owner / non-owner × link-grant / no-grant).

  - GET detail        — public payload (anonymous when link permission active)
  - GET messages      — paginated, reuses cache
  - GET export.md     — agent-friendly Markdown with YAML front-matter
  - GET export.json   — structured JSON, public-stripped fields
  - Probe rejection   — invalid UUID → 404 without DB lookup
  - Revoke flow       — revoking the link permission flips the route to 401
  - Auth matrix       — anon vs owner vs non-owner with various grants

The companion `test_session_permissions.py` covers the owner-side
endpoints that toggle the permission rows.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

import httpx
import pytest


async def _register_env(client: httpx.AsyncClient) -> str:
    r = await client.post(
        "/v1/environments",
        json={
            "machine_id": "test-public-machine",
            "machine_name": "Public Mac",
            "agent_type": "claude-code",
            "agent_version": "0.1.0",
            "os": "darwin",
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


async def _seed_session_with_content(
    client: httpx.AsyncClient,
    *,
    local_session_id: str = "sess-public",
    summary: str = "Public test session",
    project_path: str | None = "/Users/paco/workspace/ghostty",
    messages: list[dict] | None = None,
) -> tuple[str, list[dict]]:
    """Create a session + upload its content. Returns (session_uuid, messages)."""
    env_id = await _register_env(client)
    started = datetime.now(UTC).isoformat()
    if messages is None:
        messages = [
            {
                "role": "user",
                "content": "What do you guys think about this?",
                "timestamp": "2026-05-09T14:22:01Z",
            },
            {
                "role": "assistant",
                "content": "Your read is reasonable.",
                "model": "claude-sonnet-4-6",
                "timestamp": "2026-05-09T14:22:08Z",
            },
        ]
    body_bytes = json.dumps(messages).encode("utf-8")
    import hashlib

    h = hashlib.sha256(body_bytes).hexdigest()

    r = await client.post(
        "/v1/sessions/batch",
        json={
            "sessions": [
                {
                    "environment_id": env_id,
                    "local_session_id": local_session_id,
                    "started_at": started,
                    "message_count": len(messages),
                    "model": "claude-sonnet-4-6",
                    "summary": summary,
                    "project_path": project_path,
                    "content_hash": h,
                }
            ]
        },
    )
    assert r.status_code == 200, r.text

    await client.post(
        f"/v1/sessions/{local_session_id}/upload",
        files={"file": (f"{local_session_id}.json", body_bytes, "application/json")},
    )

    listing = (await client.get(f"/v1/sessions?q={local_session_id}")).json()
    sid = next(s["id"] for s in listing["items"] if s["local_session_id"] == local_session_id)
    return sid, messages


async def _enable_link(client: httpx.AsyncClient, sid: str) -> None:
    r = await client.post(f"/v1/sessions/{sid}/permissions", json={"kind": "link"})
    assert r.status_code == 200, r.text


async def _disable_link(client: httpx.AsyncClient, sid: str) -> None:
    r = await client.delete(f"/v1/sessions/{sid}/permissions", params={"kind": "link"})
    assert r.status_code == 204, r.text


def test_public_payload_matches_json_export_keys():
    """Public detail and `.json` export must agree on which Session-derived
    fields they expose — both call `public_session_base_fields`. A future
    column added to one path but not the other would fail loudly here.
    """
    from datetime import UTC, datetime
    from uuid import uuid4

    from app.models.session import Session as SessionModel
    from app.services.session_export import (
        public_session_base_fields,
        session_to_json,
    )

    sess = SessionModel(
        id=uuid4(),
        user_id=uuid4(),
        local_session_id="shape-test",
        started_at=datetime.now(UTC),
        message_count=0,
        input_tokens=0,
        output_tokens=0,
        cache_read_tokens=0,
        status="completed",
    )

    base = set(public_session_base_fields(sess, "claude-code", None).keys())

    json_body = session_to_json(
        sess,
        messages=[],
        agent_type="claude-code",
        public=True,
        include_owner_metadata=False,
    )
    json_session_keys = set(json_body.keys()) - {"messages", "share_url"}
    assert base == json_session_keys, (
        f"json export diverged from base allow-list. "
        f"Only in export: {json_session_keys - base}; only in base: {base - json_session_keys}"
    )


@pytest.mark.asyncio
async def test_public_detail_returns_stripped_payload(
    client: httpx.AsyncClient, anon_client: httpx.AsyncClient
):
    """Public detail must hide owner-internal fields when accessed via the
    anonymous public route (link grant active).
    """
    sid, _ = await _seed_session_with_content(client)
    await _enable_link(client, sid)

    r = await anon_client.get(f"/v1/public/sessions/{sid}")
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["summary"] == "Public test session"
    assert body["project_path"] == "/Users/paco/workspace/ghostty"
    assert body["agent_type"] == "claude-code"
    assert body["model"] == "claude-sonnet-4-6"

    for forbidden in (
        "user_id",
        "environment_id",
        "file_key",
        "machine_name",
        "local_session_id",
    ):
        assert forbidden not in body, f"public payload leaks {forbidden}"


@pytest.mark.asyncio
async def test_public_messages_paginate(client: httpx.AsyncClient, anon_client: httpx.AsyncClient):
    messages = [{"role": "user", "content": f"m{i}"} for i in range(50)]
    sid, _ = await _seed_session_with_content(
        client, local_session_id="sess-msg-page", messages=messages
    )
    await _enable_link(client, sid)

    page1 = (await anon_client.get(f"/v1/public/sessions/{sid}/messages?offset=0&limit=10")).json()
    assert page1["total"] == 50
    assert len(page1["items"]) == 10
    assert page1["items"][0]["content"] == "m0"

    page2 = (
        await anon_client.get(f"/v1/public/sessions/{sid}/messages?offset=10&limit=10")
    ).json()
    assert page2["items"][0]["content"] == "m10"


@pytest.mark.asyncio
async def test_public_export_md_has_front_matter_and_body(
    client: httpx.AsyncClient, anon_client: httpx.AsyncClient
):
    """The Markdown export carries YAML front-matter so an agent ingesting
    the page knows what kind of document it is.
    """
    sid, _ = await _seed_session_with_content(client, local_session_id="sess-md-export")
    await _enable_link(client, sid)

    r = await anon_client.get(f"/v1/public/sessions/{sid}/export.md")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/markdown")
    body = r.text

    assert body.startswith("---\n")
    assert 'source: "clawdi-shared-session"' in body
    assert f"/s/{sid}" in body
    assert 'agent: "claude-code"' in body
    assert 'model: "claude-sonnet-4-6"' in body

    assert "## User" in body
    assert "## Assistant" in body
    assert "What do you guys think about this?" in body
    assert "Your read is reasonable." in body


@pytest.mark.asyncio
async def test_public_export_json_strips_owner_fields(
    client: httpx.AsyncClient, anon_client: httpx.AsyncClient
):
    sid, messages = await _seed_session_with_content(client, local_session_id="sess-json-export")
    await _enable_link(client, sid)

    r = await anon_client.get(f"/v1/public/sessions/{sid}/export.json")
    assert r.status_code == 200
    body = r.json()

    assert body["summary"] == "Public test session"
    assert body["model"] == "claude-sonnet-4-6"
    assert body["messages"] == messages
    assert body["share_url"].endswith(f"/s/{sid}")

    for forbidden in (
        "local_session_id",
        "machine_name",
        "user_id",
        "file_key",
        "environment_id",
    ):
        assert forbidden not in body, f"json export leaks {forbidden}"


@pytest.mark.asyncio
async def test_invalid_uuid_404s_without_db_hit(client: httpx.AsyncClient):
    """The UUID-keyed route lets FastAPI's path validation reject malformed
    inputs at the framework layer — before any DB lookup. Random scanners
    hitting `/api/public/sessions/junk` get a 422 (FastAPI validation
    error) which is functionally equivalent: cheap rejection.
    """
    for bogus in [
        "junk",
        "x" * 23,
        "../etc/passwd",
    ]:
        r = await client.get(f"/v1/public/sessions/{bogus}")
        assert r.status_code in (404, 422), f"bogus {bogus!r} → {r.status_code}"


@pytest.mark.asyncio
async def test_link_revoke_returns_401_to_anon(
    client: httpx.AsyncClient, anon_client: httpx.AsyncClient
):
    """Revoking the link permission flips the public route from 200 (anon
    OK) to 401 (sign-in required). The session row still exists and
    the URL still resolves — only the access policy changes. Matches
    Notion / Drive: turning off "Share to web" doesn't delete the
    page, it makes anonymous visits hit a sign-in screen.
    """
    sid, _ = await _seed_session_with_content(client, local_session_id="sess-revoke")
    await _enable_link(client, sid)

    assert (await anon_client.get(f"/v1/public/sessions/{sid}")).status_code == 200

    await _disable_link(client, sid)

    for path_suffix in ["", "/messages", "/export.md", "/export.json"]:
        r = await anon_client.get(f"/v1/public/sessions/{sid}{path_suffix}")
        assert r.status_code == 401, f"{path_suffix} → {r.status_code}"


@pytest.mark.asyncio
async def test_owner_can_view_own_private_session(
    client: httpx.AsyncClient,
):
    """Owner visiting their own session URL (no link grant) gets 200.
    The auth-aware fetch detects them as the owner and bypasses the
    permission check entirely. `client` fixture is already authenticated
    as the session's owner.
    """
    sid, _ = await _seed_session_with_content(client, local_session_id="sess-owner-view")
    # NO link grant — session is private.

    r = await client.get(f"/v1/public/sessions/{sid}")
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_anon_to_private_session_401s(
    client: httpx.AsyncClient, anon_client: httpx.AsyncClient
):
    """Without a link grant and without auth, the response is 401 — not
    404. The token regex used to make 404 the "I won't tell you why"
    answer; the new model uses 401 because the URL really does identify
    a real session and the right recovery action for the visitor is
    "sign in", not "give up".
    """
    sid, _ = await _seed_session_with_content(client, local_session_id="sess-anon-private")

    r = await anon_client.get(f"/v1/public/sessions/{sid}")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_owner_export_md_matches_public_format(client: httpx.AsyncClient):
    """Owner-side `/api/sessions/{id}/export.md` returns the same shape as
    the public route — same `session_export.py` serializer — so the MCP
    `session_read` tool's UUID branch yields identical agent context to
    the share-URL branch. Only the `source` field differs
    (clawdi-session vs clawdi-shared-session).
    """
    sid, _ = await _seed_session_with_content(client, local_session_id="sess-owner-md")

    r = await client.get(f"/v1/sessions/{sid}/export.md")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/markdown")
    body = r.text

    assert body.startswith("---\n")
    assert 'source: "clawdi-session"' in body
    assert 'agent: "claude-code"' in body
    assert "## User" in body
    assert "## Assistant" in body


@pytest.mark.asyncio
async def test_owner_export_md_404s_on_someone_elses_session(
    client: httpx.AsyncClient,
):
    """Same posture as the rest of the session routes — never leak
    "this UUID exists but isn't yours" via 403.
    """
    bogus = "00000000-0000-0000-0000-000000000000"
    r = await client.get(f"/v1/sessions/{bogus}/export.md")
    assert r.status_code == 404
