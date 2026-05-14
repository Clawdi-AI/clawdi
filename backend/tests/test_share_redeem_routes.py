"""Smoke tests for /api/share/{token}/{preview,redeem,upgrade}.

Sanity coverage for public share-token endpoints: the routes load,
route, and respond with the right shapes + status codes.
"""

from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
from app.main import app
from app.models.project_share_link import ProjectShareLink
from app.models.user import User
from app.routes import share_redeem as share_redeem_routes
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
    link = ProjectShareLink(
        project_id=seed_scope.id,
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
    assert body["project_id"] == str(seed_scope.id)
    assert body["project_name"] == seed_scope.name
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
            select(ProjectShareLink).where(ProjectShareLink.token_hash == hash_share_token(raw))
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
            select(ProjectShareLink).where(ProjectShareLink.token_hash == hash_share_token(raw))
        )
    ).scalar_one()
    assert link.redeem_count == 2
    assert link.last_redeemed_at is not None


@pytest.mark.asyncio
async def test_redeem_idempotency_key_dedupes_counter(
    client_unauth, db_session, seed_user, seed_scope
):
    from sqlalchemy import select

    share_redeem_routes._redeem_idempotency_seen.clear()
    raw = await _make_share_link(db_session, seed_scope, seed_user)
    headers = {"Idempotency-Key": "retry-1"}
    first = await client_unauth.post(f"/api/share/{raw}/redeem", headers=headers)
    second = await client_unauth.post(f"/api/share/{raw}/redeem", headers=headers)
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text

    db_session.expire_all()
    link = (
        await db_session.execute(
            select(ProjectShareLink).where(ProjectShareLink.token_hash == hash_share_token(raw))
        )
    ).scalar_one()
    assert link.redeem_count == 1


@pytest.mark.asyncio
async def test_redeem_rate_limit_blocks_valid_token_flood(
    client_unauth, db_session, monkeypatch, seed_user, seed_scope
):
    share_redeem_routes._redeem_rate.clear()
    monkeypatch.setattr(share_redeem_routes, "_REDEEM_RATE_LIMIT", 2)
    raw = await _make_share_link(db_session, seed_scope, seed_user)

    assert (await client_unauth.post(f"/api/share/{raw}/redeem")).status_code == 200
    assert (await client_unauth.post(f"/api/share/{raw}/redeem")).status_code == 200
    blocked = await client_unauth.post(f"/api/share/{raw}/redeem")
    assert blocked.status_code == 429, blocked.text
    assert blocked.headers["retry-after"]


def test_redeem_rate_limit_prunes_stale_and_bounds_buckets(monkeypatch):
    share_redeem_routes._redeem_rate.clear()
    monkeypatch.setattr(share_redeem_routes, "_REDEEM_RATE_MAX_BUCKETS", 2)

    now = datetime.now(UTC)
    monkeypatch.setattr(
        share_redeem_routes,
        "_redeem_rate_last_prune_at",
        now - timedelta(minutes=2),
    )
    share_redeem_routes._redeem_rate.update(
        {
            "stale": [now - timedelta(minutes=5)],
            "oldest": [now - timedelta(seconds=50)],
            "newest": [now - timedelta(seconds=10)],
        }
    )
    request = SimpleNamespace(headers={}, client=SimpleNamespace(host="127.0.0.1"))
    ctx = SimpleNamespace(link_id="fresh-link")

    share_redeem_routes._check_redeem_rate_limit(request, ctx)

    assert "stale" not in share_redeem_routes._redeem_rate
    assert "oldest" not in share_redeem_routes._redeem_rate
    assert "127.0.0.1:fresh-link" in share_redeem_routes._redeem_rate
    assert len(share_redeem_routes._redeem_rate) <= 2


def test_redeem_rate_limit_prune_is_time_gated(monkeypatch):
    share_redeem_routes._redeem_rate.clear()

    now = datetime.now(UTC)
    monkeypatch.setattr(share_redeem_routes, "_redeem_rate_last_prune_at", now)
    share_redeem_routes._redeem_rate["stale-other"] = [now - timedelta(minutes=5)]
    request = SimpleNamespace(headers={}, client=SimpleNamespace(host="127.0.0.1"))
    ctx = SimpleNamespace(link_id="fresh-link")

    share_redeem_routes._check_redeem_rate_limit(request, ctx)

    assert "stale-other" in share_redeem_routes._redeem_rate
    assert "127.0.0.1:fresh-link" in share_redeem_routes._redeem_rate


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

    from app.models.project_membership import ProjectMembership

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
            # Use no_mount=True since this test user was created
            # inline without a Personal scope. Auto-mount target
            # resolution would 409 mount_target_ambiguous otherwise
            # (owned=[]). Real users have a Personal scope
            # auto-created at signup; capability-only path is the
            # right shape to verify here.
            r = await ac.post(f"/api/share/{raw}/upgrade", json={"no_mount": True})
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["project_id"] == str(seed_scope.id)
            assert body["resolved_owner_handle"] == "alice-a3b4"
            assert "mount_id" not in body  # capability-only
            # Idempotent repeat call returns the same row (and same
            # membership_id, not a fresh one).
            r2 = await ac.post(f"/api/share/{raw}/upgrade", json={"no_mount": True})
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
                    select(ProjectMembership).where(ProjectMembership.member_user_id == sharee.id)
                )
            )
            .scalars()
            .all()
        )
        assert len(rows) == 1
        assert rows[0].role == "viewer"
        assert rows[0].joined_via == "link"
        assert rows[0].resolved_owner_handle == "alice-a3b4"
