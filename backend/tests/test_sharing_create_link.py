"""Smoke tests for POST /api/projects/{id}/share-links.

B.1 router skeleton + B.2 create-link coverage. Full owner-side
surface (list/revoke/invitations/members/unshare) lands in B.3+.
"""

import uuid

import pytest


@pytest.mark.asyncio
async def test_create_share_link_returns_raw_token_once(client, seed_user, workspace_project):
    """Owner creates a link → 200 with raw_token + url + prefix.
    Plan B.2 contract: raw_token shown ONCE; subsequent reads see
    only the prefix."""
    # seed_user has no .name by default in conftest — set one so
    # the display_name gate passes.
    seed_user.name = "Alice Example"

    r = await client.post(
        f"/v1/projects/{workspace_project.id}/share-links",
        json={"label": "team link"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["raw_token"]
    assert len(body["raw_token"]) == 43  # 32-byte URL-safe-b64-no-pad
    assert body["url"].endswith(body["raw_token"])
    assert body["url"].startswith("http")
    assert body["prefix"] == body["raw_token"][:8]
    assert body["label"] == "team link"
    assert body["owner_handle"].startswith("alice-")


@pytest.mark.asyncio
async def test_create_share_link_persists_hash_not_raw(client, seed_user, workspace_project):
    """Server stores only the SHA-256 hash + prefix — never the
    raw_token. We verify by re-using the raw_token in a follow-up
    /preview call: if the hash were stored wrong, /preview would
    404 because hash_share_token(raw) wouldn't match. This also
    proves the create→consume loop works end-to-end."""
    seed_user.name = "Alice Example"

    r = await client.post(
        f"/v1/projects/{workspace_project.id}/share-links",
        json={},
    )
    assert r.status_code == 200
    raw = r.json()["raw_token"]
    # /preview is anonymous (no auth header needed); httpx client
    # carries an Authorization header but the dep ignores it.
    preview = await client.get(f"/v1/share/{raw}/preview")
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert body["project_id"] == str(workspace_project.id)
    assert body["owner_handle"].startswith("alice-")


@pytest.mark.asyncio
async def test_create_share_link_rejects_managed_projects(
    client, seed_user, seed_project, environment_project
):
    """Only user-created workspace/custom Projects are shareable.

    Personal/Global and Agent Projects are managed contexts, not
    collaboration containers.
    """
    seed_user.name = "Alice Example"

    for project in (seed_project, environment_project):
        r = await client.post(
            f"/v1/projects/{project.id}/share-links",
            json={},
        )
        assert r.status_code == 400, r.text
        assert r.json()["detail"]["error"] == "project_not_shareable"


@pytest.mark.asyncio
async def test_create_share_link_cross_tenant_404(client, db_session, seed_user):
    """seed_user posts to another user's project → 404 (not 403):
    refusing to distinguish 'not yours' from 'doesn't exist' so
    project IDs aren't enumerable."""
    from app.models.project import PROJECT_KIND_PERSONAL, Project
    from app.models.user import User

    seed_user.name = "Alice"
    other_nonce = uuid.uuid4().hex[:8]
    other = User(
        clerk_id=f"other_{other_nonce}",
        email=f"o_{other_nonce}@x.dev",
        name="O",
    )
    db_session.add(other)
    await db_session.commit()
    await db_session.refresh(other)
    other_project = Project(
        user_id=other.id,
        name="Other",
        slug=f"other-{other_nonce}",
        kind=PROJECT_KIND_PERSONAL,
    )
    db_session.add(other_project)
    await db_session.commit()

    try:
        r = await client.post(
            f"/v1/projects/{other_project.id}/share-links",
            json={},
        )
        assert r.status_code == 404
    finally:
        await db_session.delete(other_project)
        await db_session.delete(other)
        await db_session.commit()


@pytest.mark.asyncio
async def test_create_share_link_requires_display_name(client, seed_user, workspace_project):
    """Owner without a display name → 409 display_name_required.
    Falling back to email local-part would leak PII to recipients;
    sharing requires a stable owner handle, so we hard-block instead."""
    seed_user.name = None

    r = await client.post(
        f"/v1/projects/{workspace_project.id}/share-links",
        json={},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["error"] == "display_name_required"
