"""ApiKey lifecycle and authentication edge cases.

Covers the security-sensitive parts of ``app.core.auth`` that the smoke
tests don't exercise: the raw key is only returned on creation, the stored
hash is never round-trippable, a revoked key authenticates with 401, and
``/api/auth/me`` reflects the auth method used.
"""

from __future__ import annotations

import hashlib

import httpx
import pytest
from httpx import ASGITransport

from app.main import app


@pytest.mark.asyncio
async def test_api_key_create_returns_raw_once_and_stores_hash(
    client: httpx.AsyncClient, db_session
):
    r = await client.post("/api/auth/keys", json={"label": "laptop"})
    assert r.status_code == 200, r.text
    body = r.json()
    raw = body["raw_key"]
    assert raw.startswith("clawdi_")
    assert body["key_prefix"] == raw[:16]

    # The listing endpoint must NEVER return the raw secret (only prefix/label).
    listing = (await client.get("/api/auth/keys")).json()
    assert listing and all("raw_key" not in k for k in listing)

    # The on-disk representation is a sha256 hash, not the raw token.
    expected_hash = hashlib.sha256(raw.encode()).hexdigest()
    from sqlalchemy import select

    from app.models.api_key import ApiKey

    rows = (await db_session.execute(select(ApiKey))).scalars().all()
    assert any(k.key_hash == expected_hash for k in rows)
    assert all(k.key_hash != raw for k in rows)


@pytest.mark.asyncio
async def test_revoked_api_key_is_rejected(db_session, seed_user):
    """A revoked key hitting the real auth path returns 401, not the user.

    Uses the raw ASGI app (no ``client`` fixture) so the real ``get_auth``
    dependency runs — the fixture would override it and short-circuit this
    test.
    """
    import secrets as _secrets
    from datetime import UTC, datetime

    from app.core.database import get_session
    from app.models.api_key import ApiKey

    raw = "clawdi_" + _secrets.token_urlsafe(24)
    api_key = ApiKey(
        user_id=seed_user.id,
        key_hash=hashlib.sha256(raw.encode()).hexdigest(),
        key_prefix=raw[:16],
        label="revoked",
        revoked_at=datetime.now(UTC),
    )
    db_session.add(api_key)
    await db_session.commit()

    async def _override_get_session():
        yield db_session

    app.dependency_overrides[get_session] = _override_get_session
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            r = await ac.get("/api/memories", headers={"Authorization": f"Bearer {raw}"})
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 401, r.text
    assert "revoked" in r.text.lower()


@pytest.mark.asyncio
async def test_me_reflects_clerk_auth(client: httpx.AsyncClient):
    body = (await client.get("/api/auth/me")).json()
    assert body["auth_type"] == "clerk"


@pytest.mark.asyncio
async def test_me_reflects_cli_auth(cli_client: httpx.AsyncClient):
    body = (await cli_client.get("/api/auth/me")).json()
    assert body["auth_type"] == "api_key"


@pytest.mark.asyncio
async def test_revoke_api_key_marks_row(client: httpx.AsyncClient):
    created = (await client.post("/api/auth/keys", json={"label": "to-revoke"})).json()
    r = await client.delete(f"/api/auth/keys/{created['id']}")
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "revoked"}

    # After revoke, the key still shows in the list but with ``revoked_at`` set.
    listing = (await client.get("/api/auth/keys")).json()
    match = next(k for k in listing if k["id"] == created["id"])
    assert match["revoked_at"] is not None


@pytest.mark.asyncio
async def test_deploy_key_minted_with_full_access_by_default(
    client: httpx.AsyncClient, db_session, seed_user
):
    """A deploy key (env-bound) defaults to FULL account access — same
    as a key the user mints for their own laptop. The hosted agent
    pod must be able to do everything the user can.

    Without this property the daemon ends up scoped to a 3-token list
    and silently can't touch vault / memories / settings, which makes
    the "iCloud for AI agents" promise a lie."""
    from tests.conftest import create_env_with_scope

    env = await create_env_with_scope(
        db_session,
        user_id=seed_user.id,
        machine_id="m-deploy",
        machine_name="hosted-pod",
    )

    r = await client.post(
        "/api/auth/keys",
        json={"label": "hosted-pod", "environment_id": str(env.id)},
    )
    assert r.status_code == 200, r.text

    # Verify the persisted scopes column is NULL (full access),
    # not the legacy daemon set.
    from sqlalchemy import select

    from app.models.api_key import ApiKey

    rows = (
        (await db_session.execute(select(ApiKey).where(ApiKey.user_id == seed_user.id)))
        .scalars()
        .all()
    )
    assert rows, "minting succeeded but no row found"
    deploy_key = next(k for k in rows if k.environment_id == env.id)
    assert deploy_key.scopes is None, (
        f"deploy keys must default to full access (scopes=None), got {deploy_key.scopes!r}"
    )


@pytest.mark.asyncio
async def test_deploy_key_honours_explicit_narrow_scopes(
    client: httpx.AsyncClient, db_session, seed_user
):
    """The default is full access, but a caller that explicitly passes
    a narrower scope list still gets a narrowed key — the dashboard
    should be able to opt into narrower keys per use-case."""
    from tests.conftest import create_env_with_scope

    env = await create_env_with_scope(
        db_session,
        user_id=seed_user.id,
        machine_id="m-narrow",
        machine_name="narrow-pod",
    )

    r = await client.post(
        "/api/auth/keys",
        json={
            "label": "narrow-pod",
            "environment_id": str(env.id),
            "scopes": ["sessions:write"],
        },
    )
    assert r.status_code == 200, r.text

    from sqlalchemy import select

    from app.models.api_key import ApiKey

    deploy_key = (
        await db_session.execute(
            select(ApiKey).where(ApiKey.user_id == seed_user.id, ApiKey.environment_id == env.id)
        )
    ).scalar_one()
    assert deploy_key.scopes == ["sessions:write"]


@pytest.mark.asyncio
async def test_deploy_key_rejects_cross_tenant_environment_id(
    client: httpx.AsyncClient, db_session, seed_user
):
    """An attacker passing another user's env_id must get a 403, not a
    silent rebind. `mint_api_key` raises ValueError on the user_id
    mismatch and the route maps that to 403 (not 500)."""
    import uuid as _uuid

    from app.models.user import User
    from tests.conftest import create_env_with_scope

    other = User(clerk_id=f"other_{_uuid.uuid4().hex[:8]}", email="o@x.dev", name="O")
    db_session.add(other)
    await db_session.commit()
    await db_session.refresh(other)
    other_env = await create_env_with_scope(
        db_session,
        user_id=other.id,
        machine_id="m-other",
        machine_name="other-pod",
    )

    try:
        r = await client.post(
            "/api/auth/keys",
            json={"label": "steal", "environment_id": str(other_env.id)},
        )
        assert r.status_code == 403, r.text
    finally:
        await db_session.delete(other)
        await db_session.commit()


@pytest.mark.asyncio
async def test_deploy_key_rejects_malformed_environment_id(client: httpx.AsyncClient):
    """A malformed UUID should be 400, not 500 — sanity check on the
    parse path."""
    r = await client.post(
        "/api/auth/keys",
        json={"label": "bad", "environment_id": "not-a-uuid"},
    )
    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_revoke_other_users_key_is_404(client: httpx.AsyncClient, db_session, seed_user):
    """Revoking someone else's key by ID leaks 404, not 200 — no cross-tenant writes."""
    import secrets as _secrets
    import uuid as _uuid

    from app.models.api_key import ApiKey
    from app.models.user import User

    victim = User(clerk_id=f"victim_{_uuid.uuid4().hex[:8]}", email="v@x.dev", name="V")
    db_session.add(victim)
    await db_session.commit()
    await db_session.refresh(victim)

    raw = "clawdi_" + _secrets.token_urlsafe(24)
    key = ApiKey(
        user_id=victim.id,
        key_hash=hashlib.sha256(raw.encode()).hexdigest(),
        key_prefix=raw[:16],
        label="victim",
    )
    db_session.add(key)
    await db_session.commit()
    await db_session.refresh(key)

    try:
        # ``client`` authenticates as seed_user (attacker); should not touch victim's key.
        r = await client.delete(f"/api/auth/keys/{key.id}")
        assert r.status_code == 404, r.text
    finally:
        await db_session.delete(key)
        await db_session.delete(victim)
        await db_session.commit()


@pytest.mark.asyncio
async def test_introspect_returns_metadata_for_valid_key(
    client: httpx.AsyncClient, db_session, seed_user
):
    """A deploy pipeline can confirm a freshly-minted deploy key is
    bound to the env it expects before injecting it into a pod
    Secret — happy path returns valid=true with the row's metadata."""
    from tests.conftest import create_env_with_scope

    env = await create_env_with_scope(
        db_session,
        user_id=seed_user.id,
        machine_id="m-introspect",
        machine_name="introspect-pod",
    )
    minted = (
        await client.post(
            "/api/auth/keys",
            json={"label": "introspect", "environment_id": str(env.id)},
        )
    ).json()

    r = await client.post(
        "/api/auth/keys/introspect",
        json={"api_key": minted["raw_key"], "environment_id": str(env.id)},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["valid"] is True
    assert body["key_id"] == minted["id"]
    assert body["user_id"] == str(seed_user.id)
    assert body["environment_id"] == str(env.id)
    assert body["scopes"] is None  # full access


@pytest.mark.asyncio
async def test_introspect_rejects_wrong_env_claim(
    client: httpx.AsyncClient, db_session, seed_user
):
    """Mint a key bound to env_A, claim it's for env_B → valid=false.
    Closes the intra-user "wrong env" gap that same-Clerk-tenant
    alone does not catch."""
    from tests.conftest import create_env_with_scope

    env_a = await create_env_with_scope(
        db_session, user_id=seed_user.id, machine_id="m-a", machine_name="pod-a"
    )
    env_b = await create_env_with_scope(
        db_session, user_id=seed_user.id, machine_id="m-b", machine_name="pod-b"
    )
    minted = (
        await client.post(
            "/api/auth/keys",
            json={"label": "for-a", "environment_id": str(env_a.id)},
        )
    ).json()

    r = await client.post(
        "/api/auth/keys/introspect",
        json={"api_key": minted["raw_key"], "environment_id": str(env_b.id)},
    )
    assert r.status_code == 200
    body = r.json()
    # Uniform "valid=false" with no leak about why — caller can't
    # tell if the key exists, is for a different env, expired, etc.
    assert body["valid"] is False
    assert body.get("key_id") is None
    assert body.get("user_id") is None


@pytest.mark.asyncio
async def test_introspect_rejects_revoked_key(
    client: httpx.AsyncClient, db_session, seed_user
):
    from tests.conftest import create_env_with_scope

    env = await create_env_with_scope(
        db_session, user_id=seed_user.id, machine_id="m-rev", machine_name="pod-rev"
    )
    minted = (
        await client.post(
            "/api/auth/keys",
            json={"label": "to-revoke", "environment_id": str(env.id)},
        )
    ).json()
    await client.delete(f"/api/auth/keys/{minted['id']}")

    r = await client.post(
        "/api/auth/keys/introspect",
        json={"api_key": minted["raw_key"], "environment_id": str(env.id)},
    )
    assert r.status_code == 200
    assert r.json()["valid"] is False


@pytest.mark.asyncio
async def test_introspect_rejects_unknown_key(
    client: httpx.AsyncClient, db_session, seed_user
):
    """Caller posts a raw_key that was never issued — fail closed."""
    from tests.conftest import create_env_with_scope

    env = await create_env_with_scope(
        db_session, user_id=seed_user.id, machine_id="m-unk", machine_name="pod-unk"
    )

    r = await client.post(
        "/api/auth/keys/introspect",
        json={"api_key": "clawdi_fake_does_not_exist_xxxxxxxx", "environment_id": str(env.id)},
    )
    assert r.status_code == 200
    assert r.json()["valid"] is False


@pytest.mark.asyncio
async def test_introspect_rejects_cross_tenant_key(
    client: httpx.AsyncClient, db_session, seed_user
):
    """Attacker logged in as user_B introspects a key belonging to
    user_A. Same-Clerk-tenant gating means valid=false."""
    import hashlib
    import secrets as _secrets
    import uuid as _uuid

    from tests.conftest import create_env_with_scope

    from app.models.api_key import ApiKey
    from app.models.user import User

    victim = User(clerk_id=f"victim_{_uuid.uuid4().hex[:8]}", email="v@x.dev", name="V")
    db_session.add(victim)
    await db_session.commit()
    await db_session.refresh(victim)

    victim_env = await create_env_with_scope(
        db_session, user_id=victim.id, machine_id="m-victim", machine_name="victim-pod"
    )

    raw = "clawdi_" + _secrets.token_urlsafe(24)
    key = ApiKey(
        user_id=victim.id,
        key_hash=hashlib.sha256(raw.encode()).hexdigest(),
        key_prefix=raw[:16],
        label="victim-key",
        environment_id=victim_env.id,
    )
    db_session.add(key)
    await db_session.commit()

    try:
        # ``client`` is seed_user (attacker), introspecting victim's key
        r = await client.post(
            "/api/auth/keys/introspect",
            json={"api_key": raw, "environment_id": str(victim_env.id)},
        )
        assert r.status_code == 200
        assert r.json()["valid"] is False
    finally:
        await db_session.delete(key)
        await db_session.delete(victim_env)
        await db_session.delete(victim)
        await db_session.commit()
