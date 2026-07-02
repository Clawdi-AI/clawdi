"""Session permission lifecycle tests.

Covers the three /permissions endpoints:
  - GET    /api/sessions/{id}/permissions
  - POST   /api/sessions/{id}/permissions
  - DELETE /api/sessions/{id}/permissions?kind=...

Plus the `is_shared` derivation which is computed from "exists active
kind='link' permission row" — the EXISTS subquery needs to keep returning
the right answer through toggle on/off cycles.
"""

from __future__ import annotations

from datetime import UTC, datetime

import httpx
import pytest


async def _register_env(client: httpx.AsyncClient) -> str:
    r = await client.post(
        "/v1/environments",
        json={
            "machine_id": "test-perm-machine",
            "machine_name": "Perm Mac",
            "agent_type": "claude-code",
            "agent_version": "0.1.0",
            "os": "darwin",
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


async def _seed_session(client: httpx.AsyncClient) -> str:
    """Create one session and return its server-side UUID."""
    env_id = await _register_env(client)
    started = datetime.now(UTC).isoformat()
    r = await client.post(
        "/v1/sessions/batch",
        json={
            "sessions": [
                {
                    "environment_id": env_id,
                    "local_session_id": "sess-perm-1",
                    "started_at": started,
                    "message_count": 5,
                    "model": "claude-sonnet-4-6",
                    "summary": "permission me",
                }
            ]
        },
    )
    assert r.status_code == 200, r.text
    listing = (await client.get("/v1/sessions")).json()
    return listing["items"][0]["id"]


@pytest.mark.asyncio
async def test_link_permission_post_is_idempotent(client: httpx.AsyncClient):
    session_id = await _seed_session(client)

    first = (
        await client.post(f"/v1/sessions/{session_id}/permissions", json={"kind": "link"})
    ).json()
    assert first["kind"] == "link"
    assert first["user_id"] is None
    assert first["email"] is None
    assert first["role"] == "viewer"

    # Second call must return the SAME row, not insert a duplicate.
    # Toggle UX depends on this: clicking "Public access" on twice
    # should not create two link permissions.
    second = (
        await client.post(f"/v1/sessions/{session_id}/permissions", json={"kind": "link"})
    ).json()
    assert second["id"] == first["id"]


@pytest.mark.asyncio
async def test_link_permission_list_returns_active_row(client: httpx.AsyncClient):
    session_id = await _seed_session(client)
    created = (
        await client.post(f"/v1/sessions/{session_id}/permissions", json={"kind": "link"})
    ).json()

    listing = (await client.get(f"/v1/sessions/{session_id}/permissions")).json()
    assert len(listing["permissions"]) == 1
    assert listing["permissions"][0]["id"] == created["id"]


@pytest.mark.asyncio
async def test_link_permission_delete_revokes(client: httpx.AsyncClient):
    session_id = await _seed_session(client)
    await client.post(f"/v1/sessions/{session_id}/permissions", json={"kind": "link"})

    r = await client.delete(f"/v1/sessions/{session_id}/permissions", params={"kind": "link"})
    assert r.status_code == 204

    # After revoke the active list is empty (only active rows are
    # returned by GET; revoked rows linger in the table for audit but
    # don't show up here).
    listing = (await client.get(f"/v1/sessions/{session_id}/permissions")).json()
    assert listing["permissions"] == []

    # Idempotent delete: calling DELETE again on the now-empty state
    # is a no-op, not a 404. Toggling off twice in the popover (rapid
    # clicks) shouldn't error.
    r = await client.delete(f"/v1/sessions/{session_id}/permissions", params={"kind": "link"})
    assert r.status_code == 204


@pytest.mark.asyncio
async def test_link_permission_revoke_then_recreate(client: httpx.AsyncClient):
    """Toggle off + back on must produce a fresh active row.

    The partial unique index permits multiple rows for the same
    composite key as long as only one has revoked_at IS NULL. This
    is the "I changed my mind, share again" flow.
    """
    session_id = await _seed_session(client)

    first = (
        await client.post(f"/v1/sessions/{session_id}/permissions", json={"kind": "link"})
    ).json()
    await client.delete(f"/v1/sessions/{session_id}/permissions", params={"kind": "link"})

    second = (
        await client.post(f"/v1/sessions/{session_id}/permissions", json={"kind": "link"})
    ).json()
    # New row, different id from the revoked one.
    assert second["id"] != first["id"]


@pytest.mark.asyncio
async def test_is_shared_flag_tracks_link_permission(client: httpx.AsyncClient):
    """`is_shared` flips with the active link permission row — the EXISTS
    subquery filters on kind='link' AND revoked_at IS NULL.
    """
    session_id = await _seed_session(client)

    listing = (await client.get("/v1/sessions")).json()
    assert listing["items"][0]["is_shared"] is False
    detail = (await client.get(f"/v1/sessions/{session_id}")).json()
    assert detail["is_shared"] is False

    await client.post(f"/v1/sessions/{session_id}/permissions", json={"kind": "link"})

    listing = (await client.get("/v1/sessions")).json()
    assert listing["items"][0]["is_shared"] is True
    detail = (await client.get(f"/v1/sessions/{session_id}")).json()
    assert detail["is_shared"] is True

    await client.delete(f"/v1/sessions/{session_id}/permissions", params={"kind": "link"})

    listing = (await client.get("/v1/sessions")).json()
    assert listing["items"][0]["is_shared"] is False
    detail = (await client.get(f"/v1/sessions/{session_id}")).json()
    assert detail["is_shared"] is False


@pytest.mark.asyncio
async def test_permission_create_validates_kind_identifier_consistency(
    client: httpx.AsyncClient,
):
    """The handler rejects malformed (kind, identifier) combos so
    callers can't smuggle a user_id into a kind='link' row (or
    similar). Each branch matches the rules in
    `_validate_permission_create`.
    """
    session_id = await _seed_session(client)

    # link + identifier set → 400
    bad = await client.post(
        f"/v1/sessions/{session_id}/permissions",
        json={"kind": "link", "email": "alice@example.com"},
    )
    assert bad.status_code == 400

    # email + missing email → 400
    bad = await client.post(f"/v1/sessions/{session_id}/permissions", json={"kind": "email"})
    assert bad.status_code == 400

    # user + missing user_id → 400
    bad = await client.post(f"/v1/sessions/{session_id}/permissions", json={"kind": "user"})
    assert bad.status_code == 400


@pytest.mark.asyncio
async def test_permissions_unknown_session_404s(client: httpx.AsyncClient):
    """Cross-tenant access surface: 404, not 403.

    Same posture as `get_session_detail` — leaking "this session id
    exists" via 403 would let attackers enumerate the global UUID
    space.
    """
    bogus = "00000000-0000-0000-0000-000000000000"
    assert (
        await client.post(f"/v1/sessions/{bogus}/permissions", json={"kind": "link"})
    ).status_code == 404
    assert (
        await client.delete(f"/v1/sessions/{bogus}/permissions", params={"kind": "link"})
    ).status_code == 404
    assert (await client.get(f"/v1/sessions/{bogus}/permissions")).status_code == 404


@pytest.mark.asyncio
async def test_permissions_reject_cli_apikey_auth(cli_client: httpx.AsyncClient):
    """Permission routes are dashboard-only: a deploy key with write
    capability over a session must not be able to mint public-link
    permissions for it. `require_web_auth` enforces this — the test
    asserts the contract from the surface.
    """
    fake_id = "00000000-0000-0000-0000-000000000000"
    for method, path, kwargs in [
        ("post", f"/v1/sessions/{fake_id}/permissions", {"json": {"kind": "link"}}),
        (
            "delete",
            f"/v1/sessions/{fake_id}/permissions",
            {"params": {"kind": "link"}},
        ),
        ("get", f"/v1/sessions/{fake_id}/permissions", {}),
    ]:
        r = await getattr(cli_client, method)(path, **kwargs)
        assert r.status_code == 403, f"{method.upper()} {path} → {r.status_code}"
