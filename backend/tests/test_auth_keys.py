"""ApiKey lifecycle and authentication edge cases.

Covers the security-sensitive parts of ``app.core.auth`` that the smoke
tests don't exercise: the raw key is only returned on creation, the stored
hash is never round-trippable, a revoked key authenticates with 401, and
``/api/auth/me`` reflects the auth method used.
"""

from __future__ import annotations

import hashlib
import uuid

import httpx
import pytest
from fastapi import HTTPException
from httpx import ASGITransport

from app.core.auth import AuthContext, require_auth_scopes
from app.main import app
from app.models.api_key import ApiKey


def test_scope_enforcement_preserves_legacy_access_and_fails_closed_for_strict_runtime(
    seed_user,
):
    legacy_auth = AuthContext(
        user=seed_user,
        api_key=ApiKey(user_id=seed_user.id, scopes=None),
    )
    require_auth_scopes(legacy_auth, "vault:read")

    strict_runtime_auth = AuthContext(
        user=seed_user,
        api_key=ApiKey(
            user_id=seed_user.id,
            scopes=None,
            managed=True,
            environment_id=uuid.uuid4(),
            runtime_deployment_id="deployment-test",
        ),
    )
    with pytest.raises(HTTPException) as exc_info:
        require_auth_scopes(strict_runtime_auth, "vault:read")

    assert exc_info.value.status_code == 403
    assert exc_info.value.detail == "missing scope: vault:read"


@pytest.mark.asyncio
async def test_api_key_create_returns_raw_once_and_stores_hash(
    client: httpx.AsyncClient, db_session
):
    r = await client.post("/v1/auth/keys", json={"label": "laptop"})
    assert r.status_code == 200, r.text
    body = r.json()
    raw = body["raw_key"]
    assert raw.startswith("clawdi_")
    assert body["key_prefix"] == raw[:16]

    # The listing endpoint must NEVER return the raw secret (only prefix/label).
    listing = (await client.get("/v1/auth/keys")).json()
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
            r = await ac.get("/v1/memories", headers={"Authorization": f"Bearer {raw}"})
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 401, r.text
    assert "revoked" in r.text.lower()


@pytest.mark.asyncio
async def test_agent_key_disconnect_revokes_after_commit(
    client: httpx.AsyncClient, db_session, seed_user
):
    import uuid

    from fastapi import HTTPException

    from app.core.auth import _auth_via_api_key
    from app.services.agent_environments import (
        local_machine_registration_key,
        register_agent_environment,
    )
    from app.services.api_key import mint_api_key

    machine_id = f"cached-key-{uuid.uuid4().hex}"
    registered = await register_agent_environment(
        db_session,
        user_id=seed_user.id,
        machine_id=machine_id,
        machine_name="Cached key Agent",
        agent_type="codex",
        agent_version="1.0.0",
        os_name="linux",
        sort_order=0,
        registration_key=local_machine_registration_key(machine_id, "codex"),
    )
    minted = await mint_api_key(
        db_session,
        user_id=seed_user.id,
        label="cached Agent key",
        environment_id=registered.env.id,
    )
    assert await _auth_via_api_key(minted.raw_key, db_session) is not None
    disconnected = await client.delete(f"/v1/agents/{registered.env.id}")
    assert disconnected.status_code == 204, disconnected.text
    with pytest.raises(HTTPException) as exc_info:
        await _auth_via_api_key(minted.raw_key, db_session)
    assert exc_info.value.status_code == 401
    assert "revoked" in str(exc_info.value.detail).lower()


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_unbound_api_key_auth_reloads_committed_scope_and_revocation(
    db_session,
    engine,
    seed_user,
):
    from datetime import UTC, datetime

    from sqlalchemy import event, update
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.core.auth import _auth_via_api_key
    from app.services.api_key import mint_api_key

    minted = await mint_api_key(
        db_session,
        user_id=seed_user.id,
        label="durable authority key",
        scopes=["vault:read", "vault:write"],
    )
    assert await _auth_via_api_key(minted.raw_key, db_session) is not None
    await db_session.commit()

    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    async with sessionmaker() as mutation_session:
        await mutation_session.execute(
            update(ApiKey).where(ApiKey.id == minted.api_key.id).values(scopes=["vault:read"])
        )
        await mutation_session.commit()

    statements: list[str] = []

    def capture_statement(_connection, _cursor, statement: str, *_args) -> None:
        statements.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", capture_statement)
    try:
        refreshed = await _auth_via_api_key(minted.raw_key, db_session)
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", capture_statement)

    assert refreshed is not None
    assert refreshed.api_key is not None
    assert refreshed.api_key.scopes == ["vault:read"]
    assert len(statements) == 2
    assert "pg_advisory_xact_lock_shared" in statements[0]
    assert "LEFT OUTER JOIN users" in statements[1]
    await db_session.commit()

    async with sessionmaker() as mutation_session:
        await mutation_session.execute(
            update(ApiKey)
            .where(ApiKey.id == minted.api_key.id)
            .values(revoked_at=datetime.now(UTC))
        )
        await mutation_session.commit()

    with pytest.raises(HTTPException) as exc_info:
        await _auth_via_api_key(minted.raw_key, db_session)
    assert exc_info.value.status_code == 401
    assert "revoked" in str(exc_info.value.detail).lower()


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_agent_key_revalidation_refreshes_revocation_after_last_used_commit(
    db_session,
    engine,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
):
    from datetime import UTC, datetime

    from sqlalchemy import update
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.core.auth import _auth_via_api_key
    from app.services.agent_environments import (
        local_machine_registration_key,
        register_agent_environment,
    )
    from app.services.api_key import mint_api_key

    machine_id = f"revalidation-{uuid.uuid4().hex}"
    registered = await register_agent_environment(
        db_session,
        user_id=seed_user.id,
        machine_id=machine_id,
        machine_name="Revalidation Agent",
        agent_type="codex",
        agent_version="1.0.0",
        os_name="linux",
        sort_order=0,
        registration_key=local_machine_registration_key(machine_id, "codex"),
    )
    minted = await mint_api_key(
        db_session,
        user_id=seed_user.id,
        label="revalidation key",
        environment_id=registered.env.id,
    )
    await db_session.commit()

    original_commit = db_session.commit
    revoke_injected = False

    async def commit_then_revoke() -> None:
        nonlocal revoke_injected
        await original_commit()
        if revoke_injected:
            return
        revoke_injected = True
        sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
        async with sessionmaker() as revoke_session:
            await revoke_session.execute(
                update(ApiKey)
                .where(ApiKey.id == minted.api_key.id)
                .values(revoked_at=datetime.now(UTC))
            )
            await revoke_session.commit()

    monkeypatch.setattr(db_session, "commit", commit_then_revoke)

    with pytest.raises(HTTPException) as exc_info:
        await _auth_via_api_key(minted.raw_key, db_session)

    assert revoke_injected is True
    assert exc_info.value.status_code == 401
    assert "revoked" in str(exc_info.value.detail).lower()


@pytest.mark.asyncio
async def test_me_reflects_clerk_auth(client: httpx.AsyncClient):
    body = (await client.get("/v1/auth/me")).json()
    assert body["auth_type"] == "clerk"


@pytest.mark.asyncio
async def test_me_reflects_cli_auth(cli_client: httpx.AsyncClient):
    body = (await cli_client.get("/v1/auth/me")).json()
    assert body["auth_type"] == "api_key"


@pytest.mark.asyncio
async def test_revoke_api_key_hides_row_but_preserves_audit_record(
    client: httpx.AsyncClient, db_session
):
    from sqlalchemy import select

    from app.models.api_key import ApiKey

    created = (await client.post("/v1/auth/keys", json={"label": "to-revoke"})).json()
    r = await client.delete(f"/v1/auth/keys/{created['id']}")
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "revoked"}

    # The user-facing list is active-only, but soft revocation keeps the row for audit.
    listing = (await client.get("/v1/auth/keys")).json()
    assert created["id"] not in {key["id"] for key in listing}

    revoked_at = await db_session.scalar(
        select(ApiKey.revoked_at).where(ApiKey.id == created["id"])
    )
    assert revoked_at is not None


@pytest.mark.asyncio
async def test_managed_api_key_is_hidden_from_user_list(
    client: httpx.AsyncClient, db_session, seed_user
):
    from sqlalchemy import select

    from app.models.api_key import ApiKey

    visible = (await client.post("/v1/auth/keys", json={"label": "visible"})).json()
    raw = "clawdi_managed_hidden"
    hidden = ApiKey(
        user_id=seed_user.id,
        key_hash=hashlib.sha256(raw.encode()).hexdigest(),
        key_prefix=raw[:16],
        label="platform-managed",
        managed=True,
    )
    db_session.add(hidden)
    await db_session.commit()

    listing = await client.get("/v1/auth/keys")
    assert listing.status_code == 200, listing.text
    labels = {item["label"] for item in listing.json()}
    assert labels == {"visible"}
    assert visible["id"] in {item["id"] for item in listing.json()}
    assert (
        await db_session.scalar(select(ApiKey.managed).where(ApiKey.label == "platform-managed"))
        is True
    )


@pytest.mark.asyncio
async def test_user_revoke_rejects_managed_api_key(
    client: httpx.AsyncClient, db_session, seed_user
):
    from sqlalchemy import select

    from app.models.api_key import ApiKey

    raw = "clawdi_managed_revoke"
    key = ApiKey(
        user_id=seed_user.id,
        key_hash=hashlib.sha256(raw.encode()).hexdigest(),
        key_prefix=raw[:16],
        label="platform-managed",
        managed=True,
    )
    db_session.add(key)
    await db_session.commit()
    await db_session.refresh(key)

    response = await client.delete(f"/v1/auth/keys/{key.id}")
    assert response.status_code == 403, response.text

    revoked_at = await db_session.scalar(select(ApiKey.revoked_at).where(ApiKey.id == key.id))
    assert revoked_at is None


@pytest.mark.asyncio
async def test_deploy_key_minted_with_full_access_by_default(
    client: httpx.AsyncClient, db_session, seed_user
):
    """An Agent API key defaults to FULL account access — same
    as a key the user mints for their own laptop. The hosted agent
    pod must be able to do everything the user can.

    Without this property the daemon ends up narrowed to a 3-token API permission list
    and silently can't touch vault / memories / settings, which breaks
    Clawdi's shared context and tools promise."""
    from tests.conftest import create_env_with_project

    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id="m-deploy",
        machine_name="hosted-pod",
    )

    r = await client.post(
        "/v1/auth/keys",
        json={"label": "hosted-pod", "environment_id": str(env.id)},
    )
    assert r.status_code == 200, r.text

    # Verify the persisted scopes column is NULL (full API permission access),
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
        f"deploy keys must default to full API permission access (scopes=None), "
        f"got {deploy_key.scopes!r}"
    )


@pytest.mark.asyncio
async def test_deploy_key_honours_explicit_narrow_scopes(
    client: httpx.AsyncClient, db_session, seed_user
):
    """The default is full access, but a caller that explicitly passes
    a narrower API permission list still gets a narrowed key — the
    dashboard should be able to opt into narrower keys per use-case."""
    from tests.conftest import create_env_with_project

    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id="m-narrow",
        machine_name="narrow-pod",
    )

    r = await client.post(
        "/v1/auth/keys",
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
    from tests.conftest import create_env_with_project

    other = User(clerk_id=f"other_{_uuid.uuid4().hex[:8]}", email="o@x.dev", name="O")
    db_session.add(other)
    await db_session.commit()
    await db_session.refresh(other)
    other_env = await create_env_with_project(
        db_session,
        user_id=other.id,
        machine_id="m-other",
        machine_name="other-pod",
    )

    try:
        r = await client.post(
            "/v1/auth/keys",
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
        "/v1/auth/keys",
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
        r = await client.delete(f"/v1/auth/keys/{key.id}")
        assert r.status_code == 404, r.text
    finally:
        await db_session.delete(key)
        await db_session.delete(victim)
        await db_session.commit()
