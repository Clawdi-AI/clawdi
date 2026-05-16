"""Smoke tests for /api/share/{token}/{preview,redeem,upgrade}.

Sanity coverage for public share-token endpoints: the routes load,
route, and respond with the right shapes + status codes.
"""

from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
from app.main import app
from app.models.project_share_link import ProjectShareLink
from app.models.share_redeem_attempt import ShareRedeemAttempt
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


async def _make_share_link(db_session, seed_project, seed_user) -> str:
    raw = generate_share_token()
    link = ProjectShareLink(
        project_id=seed_project.id,
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
    client_unauth, db_session, seed_user, seed_project
):
    raw = await _make_share_link(db_session, seed_project, seed_user)
    r = await client_unauth.get(f"/api/share/{raw}/preview")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["project_id"] == str(seed_project.id)
    assert body["project_name"] == seed_project.name
    assert body["owner_display"] in (seed_user.name, seed_user.email)
    assert body["owner_handle"] == "alice-a3b4"
    assert body["vault_locked"] is True
    assert isinstance(body["skill_count"], int)
    assert isinstance(body["vault_count"], int)


@pytest.mark.asyncio
async def test_preview_does_not_bump_redeem_count(
    client_unauth, db_session, seed_user, seed_project
):
    raw = await _make_share_link(db_session, seed_project, seed_user)
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
async def test_redeem_bumps_redeem_count(client_unauth, db_session, seed_user, seed_project):
    raw = await _make_share_link(db_session, seed_project, seed_user)
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
    client_unauth, db_session, seed_user, seed_project
):
    raw = await _make_share_link(db_session, seed_project, seed_user)
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
    client_unauth, db_session, monkeypatch, seed_user, seed_project
):
    from app.routes import share_redeem as share_redeem_routes

    monkeypatch.setattr(share_redeem_routes, "_REDEEM_RATE_LIMIT", 2)
    raw = await _make_share_link(db_session, seed_project, seed_user)

    assert (await client_unauth.post(f"/api/share/{raw}/redeem")).status_code == 200
    assert (await client_unauth.post(f"/api/share/{raw}/redeem")).status_code == 200
    blocked = await client_unauth.post(f"/api/share/{raw}/redeem")
    assert blocked.status_code == 429, blocked.text
    assert blocked.headers["retry-after"]


@pytest.mark.asyncio
async def test_redeem_attempts_are_persistent_and_prune_stale(
    client_unauth, db_session, seed_user, seed_project
):
    raw = await _make_share_link(db_session, seed_project, seed_user)
    link = (
        await db_session.execute(
            select(ProjectShareLink).where(ProjectShareLink.token_hash == hash_share_token(raw))
        )
    ).scalar_one()
    stale = ShareRedeemAttempt(
        link_id=link.id,
        client_key="127.0.0.1",
        created_at=datetime.now(UTC) - timedelta(days=2),
    )
    db_session.add(stale)
    await db_session.commit()

    r = await client_unauth.post(f"/api/share/{raw}/redeem")
    assert r.status_code == 200, r.text

    attempts = (
        (
            await db_session.execute(
                select(ShareRedeemAttempt).where(ShareRedeemAttempt.link_id == link.id)
            )
        )
        .scalars()
        .all()
    )
    assert stale.id not in {attempt.id for attempt in attempts}
    assert len(attempts) == 1


@pytest.mark.asyncio
async def test_upgrade_owner_returns_409(db_session, seed_user, seed_project):
    """Owner upgrades their own project -> 409 already_owner. Uses an
    authed client (not client_unauth) since /upgrade requires
    require_user_auth_unbound. The owner of the seed_project IS
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
            raw = await _make_share_link(db_session, seed_project, seed_user)
            r = await ac.post(f"/api/share/{raw}/upgrade")
            assert r.status_code == 409, r.text
            assert r.json()["detail"]["error"] == "already_owner"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_upgrade_other_user_creates_membership(db_session, seed_user, seed_project):
    """A different authed user upgrading creates a viewer membership
    with the frozen owner_handle. Idempotent on repeat call."""
    import uuid as _uuid

    from sqlalchemy import select

    from app.models.project_membership import ProjectMembership

    nonce = _uuid.uuid4().hex[:8]
    recipient = User(
        clerk_id=f"user_test_bob_{nonce}",
        email=f"bob_{nonce}@example.com",
        name="Bob",
    )
    db_session.add(recipient)
    await db_session.commit()
    await db_session.refresh(recipient)

    async def _override_get_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def _override_get_auth() -> AuthContext:
        return AuthContext(user=recipient)

    app.dependency_overrides[get_session] = _override_get_session
    app.dependency_overrides[get_auth] = _override_get_auth
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            raw = await _make_share_link(db_session, seed_project, seed_user)
            r = await ac.post(f"/api/share/{raw}/upgrade")
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["project_id"] == str(seed_project.id)
            assert body["resolved_owner_handle"] == "alice-a3b4"
            assert "mount_id" not in body  # capability-only
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
                    select(ProjectMembership).where(
                        ProjectMembership.member_user_id == recipient.id
                    )
                )
            )
            .scalars()
            .all()
        )
        assert len(rows) == 1
        assert rows[0].role == "viewer"
        assert rows[0].joined_via == "link"
        assert rows[0].resolved_owner_handle == "alice-a3b4"
