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
    import uuid

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
    import uuid
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
    import uuid
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
    import uuid

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
    import uuid

    r = await admin_client.delete(
        f"/v1/admin/auth/keys/{uuid.uuid4()}",
        headers=_AUTH,
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_admin_upsert_managed_ai_provider_writes_fixed_contract(
    admin_client, db_session, seed_user
):
    from sqlalchemy import select

    from app.models.ai_provider import AiProvider, AiProviderAuthPayload
    from app.services.managed_ai_provider import (
        MANAGED_AI_PROVIDER_API_MODE,
        MANAGED_AI_PROVIDER_ID,
        MANAGED_AI_PROVIDER_RUNTIME_ENV,
    )
    from app.services.vault_crypto import decrypt

    raw_key = "sk-admin-managed-secret"
    r = await admin_client.put(
        "/v1/admin/ai-providers/clawdi-managed-v2",
        headers=_AUTH,
        json={
            "target_clerk_id": seed_user.clerk_id,
            "base_url": "https://ai-gateway.clawdi.ai/v1",
            "api_key": raw_key,
            "default_model": "gpt-5.4-mini",
        },
    )
    assert r.status_code == 200, r.text
    assert raw_key not in r.text
    assert r.json() == {
        "owner_user_id": str(seed_user.id),
        "owner_clerk_id": seed_user.clerk_id,
        "provider_id": MANAGED_AI_PROVIDER_ID,
        "api_mode": MANAGED_AI_PROVIDER_API_MODE,
        "runtime_env_name": MANAGED_AI_PROVIDER_RUNTIME_ENV,
        "base_url": "https://ai-gateway.clawdi.ai/v1",
        "default_model": "gpt-5.4-mini",
        "has_api_key": True,
    }

    provider = (
        await db_session.execute(
            select(AiProvider).where(
                AiProvider.owner_user_id == seed_user.id,
                AiProvider.provider_id == MANAGED_AI_PROVIDER_ID,
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
    assert provider.archived_at is None

    payload = (
        await db_session.execute(
            select(AiProviderAuthPayload).where(
                AiProviderAuthPayload.owner_user_id == seed_user.id,
                AiProviderAuthPayload.provider_id == MANAGED_AI_PROVIDER_ID,
                AiProviderAuthPayload.auth_profile == "default",
            )
        )
    ).scalar_one()
    assert payload.kind == "api_key"
    assert payload.source == "managed"
    assert payload.payload_metadata == {"runtime_env_name": MANAGED_AI_PROVIDER_RUNTIME_ENV}
    assert decrypt(payload.encrypted_payload, payload.nonce) == raw_key


@pytest.mark.asyncio
async def test_admin_upsert_managed_ai_provider_rotates_existing_payload(
    admin_client, db_session, seed_user
):
    from sqlalchemy import select

    from app.models.ai_provider import AiProvider, AiProviderAuthPayload
    from app.services.managed_ai_provider import MANAGED_AI_PROVIDER_ID
    from app.services.vault_crypto import decrypt

    first = await admin_client.put(
        "/v1/admin/ai-providers/clawdi-managed-v2",
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
        "/v1/admin/ai-providers/clawdi-managed-v2",
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
    assert providers[0].default_model == "gpt-5.4"

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
        "/v1/admin/ai-providers/clawdi-managed-v2",
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
    import uuid

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
async def test_admin_register_env_creates_with_project(admin_client, db_session, seed_user):
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


@pytest.mark.asyncio
async def test_admin_register_env_accepts_explicit_agent_id(admin_client, db_session, seed_user):
    """Hosted registration owns the stable agent id. Machine fields are metadata."""
    import uuid

    from sqlalchemy import select

    from app.models.session import AgentEnvironment

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
    assert env.registration_key is None


@pytest.mark.asyncio
async def test_admin_register_env_explicit_agent_id_is_idempotent(
    admin_client, db_session, seed_user
):
    """Stable agent ids remain the identity while machine fields refresh."""
    import uuid

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
    assert env.agent_version == "1.1.0"
    assert env.os == "darwin"
    assert env.registration_key is None


@pytest.mark.asyncio
async def test_admin_register_env_explicit_ids_allow_same_machine_metadata(
    admin_client, db_session, seed_user
):
    """Two hosted agents can share machine metadata without sharing identity."""
    import uuid

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
    import uuid

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

    deleted_again = await admin_client.delete(
        f"/api/admin/environments/{env_id}",
        headers=_AUTH,
    )
    assert deleted_again.status_code == 404


@pytest.mark.asyncio
async def test_admin_register_env_lazy_creates_user(admin_client, db_session):
    """Same lazy-create contract for env registration: a brand-new
    user clicking Deploy registers their first env. Without this,
    SaaS calls admin_register_environment, gets 404, deploy
    proceeds without sync, and the user has no clue why their pod
    isn't showing up on cloud.clawdi.ai."""
    import uuid

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
