"""Tests for `/api/admin/*` endpoints.

Auth via X-Admin-Key header (shared secret). Tests run against the
`db_session` directly without dependency overriding the auth gate —
we verify the gate as part of test surface, not bypass it.
"""

from collections.abc import AsyncIterator

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport

from app.core.config import settings
from app.core.database import get_session
from app.main import app

_ADMIN_KEY = "test-admin-secret-do-not-use-in-prod"


@pytest_asyncio.fixture
async def admin_client(db_session, seed_user) -> AsyncIterator[httpx.AsyncClient]:
    """Client that does NOT inject auth — admin endpoints test the
    `X-Admin-Key` header gate directly. Sets settings.admin_api_key
    to a known value for the test scope."""

    async def _override_get_session():
        yield db_session

    original_admin_key = settings.admin_api_key
    settings.admin_api_key = _ADMIN_KEY

    app.dependency_overrides[get_session] = _override_get_session
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
        "/api/admin/auth/keys",
        json={"target_clerk_id": seed_user.clerk_id, "label": "test"},
    )
    assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_admin_mint_rejects_wrong_key(admin_client, seed_user):
    """Wrong header value: 401."""
    r = await admin_client.post(
        "/api/admin/auth/keys",
        headers={"X-Admin-Key": "wrong-key"},
        json={"target_clerk_id": seed_user.clerk_id, "label": "test"},
    )
    assert r.status_code == 401


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
                "/api/admin/auth/keys",
                headers={"X-Admin-Key": "anything"},
                json={"target_clerk_id": seed_user.clerk_id, "label": "test"},
            )
            assert r.status_code == 503
    finally:
        app.dependency_overrides.clear()
        settings.admin_api_key = original


@pytest.mark.asyncio
async def test_admin_mint_persists_admin_allowlist_scopes(
    admin_client, db_session, seed_user
):
    """Mint via admin endpoint persists the allowlist scopes
    (not None / full access)."""
    from sqlalchemy import select

    from app.models.api_key import ApiKey

    r = await admin_client.post(
        "/api/admin/auth/keys",
        headers={"X-Admin-Key": _ADMIN_KEY},
        json={"target_clerk_id": seed_user.clerk_id, "label": "narrow-test"},
    )
    assert r.status_code == 200

    rows = (
        await db_session.execute(select(ApiKey).where(ApiKey.user_id == seed_user.id))
    ).scalars().all()
    assert rows
    minted = next(k for k in rows if k.label == "narrow-test")

    # Persisted scopes must be the admin allowlist, NOT None.
    assert minted.scopes is not None, (
        "admin-minted key must NOT have scopes=None (full access) — "
        "that would defeat the privacy invariant"
    )
    assert "sessions:write" in minted.scopes
    assert "skills:read" in minted.scopes
    # Verify privacy-sensitive scopes are NOT in the persisted set
    assert "sessions:read" not in minted.scopes, (
        "PRIVACY: admin-minted keys must NOT carry sessions:read"
    )
    assert "memories:read" not in minted.scopes
    assert "vault:resolve" not in minted.scopes
    assert "vault:write" not in minted.scopes


@pytest.mark.asyncio
async def test_admin_mint_rejects_privacy_violating_scopes(
    admin_client, seed_user
):
    """Caller cannot smuggle a read-side scope past the admin endpoint
    by passing it explicitly. 400 with a list of invalid scopes."""
    r = await admin_client.post(
        "/api/admin/auth/keys",
        headers={"X-Admin-Key": _ADMIN_KEY},
        json={
            "target_clerk_id": seed_user.clerk_id,
            "label": "attacker-attempt",
            "scopes": ["sessions:write", "vault:resolve"],  # vault:resolve = privacy violation
        },
    )
    assert r.status_code == 400
    assert "vault:resolve" in r.text


@pytest.mark.asyncio
async def test_admin_mint_allows_subset_of_allowlist(admin_client, db_session, seed_user):
    """Caller can narrow further: pass a subset of the allowlist,
    minted key gets exactly that subset."""
    from sqlalchemy import select

    from app.models.api_key import ApiKey

    r = await admin_client.post(
        "/api/admin/auth/keys",
        headers={"X-Admin-Key": _ADMIN_KEY},
        json={
            "target_clerk_id": seed_user.clerk_id,
            "label": "narrow-explicit",
            "scopes": ["sessions:write"],  # narrower than allowlist default
        },
    )
    assert r.status_code == 200

    minted = (
        await db_session.execute(
            select(ApiKey).where(
                ApiKey.user_id == seed_user.id, ApiKey.label == "narrow-explicit"
            )
        )
    ).scalar_one()
    assert minted.scopes == ["sessions:write"]


@pytest.mark.asyncio
async def test_admin_mint_unknown_target_user(admin_client):
    """Target Clerk id not in DB: 404."""
    r = await admin_client.post(
        "/api/admin/auth/keys",
        headers={"X-Admin-Key": _ADMIN_KEY},
        json={"target_clerk_id": "user_does_not_exist", "label": "test"},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_admin_revoke_happy_path(admin_client, db_session, seed_user):
    """Mint a key, then revoke it via admin endpoint. Verify revoked_at set."""
    from sqlalchemy import select

    from app.models.api_key import ApiKey

    minted_resp = await admin_client.post(
        "/api/admin/auth/keys",
        headers={"X-Admin-Key": _ADMIN_KEY},
        json={"target_clerk_id": seed_user.clerk_id, "label": "to-revoke"},
    )
    key_id = minted_resp.json()["id"]

    r = await admin_client.delete(
        f"/api/admin/auth/keys/{key_id}",
        headers={"X-Admin-Key": _ADMIN_KEY},
    )
    assert r.status_code == 200
    assert r.json()["status"] == "revoked"

    db_session.expire_all()
    row = (
        await db_session.execute(select(ApiKey).where(ApiKey.id == key_id))
    ).scalar_one()
    assert row.revoked_at is not None


@pytest.mark.asyncio
async def test_admin_revoke_idempotent_on_already_revoked(
    admin_client, db_session, seed_user
):
    """Revoking an already-revoked key returns 200 (idempotent), not
    an error. Useful for migration retry semantics."""
    minted_resp = await admin_client.post(
        "/api/admin/auth/keys",
        headers={"X-Admin-Key": _ADMIN_KEY},
        json={"target_clerk_id": seed_user.clerk_id, "label": "double-revoke"},
    )
    key_id = minted_resp.json()["id"]

    await admin_client.delete(
        f"/api/admin/auth/keys/{key_id}",
        headers={"X-Admin-Key": _ADMIN_KEY},
    )
    r = await admin_client.delete(
        f"/api/admin/auth/keys/{key_id}",
        headers={"X-Admin-Key": _ADMIN_KEY},
    )
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_admin_revoke_unknown_key(admin_client):
    """404 for a key id that doesn't exist."""
    import uuid

    r = await admin_client.delete(
        f"/api/admin/auth/keys/{uuid.uuid4()}",
        headers={"X-Admin-Key": _ADMIN_KEY},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_admin_register_env_creates_with_scope(
    admin_client, db_session, seed_user
):
    """Admin env registration creates an AgentEnvironment AND a
    default scope, matching the user-facing register_environment
    contract. Migration tooling depends on default_scope_id being
    set so the daemon can upload."""
    from sqlalchemy import select

    from app.models.session import AgentEnvironment

    r = await admin_client.post(
        "/api/admin/environments",
        headers={"X-Admin-Key": _ADMIN_KEY},
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
    assert env.default_scope_id is not None  # heal logic ran


@pytest.mark.asyncio
async def test_admin_register_env_idempotent(admin_client, db_session, seed_user):
    """Re-registering same (user, machine_id, agent_type) returns
    the same env id — migration retry safety."""
    body = {
        "target_clerk_id": seed_user.clerk_id,
        "machine_id": "idempotent-machine",
        "machine_name": "pod-1",
        "agent_type": "openclaw",
    }
    r1 = await admin_client.post(
        "/api/admin/environments",
        headers={"X-Admin-Key": _ADMIN_KEY},
        json=body,
    )
    r2 = await admin_client.post(
        "/api/admin/environments",
        headers={"X-Admin-Key": _ADMIN_KEY},
        json=body,
    )
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r1.json()["id"] == r2.json()["id"]


@pytest.mark.asyncio
async def test_admin_register_env_unknown_user(admin_client):
    """404 when target user doesn't exist."""
    r = await admin_client.post(
        "/api/admin/environments",
        headers={"X-Admin-Key": _ADMIN_KEY},
        json={
            "target_clerk_id": "user_does_not_exist",
            "machine_id": "x",
            "machine_name": "y",
            "agent_type": "openclaw",
        },
    )
    assert r.status_code == 404
