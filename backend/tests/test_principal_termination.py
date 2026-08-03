from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import jwt
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives.asymmetric import rsa
from httpx import ASGITransport
from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core import auth as auth_module
from app.core.config import settings
from app.core.database import get_session
from app.main import app
from app.models.ai_provider import AiProvider
from app.models.api_key import ApiKey
from app.models.audit import ControlPlaneAuditEvent
from app.models.channel import (
    CHANNEL_STATUS_DISABLED,
    WHATSAPP_ONBOARDING_OWNERSHIP_CUSTOM,
    ChannelAccount,
    ChannelWhatsAppOnboardingSession,
)
from app.models.platform_workload_auth import (
    PLATFORM_WORKLOAD_CLIENT_ACTIVE,
    PlatformWorkloadClient,
    PlatformWorkloadSigningKey,
)
from app.models.principal_lifecycle import PrincipalLifecycle, PrincipalLifecycleCommand
from app.models.project import Project
from app.models.session import AgentEnvironment
from app.models.user import PRINCIPAL_KIND_PARTNER_TENANT, User
from app.routes import platform as platform_routes
from app.services import agent_environments as agent_environments_service
from app.services.agent_environments import register_agent_environment
from app.services.api_key import mint_api_key
from app.services.managed_ai_provider import lock_deployment_managed_provider_mutation
from app.services.platform_workload_auth import (
    PLATFORM_WORKLOAD_CLIENT_ASSERTION_TYPE,
    PLATFORM_WORKLOAD_SCOPES,
    InMemoryPlatformWorkloadKeyResolver,
    canonical_platform_workload_token_endpoint,
    get_platform_workload_key_resolver,
)
from app.services.principal_lifecycle import (
    PrincipalTerminatedError,
    assert_clerk_principal_active,
    assert_user_authority_active,
    complete_principal_cleanup,
    fence_principal_termination,
    load_clerk_user_for_issuer,
)
from app.services.whatsapp_device_onboarding import _finalize_connected_account

_ADMIN_KEY = "principal-termination-admin-test"
_CLERK_ISSUER = "https://clerk.termination.example.test"


@dataclass(frozen=True)
class TerminationHarness:
    client: httpx.AsyncClient
    client_id: str
    client_kid: str
    client_private_key: Any


class _GatedWhatsAppRegistry:
    """Minimal registry seam for deterministic promotion transaction tests."""

    def __init__(self, revision: str) -> None:
        self.revision = revision
        self.bind_entered = asyncio.Event()
        self.release_bind = asyncio.Event()
        self.custom_bindings: dict[uuid.UUID, uuid.UUID] = {}

    def custom_session_revision(self, _session_id: uuid.UUID) -> str:
        return self.revision

    async def bind_custom_account(
        self,
        *,
        session_id: uuid.UUID,
        account_id: uuid.UUID,
        config_revision: str,
    ) -> bool:
        assert config_revision == self.revision
        self.bind_entered.set()
        await asyncio.wait_for(self.release_bind.wait(), timeout=5)
        self.custom_bindings[account_id] = session_id
        return True

    def custom_binding(self, account_id: uuid.UUID) -> uuid.UUID | None:
        return self.custom_bindings.get(account_id)

    async def unbind_custom_account(
        self,
        *,
        session_id: uuid.UUID,
        account_id: uuid.UUID,
    ) -> bool:
        if self.custom_bindings.get(account_id) != session_id:
            return False
        del self.custom_bindings[account_id]
        return True


async def _wait_for_advisory_waiter(session_factory, pid: int) -> None:
    async with session_factory() as observer:
        waiting = False
        for _ in range(100):
            waiting = bool(
                await observer.scalar(
                    text(
                        "SELECT EXISTS (SELECT 1 FROM pg_locks "
                        "WHERE pid = :pid AND locktype = 'advisory' AND NOT granted)"
                    ),
                    {"pid": pid},
                )
            )
            if waiting:
                break
            await asyncio.sleep(0.01)
    assert waiting is True


async def _delete_lifecycle(session_factory, lifecycle_id: uuid.UUID | None) -> None:
    if lifecycle_id is None:
        return
    async with session_factory() as session:
        await session.execute(
            delete(PrincipalLifecycleCommand).where(
                PrincipalLifecycleCommand.lifecycle_id == lifecycle_id
            )
        )
        await session.execute(
            delete(PrincipalLifecycle).where(PrincipalLifecycle.id == lifecycle_id)
        )
        await session.commit()


def _public_jwk(private_key: Any, *, kid: str) -> dict[str, Any]:
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key()))
    jwk.update({"kid": kid, "alg": "RS256", "use": "sig", "key_ops": ["verify"]})
    return jwk


@pytest_asyncio.fixture
async def termination_harness(db_session) -> AsyncIterator[TerminationHarness]:
    client_private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    signing_private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    client_id = f"principal-termination-{uuid.uuid4().hex}"
    client_kid = f"client-{uuid.uuid4().hex}"
    signing_kid = f"issuer-{uuid.uuid4().hex}"
    private_key_ref = f"memory://{signing_kid}"
    now = datetime.now(UTC)
    db_session.add_all(
        [
            PlatformWorkloadClient(
                client_id=client_id,
                assertion_kid=client_kid,
                assertion_algorithm="RS256",
                public_jwk=_public_jwk(client_private_key, kid=client_kid),
                status=PLATFORM_WORKLOAD_CLIENT_ACTIVE,
                allowed_scopes=list(PLATFORM_WORKLOAD_SCOPES),
                token_version=1,
            ),
            PlatformWorkloadSigningKey(
                kid=signing_kid,
                algorithm="RS256",
                private_key_ref=private_key_ref,
                status="active",
                not_before=now - timedelta(minutes=1),
                expires_at=now + timedelta(hours=1),
            ),
        ]
    )
    await db_session.commit()
    resolver = InMemoryPlatformWorkloadKeyResolver({private_key_ref: signing_private_key})

    async def _override_get_session():
        yield db_session

    def _override_resolver():
        return resolver

    previous = {
        "admin_api_key": settings.admin_api_key,
        "clerk_jwt_issuer": settings.clerk_jwt_issuer,
        "platform_legacy_admin_auth_enabled": settings.platform_legacy_admin_auth_enabled,
        "platform_workload_issuer": settings.platform_workload_issuer,
        "platform_workload_token_endpoint": settings.platform_workload_token_endpoint,
        "public_api_url": settings.public_api_url,
    }
    settings.admin_api_key = _ADMIN_KEY
    settings.clerk_jwt_issuer = _CLERK_ISSUER
    settings.platform_legacy_admin_auth_enabled = True
    settings.platform_workload_issuer = "principal-termination-platform-test"
    settings.platform_workload_token_endpoint = ""
    settings.public_api_url = "http://test"
    app.dependency_overrides[get_session] = _override_get_session
    app.dependency_overrides[get_platform_workload_key_resolver] = _override_resolver
    try:
        async with httpx.AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            yield TerminationHarness(
                client=client,
                client_id=client_id,
                client_kid=client_kid,
                client_private_key=client_private_key,
            )
    finally:
        app.dependency_overrides.clear()
        for name, value in previous.items():
            setattr(settings, name, value)


def _client_assertion(harness: TerminationHarness) -> str:
    now = int(datetime.now(UTC).timestamp())
    return jwt.encode(
        {
            "iss": harness.client_id,
            "sub": harness.client_id,
            "aud": canonical_platform_workload_token_endpoint(),
            "iat": now,
            "exp": now + 120,
            "jti": str(uuid.uuid4()),
        },
        harness.client_private_key,
        algorithm="RS256",
        headers={"kid": harness.client_kid, "typ": "JWT"},
    )


async def _access_token(harness: TerminationHarness, *scopes: str) -> str:
    response = await harness.client.post(
        "/v1/platform/oauth/token",
        data={
            "grant_type": "client_credentials",
            "client_id": harness.client_id,
            "scope": " ".join(scopes),
            "client_assertion_type": PLATFORM_WORKLOAD_CLIENT_ASSERTION_TYPE,
            "client_assertion": _client_assertion(harness),
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["access_token"]


def _termination_body(subject: str, revision: int, command_id: str) -> dict[str, Any]:
    return {
        "principal": {"kind": "clerk", "issuer": _CLERK_ISSUER, "subject": subject},
        "revision": revision,
        "command_id": command_id,
    }


async def _terminate(
    harness: TerminationHarness,
    token: str,
    *,
    subject: str,
    revision: int,
    command_id: str,
) -> httpx.Response:
    return await harness.client.post(
        "/v1/platform/principals/terminate",
        headers={
            "Authorization": f"Bearer {token}",
            "Idempotency-Key": command_id,
        },
        json=_termination_body(subject, revision, command_id),
    )


async def _create_agent(
    harness: TerminationHarness,
    token: str,
    *,
    owner_kind: str,
    owner_ref: str,
    label: str,
) -> tuple[httpx.Response, uuid.UUID]:
    agent_id = uuid.uuid4()
    response = await harness.client.post(
        "/v1/platform/agents",
        headers={
            "Authorization": f"Bearer {token}",
            "Idempotency-Key": f"{label}-{uuid.uuid4().hex}",
        },
        json={
            "owner": {"kind": owner_kind, "ref": owner_ref},
            "agent_id": str(agent_id),
            "machine_id": label,
            "machine_name": label,
            "agent_type": "openclaw",
            "os_name": "linux",
        },
    )
    return response, agent_id


@pytest.mark.asyncio
async def test_delete_before_create_fences_admin_platform_and_missing_user(
    termination_harness,
    db_session,
):
    subject = f"missing_{uuid.uuid4().hex}"
    command_id = f"terminate-{uuid.uuid4().hex}"
    create_only_token = await _access_token(termination_harness, "platform:agents:create")
    missing_scope = await _terminate(
        termination_harness,
        create_only_token,
        subject=subject,
        revision=1,
        command_id=command_id,
    )
    legacy_admin = await termination_harness.client.post(
        "/v1/platform/principals/terminate",
        headers={"X-Admin-Key": _ADMIN_KEY, "Idempotency-Key": command_id},
        json=_termination_body(subject, 1, command_id),
    )
    assert missing_scope.status_code == 403, missing_scope.text
    assert legacy_admin.status_code == 401, legacy_admin.text

    token = await _access_token(
        termination_harness,
        "platform:principals:terminate",
        "platform:agents:create",
    )
    terminated = await _terminate(
        termination_harness,
        token,
        subject=subject,
        revision=1,
        command_id=command_id,
    )
    assert terminated.status_code == 200, terminated.text
    assert terminated.json() == {
        "principal": {"kind": "clerk", "issuer": _CLERK_ISSUER, "subject": subject},
        "command_id": command_id,
        "requested_revision": 1,
        "accepted_revision": 1,
        "advanced": True,
        "status": "terminated",
        "cleanup_state": "complete",
        "user_disabled": False,
    }

    stale_platform, _ = await _create_agent(
        termination_harness,
        token,
        owner_kind="clerk",
        owner_ref=subject,
        label="stale-platform",
    )
    stale_admin = await termination_harness.client.post(
        "/v1/admin/auth/keys",
        headers={"X-Admin-Key": _ADMIN_KEY},
        json={"target_clerk_id": subject, "label": "stale-admin"},
    )
    assert stale_platform.status_code == 403, stale_platform.text
    assert stale_admin.status_code == 403, stale_admin.text
    assert await db_session.scalar(select(User.id).where(User.clerk_id == subject)) is None
    lifecycle = (
        await db_session.execute(
            select(PrincipalLifecycle).where(PrincipalLifecycle.subject == subject)
        )
    ).scalar_one()
    assert lifecycle.user_id is None
    assert lifecycle.cleanup_completed_at is not None


@pytest.mark.asyncio
async def test_missing_issuer_configuration_cannot_revive_terminated_owner(
    termination_harness,
    db_session,
):
    subject = f"config_removed_{uuid.uuid4().hex}"
    token = await _access_token(
        termination_harness,
        "platform:principals:terminate",
        "platform:agents:create",
    )
    response = await _terminate(
        termination_harness,
        token,
        subject=subject,
        revision=1,
        command_id=f"config-removed-{uuid.uuid4().hex}",
    )
    assert response.status_code == 200, response.text
    previous_issuer = settings.clerk_jwt_issuer
    settings.clerk_jwt_issuer = ""
    try:
        stale_admin = await termination_harness.client.post(
            "/v1/admin/auth/keys",
            headers={"X-Admin-Key": _ADMIN_KEY},
            json={"target_clerk_id": subject, "label": "config-removed"},
        )
        stale_platform, _ = await _create_agent(
            termination_harness,
            token,
            owner_kind="clerk",
            owner_ref=subject,
            label="config-removed",
        )
    finally:
        settings.clerk_jwt_issuer = previous_issuer

    assert stale_admin.status_code == 403, stale_admin.text
    assert stale_platform.status_code == 403, stale_platform.text
    assert await db_session.scalar(select(User.id).where(User.clerk_id == subject)) is None


@pytest.mark.asyncio
async def test_non_jwt_owner_requires_configured_or_bound_issuer(
    termination_harness,
    db_session,
    seed_user,
):
    token = await _access_token(termination_harness, "platform:agents:create")
    previous_issuer = settings.clerk_jwt_issuer
    settings.clerk_jwt_issuer = ""
    try:
        unbound, _ = await _create_agent(
            termination_harness,
            token,
            owner_kind="clerk",
            owner_ref=seed_user.clerk_id,
            label="unbound-owner",
        )
        assert unbound.status_code == 503, unbound.text

        seed_user.clerk_issuer = _CLERK_ISSUER
        await db_session.commit()
        bound, agent_id = await _create_agent(
            termination_harness,
            token,
            owner_kind="clerk",
            owner_ref=seed_user.clerk_id,
            label="bound-owner",
        )
    finally:
        settings.clerk_jwt_issuer = previous_issuer
    assert bound.status_code == 200, bound.text
    assert await db_session.get(AgentEnvironment, agent_id) is not None


@pytest.mark.asyncio
async def test_termination_denies_stale_jwt_and_cached_api_key(
    termination_harness,
    db_session,
    seed_user,
    monkeypatch,
):
    minted = await mint_api_key(
        db_session,
        user_id=seed_user.id,
        label="termination-cache-test",
        commit=True,
    )

    api_headers = {"Authorization": f"Bearer {minted.raw_key}"}
    before_api_key = await termination_harness.client.get("/v1/auth/me", headers=api_headers)
    assert before_api_key.status_code == 200, before_api_key.text

    clerk_private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = int(datetime.now(UTC).timestamp())
    clerk_jwt = jwt.encode(
        {
            "sub": seed_user.clerk_id,
            "iss": _CLERK_ISSUER,
            "iat": now,
            "exp": now + 600,
            "email": seed_user.email,
        },
        clerk_private_key,
        algorithm="RS256",
    )

    async def _resolve_test_clerk_key(_token: str):
        return clerk_private_key.public_key()

    monkeypatch.setattr(auth_module, "_resolve_clerk_signing_key", _resolve_test_clerk_key)
    jwt_headers = {"Authorization": f"Bearer {clerk_jwt}"}
    before_jwt = await termination_harness.client.get("/v1/auth/me", headers=jwt_headers)
    assert before_jwt.status_code == 200, before_jwt.text

    # Simulate another worker retaining its positive cache. Cache hits must
    # still consult the durable user/fence state after termination commits.
    monkeypatch.setattr(platform_routes, "invalidate_user_api_key_auth_cache", lambda _id: None)
    monkeypatch.setattr(platform_routes, "invalidate_api_key_auth_cache", lambda _id: None)
    token = await _access_token(termination_harness, "platform:principals:terminate")
    command_id = f"terminate-{uuid.uuid4().hex}"
    response = await _terminate(
        termination_harness,
        token,
        subject=seed_user.clerk_id,
        revision=4,
        command_id=command_id,
    )
    assert response.status_code == 200, response.text
    assert response.json()["user_disabled"] is True

    after_api_key = await termination_harness.client.get("/v1/auth/me", headers=api_headers)
    after_jwt = await termination_harness.client.get("/v1/auth/me", headers=jwt_headers)
    assert after_api_key.status_code == 401, after_api_key.text
    assert after_jwt.status_code == 401, after_jwt.text

    await db_session.refresh(seed_user)
    await db_session.refresh(minted.api_key)
    assert seed_user.clerk_issuer == _CLERK_ISSUER
    assert minted.api_key.revoked_at is not None


@pytest.mark.asyncio
async def test_revision_ordering_and_command_idempotency(termination_harness, db_session):
    subject = f"revision_{uuid.uuid4().hex}"
    token = await _access_token(termination_harness, "platform:principals:terminate")
    command_5 = f"revision-5-{uuid.uuid4().hex}"
    first = await _terminate(
        termination_harness,
        token,
        subject=subject,
        revision=5,
        command_id=command_5,
    )
    duplicate = await _terminate(
        termination_harness,
        token,
        subject=subject,
        revision=5,
        command_id=command_5,
    )
    lower = await _terminate(
        termination_harness,
        token,
        subject=subject,
        revision=4,
        command_id=f"revision-4-{uuid.uuid4().hex}",
    )
    equal = await _terminate(
        termination_harness,
        token,
        subject=subject,
        revision=5,
        command_id=f"revision-5-equal-{uuid.uuid4().hex}",
    )
    higher = await _terminate(
        termination_harness,
        token,
        subject=subject,
        revision=6,
        command_id=f"revision-6-{uuid.uuid4().hex}",
    )
    assert first.status_code == duplicate.status_code == 200
    assert duplicate.json() == first.json()
    assert lower.status_code == equal.status_code == higher.status_code == 200
    assert lower.json()["advanced"] is False
    assert lower.json()["accepted_revision"] == 5
    assert equal.json()["advanced"] is False
    assert higher.json()["advanced"] is True
    assert higher.json()["accepted_revision"] == 6
    lifecycle = (
        await db_session.execute(
            select(PrincipalLifecycle).where(PrincipalLifecycle.subject == subject)
        )
    ).scalar_one()
    assert lifecycle.current_revision == 6
    assert lifecycle.cleanup_completed_at is not None
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(PrincipalLifecycleCommand)
            .where(PrincipalLifecycleCommand.lifecycle_id == lifecycle.id)
        )
        == 4
    )


@pytest.mark.asyncio
async def test_cleanup_failure_keeps_fence_and_retry_repairs(
    termination_harness,
    db_session,
    seed_user,
    monkeypatch,
):
    subject = seed_user.clerk_id
    assert subject is not None
    command_id = f"repair-{uuid.uuid4().hex}"
    token = await _access_token(termination_harness, "platform:principals:terminate")
    minted = await mint_api_key(
        db_session,
        user_id=seed_user.id,
        label="termination-repair-cache-test",
        commit=True,
    )
    api_headers = {"Authorization": f"Bearer {minted.raw_key}"}
    assert (
        await termination_harness.client.get("/v1/auth/me", headers=api_headers)
    ).status_code == 200

    async def _fail_cleanup(*args, **kwargs):
        raise RuntimeError("injected cleanup failure")

    with monkeypatch.context() as scoped:
        scoped.setattr(platform_routes, "complete_principal_cleanup", _fail_cleanup)
        failed = await _terminate(
            termination_harness,
            token,
            subject=subject,
            revision=1,
            command_id=command_id,
        )
    assert failed.status_code == 503, failed.text
    lifecycle = (
        await db_session.execute(
            select(PrincipalLifecycle).where(PrincipalLifecycle.subject == subject)
        )
    ).scalar_one()
    assert lifecycle.cleanup_completed_at is None
    assert lifecycle.next_cleanup_attempt_at is not None
    assert lifecycle.cleanup_claim_id is None
    await db_session.refresh(seed_user)
    await db_session.refresh(minted.api_key)
    assert minted.api_key.revoked_at is None
    fenced_api_key = await termination_harness.client.get("/v1/auth/me", headers=api_headers)
    assert fenced_api_key.status_code == 401, fenced_api_key.text

    repaired = await _terminate(
        termination_harness,
        token,
        subject=subject,
        revision=1,
        command_id=command_id,
    )
    assert repaired.status_code == 200, repaired.text
    await db_session.refresh(lifecycle)
    await db_session.refresh(seed_user)
    await db_session.refresh(minted.api_key)
    assert lifecycle.cleanup_completed_at is not None
    assert minted.api_key.revoked_at is not None


@pytest.mark.asyncio
async def test_partner_tenant_owner_is_not_fenced_by_clerk_lifecycle(
    termination_harness,
    db_session,
):
    partner_ref = f"partner:{uuid.uuid4().hex}"
    partner = User(
        clerk_id=None,
        clerk_issuer=None,
        principal_kind=PRINCIPAL_KIND_PARTNER_TENANT,
        partner_tenant_ref=partner_ref,
    )
    db_session.add(partner)
    await db_session.flush()
    personal = Project(
        user_id=partner.id,
        name="Personal",
        slug="personal",
        kind="personal",
    )
    db_session.add(personal)
    await db_session.commit()
    token = await _access_token(
        termination_harness,
        "platform:principals:terminate",
        "platform:agents:create",
    )
    await _terminate(
        termination_harness,
        token,
        subject=f"unrelated_{uuid.uuid4().hex}",
        revision=1,
        command_id=f"unrelated-{uuid.uuid4().hex}",
    )
    created, agent_id = await _create_agent(
        termination_harness,
        token,
        owner_kind="partner_tenant",
        owner_ref=partner_ref,
        label="partner-agent",
    )
    assert created.status_code == 200, created.text
    assert await db_session.get(AgentEnvironment, agent_id) is not None


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_active_requests_share_locks_and_termination_waits_then_revokes(
    engine,
    db_session,
    seed_user,
):
    subject = seed_user.clerk_id
    assert subject is not None
    seed_user.clerk_issuer = _CLERK_ISSUER
    await db_session.commit()
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    release_active = asyncio.Event()
    active_ready = [asyncio.Event(), asyncio.Event()]
    created_key_ids: list[uuid.UUID] = []
    termination_started = asyncio.Event()
    termination_pid: int | None = None
    command_id = f"shared-lock-{uuid.uuid4().hex}"
    lifecycle_id: uuid.UUID | None = None
    previous_issuer = settings.clerk_jwt_issuer
    settings.clerk_jwt_issuer = _CLERK_ISSUER

    async def _active_request(index: int) -> None:
        async with session_factory() as session:
            await assert_clerk_principal_active(
                session,
                issuer=_CLERK_ISSUER,
                subject=subject,
            )
            await assert_user_authority_active(session, seed_user.id)
            minted = await mint_api_key(
                session,
                user_id=seed_user.id,
                label=f"shared-active-{index}",
                commit=False,
            )
            created_key_ids.append(minted.api_key.id)
            active_ready[index].set()
            await asyncio.wait_for(release_active.wait(), timeout=5)
            await session.commit()

    async def _terminate_after_active_requests() -> uuid.UUID:
        nonlocal termination_pid
        async with session_factory() as session:
            termination_pid = await session.scalar(select(func.pg_backend_pid()))
            termination_started.set()
            receipt = await fence_principal_termination(
                session,
                issuer=_CLERK_ISSUER,
                subject=subject,
                revision=1,
                command_id=command_id,
            )
            await session.commit()
            await complete_principal_cleanup(session, lifecycle_id=receipt.lifecycle_id)
            await session.commit()
            return receipt.lifecycle_id

    active_tasks = [asyncio.create_task(_active_request(index)) for index in range(2)]
    termination_task: asyncio.Task[uuid.UUID] | None = None
    try:
        # Both requests reach the mutation while the other transaction is
        # still open; exclusive active-request locks would time out here.
        await asyncio.wait_for(
            asyncio.gather(*(event.wait() for event in active_ready)),
            timeout=5,
        )
        termination_task = asyncio.create_task(_terminate_after_active_requests())
        await asyncio.wait_for(termination_started.wait(), timeout=5)
        assert termination_pid is not None

        await _wait_for_advisory_waiter(session_factory, termination_pid)

        release_active.set()
        await asyncio.wait_for(asyncio.gather(*active_tasks), timeout=5)
        lifecycle_id = await asyncio.wait_for(termination_task, timeout=10)

        async with session_factory() as session:
            revoked_count = await session.scalar(
                select(func.count())
                .select_from(ApiKey)
                .where(
                    ApiKey.id.in_(created_key_ids),
                    ApiKey.revoked_at.is_not(None),
                )
            )
            assert revoked_count == 2
            with pytest.raises(PrincipalTerminatedError):
                await assert_user_authority_active(session, seed_user.id)
            await session.rollback()
    finally:
        settings.clerk_jwt_issuer = previous_issuer
        release_active.set()
        for task in active_tasks:
            if not task.done():
                task.cancel()
        if termination_task is not None and not termination_task.done():
            termination_task.cancel()
        await asyncio.gather(*active_tasks, return_exceptions=True)
        if termination_task is not None:
            await asyncio.gather(termination_task, return_exceptions=True)
        await _delete_lifecycle(session_factory, lifecycle_id)


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_cross_issuer_legacy_binding_keeps_authority_before_user_row_lock(
    engine,
    db_session,
    seed_user,
):
    subject = seed_user.clerk_id
    assert subject is not None
    seed_user.clerk_issuer = None
    await db_session.commit()

    binding_issuer = "https://binding.clerk.example.test"
    command_id = f"cross-issuer-lock-{uuid.uuid4().hex}"
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    binding_holds_row = asyncio.Event()
    release_binding = asyncio.Event()
    termination_started = asyncio.Event()
    termination_pid: int | None = None
    lifecycle_id: uuid.UUID | None = None
    previous_issuer = settings.clerk_jwt_issuer
    settings.clerk_jwt_issuer = _CLERK_ISSUER

    async def _bind_legacy_user() -> None:
        async with session_factory() as session:
            await assert_clerk_principal_active(
                session,
                issuer=binding_issuer,
                subject=subject,
            )
            user = await load_clerk_user_for_issuer(
                session,
                issuer=binding_issuer,
                subject=subject,
                bind_legacy=True,
            )
            assert user is not None
            binding_holds_row.set()
            await asyncio.wait_for(release_binding.wait(), timeout=5)
            # Mirrors JWT auth after its legacy issuer binding. This shared
            # lock is reentrant only when the helper acquired authority before
            # the User row; the old row-then-authority order deadlocked here.
            await assert_user_authority_active(session, user.id)
            await session.commit()

    async def _terminate_other_issuer() -> uuid.UUID:
        nonlocal termination_pid
        await asyncio.wait_for(binding_holds_row.wait(), timeout=5)
        async with session_factory() as session:
            termination_pid = await session.scalar(select(func.pg_backend_pid()))
            termination_started.set()
            receipt = await fence_principal_termination(
                session,
                issuer=_CLERK_ISSUER,
                subject=subject,
                revision=1,
                command_id=command_id,
            )
            assert receipt.user_id is None
            await session.commit()
            await complete_principal_cleanup(session, lifecycle_id=receipt.lifecycle_id)
            await session.commit()
            return receipt.lifecycle_id

    binding_task = asyncio.create_task(_bind_legacy_user())
    termination_task = asyncio.create_task(_terminate_other_issuer())
    try:
        await asyncio.wait_for(termination_started.wait(), timeout=5)
        assert termination_pid is not None
        await _wait_for_advisory_waiter(session_factory, termination_pid)
        release_binding.set()
        _, lifecycle_id = await asyncio.wait_for(
            asyncio.gather(binding_task, termination_task),
            timeout=10,
        )

        async with session_factory() as session:
            user = await session.get(User, seed_user.id)
            lifecycle = await session.get(PrincipalLifecycle, lifecycle_id)
            assert user is not None
            assert user.clerk_issuer == binding_issuer
            assert lifecycle is not None
            assert lifecycle.issuer == _CLERK_ISSUER
            assert lifecycle.user_id is None
            assert lifecycle.cleanup_completed_at is not None
    finally:
        settings.clerk_jwt_issuer = previous_issuer
        release_binding.set()
        for task in (binding_task, termination_task):
            if not task.done():
                task.cancel()
        await asyncio.gather(binding_task, termination_task, return_exceptions=True)
        await _delete_lifecycle(session_factory, lifecycle_id)


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_registration_rollback_rechecks_fence_before_refreshing_winner(
    engine,
    db_session,
    seed_user,
    monkeypatch,
):
    subject = seed_user.clerk_id
    assert subject is not None
    seed_user.clerk_issuer = _CLERK_ISSUER
    await db_session.commit()
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    environment_id = uuid.uuid4()
    loser_reached_create = asyncio.Event()
    release_loser = asyncio.Event()
    termination_started = asyncio.Event()
    termination_pid: int | None = None
    lifecycle_id: uuid.UUID | None = None
    original_next_name = agent_environments_service._next_explicit_default_name
    previous_issuer = settings.clerk_jwt_issuer
    settings.clerk_jwt_issuer = _CLERK_ISSUER

    async def _gated_next_name(db, user_id, agent_type):
        loser_reached_create.set()
        await asyncio.wait_for(release_loser.wait(), timeout=5)
        return await original_next_name(db, user_id, agent_type)

    async def _losing_registration():
        async with session_factory() as session:
            return await register_agent_environment(
                session,
                user_id=seed_user.id,
                environment_id=environment_id,
                machine_id="loser-machine",
                machine_name="Losing Registration",
                agent_type="codex",
                agent_version="loser",
                os_name="linux",
                sort_order=1,
                registration_key=None,
            )

    async def _terminate() -> uuid.UUID:
        nonlocal termination_pid
        async with session_factory() as session:
            termination_pid = await session.scalar(select(func.pg_backend_pid()))
            termination_started.set()
            command_id = f"registration-rollback-{uuid.uuid4().hex}"
            receipt = await fence_principal_termination(
                session,
                issuer=_CLERK_ISSUER,
                subject=subject,
                revision=1,
                command_id=command_id,
            )
            await session.commit()
            await complete_principal_cleanup(session, lifecycle_id=receipt.lifecycle_id)
            await session.commit()
            return receipt.lifecycle_id

    monkeypatch.setattr(
        agent_environments_service,
        "_next_explicit_default_name",
        _gated_next_name,
    )
    loser_task = asyncio.create_task(_losing_registration())
    termination_task: asyncio.Task[uuid.UUID] | None = None
    try:
        await asyncio.wait_for(loser_reached_create.wait(), timeout=5)
        async with session_factory() as session:
            winner = await register_agent_environment(
                session,
                user_id=seed_user.id,
                environment_id=environment_id,
                machine_id="winner-machine",
                machine_name="Winning Registration",
                agent_type="codex",
                agent_version="winner",
                os_name="linux",
                sort_order=2,
                registration_key=f"winner:{uuid.uuid4().hex}",
            )
            assert winner.created is True

        termination_task = asyncio.create_task(_terminate())
        await asyncio.wait_for(termination_started.wait(), timeout=5)
        assert termination_pid is not None
        await _wait_for_advisory_waiter(session_factory, termination_pid)

        release_loser.set()
        loser_result = (await asyncio.gather(loser_task, return_exceptions=True))[0]
        assert isinstance(loser_result, PrincipalTerminatedError)
        lifecycle_id = await asyncio.wait_for(termination_task, timeout=10)

        async with session_factory() as session:
            registered = await session.get(AgentEnvironment, environment_id)
            assert registered is not None
            assert registered.machine_id == "winner-machine"
            assert registered.agent_version == "winner"
            assert registered.archived_at is not None
    finally:
        settings.clerk_jwt_issuer = previous_issuer
        release_loser.set()
        if not loser_task.done():
            loser_task.cancel()
        if termination_task is not None and not termination_task.done():
            termination_task.cancel()
        await asyncio.gather(loser_task, return_exceptions=True)
        if termination_task is not None:
            await asyncio.gather(termination_task, return_exceptions=True)
        await _delete_lifecycle(session_factory, lifecycle_id)


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_whatsapp_promotion_is_ordered_before_cleanup_and_stale_retry_is_fenced(
    engine,
    db_session,
    seed_user,
):
    subject = seed_user.clerk_id
    assert subject is not None
    seed_user.clerk_issuer = _CLERK_ISSUER
    revision = f"promotion-{uuid.uuid4().hex}"
    now = datetime.now(UTC)
    first = ChannelWhatsAppOnboardingSession(
        ownership_kind=WHATSAPP_ONBOARDING_OWNERSHIP_CUSTOM,
        sidecar_account_id=uuid.uuid4(),
        sidecar_config_revision=revision,
        user_id=seed_user.id,
        request_id=uuid.uuid4(),
        name="Concurrent custom",
        state="ready",
        method="qr",
        started_at=now,
        expires_at=now + timedelta(minutes=5),
    )
    stale = ChannelWhatsAppOnboardingSession(
        ownership_kind=first.ownership_kind,
        sidecar_account_id=uuid.uuid4(),
        sidecar_config_revision=revision,
        user_id=seed_user.id,
        request_id=uuid.uuid4(),
        name="Stale custom",
        state="ready",
        method="qr",
        started_at=now,
        expires_at=now + timedelta(minutes=5),
    )
    db_session.add_all([first, stale])
    await db_session.commit()

    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    registry = _GatedWhatsAppRegistry(revision)
    termination_started = asyncio.Event()
    termination_pid: int | None = None
    lifecycle_id: uuid.UUID | None = None
    previous_issuer = settings.clerk_jwt_issuer
    settings.clerk_jwt_issuer = _CLERK_ISSUER

    async def _run_promotion(onboarding_id: uuid.UUID) -> None:
        async with session_factory() as session:
            onboarding = await session.get(ChannelWhatsAppOnboardingSession, onboarding_id)
            assert onboarding is not None
            await _finalize_connected_account(
                session,
                onboarding=onboarding,
                registry=registry,
            )

    async def _terminate() -> uuid.UUID:
        nonlocal termination_pid
        async with session_factory() as session:
            termination_pid = await session.scalar(select(func.pg_backend_pid()))
            termination_started.set()
            command_id = f"whatsapp-custom-{uuid.uuid4().hex}"
            receipt = await fence_principal_termination(
                session,
                issuer=_CLERK_ISSUER,
                subject=subject,
                revision=1,
                command_id=command_id,
            )
            await session.commit()
            await complete_principal_cleanup(session, lifecycle_id=receipt.lifecycle_id)
            await session.commit()
            return receipt.lifecycle_id

    promotion_task = asyncio.create_task(_run_promotion(first.id))
    termination_task: asyncio.Task[uuid.UUID] | None = None
    try:
        await asyncio.wait_for(registry.bind_entered.wait(), timeout=5)
        termination_task = asyncio.create_task(_terminate())
        await asyncio.wait_for(termination_started.wait(), timeout=5)
        assert termination_pid is not None
        await _wait_for_advisory_waiter(session_factory, termination_pid)

        registry.release_bind.set()
        await asyncio.wait_for(promotion_task, timeout=5)
        lifecycle_id = await asyncio.wait_for(termination_task, timeout=10)

        async with session_factory() as session:
            lifecycle = await session.get(PrincipalLifecycle, lifecycle_id)
            assert lifecycle is not None
            assert lifecycle.cleanup_completed_at is not None
            promoted = await session.get(ChannelWhatsAppOnboardingSession, first.id)
            assert promoted is not None
            assert promoted.channel_account_id is not None
            account = await session.get(ChannelAccount, promoted.channel_account_id)
            assert account is not None
            assert account.status == CHANNEL_STATUS_DISABLED
            assert account.archived_at is not None

        with pytest.raises(PrincipalTerminatedError):
            await _run_promotion(stale.id)

        async with session_factory() as session:
            stale_after = await session.get(ChannelWhatsAppOnboardingSession, stale.id)
            assert stale_after is not None
            assert stale_after.channel_account_id is None
    finally:
        settings.clerk_jwt_issuer = previous_issuer
        registry.release_bind.set()
        if not promotion_task.done():
            promotion_task.cancel()
        if termination_task is not None and not termination_task.done():
            termination_task.cancel()
        await asyncio.gather(promotion_task, return_exceptions=True)
        if termination_task is not None:
            await asyncio.gather(termination_task, return_exceptions=True)
        await _delete_lifecycle(session_factory, lifecycle_id)


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_concurrent_endpoint_replay_uses_durable_command_receipt(
    termination_harness,
    engine,
):
    """Concurrent HTTP retries converge through the durable command receipt."""

    subject = f"endpoint_concurrent_{uuid.uuid4().hex}"
    command_id = f"endpoint-concurrent-{uuid.uuid4().hex}"
    token = await _access_token(termination_harness, "platform:principals:terminate")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async def _fresh_session() -> AsyncIterator[Any]:
        async with session_factory() as session:
            yield session

    previous_session_override = app.dependency_overrides[get_session]
    app.dependency_overrides[get_session] = _fresh_session
    higher_command_id = f"endpoint-concurrent-higher-{uuid.uuid4().hex}"
    tasks = [
        asyncio.create_task(
            _terminate(
                termination_harness,
                token,
                subject=subject,
                revision=revision,
                command_id=current_command_id,
            )
        )
        for revision, current_command_id in (
            (7, command_id),
            (7, command_id),
            (8, higher_command_id),
        )
    ]
    try:
        first, duplicate, higher = await asyncio.wait_for(
            asyncio.gather(*tasks),
            timeout=10,
        )
        assert first.status_code == duplicate.status_code == higher.status_code == 200
        assert duplicate.json() == first.json()
        assert higher.json()["accepted_revision"] == 8
        assert higher.json()["advanced"] is True
    finally:
        app.dependency_overrides[get_session] = previous_session_override
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async with session_factory() as session:
        lifecycle = (
            await session.execute(
                select(PrincipalLifecycle).where(PrincipalLifecycle.subject == subject)
            )
        ).scalar_one()
        assert lifecycle.current_revision == 8
        assert lifecycle.cleanup_completed_at is not None
        assert (
            await session.scalar(
                select(func.count())
                .select_from(PrincipalLifecycleCommand)
                .where(PrincipalLifecycleCommand.lifecycle_id == lifecycle.id)
            )
            == 2
        )
        await session.execute(
            delete(ControlPlaneAuditEvent).where(
                ControlPlaneAuditEvent.resource_id == f"{_CLERK_ISSUER}#{subject}"
            )
        )
        await session.execute(
            delete(PrincipalLifecycleCommand).where(
                PrincipalLifecycleCommand.lifecycle_id == lifecycle.id
            )
        )
        await session.delete(lifecycle)
        await session.commit()


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_provider_mutation_holds_principal_authority_before_owner_lock(
    engine,
    db_session,
    seed_user,
):
    """The established provider owner lock remains below principal authority."""

    subject = seed_user.clerk_id
    assert subject is not None
    seed_user.clerk_issuer = _CLERK_ISSUER
    provider_id = f"clawdi-v2-deployment-{uuid.uuid4().int}"
    provider = AiProvider(
        owner_user_id=seed_user.id,
        provider_id=provider_id,
        type="openai_compatible",
        label="Termination Lock Ordering",
        base_url="https://provider-lock.example.test/v1",
        auth_type="none",
        managed_by="clawdi",
    )
    db_session.add(provider)
    await db_session.commit()

    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    provider_mutation_ready = asyncio.Event()
    release_provider_mutation = asyncio.Event()
    termination_started = asyncio.Event()
    termination_pid: int | None = None
    lifecycle_id: uuid.UUID | None = None
    previous_issuer = settings.clerk_jwt_issuer
    settings.clerk_jwt_issuer = _CLERK_ISSUER

    async def _paused_provider_mutation() -> None:
        async with session_factory() as session:
            await assert_clerk_principal_active(
                session,
                issuer=_CLERK_ISSUER,
                subject=subject,
            )
            await assert_user_authority_active(session, seed_user.id)
            await lock_deployment_managed_provider_mutation(
                session,
                owner_user_id=seed_user.id,
                provider_id=provider_id,
            )
            provider_mutation_ready.set()
            await asyncio.wait_for(release_provider_mutation.wait(), timeout=5)
            await session.commit()

    async def _terminate_while_provider_is_paused() -> None:
        nonlocal lifecycle_id, termination_pid
        await asyncio.wait_for(provider_mutation_ready.wait(), timeout=5)
        command_id = f"provider-race-{uuid.uuid4().hex}"
        async with session_factory() as session:
            termination_pid = await session.scalar(select(func.pg_backend_pid()))
            termination_started.set()
            receipt = await fence_principal_termination(
                session,
                issuer=_CLERK_ISSUER,
                subject=subject,
                revision=1,
                command_id=command_id,
            )
            lifecycle_id = receipt.lifecycle_id
            await session.commit()
            await complete_principal_cleanup(session, lifecycle_id=receipt.lifecycle_id)
            await session.commit()

    tasks = [
        asyncio.create_task(_paused_provider_mutation()),
        asyncio.create_task(_terminate_while_provider_is_paused()),
    ]
    try:
        await asyncio.wait_for(termination_started.wait(), timeout=5)
        assert termination_pid is not None
        await _wait_for_advisory_waiter(session_factory, termination_pid)
        release_provider_mutation.set()
        await asyncio.wait_for(asyncio.gather(*tasks), timeout=10)
    finally:
        settings.clerk_jwt_issuer = previous_issuer
        release_provider_mutation.set()
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    await db_session.refresh(seed_user)
    await db_session.refresh(provider)
    assert provider.archived_at is not None

    await _delete_lifecycle(session_factory, lifecycle_id)
