"""Smoke tests for /api/share/{token}/{preview,redeem,upgrade}.

Sanity coverage only — full per-edge testing lands with Phase G E2E.
The point here is: with Phase A models in place, the three endpoints
load, route, and respond with the right shapes + status codes.
"""

from collections.abc import AsyncIterator
from datetime import UTC, datetime

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
from app.main import app
from app.models.scope_share_link import ScopeShareLink
from app.models.user import User
from app.services.sharing import generate_share_token, hash_share_token


@pytest_asyncio.fixture
async def client_unauth(db_session: AsyncSession) -> AsyncIterator[httpx.AsyncClient]:
    """Anonymous httpx client — no AuthContext override. Endpoints that
    require_share_token gate solely on the URL-path token; this fixture
    is what the public `/api/share/...` surface should be exercised
    through."""

    async def _override_get_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = _override_get_session
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac
    finally:
        app.dependency_overrides.clear()


async def _make_share_link(db_session, seed_scope, seed_user) -> str:
    raw = generate_share_token()
    link = ScopeShareLink(
        scope_id=seed_scope.id,
        token_hash=hash_share_token(raw),
        token_prefix=raw[:8],
        resolved_owner_handle="alice-a3b4",
        created_by=seed_user.id,
        created_at=datetime.now(UTC),
    )
    db_session.add(link)
    await db_session.commit()
    return raw


@pytest.mark.asyncio
async def test_preview_unknown_token_404(client_unauth):
    r = await client_unauth.get("/api/share/totally-bogus-token/preview")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_preview_valid_token_returns_summary(
    client_unauth, db_session, seed_user, seed_scope
):
    raw = await _make_share_link(db_session, seed_scope, seed_user)
    r = await client_unauth.get(f"/api/share/{raw}/preview")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scope_id"] == str(seed_scope.id)
    assert body["scope_name"] == seed_scope.name
    assert body["owner_display"] in (seed_user.name, seed_user.email)
    assert body["owner_handle"] == "alice-a3b4"
    assert body["vault_locked"] is True
    assert isinstance(body["skill_count"], int)
    assert isinstance(body["vault_count"], int)


@pytest.mark.asyncio
async def test_preview_does_not_bump_redeem_count(client_unauth, db_session, seed_user, seed_scope):
    from sqlalchemy import select

    raw = await _make_share_link(db_session, seed_scope, seed_user)
    await client_unauth.get(f"/api/share/{raw}/preview")
    await client_unauth.get(f"/api/share/{raw}/preview")
    db_session.expire_all()
    link = (
        await db_session.execute(
            select(ScopeShareLink).where(ScopeShareLink.token_hash == hash_share_token(raw))
        )
    ).scalar_one()
    assert link.redeem_count == 0
    assert link.last_redeemed_at is None


@pytest.mark.asyncio
async def test_redeem_bumps_redeem_count(client_unauth, db_session, seed_user, seed_scope):
    from sqlalchemy import select

    raw = await _make_share_link(db_session, seed_scope, seed_user)
    await client_unauth.post(f"/api/share/{raw}/redeem")
    await client_unauth.post(f"/api/share/{raw}/redeem")
    db_session.expire_all()
    link = (
        await db_session.execute(
            select(ScopeShareLink).where(ScopeShareLink.token_hash == hash_share_token(raw))
        )
    ).scalar_one()
    assert link.redeem_count == 2
    assert link.last_redeemed_at is not None


@pytest.mark.asyncio
async def test_upgrade_owner_returns_409(db_session, seed_user, seed_scope):
    """Owner upgrades their own scope -> 409 already_owner. Uses an
    authed client (not client_unauth) since /upgrade requires
    require_user_auth_unbound. The owner of the seed_scope IS
    seed_user, so this is the self-share case."""

    async def _override_get_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def _override_get_auth() -> AuthContext:
        return AuthContext(user=seed_user)

    app.dependency_overrides[get_session] = _override_get_session
    app.dependency_overrides[get_auth] = _override_get_auth
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            raw = await _make_share_link(db_session, seed_scope, seed_user)
            r = await ac.post(f"/api/share/{raw}/upgrade")
            assert r.status_code == 409, r.text
            assert r.json()["detail"]["error"] == "already_owner"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_upgrade_other_user_creates_membership(db_session, seed_user, seed_scope):
    """A different authed user upgrading creates a viewer membership
    with the frozen owner_handle. Idempotent on repeat call."""
    import uuid as _uuid

    from sqlalchemy import select

    from app.models.scope_membership import ScopeMembership

    nonce = _uuid.uuid4().hex[:8]
    sharee = User(clerk_id=f"user_test_bob_{nonce}", email=f"bob_{nonce}@example.com", name="Bob")
    db_session.add(sharee)
    await db_session.commit()
    await db_session.refresh(sharee)

    async def _override_get_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def _override_get_auth() -> AuthContext:
        return AuthContext(user=sharee)

    app.dependency_overrides[get_session] = _override_get_session
    app.dependency_overrides[get_auth] = _override_get_auth
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            raw = await _make_share_link(db_session, seed_scope, seed_user)
            r = await ac.post(f"/api/share/{raw}/upgrade")
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["scope_id"] == str(seed_scope.id)
            assert body["resolved_owner_handle"] == "alice-a3b4"
            # Idempotent repeat call returns the same row (and same
            # membership_id, not a fresh one).
            r2 = await ac.post(f"/api/share/{raw}/upgrade")
            assert r2.status_code == 200
            assert r2.json()["membership_id"] == body["membership_id"]
    finally:
        app.dependency_overrides.clear()

    # Verify exactly one membership row, with frozen handle + viewer
    # role. Uses a fresh AsyncSession (not the test's `db_session`
    # which has done partial IO under override) — same DB so the
    # committed row is visible. Phase G E2E covers fuller assertions.
    from app.core.database import async_session_factory

    async with async_session_factory() as fresh:
        rows = (
            (
                await fresh.execute(
                    select(ScopeMembership).where(ScopeMembership.user_id == sharee.id)
                )
            )
            .scalars()
            .all()
        )
        assert len(rows) == 1
        assert rows[0].role == "viewer"
        assert rows[0].joined_via == "link"
        assert rows[0].resolved_owner_handle == "alice-a3b4"
