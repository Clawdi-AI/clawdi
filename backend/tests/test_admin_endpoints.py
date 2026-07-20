"""Tests for `/api/admin/*` endpoints.

Auth via X-Admin-Key header (shared secret). Tests run against the
`db_session` directly without dependency overriding the auth gate —
we verify the gate as part of test surface, not bypass it.
"""

import uuid
from collections.abc import AsyncIterator

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport

from app.core.config import settings
from app.core.database import get_session
from app.main import app
from app.services.managed_ai_provider import (
    V2_LEGACY_MANAGED_AI_PROVIDER_ID,
    V2_MANAGED_AI_PROVIDER_ID,
)

_ADMIN_KEY = "test-admin-secret-do-not-use-in-prod"
# Shared header dict for the bulk of tests that exercise the happy-path
# `X-Admin-Key` gate. Tests that deliberately omit or mutate the header
# (auth-gate regression tests) build their own dict inline so the
# tampering stays visible at the call site.
_AUTH = {"X-Admin-Key": _ADMIN_KEY}


@pytest_asyncio.fixture
async def admin_client(db_session, seed_user) -> AsyncIterator[httpx.AsyncClient]:
    """Client that does NOT inject auth — admin endpoints test the
    `X-Admin-Key` header gate directly. Sets settings.admin_api_key
    to a known value for the test project and restores it in teardown
    even if the transport / context-manager raises before yield."""

    async def _override_get_session():
        yield db_session

    original_admin_key = settings.admin_api_key
    settings.admin_api_key = _ADMIN_KEY
    app.dependency_overrides[get_session] = _override_get_session

    # Outer try/finally guards `settings.admin_api_key` restoration
    # against a raise from `ASGITransport(app=app)` or the
    # AsyncClient context manager itself — without it a setup
    # failure here would silently contaminate every subsequent
    # test in the same process with the test-project admin secret.
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac
    finally:
        app.dependency_overrides.clear()
        settings.admin_api_key = original_admin_key


@pytest.mark.asyncio
async def test_admin_mint_requires_admin_key(admin_client, seed_user):
    """Without the X-Admin-Key header, endpoint returns 401."""
    r = await admin_client.post(
        "/v1/admin/auth/keys",
        json={"target_clerk_id": seed_user.clerk_id, "label": "test"},
    )
    assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_admin_mint_rejects_wrong_key(admin_client, seed_user):
    """Wrong header value: 401."""
    r = await admin_client.post(
        "/v1/admin/auth/keys",
        headers={"X-Admin-Key": "wrong-key"},
        json={"target_clerk_id": seed_user.clerk_id, "label": "test"},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "target_clerk_id",
    ["", " user_123", "user 123", "partner:phala:team_123", "x" * 201],
)
async def test_admin_mint_rejects_invalid_target_clerk_id(admin_client, target_clerk_id):
    response = await admin_client.post(
        "/v1/admin/auth/keys",
        headers=_AUTH,
        json={"target_clerk_id": target_clerk_id, "label": "invalid-target"},
    )

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("path", "payload"),
    [
        ("/v1/admin/auth/keys", {"label": "partner-runtime"}),
        (
            "/v1/admin/agents",
            {
                "agent_id": "de9e247b-1c60-4f8a-ad7b-537b16b247a8",
                "machine_id": "partner-agent",
                "machine_name": "Partner Agent",
                "agent_type": "openclaw",
            },
        ),
    ],
)
async def test_legacy_admin_rejects_partner_principal_fields(
    admin_client,
    seed_user,
    path,
    payload,
):
    response = await admin_client.post(
        path,
        headers=_AUTH,
        json={
            "target_clerk_id": seed_user.clerk_id,
            "principal_kind": "partner_tenant",
            "partner_tenant_ref": "phala_cloud:team_123",
            **payload,
        },
    )

    assert response.status_code == 422, response.text
    extra_fields = {
        error["loc"][-1]
        for error in response.json()["detail"]
        if error["type"] == "extra_forbidden"
    }
    assert extra_fields == {"principal_kind", "partner_tenant_ref"}


@pytest.mark.asyncio
async def test_admin_endpoints_disabled_when_unset(db_session, seed_user):
    """If `settings.admin_api_key` is empty, endpoints return 503
    regardless of header. Default OSS posture: admin endpoints are
    OPT-IN, not present unless operator explicitly configures them."""

    async def _override_get_session():
        yield db_session

    original = settings.admin_api_key
    settings.admin_api_key = ""

    app.dependency_overrides[get_session] = _override_get_session
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            r = await ac.post(
                "/v1/admin/auth/keys",
                headers={"X-Admin-Key": "anything"},
                json={"target_clerk_id": seed_user.clerk_id, "label": "test"},
            )
            assert r.status_code == 503
    finally:
        app.dependency_overrides.clear()
        settings.admin_api_key = original


@pytest.mark.asyncio
async def test_admin_mint_default_grants_full_account_access(admin_client, db_session, seed_user):
    """Mint via admin endpoint with no `scopes` field defaults to
    full account access — same as user-self-mint via Clerk JWT."""
    from sqlalchemy import select

    from app.models.api_key import ApiKey

    r = await admin_client.post(
        "/v1/admin/auth/keys",
        headers=_AUTH,
        json={"target_clerk_id": seed_user.clerk_id, "label": "default-scopes"},
    )
    assert r.status_code == 200

    minted = (
        await db_session.execute(
            select(ApiKey).where(ApiKey.user_id == seed_user.id, ApiKey.label == "default-scopes")
        )
    ).scalar_one()

    # `scopes=None` is the full-API-permission sentinel; matches
    # user-self-mint behaviour. Hosted pods need full parity with
    # self-managed installs (vault reads, memory reads) so the admin
    # path does not impose a permission ceiling.
    assert minted.scopes is None


@pytest.mark.asyncio
async def test_admin_mint_accepts_explicit_narrow_scopes(admin_client, db_session, seed_user):
    """Callers can lock the minted key down by passing an explicit
    API permission list — useful for ops tooling that doesn't need everything."""
    from sqlalchemy import select

    from app.models.api_key import ApiKey

    r = await admin_client.post(
        "/v1/admin/auth/keys",
        headers=_AUTH,
        json={
            "target_clerk_id": seed_user.clerk_id,
            "label": "narrow-explicit",
            "scopes": ["sessions:write"],
        },
    )
    assert r.status_code == 200

    minted = (
        await db_session.execute(
            select(ApiKey).where(ApiKey.user_id == seed_user.id, ApiKey.label == "narrow-explicit")
        )
    ).scalar_one()
    assert minted.scopes == ["sessions:write"]


@pytest.mark.asyncio
async def test_admin_mint_accepts_managed_flag(admin_client, db_session, seed_user):
    from sqlalchemy import select

    from app.models.api_key import ApiKey

    response = await admin_client.post(
        "/v1/admin/auth/keys",
        headers=_AUTH,
        json={
            "target_clerk_id": seed_user.clerk_id,
            "label": "platform-managed",
            "managed": True,
        },
    )
    assert response.status_code == 200, response.text

    minted = (
        await db_session.execute(
            select(ApiKey).where(ApiKey.user_id == seed_user.id, ApiKey.label == "platform-managed")
        )
    ).scalar_one()
    assert minted.managed is True
    assert minted.environment_id is None


@pytest.mark.asyncio
async def test_admin_managed_environment_key_stays_legacy_and_rejects_v2_binding(
    admin_client,
    db_session,
    seed_user,
):

    from sqlalchemy import func, select

    from app.models.api_key import ApiKey
    from app.models.runtime_observation import V2RuntimeEnvironmentFence
    from tests.conftest import create_env_with_project

    legacy_environment = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"legacy-managed-{uuid.uuid4().hex}",
        machine_name="legacy-managed",
    )
    strict_v2_environment = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"strict-v2-managed-{uuid.uuid4().hex}",
        machine_name="strict-v2-managed",
    )

    legacy = await admin_client.post(
        "/v1/admin/auth/keys",
        headers=_AUTH,
        json={
            "target_clerk_id": seed_user.clerk_id,
            "label": "legacy-managed-environment",
            "environment_id": str(legacy_environment.id),
            "managed": True,
        },
    )
    rejected_v2 = await admin_client.post(
        "/v1/admin/auth/keys",
        headers=_AUTH,
        json={
            "target_clerk_id": seed_user.clerk_id,
            "label": "strict-v2-managed-environment",
            "environment_id": str(strict_v2_environment.id),
            "deployment_id": "deployment-strict-v2",
            "managed": True,
        },
    )

    assert legacy.status_code == 200, legacy.text
    assert rejected_v2.status_code == 422, rejected_v2.text
    assert any(error["loc"][-1] == "deployment_id" for error in rejected_v2.json()["detail"])
    assert await db_session.get(V2RuntimeEnvironmentFence, legacy_environment.id) is None
    assert await db_session.get(V2RuntimeEnvironmentFence, strict_v2_environment.id) is None
    legacy_key = (
        await db_session.execute(select(ApiKey).where(ApiKey.label == "legacy-managed-environment"))
    ).scalar_one()
    assert legacy_key.runtime_deployment_id is None
    rejected_key_count = await db_session.scalar(
        select(func.count())
        .select_from(ApiKey)
        .where(ApiKey.label == "strict-v2-managed-environment")
    )
    assert rejected_key_count == 0


@pytest.mark.asyncio
async def test_admin_mint_accepts_arbitrary_scopes(admin_client, db_session, seed_user):
    """No allowlist ceiling: callers can mint keys carrying any API
    permission they want (vault:resolve, sessions:read, etc.). Trust
    model is that X-Admin-Key holders are already first-party SaaS callers."""
    from sqlalchemy import select

    from app.models.api_key import ApiKey

    r = await admin_client.post(
        "/v1/admin/auth/keys",
        headers=_AUTH,
        json={
            "target_clerk_id": seed_user.clerk_id,
            "label": "vault-and-read",
            "scopes": ["sessions:read", "vault:resolve"],
        },
    )
    assert r.status_code == 200

    minted = (
        await db_session.execute(
            select(ApiKey).where(ApiKey.user_id == seed_user.id, ApiKey.label == "vault-and-read")
        )
    ).scalar_one()
    assert minted.scopes == ["sessions:read", "vault:resolve"]


@pytest.mark.asyncio
async def test_admin_mint_api_key_writes_control_plane_audit(admin_client, db_session, seed_user):
    from sqlalchemy import select

    from app.models.audit import ControlPlaneAuditEvent

    response = await admin_client.post(
        "/v1/admin/auth/keys",
        headers=_AUTH,
        json={
            "target_clerk_id": seed_user.clerk_id,
            "label": "audit-mint",
            "managed": True,
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()

    event = (
        await db_session.execute(
            select(ControlPlaneAuditEvent).where(
                ControlPlaneAuditEvent.action == "api_key.mint",
                ControlPlaneAuditEvent.resource_id == body["id"],
            )
        )
    ).scalar_one()
    assert event.actor_type == "admin"
    assert event.resource_type == "api_key"
    assert event.target_user_id == seed_user.id
    assert event.source == "api.admin"
    assert event.details["label"] == "audit-mint"
    assert event.details["key_prefix"] == body["key_prefix"]
    assert event.details["managed"] is True
    assert event.details["has_environment_binding"] is False
    assert body["raw_key"] not in str(event.details)


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_admin_mint_api_key_rolls_back_key_when_audit_fails(
    admin_client, engine, seed_user, monkeypatch
):
    """Key row and audit event share one transaction.

    A key that commits while the caller gets a 500 is an untrackable,
    unrevokable credential: the SaaS side only learns `key_id` from a
    successful response, so it can never revoke what it never saw.
    """
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.models.api_key import ApiKey
    from app.routes import admin as admin_routes

    def explode(*args, **kwargs):
        raise RuntimeError("audit write failed")

    monkeypatch.setattr(admin_routes, "record_control_plane_audit", explode)

    with pytest.raises(RuntimeError):
        await admin_client.post(
            "/v1/admin/auth/keys",
            headers=_AUTH,
            json={
                "target_clerk_id": seed_user.clerk_id,
                "label": "orphan-check",
                "managed": True,
            },
        )

    # Assert through a fresh session: it only sees committed rows. A key
    # visible here was committed before the audit event — the exact
    # orphan this test guards against.
    async with async_sessionmaker(engine, expire_on_commit=False)() as fresh:
        # Prove this test is in the real-commit lane: the independently
        # connected observer must see the fixture user before checking the
        # failed mutation. Otherwise an outer test transaction could hide
        # both a broken early commit and the setup row.
        assert await fresh.get(type(seed_user), seed_user.id) is not None
        orphan = (
            await fresh.execute(
                select(ApiKey).where(ApiKey.user_id == seed_user.id, ApiKey.label == "orphan-check")
            )
        ).scalar_one_or_none()
    assert orphan is None


@pytest.mark.asyncio
async def test_admin_mint_lazy_creates_user(admin_client, db_session):
    """First-time deploy path: a user who's never visited cloud-api
    directly (no row yet) clicks Deploy on the upstream SaaS
    dashboard. SaaS calls admin mint with their Clerk id. cloud-api
    lazy-creates the user row + Personal project, then mints normally —
    same identity the user gets when they later sign in directly.

    Without this, the most common SaaS-side entry path silently
    fails: deploy succeeds but pod has no sync env, user has to
    redeploy after their first direct cloud-api visit.
    """
    # Random per-run clerk_id — test DB is real Postgres and rows
    # persist across test runs; a hardcoded id would collide.

    from sqlalchemy import select

    from app.models.project import PROJECT_KIND_PERSONAL, Project
    from app.models.user import User

    novel_clerk_id = f"user_first_deploy_{uuid.uuid4().hex[:12]}"

    # Pre-flight: confirm the user really doesn't exist yet.
    pre = (
        await db_session.execute(select(User).where(User.clerk_id == novel_clerk_id))
    ).scalar_one_or_none()
    assert pre is None

    r = await admin_client.post(
        "/v1/admin/auth/keys",
        headers=_AUTH,
        json={"target_clerk_id": novel_clerk_id, "label": "first-deploy"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["raw_key"].startswith("clawdi_")

    # User row was created with the right clerk_id, no email/name
    # (admin endpoint doesn't have those — JWT path will fill on
    # first cloud.clawdi.ai sign-in).
    user = (
        await db_session.execute(select(User).where(User.clerk_id == novel_clerk_id))
    ).scalar_one()
    assert user.principal_kind == "clerk"
    assert user.partner_tenant_ref is None
    assert user.email is None
    assert user.name is None

    # Personal project was created in the same transaction. Downstream
    # resolvers assume it exists; this matches the JWT path's
    # invariant.
    personal = (
        await db_session.execute(
            select(Project).where(Project.user_id == user.id, Project.kind == PROJECT_KIND_PERSONAL)
        )
    ).scalar_one_or_none()
    assert personal is not None
    assert personal.slug == "personal"


@pytest.mark.asyncio
async def test_admin_mint_existing_user_reuses_row(admin_client, db_session, seed_user):
    """Re-minting for an existing user MUST reuse the row, not
    create a new one. Test pins the idempotency contract — if the
    helper accidentally always inserts, every admin mint would
    explode on the clerk_id unique constraint."""
    from sqlalchemy import func, select

    from app.models.user import User

    pre_count = (await db_session.execute(select(func.count(User.id)))).scalar_one()

    r = await admin_client.post(
        "/v1/admin/auth/keys",
        headers=_AUTH,
        json={"target_clerk_id": seed_user.clerk_id, "label": "second-mint"},
    )
    assert r.status_code == 200

    post_count = (await db_session.execute(select(func.count(User.id)))).scalar_one()
    assert post_count == pre_count, "lazy-create must skip when user already exists"


@pytest.mark.asyncio
async def test_admin_mint_lazy_create_handles_race(db_session):
    """Concurrent admin calls for the same brand-new clerk_id race
    on the `users.clerk_id` unique constraint. The loser must
    catch IntegrityError, rollback, and adopt the winner's row —
    not 500 with a unique-constraint traceback.

    Real-world race: a user clicks Deploy on clawdi.ai (admin mint
    fires) AND signs into cloud.clawdi.ai (JWT lazy-create fires)
    in the same second. Whichever reaches `db.flush` first wins;
    the other must converge gracefully.

    Test simulates this by injecting an IntegrityError on the first
    flush attempt and verifying the rollback+re-query path returns
    the row that the "winner" (separately seeded) wrote.
    """
    from unittest.mock import AsyncMock

    from sqlalchemy.exc import IntegrityError

    from app.models.user import User
    from app.routes.admin import _resolve_or_create_user

    clerk_id = f"clerk_race_{uuid.uuid4().hex[:12]}"

    # Seed the "winner's" row: this is what `_resolve_or_create_user`
    # will find after rolling back its losing flush.
    winner = User(clerk_id=clerk_id, email=None, name=None)
    db_session.add(winner)
    await db_session.commit()

    # Make `db.flush()` raise IntegrityError exactly once — the
    # path the loser takes when its INSERT trips the unique
    # constraint. Real flush() is restored after the first call so
    # any later flush (Personal project insert, etc.) works normally.
    real_flush = db_session.flush
    flush_calls = {"count": 0}

    async def mock_flush(*args, **kwargs):
        flush_calls["count"] += 1
        if flush_calls["count"] == 1:
            raise IntegrityError("simulated race", None, Exception())
        return await real_flush(*args, **kwargs)

    db_session.flush = AsyncMock(side_effect=mock_flush)

    try:
        result = await _resolve_or_create_user(db_session, clerk_id)
    finally:
        db_session.flush = real_flush

    # The loser converged onto the winner's row.
    assert result.clerk_id == clerk_id
    assert result.id == winner.id
    # No duplicate row — the unique constraint did its job.
    from sqlalchemy import func, select

    count = (
        await db_session.execute(select(func.count(User.id)).where(User.clerk_id == clerk_id))
    ).scalar_one()
    assert count == 1


@pytest.mark.asyncio
async def test_admin_mint_lazy_create_500s_when_winner_disappears(db_session):
    """Pathological case: IntegrityError fires (someone else
    inserted), but by the time we re-query, the row is gone (would
    require a concurrent delete — extremely unlikely). Helper must
    surface as 500 rather than 404 so the SaaS caller sees this is
    an operational anomaly, not a wrong-clerk_id payload.
    """
    from unittest.mock import AsyncMock

    from fastapi import HTTPException
    from sqlalchemy.exc import IntegrityError

    from app.routes.admin import _resolve_or_create_user

    clerk_id = f"clerk_ghost_winner_{uuid.uuid4().hex[:12]}"

    # No row pre-seeded — re-query after rollback will find nothing.
    real_flush = db_session.flush

    async def mock_flush(*args, **kwargs):
        raise IntegrityError("simulated race", None, Exception())

    db_session.flush = AsyncMock(side_effect=mock_flush)

    try:
        with pytest.raises(HTTPException) as exc_info:
            await _resolve_or_create_user(db_session, clerk_id)
    finally:
        db_session.flush = real_flush

    assert exc_info.value.status_code == 500
    assert "could not create or load user" in exc_info.value.detail


@pytest.mark.asyncio
async def test_admin_lazy_create_creates_personal_project(db_session):
    """The lazy-create transaction MUST create a Personal project
    alongside the User row. Downstream resolvers (sessions, skills,
    memories) all assume every user has one and 500 without it.
    JWT path enforces the same invariant; admin path must too."""

    from sqlalchemy import select

    from app.models.project import PROJECT_KIND_PERSONAL, Project
    from app.routes.admin import _resolve_or_create_user

    clerk_id = f"clerk_project_inv_{uuid.uuid4().hex[:12]}"
    user = await _resolve_or_create_user(db_session, clerk_id)

    personal = (
        await db_session.execute(
            select(Project).where(Project.user_id == user.id, Project.kind == PROJECT_KIND_PERSONAL)
        )
    ).scalar_one_or_none()
    assert personal is not None, "Personal project must exist after lazy-create"
    assert personal.slug == "personal"


@pytest.mark.asyncio
async def test_admin_revoke_happy_path(admin_client, db_session, seed_user):
    """Mint a key, then revoke it via admin endpoint. Verify revoked_at set."""
    from sqlalchemy import select

    from app.models.api_key import ApiKey

    minted_resp = await admin_client.post(
        "/v1/admin/auth/keys",
        headers=_AUTH,
        json={"target_clerk_id": seed_user.clerk_id, "label": "to-revoke"},
    )
    key_id = minted_resp.json()["id"]

    r = await admin_client.delete(
        f"/v1/admin/auth/keys/{key_id}",
        headers=_AUTH,
    )
    assert r.status_code == 200
    assert r.json()["status"] == "revoked"

    db_session.expire_all()
    row = (await db_session.execute(select(ApiKey).where(ApiKey.id == key_id))).scalar_one()
    assert row.revoked_at is not None


@pytest.mark.asyncio
async def test_admin_revoke_api_key_writes_control_plane_audit(admin_client, db_session, seed_user):
    from sqlalchemy import select

    from app.models.audit import ControlPlaneAuditEvent

    minted_response = await admin_client.post(
        "/v1/admin/auth/keys",
        headers=_AUTH,
        json={"target_clerk_id": seed_user.clerk_id, "label": "audit-revoke"},
    )
    assert minted_response.status_code == 200, minted_response.text
    minted = minted_response.json()

    response = await admin_client.delete(
        f"/v1/admin/auth/keys/{minted['id']}",
        headers=_AUTH,
    )
    assert response.status_code == 200, response.text

    event = (
        await db_session.execute(
            select(ControlPlaneAuditEvent).where(
                ControlPlaneAuditEvent.action == "api_key.revoke",
                ControlPlaneAuditEvent.resource_id == minted["id"],
            )
        )
    ).scalar_one()
    assert event.actor_type == "admin"
    assert event.resource_type == "api_key"
    assert event.target_user_id == seed_user.id
    assert event.source == "api.admin"
    assert event.details["label"] == "audit-revoke"
    assert event.details["key_prefix"] == minted["key_prefix"]
    assert minted["raw_key"] not in str(event.details)


@pytest.mark.asyncio
async def test_admin_revoke_can_revoke_managed_key(admin_client, db_session, seed_user):
    from sqlalchemy import select

    from app.models.api_key import ApiKey

    minted_resp = await admin_client.post(
        "/v1/admin/auth/keys",
        headers=_AUTH,
        json={
            "target_clerk_id": seed_user.clerk_id,
            "label": "managed-to-revoke",
            "managed": True,
        },
    )
    key_id = minted_resp.json()["id"]

    response = await admin_client.delete(
        f"/v1/admin/auth/keys/{key_id}",
        headers=_AUTH,
    )
    assert response.status_code == 200, response.text

    row = (await db_session.execute(select(ApiKey).where(ApiKey.id == key_id))).scalar_one()
    assert row.managed is True
    assert row.revoked_at is not None


@pytest.mark.asyncio
async def test_admin_revoke_idempotent_on_already_revoked(admin_client, db_session, seed_user):
    """Revoking an already-revoked key returns 200 (idempotent), not
    an error. Useful for migration retry semantics."""
    minted_resp = await admin_client.post(
        "/v1/admin/auth/keys",
        headers=_AUTH,
        json={"target_clerk_id": seed_user.clerk_id, "label": "double-revoke"},
    )
    key_id = minted_resp.json()["id"]

    await admin_client.delete(
        f"/v1/admin/auth/keys/{key_id}",
        headers=_AUTH,
    )
    r = await admin_client.delete(
        f"/v1/admin/auth/keys/{key_id}",
        headers=_AUTH,
    )
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_admin_revoke_unknown_key(admin_client):
    """404 for a key id that doesn't exist."""

    r = await admin_client.delete(
        f"/v1/admin/auth/keys/{uuid.uuid4()}",
        headers=_AUTH,
    )
    assert r.status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "route_provider_id",
    [V2_MANAGED_AI_PROVIDER_ID, V2_LEGACY_MANAGED_AI_PROVIDER_ID],
)
async def test_admin_upsert_managed_ai_provider_writes_fixed_contract(
    admin_client, db_session, seed_user, route_provider_id: str
):
    from sqlalchemy import select

    from app.models.ai_provider import AiProvider, AiProviderAuthPayload
    from app.services.managed_ai_provider import (
        MANAGED_AI_PROVIDER_API_MODE,
        MANAGED_AI_PROVIDER_RUNTIME_ENV,
    )
    from app.services.vault_crypto import decrypt

    raw_key = "sk-admin-managed-secret"
    managed_models = [
        {
            "id": "gpt-5.4-mini",
            "context_window": 272000,
            "max_tokens": 128000,
            "input_modalities": ["text", "image"],
            "supports_vision": True,
            "supports_tools": True,
            "supports_reasoning": True,
        }
    ]
    r = await admin_client.put(
        f"/v1/admin/ai-providers/{route_provider_id}",
        headers=_AUTH,
        json={
            "target_clerk_id": seed_user.clerk_id,
            "base_url": "https://ai-gateway.clawdi.ai/v1",
            "api_key": raw_key,
            "default_model": "gpt-5.4-mini",
            "models": managed_models,
        },
    )
    assert r.status_code == 200, r.text
    assert raw_key not in r.text
    assert r.json() == {
        "owner_user_id": str(seed_user.id),
        "owner_clerk_id": seed_user.clerk_id,
        "provider_id": route_provider_id,
        "api_mode": MANAGED_AI_PROVIDER_API_MODE,
        "runtime_env_name": MANAGED_AI_PROVIDER_RUNTIME_ENV,
        "base_url": "https://ai-gateway.clawdi.ai/v1",
        "models": managed_models,
        "has_api_key": True,
    }

    provider = (
        await db_session.execute(
            select(AiProvider).where(
                AiProvider.owner_user_id == seed_user.id,
                AiProvider.provider_id == route_provider_id,
            )
        )
    ).scalar_one()
    assert provider.type == "custom_openai_compatible"
    assert provider.api_mode == MANAGED_AI_PROVIDER_API_MODE
    assert provider.auth_type == "api_key"
    assert provider.auth_ref is None
    assert provider.auth_metadata == {"source": "managed", "profile": "default"}
    assert provider.managed_by == "clawdi"
    assert provider.runtime_env_name == MANAGED_AI_PROVIDER_RUNTIME_ENV
    assert provider.models == managed_models
    assert provider.archived_at is None

    payload = (
        await db_session.execute(
            select(AiProviderAuthPayload).where(
                AiProviderAuthPayload.owner_user_id == seed_user.id,
                AiProviderAuthPayload.provider_id == route_provider_id,
                AiProviderAuthPayload.auth_profile == "default",
            )
        )
    ).scalar_one()
    assert payload.kind == "api_key"
    assert payload.source == "managed"
    assert payload.payload_metadata == {"runtime_env_name": MANAGED_AI_PROVIDER_RUNTIME_ENV}
    assert decrypt(payload.encrypted_payload, payload.nonce) == raw_key


@pytest.mark.asyncio
async def test_admin_upsert_managed_ai_provider_rejects_unknown_id(admin_client, seed_user):
    response = await admin_client.put(
        "/v1/admin/ai-providers/not-clawdi-managed",
        headers=_AUTH,
        json={
            "target_clerk_id": seed_user.clerk_id,
            "base_url": "https://ai-gateway.clawdi.ai/v1",
            "api_key": "sk-unsupported-provider",
        },
    )

    assert response.status_code == 404, response.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "model",
    [
        {"id": "gpt-test", "context_window": 0},
        {"id": "gpt-test", "max_tokens": 0},
        {"id": "gpt-test", "label": ""},
        {"id": "gpt-test", "alias": ""},
        {"id": "gpt-test", "max_tokens": None},
        {"id": "gpt-test", "unknown": True},
        {"id": "gpt-test", "capabilities": {"audio": True}},
        {"id": "gpt-test", "capabilities": {"chat": 1}},
        {"id": "gpt-test", "capabilities": {"chat": None}},
        {"id": "gpt-test", "cost": {"input": 1, "output": 2, "currency": "USD"}},
        {"id": "gpt-test", "cost": {"input": 1, "output": 2, "cache_write": None}},
    ],
    ids=[
        "zero-context-window",
        "zero-max-tokens",
        "empty-label",
        "empty-alias",
        "null-model-field",
        "unknown-model-field",
        "unknown-capability",
        "non-bool-capability",
        "null-capability",
        "unknown-cost-field",
        "null-cost-field",
    ],
)
async def test_admin_managed_ai_provider_rejects_models_outside_hosted_wire_contract(
    admin_client,
    seed_user,
    model: dict,
):
    response = await admin_client.put(
        f"/v1/admin/ai-providers/{V2_MANAGED_AI_PROVIDER_ID}",
        headers=_AUTH,
        json={
            "target_clerk_id": seed_user.clerk_id,
            "base_url": "https://ai-gateway.clawdi.ai/v1",
            "api_key": "sk-strict-model-test",
            "models": [model],
        },
    )

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_admin_upsert_managed_ai_provider_rotates_existing_payload(
    admin_client, db_session, seed_user
):
    from sqlalchemy import select

    from app.models.ai_provider import AiProvider, AiProviderAuthPayload
    from app.services.managed_ai_provider import MANAGED_AI_PROVIDER_ID
    from app.services.vault_crypto import decrypt

    first = await admin_client.put(
        f"/v1/admin/ai-providers/{MANAGED_AI_PROVIDER_ID}",
        headers=_AUTH,
        json={
            "target_clerk_id": seed_user.clerk_id,
            "base_url": "https://ai-gateway.clawdi.ai/v1",
            "api_key": "sk-first-admin-managed-secret",
        },
    )
    assert first.status_code == 200, first.text
    second_key = "sk-second-admin-managed-secret"
    second = await admin_client.put(
        f"/v1/admin/ai-providers/{MANAGED_AI_PROVIDER_ID}",
        headers=_AUTH,
        json={
            "target_clerk_id": seed_user.clerk_id,
            "base_url": "https://ai-gateway.clawdi.ai/v1",
            "api_key": second_key,
            "default_model": "gpt-5.4",
        },
    )
    assert second.status_code == 200, second.text
    assert second_key not in second.text

    providers = (
        (
            await db_session.execute(
                select(AiProvider).where(
                    AiProvider.owner_user_id == seed_user.id,
                    AiProvider.provider_id == MANAGED_AI_PROVIDER_ID,
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(providers) == 1
    assert providers[0].models == [{"id": "gpt-5.4"}]

    payloads = (
        (
            await db_session.execute(
                select(AiProviderAuthPayload).where(
                    AiProviderAuthPayload.owner_user_id == seed_user.id,
                    AiProviderAuthPayload.provider_id == MANAGED_AI_PROVIDER_ID,
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(payloads) == 1
    assert decrypt(payloads[0].encrypted_payload, payloads[0].nonce) == second_key


@pytest.mark.asyncio
async def test_admin_upsert_managed_ai_provider_rejects_invalid_base_url(admin_client, seed_user):
    raw_key = "sk-invalid-url-secret"
    r = await admin_client.put(
        f"/v1/admin/ai-providers/{V2_MANAGED_AI_PROVIDER_ID}",
        headers=_AUTH,
        json={
            "target_clerk_id": seed_user.clerk_id,
            "base_url": "not-a-url",
            "api_key": raw_key,
        },
    )
    assert r.status_code == 422
    assert raw_key not in r.text


@pytest.mark.asyncio
async def test_admin_channel_lifecycle_manages_public_bot(admin_client, db_session, seed_user):

    from sqlalchemy import select

    from app.models.channel import ChannelAccount
    from app.services.channels import (
        decrypt_provider_token,
        get_channel_secret,
        verify_hashed_token,
    )

    created = await admin_client.post(
        "/v1/admin/channels",
        headers=_AUTH,
        json={
            "target_clerk_id": seed_user.clerk_id,
            "provider": "telegram",
            "name": f"admin-public-{uuid.uuid4().hex}",
            "visibility": "public",
            "provider_token": "123456:admin-token",
            "config": {"commands": "managed"},
            "secrets": {"app_secret": "secret-v1"},
        },
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["owner_clerk_id"] == seed_user.clerk_id
    assert body["visibility"] == "public"
    assert body["has_provider_token"] is True
    assert body["webhook_secret"]
    assert "admin-token" not in created.text
    assert "secret-v1" not in created.text

    account = (
        await db_session.execute(select(ChannelAccount).where(ChannelAccount.id == body["id"]))
    ).scalar_one()
    assert account.user_id == seed_user.id
    assert account.visibility == "public"
    assert decrypt_provider_token(account) == "123456:admin-token"
    assert await get_channel_secret(db_session, account=account, name="app_secret") == "secret-v1"

    listed = await admin_client.get(
        "/v1/admin/channels",
        headers=_AUTH,
        params={"visibility": "public", "provider": "telegram"},
    )
    assert listed.status_code == 200
    assert body["id"] in {item["id"] for item in listed.json()}

    patched = await admin_client.patch(
        f"/v1/admin/channels/{body['id']}",
        headers=_AUTH,
        json={
            "name": "admin-public-renamed",
            "provider_token": None,
            "config": {"commands": "rotated"},
            "secrets": {"app_secret": "secret-v2"},
        },
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["name"] == "admin-public-renamed"
    assert patched.json()["has_provider_token"] is False
    assert patched.json()["config"] == {"commands": "rotated"}

    await db_session.refresh(account)
    assert account.encrypted_provider_token is None
    assert account.provider_token_nonce is None
    assert await get_channel_secret(db_session, account=account, name="app_secret") == "secret-v2"

    rotated = await admin_client.post(
        f"/v1/admin/channels/{body['id']}/webhook-secret/rotate",
        headers=_AUTH,
    )
    assert rotated.status_code == 200
    await db_session.refresh(account)
    assert verify_hashed_token(rotated.json()["webhook_secret"], account.webhook_secret_hash)

    deleted = await admin_client.delete(f"/v1/admin/channels/{body['id']}", headers=_AUTH)
    assert deleted.status_code == 204
    await db_session.refresh(account)
    assert account.archived_at is not None

    archived = await admin_client.get(f"/v1/admin/channels/{body['id']}", headers=_AUTH)
    assert archived.status_code == 200
    assert archived.json()["archived_at"] is not None


@pytest.mark.asyncio
async def test_admin_channel_create_requires_admin_key(admin_client, seed_user):
    r = await admin_client.post(
        "/v1/admin/channels",
        json={
            "target_clerk_id": seed_user.clerk_id,
            "provider": "telegram",
            "name": "admin-channel-no-key",
        },
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_admin_register_env_creates_with_project(admin_client, client, db_session, seed_user):
    """Admin env registration creates an AgentEnvironment AND a
    default project, matching the user-facing register_environment
    contract. Migration tooling depends on default_project_id being
    set so the daemon can upload."""
    from sqlalchemy import select

    from app.models.session import AgentEnvironment

    r = await admin_client.post(
        "/v1/admin/environments",
        headers=_AUTH,
        json={
            "target_clerk_id": seed_user.clerk_id,
            "machine_id": "migrate-machine-1",
            "machine_name": "migrated-pod",
            "agent_type": "openclaw",
        },
    )
    assert r.status_code == 200, r.text
    env_id = r.json()["id"]

    env = (
        await db_session.execute(select(AgentEnvironment).where(AgentEnvironment.id == env_id))
    ).scalar_one()
    assert env.user_id == seed_user.id
    assert env.machine_id == "migrate-machine-1"
    assert env.registration_key == "machine:migrate-machine-1:agent:openclaw"
    assert env.default_project_id is not None  # heal logic ran

    detail = await client.get(f"/v1/environments/{env_id}")
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["explicit_identity"] is False
    assert "registration_key" not in body


@pytest.mark.asyncio
async def test_admin_register_env_accepts_explicit_agent_id(
    admin_client, client, db_session, seed_user
):
    """Hosted registration owns the stable agent id. Machine fields are metadata."""

    from sqlalchemy import select

    from app.models.session import AgentEnvironment

    machine_key = await admin_client.post(
        "/v1/admin/environments",
        headers=_AUTH,
        json={
            "target_clerk_id": seed_user.clerk_id,
            "machine_id": "machine-key-before-explicit",
            "machine_name": "machine-key-pod",
            "agent_type": "openclaw",
        },
    )
    assert machine_key.status_code == 200, machine_key.text
    machine_key_env_id = machine_key.json()["id"]

    agent_id = uuid.uuid4()
    r = await admin_client.post(
        "/v1/admin/environments",
        headers=_AUTH,
        json={
            "target_clerk_id": seed_user.clerk_id,
            "environment_id": str(agent_id),
            "machine_id": "hosted-machine-explicit",
            "machine_name": "hosted-pod",
            "agent_type": "codex",
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["id"] == str(agent_id)

    env = (
        await db_session.execute(select(AgentEnvironment).where(AgentEnvironment.id == agent_id))
    ).scalar_one()
    assert env.user_id == seed_user.id
    assert env.machine_id == "hosted-machine-explicit"
    assert env.machine_name == "hosted-pod"
    assert env.default_name == "Codex"
    assert env.registration_key is None

    detail = await client.get(f"/v1/environments/{agent_id}")
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["explicit_identity"] is True
    assert "registration_key" not in body

    agent_detail = await client.get(f"/v1/agents/{agent_id}")
    assert agent_detail.status_code == 200, agent_detail.text
    assert agent_detail.json()["explicit_identity"] is True

    listing = await client.get("/v1/environments")
    assert listing.status_code == 200, listing.text
    by_id = {item["id"]: item for item in listing.json()}
    assert {
        machine_key_env_id: by_id[machine_key_env_id]["explicit_identity"],
        str(agent_id): by_id[str(agent_id)]["explicit_identity"],
    } == {machine_key_env_id: False, str(agent_id): True}


@pytest.mark.asyncio
async def test_admin_register_env_auto_assigns_explicit_default_names(
    admin_client, db_session, seed_user
):

    from sqlalchemy import select

    from app.models.session import AgentEnvironment

    self_managed = await admin_client.post(
        "/v1/admin/environments",
        headers=_AUTH,
        json={
            "target_clerk_id": seed_user.clerk_id,
            "machine_id": "self-managed-before-explicit",
            "machine_name": "self-managed-before-explicit",
            "agent_type": "openclaw",
        },
    )
    assert self_managed.status_code == 200, self_managed.text

    async def register_explicit(agent_type: str) -> uuid.UUID:
        agent_id = uuid.uuid4()
        created = await admin_client.post(
            "/v1/admin/environments",
            headers=_AUTH,
            json={
                "target_clerk_id": seed_user.clerk_id,
                "environment_id": str(agent_id),
                "machine_id": f"hosted-{agent_type}-{agent_id.hex[:8]}",
                "machine_name": f"hosted-{agent_type}",
                "agent_type": agent_type,
            },
        )
        assert created.status_code == 200, created.text
        return agent_id

    first_openclaw = await register_explicit("openclaw")
    second_openclaw = await register_explicit("openclaw")
    hermes = await register_explicit("hermes")
    codex = await register_explicit("codex")
    claude_code = await register_explicit("claude_code")

    deleted = await admin_client.delete(f"/v1/admin/environments/{first_openclaw}", headers=_AUTH)
    assert deleted.status_code == 204, deleted.text

    third_openclaw = await register_explicit("openclaw")

    rows = (
        await db_session.execute(
            select(
                AgentEnvironment.id,
                AgentEnvironment.default_name,
                AgentEnvironment.registration_key,
            ).where(
                AgentEnvironment.id.in_(
                    [
                        uuid.UUID(self_managed.json()["id"]),
                        second_openclaw,
                        third_openclaw,
                        hermes,
                        codex,
                        claude_code,
                    ]
                )
            )
        )
    ).all()
    by_id = {row.id: row for row in rows}
    assert by_id[uuid.UUID(self_managed.json()["id"])].default_name is None
    assert by_id[uuid.UUID(self_managed.json()["id"])].registration_key is not None
    assert by_id[second_openclaw].default_name == "OpenClaw 2"
    assert by_id[third_openclaw].default_name == "OpenClaw 3"
    assert by_id[hermes].default_name == "Hermes"
    assert by_id[codex].default_name == "Codex"
    assert by_id[claude_code].default_name == "Claude Code"


@pytest.mark.asyncio
async def test_admin_register_env_rejects_default_name_request_field(admin_client, seed_user):

    response = await admin_client.post(
        "/v1/admin/environments",
        headers=_AUTH,
        json={
            "target_clerk_id": seed_user.clerk_id,
            "environment_id": str(uuid.uuid4()),
            "machine_id": "hosted-default-name-rejected",
            "machine_name": "hosted-default-name-rejected",
            "default_name": "Caller Provided",
            "agent_type": "codex",
        },
    )

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_admin_agents_alias_registers_with_agent_id_and_runtime_state(
    admin_client, db_session, seed_user
):

    from sqlalchemy import select

    from app.models.hosted_runtime import HostedRuntimeState
    from app.models.session import AgentEnvironment

    agent_id = uuid.uuid4()
    created = await admin_client.post(
        "/v1/admin/agents",
        headers=_AUTH,
        json={
            "target_clerk_id": seed_user.clerk_id,
            "agent_id": str(agent_id),
            "machine_id": "admin-agent-alias",
            "machine_name": "admin-agent-pod",
            "agent_type": "codex",
            "agent_version": "1.0.0",
            "os_name": "linux",
        },
    )
    assert created.status_code == 200, created.text
    assert created.json()["id"] == str(agent_id)

    env = (
        await db_session.execute(select(AgentEnvironment).where(AgentEnvironment.id == agent_id))
    ).scalar_one()
    assert env.user_id == seed_user.id
    assert env.default_name == "Codex"
    assert env.registration_key is None

    runtime = await admin_client.put(
        f"/v1/admin/agents/{agent_id}/runtime-state",
        headers=_AUTH,
        json={
            "deployment_id": "dep-admin-agent-alias",
            "instance_id": "iid-admin-agent-alias",
            "generation": 7,
            "cli_package_spec": "clawdi@0.12.10-beta.55",
            "locale": {"language": "en", "timezone": "America/Los_Angeles"},
            "system": {},
            "live_sync": {"enabled": False, "agents": []},
            "recovery": {"cacheManifest": True, "allowOfflineBoot": True},
            "tools": {
                "codex": {
                    "enabled": True,
                    "provider_id": "clawdi-managed",
                    "primary_model": {
                        "provider_id": "clawdi-managed",
                        "model": "gpt-5.5",
                    },
                }
            },
            "runtimes": {
                "openclaw": {
                    "enabled": True,
                    "providerMode": "configured",
                    "provider_ids": ["clawdi-managed"],
                    "primary_model": {
                        "provider_id": "clawdi-managed",
                        "model": "gpt-5.5",
                    },
                    "install": {"source": "official"},
                }
            },
        },
    )
    assert runtime.status_code == 200, runtime.text
    assert runtime.json()["environment_id"] == str(agent_id)

    state = (
        await db_session.execute(
            select(HostedRuntimeState).where(HostedRuntimeState.environment_id == agent_id)
        )
    ).scalar_one_or_none()
    assert state is not None
    assert state.deployment_id == "dep-admin-agent-alias"

    deleted_state = await admin_client.delete(
        f"/v1/admin/agents/{agent_id}/runtime-state",
        headers=_AUTH,
    )
    assert deleted_state.status_code == 204, deleted_state.text

    state = (
        await db_session.execute(
            select(HostedRuntimeState).where(HostedRuntimeState.environment_id == agent_id)
        )
    ).scalar_one_or_none()
    assert state is None

    deleted_agent = await admin_client.delete(f"/v1/admin/agents/{agent_id}", headers=_AUTH)
    assert deleted_agent.status_code == 204, deleted_agent.text

    env = (
        await db_session.execute(select(AgentEnvironment).where(AgentEnvironment.id == agent_id))
    ).scalar_one_or_none()
    assert env is None


@pytest.mark.asyncio
async def test_admin_register_env_explicit_agent_id_is_idempotent(
    admin_client, db_session, seed_user
):
    """Stable agent ids remain the identity while machine fields refresh."""

    from sqlalchemy import select

    from app.models.session import AgentEnvironment

    agent_id = uuid.uuid4()
    body = {
        "target_clerk_id": seed_user.clerk_id,
        "environment_id": str(agent_id),
        "machine_id": "hosted-agent-initial",
        "machine_name": "hosted-pod-initial",
        "agent_type": "codex",
        "agent_version": "1.0.0",
        "os_name": "linux",
    }
    first = await admin_client.post("/v1/admin/environments", headers=_AUTH, json=body)
    second = await admin_client.post(
        "/v1/admin/environments",
        headers=_AUTH,
        json={
            **body,
            "machine_id": "hosted-agent-moved",
            "machine_name": "hosted-pod-moved",
            "agent_version": "1.1.0",
            "os_name": "darwin",
        },
    )

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["id"] == str(agent_id)
    assert second.json()["id"] == str(agent_id)

    envs = (
        (await db_session.execute(select(AgentEnvironment).where(AgentEnvironment.id == agent_id)))
        .scalars()
        .all()
    )
    assert len(envs) == 1
    env = envs[0]
    assert env.machine_id == "hosted-agent-moved"
    assert env.machine_name == "hosted-pod-moved"
    assert env.default_name == "Codex"
    assert env.agent_version == "1.1.0"
    assert env.os == "darwin"
    assert env.registration_key is None


@pytest.mark.asyncio
async def test_admin_register_env_explicit_ids_allow_same_machine_metadata(
    admin_client, db_session, seed_user
):
    """Two hosted agents can share machine metadata without sharing identity."""

    from sqlalchemy import select

    from app.models.session import AgentEnvironment

    machine_id = "same-hosted-machine"
    first_id = uuid.uuid4()
    second_id = uuid.uuid4()
    body = {
        "target_clerk_id": seed_user.clerk_id,
        "machine_id": machine_id,
        "machine_name": "hosted-pod",
        "agent_type": "codex",
    }
    r1 = await admin_client.post(
        "/v1/admin/environments",
        headers=_AUTH,
        json={**body, "environment_id": str(first_id)},
    )
    r2 = await admin_client.post(
        "/v1/admin/environments",
        headers=_AUTH,
        json={**body, "environment_id": str(second_id)},
    )
    assert r1.status_code == 200, r1.text
    assert r2.status_code == 200, r2.text
    assert r1.json()["id"] == str(first_id)
    assert r2.json()["id"] == str(second_id)

    envs = (
        (
            await db_session.execute(
                select(AgentEnvironment).where(
                    AgentEnvironment.user_id == seed_user.id,
                    AgentEnvironment.machine_id == machine_id,
                    AgentEnvironment.agent_type == "codex",
                )
            )
        )
        .scalars()
        .all()
    )
    assert {env.id for env in envs} == {first_id, second_id}
    assert all(env.registration_key is None for env in envs)


@pytest.mark.asyncio
async def test_admin_register_env_explicit_id_rejects_cross_tenant_id(
    admin_client, db_session, seed_user
):

    from sqlalchemy import select

    from app.models.session import AgentEnvironment
    from app.models.user import User

    other = User(clerk_id=f"other_env_{uuid.uuid4().hex[:8]}", email="other@x.dev", name="Other")
    db_session.add(other)
    await db_session.commit()
    await db_session.refresh(other)
    other_id = other.id

    agent_id = uuid.uuid4()
    try:
        created = await admin_client.post(
            "/v1/admin/environments",
            headers=_AUTH,
            json={
                "target_clerk_id": other.clerk_id,
                "environment_id": str(agent_id),
                "machine_id": "other-explicit",
                "machine_name": "other-pod",
                "agent_type": "codex",
            },
        )
        assert created.status_code == 200, created.text

        rejected = await admin_client.post(
            "/v1/admin/environments",
            headers=_AUTH,
            json={
                "target_clerk_id": seed_user.clerk_id,
                "environment_id": str(agent_id),
                "machine_id": "seed-explicit",
                "machine_name": "seed-pod",
                "agent_type": "codex",
            },
        )
        assert rejected.status_code == 409, rejected.text

        env = (
            await db_session.execute(
                select(AgentEnvironment).where(AgentEnvironment.id == agent_id)
            )
        ).scalar_one()
        assert env.user_id == other_id
    finally:
        await db_session.delete(other)
        await db_session.commit()


@pytest.mark.asyncio
async def test_admin_register_env_idempotent(admin_client, db_session, seed_user):
    """Legacy admin registration without an explicit id remains idempotent."""
    body = {
        "target_clerk_id": seed_user.clerk_id,
        "machine_id": "idempotent-machine",
        "machine_name": "pod-1",
        "agent_type": "openclaw",
    }
    r1 = await admin_client.post(
        "/v1/admin/environments",
        headers=_AUTH,
        json=body,
    )
    r2 = await admin_client.post(
        "/v1/admin/environments",
        headers=_AUTH,
        json=body,
    )
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r1.json()["id"] == r2.json()["id"]


@pytest.mark.asyncio
async def test_admin_delete_env_removes_environment_and_orphans_sessions(
    admin_client, db_session, seed_user
):
    """Hosted compute delete needs an admin path to remove the
    cloud-api machine tile while preserving historical sessions."""
    from datetime import UTC, datetime
    from uuid import UUID

    from sqlalchemy import select

    from app.models.audit import ControlPlaneAuditEvent
    from app.models.session import AgentEnvironment, Session

    created = await admin_client.post(
        "/api/admin/environments",
        headers=_AUTH,
        json={
            "target_clerk_id": seed_user.clerk_id,
            "machine_id": "delete-machine-1",
            "machine_name": "delete-pod",
            "agent_type": "codex",
        },
    )
    assert created.status_code == 200, created.text
    env_id = UUID(created.json()["id"])

    session_row = Session(
        user_id=seed_user.id,
        environment_id=env_id,
        local_session_id="local-delete-env-session",
        project_path="/tmp/project",
        started_at=datetime.now(UTC),
        last_activity_at=datetime.now(UTC),
    )
    db_session.add(session_row)
    await db_session.commit()

    deleted = await admin_client.delete(f"/api/admin/environments/{env_id}", headers=_AUTH)
    assert deleted.status_code == 204, deleted.text

    env = (
        await db_session.execute(select(AgentEnvironment).where(AgentEnvironment.id == env_id))
    ).scalar_one_or_none()
    assert env is None
    await db_session.refresh(session_row)
    assert session_row.environment_id is None
    event = (
        await db_session.execute(
            select(ControlPlaneAuditEvent).where(
                ControlPlaneAuditEvent.action == "agent_environment.delete",
                ControlPlaneAuditEvent.resource_id == str(env_id),
            )
        )
    ).scalar_one()
    assert event.actor_type == "admin"
    assert event.resource_type == "agent_environment"
    assert event.target_user_id == seed_user.id
    assert event.source == "api.admin"
    assert event.details["agent_type"] == "codex"
    assert event.details["machine_id"] == "delete-machine-1"

    deleted_again = await admin_client.delete(
        f"/api/admin/environments/{env_id}",
        headers=_AUTH,
    )
    assert deleted_again.status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path_template",
    ["/v1/admin/agents/{env_id}", "/v1/admin/environments/{env_id}"],
)
async def test_admin_delete_environment_accepts_matching_optional_owner(
    admin_client, db_session, seed_user, path_template
):
    import uuid as _uuid

    from app.models.session import AgentEnvironment
    from tests.conftest import create_env_with_project

    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"delete-owner-match-{_uuid.uuid4().hex[:8]}",
        machine_name="delete-owner-match-pod",
        agent_type="codex",
    )

    response = await admin_client.delete(
        path_template.format(env_id=env.id),
        headers=_AUTH,
        params={"target_clerk_id": seed_user.clerk_id},
    )

    assert response.status_code == 204, response.text
    assert await db_session.get(AgentEnvironment, env.id) is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path_template",
    ["/v1/admin/agents/{env_id}", "/v1/admin/environments/{env_id}"],
)
async def test_admin_delete_environment_rejects_mismatched_optional_owner(
    admin_client, db_session, seed_user, path_template
):
    import uuid as _uuid

    from app.models.session import AgentEnvironment
    from app.models.user import User
    from tests.conftest import create_env_with_project

    other = User(
        clerk_id=f"other_delete_{_uuid.uuid4().hex[:8]}",
        email="other-delete@x.dev",
        name="Other Delete",
    )
    db_session.add(other)
    await db_session.commit()
    await db_session.refresh(other)
    env = await create_env_with_project(
        db_session,
        user_id=other.id,
        machine_id=f"delete-owner-mismatch-{_uuid.uuid4().hex[:8]}",
        machine_name="delete-owner-mismatch-pod",
        agent_type="codex",
    )

    response = await admin_client.delete(
        path_template.format(env_id=env.id),
        headers=_AUTH,
        params={"target_clerk_id": seed_user.clerk_id},
    )

    assert response.status_code == 403, response.text
    assert await db_session.get(AgentEnvironment, env.id) is not None


@pytest.mark.asyncio
async def test_admin_register_env_lazy_creates_user(admin_client, db_session):
    """Same lazy-create contract for env registration: a brand-new
    user clicking Deploy registers their first env. Without this,
    SaaS calls admin_register_environment, gets 404, deploy
    proceeds without sync, and the user has no clue why their pod
    isn't showing up on cloud.clawdi.ai."""

    from sqlalchemy import select

    from app.models.project import PROJECT_KIND_PERSONAL, Project
    from app.models.user import User

    novel_clerk_id = f"user_env_register_{uuid.uuid4().hex[:12]}"
    r = await admin_client.post(
        "/v1/admin/environments",
        headers=_AUTH,
        json={
            "target_clerk_id": novel_clerk_id,
            "machine_id": "m-first",
            "machine_name": "test-pod",
            "agent_type": "openclaw",
        },
    )
    assert r.status_code == 200, r.text

    user = (
        await db_session.execute(select(User).where(User.clerk_id == novel_clerk_id))
    ).scalar_one()
    # Personal project created alongside (JWT-path parity).
    personal = (
        await db_session.execute(
            select(Project).where(Project.user_id == user.id, Project.kind == PROJECT_KIND_PERSONAL)
        )
    ).scalar_one_or_none()
    assert personal is not None


@pytest.mark.asyncio
async def test_admin_mint_rejects_cross_tenant_environment_id(admin_client, db_session, seed_user):
    """Admin caller passing user A's `target_clerk_id` together with an
    `environment_id` owned by user B must get 403 (not silently mint a
    cross-tenant key, not 500 on the ValueError traceback).

    Defense in depth: `mint_api_key` raises ValueError on the
    user_id/env_id ownership mismatch and the admin route maps that
    to 403. The user-self-mint path has the same test
    (`test_deploy_key_rejects_cross_tenant_environment_id`); without
    the admin counterpart, a future refactor that inlines the
    ownership check (or removes the service-layer check) would
    silently regress the admin path with no safety net.
    """
    import uuid as _uuid

    from app.models.user import User
    from tests.conftest import create_env_with_project

    other = User(clerk_id=f"other_admin_{_uuid.uuid4().hex[:8]}", email="o@x.dev", name="O")
    db_session.add(other)
    await db_session.commit()
    await db_session.refresh(other)
    other_env = await create_env_with_project(
        db_session,
        user_id=other.id,
        machine_id="m-other-admin",
        machine_name="other-pod",
    )

    try:
        r = await admin_client.post(
            "/v1/admin/auth/keys",
            headers=_AUTH,
            json={
                "target_clerk_id": seed_user.clerk_id,
                "label": "cross-tenant-attempt",
                "environment_id": str(other_env.id),
            },
        )
        assert r.status_code == 403, r.text
    finally:
        await db_session.delete(other)
        await db_session.commit()


@pytest.mark.asyncio
async def test_admin_endpoints_excluded_from_openapi_schema(admin_client, seed_user):
    """Regression: `/api/admin/*` MUST NOT appear in the public OpenAPI
    schema. The web/CLI typed-client codegen consumes /openapi.json,
    and admin endpoints are server-to-server only — leaking them
    advertises the X-Admin-Key surface to anyone who downloads the
    frontend bundle.

    Also verifies the endpoints are still REACHABLE — a regression
    where someone disables the admin router entirely (or comments
    out `include_router(admin_router)`) would pass the
    "absent from schema" check trivially. Catching both means the
    test holds the actual invariant: hidden from schema AND live.
    """
    r = await admin_client.get("/openapi.json")
    assert r.status_code == 200
    schema = r.json()
    admin_paths = [p for p in schema.get("paths", {}) if p.startswith("/v1/admin")]
    assert admin_paths == [], (
        f"admin endpoints leaked into OpenAPI schema: {admin_paths}. "
        "Add `include_in_schema=False` to the admin router."
    )

    # Reachability check: the actual endpoint must respond (200), not
    # 404 — confirms the router is still wired up under the schema-
    # excluded prefix.
    mint = await admin_client.post(
        "/v1/admin/auth/keys",
        headers=_AUTH,
        json={"target_clerk_id": seed_user.clerk_id, "label": "reachability-check"},
    )
    assert mint.status_code == 200, (
        f"admin mint endpoint is not reachable (status={mint.status_code}): {mint.text}. "
        "include_in_schema=False must hide the route from /openapi.json without "
        "actually disabling it."
    )
