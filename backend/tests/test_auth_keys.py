"""ApiKey lifecycle and authentication edge cases.

Covers the security-sensitive parts of ``app.core.auth`` that the smoke
tests don't exercise: the raw key is only returned on creation, the stored
hash is never round-trippable, a revoked key authenticates with 401, and
``/api/auth/me`` reflects the auth method used.
"""

from __future__ import annotations

import hashlib
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi import HTTPException
from httpx import ASGITransport
from sqlalchemy import func, select

from app.core.auth import AuthContext, get_auth, require_auth_scopes
from app.main import app
from app.models.api_key import ApiKey
from app.services.api_key import mint_api_key
from app.services.metrics import registry


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid_expiry", ["naive", "past"])
async def test_mint_api_key_rejects_invalid_expiry(db_session, seed_user, invalid_expiry):
    from datetime import UTC, datetime, timedelta

    from app.services.api_key import mint_api_key

    expires_at = (
        datetime(2030, 1, 1)
        if invalid_expiry == "naive"
        else datetime.now(UTC) - timedelta(seconds=1)
    )
    with pytest.raises(ValueError, match="expires_at must be"):
        await mint_api_key(
            db_session, user_id=seed_user.id, label="invalid-expiry", expires_at=expires_at
        )


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


@pytest.mark.parametrize("prefix", ["/v1", "/api"])
@pytest.mark.parametrize(
    "body",
    [
        None,
        {"label": "old-client"},
        {"label": "scoped-client", "scopes": ["sessions:write"], "expires_in_days": 30},
        {"environment_id": "not-a-uuid", "scopes": [], "expires_in_days": 0},
    ],
)
async def test_personal_key_creation_is_retired_without_issuing_keys(db_session, prefix, body):
    before = await db_session.scalar(select(func.count()).select_from(ApiKey))
    # No login or database dependency is needed to report permanent retirement.
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post(f"{prefix}/auth/keys", json=body)
    assert response.status_code == 410, response.text
    assert response.json() == {
        "detail": "API keys can no longer be created. Run `clawdi auth login` "
        "(use `--no-open` on a server). Existing keys keep working until revoked."
    }
    assert await db_session.scalar(select(func.count()).select_from(ApiKey)) == before


@pytest.mark.parametrize("prefix", ["/v1", "/api"])
async def test_internal_key_listing_exposes_scopes_and_expiry_but_never_secrets(
    client: httpx.AsyncClient, db_session, seed_user, prefix
):
    expiry = datetime.now(UTC) + timedelta(days=30)
    minted = await mint_api_key(
        db_session,
        user_id=seed_user.id,
        label="internal",
        scopes=["sessions:write"],
        expires_at=expiry,
    )
    raw = minted.raw_key
    assert raw.startswith("clawdi_")
    assert minted.api_key.key_prefix == raw[:16]
    listing = await client.get(f"{prefix}/auth/keys")
    assert listing.status_code == 200, listing.text
    listed = next(key for key in listing.json() if key["id"] == str(minted.api_key.id))
    assert listed["scopes"] == ["sessions:write"]
    assert datetime.fromisoformat(listed["expires_at"]) == expiry
    assert all("raw_key" not in key and "key_hash" not in key for key in listing.json())
    assert minted.api_key.key_hash == hashlib.sha256(raw.encode()).hexdigest()
    assert minted.api_key.key_hash != raw


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
    other_key = await mint_api_key(
        db_session, user_id=seed_user.id, label="other authority key", scopes=["skills:read"]
    )
    assert await _auth_via_api_key(minted.raw_key, db_session) is not None
    other_auth = await _auth_via_api_key(other_key.raw_key, db_session)
    assert other_auth is not None and other_auth.api_key is not None
    assert other_auth.api_key.id == other_key.api_key.id
    assert other_auth.api_key.scopes == ["skills:read"]
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
    client: httpx.AsyncClient, db_session, seed_user
):
    minted = await mint_api_key(db_session, user_id=seed_user.id, label="to-revoke")
    key_id = str(minted.api_key.id)
    r = await client.delete(f"/v1/auth/keys/{key_id}")
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "revoked"}

    # The user-facing list is active-only, but soft revocation keeps the row for audit.
    listing = (await client.get("/v1/auth/keys")).json()
    assert key_id not in {key["id"] for key in listing}

    revoked_at = await db_session.scalar(select(ApiKey.revoked_at).where(ApiKey.id == key_id))
    assert revoked_at is not None


@pytest.mark.asyncio
async def test_managed_api_key_is_hidden_from_user_list(
    client: httpx.AsyncClient, db_session, seed_user
):
    from sqlalchemy import select

    from app.models.api_key import ApiKey

    visible = await mint_api_key(db_session, user_id=seed_user.id, label="visible")
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
    assert str(visible.api_key.id) in {item["id"] for item in listing.json()}
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


async def test_internal_scoped_key_allows_sync_but_rejects_account_management(
    client, db_session, seed_user
):
    from app.core.api_scopes import RUNTIME_MCP_SCOPES

    minted = await mint_api_key(
        db_session, user_id=seed_user.id, label="internal-sync", scopes=list(RUNTIME_MCP_SCOPES)
    )
    app.dependency_overrides.pop(get_auth)
    headers = {"Authorization": f"Bearer {minted.raw_key}"}
    denied = await client.get("/v1/settings", headers=headers)
    assert denied.status_code == 403, denied.text
    vault_list = await client.get("/v1/vault", headers=headers)
    assert vault_list.status_code == 403, vault_list.text
    registered = await client.post(
        "/v1/agents",
        headers=headers,
        json={
            "machine_id": "scoped-sync",
            "machine_name": "Scoped sync",
            "os": "linux",
            "agent_type": "claude_code",
        },
    )
    assert registered.status_code == 200, registered.text
    synced = await client.post("/v1/sessions/batch", headers=headers, json={"sessions": []})
    assert synced.status_code == 200, synced.text


@pytest.mark.parametrize(
    "kind", ["personal_api_key", "env_api_key", "managed_legacy_key", "runtime_key"]
)
async def test_authenticated_api_key_requests_count_once_and_expired_keys_do_not(
    db_session, seed_user, kind
):
    from app.core.database import get_session
    from app.services.api_key import mint_api_key
    from app.services.runtime_observation import provision_runtime_environment_fence
    from tests.conftest import create_env_with_project

    environment_id = None
    deployment_id = None
    if kind in ("env_api_key", "runtime_key"):
        env = await create_env_with_project(
            db_session, user_id=seed_user.id, machine_id=f"metric-{kind}", machine_name="Metrics"
        )
        environment_id = env.id
    if kind == "runtime_key":
        deployment_id = "metric-runtime-deployment"
        await provision_runtime_environment_fence(
            db_session,
            environment_id=environment_id,
            owner_id=seed_user.id,
            deployment_id=deployment_id,
        )
    minted = await mint_api_key(
        db_session,
        user_id=seed_user.id,
        label="metrics",
        environment_id=environment_id,
        runtime_deployment_id=deployment_id,
        managed=kind in ("managed_legacy_key", "runtime_key"),
    )

    async def override_session():
        yield db_session

    app.dependency_overrides[get_session] = override_session
    labels = {"kind": kind, "surface": "user"}
    before = registry.get_sample_value("clawdi_backend_authenticated_requests_total", labels) or 0
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get(
            "/v1/auth/me", headers={"Authorization": f"Bearer {minted.raw_key}"}
        )
        assert response.status_code == 200, response.text
        assert (
            registry.get_sample_value("clawdi_backend_authenticated_requests_total", labels)
            == before + 1
        )
        minted.api_key.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await db_session.commit()
        expired = await ac.get("/v1/auth/me", headers={"Authorization": f"Bearer {minted.raw_key}"})
        assert expired.status_code == 401, expired.text
        assert (
            registry.get_sample_value("clawdi_backend_authenticated_requests_total", labels)
            == before + 1
        )


async def test_legacy_full_access_non_expiring_key_is_still_listed_and_usable(
    client, db_session, seed_user
):
    from app.services.api_key import mint_api_key

    minted = await mint_api_key(db_session, user_id=seed_user.id, label="legacy")
    listed = (await client.get("/v1/auth/keys")).json()
    legacy = next(key for key in listed if key["id"] == str(minted.api_key.id))
    assert legacy["scopes"] is None
    assert legacy["expires_at"] is None
    app.dependency_overrides.pop(get_auth)
    response = await client.get(
        "/v1/settings", headers={"Authorization": f"Bearer {minted.raw_key}"}
    )
    assert response.status_code == 200, response.text
