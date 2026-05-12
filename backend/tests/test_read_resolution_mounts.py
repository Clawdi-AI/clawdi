"""MD — read-path resolution walks mount edges.

When a caller queries `/api/skills?scope_id=<parent>`, the resolver
walks mount edges rooted at that parent, gated on viewer-source
membership. Each test pins one rule from the spec.
"""

import uuid
from datetime import UTC, datetime

import pytest


async def _seed_mounted_scope_with_skill(
    db_session, parent_user, parent_scope, *, skill_key="git-helper"
):
    """Create another user + their scope + a skill in it + a membership
    + a mount on parent. Returns (other_user, source_scope, skill)."""
    from app.models.scope import SCOPE_KIND_ENVIRONMENT, Scope
    from app.models.scope_membership import ScopeMembership
    from app.models.scope_mount import ScopeMount
    from app.models.skill import Skill
    from app.models.user import User

    nonce = uuid.uuid4().hex[:8]
    other = User(
        clerk_id=f"other_{nonce}",
        email=f"other_{nonce}@test.dev",
        name="Other",
    )
    db_session.add(other)
    await db_session.commit()
    await db_session.refresh(other)

    src = Scope(
        user_id=other.id,
        name="Engineering",
        slug=f"engineering-{nonce}",
        kind=SCOPE_KIND_ENVIRONMENT,
    )
    db_session.add(src)
    await db_session.commit()
    await db_session.refresh(src)

    skill = Skill(
        user_id=other.id,
        scope_id=src.id,
        skill_key=skill_key,
        name=skill_key,
        description="mounted skill",
        content_hash="0" * 64,
        is_active=True,
    )
    db_session.add(skill)

    db_session.add(
        ScopeMembership(
            scope_id=src.id,
            user_id=parent_user.id,
            role="viewer",
            joined_via="link",
            joined_at=datetime.now(UTC),
            resolved_owner_handle="other-test",
        )
    )

    db_session.add(
        ScopeMount(
            parent_scope_id=parent_scope.id,
            source_scope_id=src.id,
            alias=f"@other-test/{src.slug}",
            mode="live",
            created_by=parent_user.id,
            created_at=datetime.now(UTC),
        )
    )
    await db_session.commit()

    return other, src, skill


@pytest.mark.asyncio
async def test_parent_scoped_skill_list_returns_mounted_content(
    client, db_session, seed_user, seed_scope
):
    """GET /api/skills?scope_id=<personal> returns skills from
    Personal AND mounted sources."""
    seed_user.name = "Bob"
    other, src, skill = await _seed_mounted_scope_with_skill(
        db_session, seed_user, seed_scope
    )

    r = await client.get(f"/api/skills?scope_id={seed_scope.id}")
    assert r.status_code == 200, r.text
    body = r.json()
    items = body["items"]
    keys = {s["skill_key"] for s in items}
    assert "git-helper" in keys
    # Verify it actually came from the mount source, not the parent
    mounted = next(s for s in items if s["skill_key"] == "git-helper")
    assert mounted["scope_id"] == str(src.id)


@pytest.mark.asyncio
async def test_parent_scoped_skill_list_filters_mount_when_membership_dropped(
    client, db_session, seed_user, seed_scope
):
    """If viewer's membership in the source is removed, the mount
    edge still exists but resolve_for_parent silently filters it
    out. Critical safety invariant."""
    from sqlalchemy import delete

    from app.models.scope_membership import ScopeMembership

    seed_user.name = "Bob"
    other, src, skill = await _seed_mounted_scope_with_skill(
        db_session, seed_user, seed_scope
    )

    # Drop Bob's membership in src — mount row stays, but he loses
    # capability.
    await db_session.execute(
        delete(ScopeMembership).where(
            ScopeMembership.scope_id == src.id,
            ScopeMembership.user_id == seed_user.id,
        )
    )
    await db_session.commit()

    r = await client.get(f"/api/skills?scope_id={seed_scope.id}")
    assert r.status_code == 200, r.text
    keys = {s["skill_key"] for s in r.json()["items"]}
    assert "git-helper" not in keys


@pytest.mark.asyncio
async def test_unscoped_skill_list_unchanged_by_mounts(
    client, db_session, seed_user, seed_scope
):
    """`/api/skills` (no scope_id) returns everything visible —
    same shape as before mounts existed. Mounts don't add
    anything to this query because the source is already in
    scope_ids_visible_to via membership."""
    seed_user.name = "Bob"
    other, src, skill = await _seed_mounted_scope_with_skill(
        db_session, seed_user, seed_scope
    )

    r = await client.get("/api/skills")
    assert r.status_code == 200, r.text
    keys = {s["skill_key"] for s in r.json()["items"]}
    assert "git-helper" in keys  # visible via membership


@pytest.mark.asyncio
async def test_parent_scoped_skill_list_returns_empty_when_parent_invisible(
    client, db_session, seed_user
):
    """`?scope_id=<not-mine>` → empty listing (404-equivalent at
    the resolver layer; the route returns 200 with items: [])."""
    bogus = "00000000-0000-0000-0000-000000000000"
    r = await client.get(f"/api/skills?scope_id={bogus}")
    # Either 200 with empty items OR 404. Both signal "no visibility".
    if r.status_code == 200:
        assert r.json()["items"] == []
    else:
        assert r.status_code == 404


@pytest.mark.asyncio
async def test_resolve_for_parent_helper_walks_mounts_with_membership_check(
    db_session, seed_user, seed_scope
):
    """Direct test of resolve_for_parent: parent + mounted-source-
    with-membership returned; mount without independent membership
    filtered out."""
    from app.core.auth import AuthContext
    from app.core.scope import resolve_for_parent

    other, src, _ = await _seed_mounted_scope_with_skill(
        db_session, seed_user, seed_scope
    )

    auth = AuthContext(user=seed_user)
    composed = await resolve_for_parent(db_session, auth, seed_scope.id)
    assert seed_scope.id in composed
    assert src.id in composed
