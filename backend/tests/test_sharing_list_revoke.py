"""B.3 GET + B.4 DELETE coverage for share-links.

Append-style suite for the owner's create→list→revoke cycle.
Cross-tenant 404 isolation is already covered in
test_sharing_create_link.py; here we just verify the list shape
and revoke idempotency.
"""

import pytest

from app.models.project_share_link import ProjectShareLink


@pytest.mark.asyncio
async def test_list_share_links_returns_prefix_not_raw(client, seed_user, seed_project):
    """List endpoint returns prefix-only metadata — raw_token is
    never recoverable after create-time. Two links → newest first."""
    seed_user.name = "Alice"

    await client.post(f"/api/projects/{seed_project.id}/share-links", json={"label": "alpha"})
    await client.post(f"/api/projects/{seed_project.id}/share-links", json={"label": "beta"})

    r = await client.get(f"/api/projects/{seed_project.id}/share-links")
    assert r.status_code == 200, r.text
    items = r.json()
    assert len(items) == 2
    # Newest first
    assert items[0]["label"] == "beta"
    assert items[1]["label"] == "alpha"
    for item in items:
        assert "raw_token" not in item
        assert "url" not in item
        assert len(item["prefix"]) == 8
        assert item["redeem_count"] == 0
        assert item["revoked_at"] is None


@pytest.mark.asyncio
async def test_revoke_share_link_stamps_revoked_at(client, seed_user, seed_project):
    """DELETE → 200 status:revoked; subsequent list shows revoked_at."""
    seed_user.name = "Alice"
    create = await client.post(f"/api/projects/{seed_project.id}/share-links", json={})
    link_id = create.json()["id"]

    r = await client.delete(f"/api/projects/{seed_project.id}/share-links/{link_id}")
    assert r.status_code == 200
    assert r.json()["status"] == "revoked"

    # Verify via the list endpoint rather than touching the DB
    # directly — same test client/session, no cross-pool greenlet
    # issues, and exercises the list serialization path too.
    listing = await client.get(f"/api/projects/{seed_project.id}/share-links")
    assert listing.status_code == 200
    row = next(item for item in listing.json() if item["id"] == link_id)
    assert row["revoked_at"] is not None


@pytest.mark.asyncio
async def test_revoke_share_link_idempotent(client, seed_user, seed_project):
    """Two revokes → both 200 with the same status. Single-stamp
    semantics are unit-tested implicitly: the second DELETE doesn't
    error and returns the same response shape."""
    seed_user.name = "Alice"
    create = await client.post(f"/api/projects/{seed_project.id}/share-links", json={})
    link_id = create.json()["id"]

    r1 = await client.delete(f"/api/projects/{seed_project.id}/share-links/{link_id}")
    assert r1.status_code == 200
    assert r1.json()["status"] == "revoked"

    r2 = await client.delete(f"/api/projects/{seed_project.id}/share-links/{link_id}")
    assert r2.status_code == 200
    assert r2.json()["status"] == "revoked"


@pytest.mark.asyncio
async def test_revoke_unknown_link_404(client, seed_user, seed_project):
    """Unknown link_id → 404, even if the project_id is valid."""
    seed_user.name = "Alice"
    r = await client.delete(
        f"/api/projects/{seed_project.id}/share-links/00000000-0000-0000-0000-000000000000"
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_revoked_link_blocks_unauth_access(client, seed_user, seed_project):
    """End-to-end revoke → subsequent /preview returns 410 Gone.

    Uses an inline unauth client to keep both the owner override
    (for DELETE) and an anonymous httpx client (for GET /preview)
    alive in the same test event loop — avoids the
    `async_session_factory()` cross-loop greenlet boundary that
    breaks if we open a second pool inside a test.
    """
    from datetime import UTC, datetime

    import httpx
    from httpx import ASGITransport

    from app.core.auth import get_auth
    from app.core.database import get_session
    from app.main import app
    from app.services.sharing import generate_share_token, hash_share_token

    seed_user.name = "Alice"
    # The `client` fixture's override is active; reuse its db_session.
    # Pull it back from the override map for inline seeding.
    db_override = app.dependency_overrides[get_session]
    db_session = None
    async for s in db_override():
        db_session = s
        break
    assert db_session is not None

    raw = generate_share_token()
    link = ProjectShareLink(
        project_id=seed_project.id,
        token_hash=hash_share_token(raw),
        token_prefix=raw[:8],
        label="will revoke",
        created_by=seed_user.id,
        resolved_owner_handle="alice-test",
        created_at=datetime.now(UTC),
    )
    db_session.add(link)
    await db_session.commit()
    await db_session.refresh(link)
    link_id = link.id

    # /preview before revoke — anonymous (clear get_auth override).
    saved_auth = app.dependency_overrides.pop(get_auth, None)
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as anon:
            pre = await anon.get(f"/api/share/{raw}/preview")
            assert pre.status_code == 200, pre.text
    finally:
        if saved_auth is not None:
            app.dependency_overrides[get_auth] = saved_auth

    # Revoke via owner endpoint (uses the original `client` fixture).
    r = await client.delete(f"/api/projects/{seed_project.id}/share-links/{link_id}")
    assert r.status_code == 200

    # /preview after revoke → 410.
    saved_auth = app.dependency_overrides.pop(get_auth, None)
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as anon:
            post = await anon.get(f"/api/share/{raw}/preview")
            assert post.status_code == 410, post.text
    finally:
        if saved_auth is not None:
            app.dependency_overrides[get_auth] = saved_auth
