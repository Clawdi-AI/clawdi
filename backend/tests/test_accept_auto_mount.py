"""MC — auto-mount behavior on /upgrade + /me/invitations/{id}/accept.

The two accept paths share the auto-mount target resolution rule:
  - body.no_mount=True → capability only (membership), skip mount.
  - body.parent_scope_id set → explicit target, validated as owned.
  - 1 owned scope → silent auto-mount.
  - 2+ owned scopes, no parent_scope_id → 409 mount_target_ambiguous
    (membership commits, mount deferred).
"""

import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
from app.main import app
from app.models.scope_mount import ScopeMount
from app.models.scope_share_link import ScopeShareLink
from app.models.user import User
from app.services.sharing import generate_share_token, hash_share_token


@pytest_asyncio.fixture
async def sharee_with_personal_scope(
    db_session: AsyncSession,
) -> AsyncIterator[tuple[User, "Scope"]]:
    """A test user with exactly ONE owned scope (Personal). Real
    Clawdi accounts get this auto-created at signup.
    """
    from app.models.scope import SCOPE_KIND_PERSONAL, Scope

    nonce = uuid.uuid4().hex[:8]
    user = User(
        clerk_id=f"sharee_{nonce}",
        email=f"sharee_{nonce}@test.dev",
        name="Sharee",
    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)

    personal = Scope(
        user_id=user.id,
        name="Personal",
        slug=f"personal-{nonce}",
        kind=SCOPE_KIND_PERSONAL,
    )
    db_session.add(personal)
    await db_session.commit()
    await db_session.refresh(personal)

    yield user, personal

    # Cleanup: cascade deletes via FK on Scope.user_id; explicit user
    # delete sweeps the rest.
    await db_session.delete(user)
    await db_session.commit()


async def _make_share_link(db_session, scope, owner_user) -> str:
    raw = generate_share_token()
    link = ScopeShareLink(
        scope_id=scope.id,
        token_hash=hash_share_token(raw),
        token_prefix=raw[:8],
        resolved_owner_handle="alice-test",
        created_by=owner_user.id,
        created_at=datetime.now(UTC),
    )
    db_session.add(link)
    await db_session.commit()
    return raw


def _override_app(db_session, user):
    async def _override_get_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def _override_get_auth() -> AuthContext:
        return AuthContext(user=user)

    app.dependency_overrides[get_session] = _override_get_session
    app.dependency_overrides[get_auth] = _override_get_auth


@pytest.mark.asyncio
async def test_upgrade_auto_mounts_when_exactly_one_owned_scope(
    db_session, seed_user, seed_scope, sharee_with_personal_scope
):
    """Sharee has 1 owned scope (Personal) → upgrade auto-mounts
    silently. Response carries mount_id + mount_alias."""
    sharee, personal = sharee_with_personal_scope
    seed_user.name = "Alice"
    raw = await _make_share_link(db_session, seed_scope, seed_user)

    _override_app(db_session, sharee)
    try:
        async with httpx.AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as ac:
            r = await ac.post(f"/api/share/{raw}/upgrade")
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["scope_id"] == str(seed_scope.id)
            assert "mount_id" in body
            assert body["mount_alias"].startswith("@alice-test/")
            assert body["mount_parent_scope_id"] == str(personal.id)
    finally:
        app.dependency_overrides.clear()

    # Verify mount row landed
    mounts = (
        (
            await db_session.execute(
                select(ScopeMount).where(ScopeMount.parent_scope_id == personal.id)
            )
        )
        .scalars()
        .all()
    )
    assert len(mounts) == 1
    assert mounts[0].source_scope_id == seed_scope.id


@pytest.mark.asyncio
async def test_upgrade_returns_409_when_multiple_owned_scopes(
    db_session, seed_user, seed_scope, sharee_with_personal_scope
):
    """Sharee has 2+ owned scopes, no parent_scope_id in body →
    409 mount_target_ambiguous. Membership commits (capability
    acquired); only mount is deferred."""
    from app.models.scope import SCOPE_KIND_ENVIRONMENT, Scope
    from app.models.scope_membership import ScopeMembership

    sharee, personal = sharee_with_personal_scope
    seed_user.name = "Alice"

    # Give the sharee a second owned scope to trigger ambiguity.
    second = Scope(
        user_id=sharee.id,
        name="Engineering",
        slug=f"sharee-eng-{uuid.uuid4().hex[:8]}",
        kind=SCOPE_KIND_ENVIRONMENT,
    )
    db_session.add(second)
    await db_session.commit()

    raw = await _make_share_link(db_session, seed_scope, seed_user)

    _override_app(db_session, sharee)
    try:
        async with httpx.AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as ac:
            r = await ac.post(f"/api/share/{raw}/upgrade")
            assert r.status_code == 409, r.text
            err = r.json()["detail"]
            assert err["error"] == "mount_target_ambiguous"
            owned_slugs = {s["slug"] for s in err["owned_scopes"]}
            assert {personal.slug, second.slug}.issubset(owned_slugs)
            assert "membership_id" in err
    finally:
        app.dependency_overrides.clear()

    # Membership row landed despite the 409 (capability still acquired).
    membership = (
        await db_session.execute(
            select(ScopeMembership).where(
                ScopeMembership.scope_id == seed_scope.id,
                ScopeMembership.user_id == sharee.id,
            )
        )
    ).scalar_one_or_none()
    assert membership is not None

    # No mount row — that's the deferred half.
    mount_count = (
        (
            await db_session.execute(
                select(ScopeMount).where(
                    ScopeMount.parent_scope_id.in_([personal.id, second.id])
                )
            )
        )
        .scalars()
        .all()
    )
    assert mount_count == []


@pytest.mark.asyncio
async def test_upgrade_with_explicit_parent_scope_id_mounts_there(
    db_session, seed_user, seed_scope, sharee_with_personal_scope
):
    """Sharee with 2+ owned scopes can pin the target via
    parent_scope_id and get the auto-mount in one call."""
    from app.models.scope import SCOPE_KIND_ENVIRONMENT, Scope

    sharee, personal = sharee_with_personal_scope
    seed_user.name = "Alice"
    second = Scope(
        user_id=sharee.id,
        name="Engineering",
        slug=f"sharee-eng-{uuid.uuid4().hex[:8]}",
        kind=SCOPE_KIND_ENVIRONMENT,
    )
    db_session.add(second)
    await db_session.commit()
    await db_session.refresh(second)

    raw = await _make_share_link(db_session, seed_scope, seed_user)

    _override_app(db_session, sharee)
    try:
        async with httpx.AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as ac:
            r = await ac.post(
                f"/api/share/{raw}/upgrade",
                json={"parent_scope_id": str(second.id)},
            )
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["mount_parent_scope_id"] == str(second.id)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_upgrade_no_mount_skips_mount_row(
    db_session, seed_user, seed_scope, sharee_with_personal_scope
):
    """no_mount=True → membership only, no mount row created."""
    sharee, personal = sharee_with_personal_scope
    seed_user.name = "Alice"
    raw = await _make_share_link(db_session, seed_scope, seed_user)

    _override_app(db_session, sharee)
    try:
        async with httpx.AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as ac:
            r = await ac.post(
                f"/api/share/{raw}/upgrade", json={"no_mount": True}
            )
            assert r.status_code == 200, r.text
            body = r.json()
            assert "mount_id" not in body
    finally:
        app.dependency_overrides.clear()

    mounts = (
        (
            await db_session.execute(
                select(ScopeMount).where(ScopeMount.parent_scope_id == personal.id)
            )
        )
        .scalars()
        .all()
    )
    assert mounts == []
