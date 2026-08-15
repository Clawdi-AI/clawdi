from __future__ import annotations

import asyncio
import hashlib
import logging
import uuid
from collections.abc import AsyncIterator
from copy import deepcopy

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport
from sqlalchemy import func, select

from app.core.config import settings
from app.core.database import get_session
from app.main import app
from app.models.api_key import ApiKey
from app.models.audit import ControlPlaneAuditEvent
from app.models.hosted_runtime import HostedRuntimeSecret, HostedRuntimeState
from app.models.platform_idempotency import PlatformMutationIdempotency
from app.models.session import AgentEnvironment
from app.models.skill import SKILL_AUTHORITY_AGENT_SYNC, SKILL_AUTHORITY_CLOUD, Skill
from app.models.user import PRINCIPAL_KIND_PARTNER_TENANT, User
from app.schemas.platform import PLATFORM_RUNTIME_KEY_SCOPES, PlatformRuntimeStateUpsert
from app.services.hosted_runtime_secrets import runtime_secret_values_idempotency_identity
from app.services.platform_contract import platform_request_hash, store_platform_response
from app.services.runtime_source import (
    expected_runtime_bundle_v2_etag,
    load_runtime_source_batch,
    render_runtime_source,
    vault_key_identity,
)
from app.services.user_provisioning import lazy_create_partner_user_with_personal_project
from app.services.vault_crypto import decrypt
from tests.conftest import create_env_with_project
from tests.hosted_runtime_fixtures import (
    CANONICAL_CODEX_TOOL_PROVIDER_ID,
    ensure_canonical_codex_tool_provider,
    filebrowser_companion,
)

_ADMIN_KEY = "test-platform-admin-secret"
_CLERK_ISSUER = "https://platform-tests.clerk.example.test"
_ADMIN_AUTH = {"X-Admin-Key": _ADMIN_KEY}
_TEST_CLI_PACKAGE_SPEC = "clawdi@1.2.3-test"
_TEST_HOSTED_INTEGRATIONS_CLI_PACKAGE_SPEC = "clawdi@1.2.5-test"
_TEST_LOCALE = {"language": "en", "timezone": "America/Los_Angeles"}
_TEST_SYSTEM = {}
_TEST_SECRET_VALUES = {
    "secret://clawdi/auth-token": "runtime-auth-token-test",
    "secret://runtime/openclaw/gateway-token": "openclaw-gateway-token-test",
}
_TEST_HERMES_DASHBOARD_AUTH = {
    "mode": "password",
    "provider": "basic",
    "username": "admin",
    "passwordSecretRef": "secret://runtime/hermes/dashboard-password",
    "sessionSecretRef": "secret://runtime/hermes/dashboard-session-secret",
    "sessionTtlSeconds": 43_200,
    "publicUrl": "https://agent.example.test/hermes",
    "activation": {
        "enabled": True,
        "capability": "hermes-basic-auth-v1",
    },
}
_TEST_TOOLS = {
    "codex": {
        "enabled": True,
        "provider_id": "clawdi-managed-v2",
        "primary_model": {
            "provider_id": "clawdi-managed-v2",
            "model": "gpt-5.5",
        },
    }
}
_TEST_COMPANIONS = filebrowser_companion("deployment-1")
_TEST_AGENT_PLUGINS = {
    "schemaVersion": 1,
    "installations": {
        "acme.tools": {
            "installationId": "install_01hxyz",
            "version": "1.2.3",
            "agentPluginsSchema": ("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"),
            "source": {
                "type": "github",
                "url": "https://github.com/acme/agent-plugins",
                "path": "plugins/acme.tools",
                "commit": "a" * 40,
            },
            "contentDigest": f"sha256-tree-v1:{'b' * 64}",
        }
    },
}


@pytest_asyncio.fixture
async def platform_client(db_session, seed_user) -> AsyncIterator[httpx.AsyncClient]:
    async def _override_get_session():
        yield db_session

    original_admin_key = settings.admin_api_key
    original_clerk_issuer = settings.clerk_jwt_issuer
    settings.admin_api_key = _ADMIN_KEY
    settings.clerk_jwt_issuer = _CLERK_ISSUER
    app.dependency_overrides[get_session] = _override_get_session
    try:
        async with httpx.AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            yield client
    finally:
        app.dependency_overrides.clear()
        settings.admin_api_key = original_admin_key
        settings.clerk_jwt_issuer = original_clerk_issuer


def _headers(key: str, *, request_id: str | None = None) -> dict[str, str]:
    headers = {**_ADMIN_AUTH, "Idempotency-Key": key}
    if request_id is not None:
        headers["X-Request-ID"] = request_id
    return headers


def _clerk_owner(user: User) -> dict[str, str]:
    assert user.clerk_id is not None
    return {"kind": "clerk", "ref": user.clerk_id}


def _agent_body(owner: dict[str, str], agent_id: uuid.UUID) -> dict[str, object]:
    return {
        "owner": owner,
        "agent_id": str(agent_id),
        "machine_id": f"machine-{agent_id.hex[:8]}",
        "machine_name": "platform-agent",
        "agent_type": "openclaw",
        "agent_version": "1.0.0",
        "os_name": "linux",
    }


def _runtime_payload(agent_id: uuid.UUID) -> dict[str, object]:
    return {
        "deployment_id": "deployment-1",
        "instance_id": "instance-1",
        "generation": 1,
        "cli_package_spec": _TEST_HOSTED_INTEGRATIONS_CLI_PACKAGE_SPEC,
        "locale": _TEST_LOCALE,
        "system": _TEST_SYSTEM,
        "runtimes": {
            "openclaw": {
                "enabled": True,
                "providerMode": "configured",
                "provider_ids": ["clawdi-managed-v2"],
                "primary_model": {
                    "provider_id": "clawdi-managed-v2",
                    "model": "gpt-5.5",
                },
                "install": {"source": "official"},
                "run": {"args": ["gateway", "run"]},
                "services": {},
            }
        },
        "live_sync": {
            "enabled": True,
            "agents": [
                {
                    "agentType": "openclaw",
                    "environmentId": str(agent_id),
                }
            ],
        },
        "recovery": {"cacheManifest": True, "allowOfflineBoot": True},
        "mcp": {"servers": {"clawdi": {"command": "clawdi", "args": ["mcp"]}}},
        "skills": {"entries": {"clawdi": {"enabled": True, "version": 1}}},
        "tools": _TEST_TOOLS,
        "secretValues": dict(_TEST_SECRET_VALUES),
    }


def _runtime_body(
    owner: dict[str, str],
    agent_id: uuid.UUID,
    *,
    provider_id: str | None = None,
) -> dict[str, object]:
    payload = _runtime_payload(agent_id)
    if provider_id is not None:
        runtime = payload["runtimes"]["openclaw"]
        runtime["provider_ids"] = [provider_id]
        runtime["primary_model"]["provider_id"] = provider_id
        payload["tools"] = {
            "codex": {
                "enabled": True,
                "provider_id": provider_id,
                "primary_model": {
                    "provider_id": provider_id,
                    "model": "gpt-5.5",
                },
            }
        }
    return {"owner": owner, **payload}


async def _create_platform_agent(
    client: httpx.AsyncClient,
    owner: dict[str, str],
    agent_id: uuid.UUID,
    *,
    key: str,
) -> httpx.Response:
    return await client.post(
        "/v1/platform/agents",
        headers=_headers(key),
        json=_agent_body(owner, agent_id),
    )


@pytest.mark.asyncio
async def test_platform_routes_require_admin_key(platform_client, seed_user):
    response = await platform_client.post(
        "/v1/platform/agents",
        headers={"Idempotency-Key": "no-admin-key"},
        json=_agent_body(_clerk_owner(seed_user), uuid.uuid4()),
    )

    assert response.status_code == 401, response.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        (
            "POST",
            "/v1/platform/agents",
            {
                "agent_id": str(uuid.uuid4()),
                "machine_id": "missing-owner",
                "machine_name": "missing-owner",
                "agent_type": "openclaw",
            },
        ),
        ("DELETE", f"/v1/platform/agents/{uuid.uuid4()}", {}),
        (
            "PUT",
            f"/v1/platform/agents/{uuid.uuid4()}/runtime-state",
            _runtime_payload(uuid.uuid4()),
        ),
        ("DELETE", f"/v1/platform/agents/{uuid.uuid4()}/runtime-state", {}),
        (
            "POST",
            "/v1/platform/auth/keys",
            {
                "label": "missing-owner",
                "environment_id": str(uuid.uuid4()),
                "scopes": list(PLATFORM_RUNTIME_KEY_SCOPES),
            },
        ),
        ("DELETE", f"/v1/platform/auth/keys/{uuid.uuid4()}", {}),
    ],
)
async def test_platform_mutations_require_owner(platform_client, method, path, body):
    response = await platform_client.request(
        method,
        path,
        headers=_headers(f"missing-owner-{uuid.uuid4()}"),
        json=body,
    )

    assert response.status_code == 422, response.text
    assert any(error["loc"][-1] == "owner" for error in response.json()["detail"])


@pytest.mark.asyncio
async def test_platform_mutations_require_idempotency_key(platform_client, seed_user):
    response = await platform_client.post(
        "/v1/platform/agents",
        headers=_ADMIN_AUTH,
        json=_agent_body(_clerk_owner(seed_user), uuid.uuid4()),
    )

    assert response.status_code == 422, response.text
    assert any(error["loc"][-1] == "Idempotency-Key" for error in response.json()["detail"])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        (
            "POST",
            "/v1/platform/agents",
            {
                "agent_id": str(uuid.uuid4()),
                "machine_id": "unknown-owner",
                "machine_name": "unknown-owner",
                "agent_type": "openclaw",
            },
        ),
        ("DELETE", f"/v1/platform/agents/{uuid.uuid4()}", {}),
        (
            "PUT",
            f"/v1/platform/agents/{uuid.uuid4()}/runtime-state",
            _runtime_payload(uuid.uuid4()),
        ),
        ("DELETE", f"/v1/platform/agents/{uuid.uuid4()}/runtime-state", {}),
        (
            "POST",
            "/v1/platform/auth/keys",
            {
                "label": "unknown-owner",
                "environment_id": str(uuid.uuid4()),
                "scopes": list(PLATFORM_RUNTIME_KEY_SCOPES),
            },
        ),
        ("DELETE", f"/v1/platform/auth/keys/{uuid.uuid4()}", {}),
    ],
)
async def test_platform_mutations_reject_unknown_owner(
    platform_client,
    db_session,
    method,
    path,
    body,
):
    owner = {"kind": "partner_tenant", "ref": f"missing:{uuid.uuid4().hex}"}
    idempotency_key = f"unknown-owner-{uuid.uuid4()}"
    response = await platform_client.request(
        method,
        path,
        headers=_headers(idempotency_key),
        json={"owner": owner, **body},
    )

    assert response.status_code == 404, response.text
    event = (
        await db_session.execute(
            select(ControlPlaneAuditEvent).where(
                ControlPlaneAuditEvent.source == "api.platform",
                ControlPlaneAuditEvent.details["idempotency_key"].astext == idempotency_key,
            )
        )
    ).scalar_one()
    assert event.target_user_id is None
    assert event.details["owner"] == owner
    assert event.details["result"] == "owner_not_found"


@pytest.mark.asyncio
async def test_platform_clerk_owner_full_lifecycle_and_audit(
    platform_client,
    db_session,
    seed_user,
):
    owner = _clerk_owner(seed_user)
    agent_id = uuid.uuid4()
    request_id = f"req-{uuid.uuid4().hex}"

    created = await platform_client.post(
        "/v1/platform/agents",
        headers=_headers("lifecycle-agent-create", request_id=request_id),
        json={**_agent_body(owner, agent_id), "default_name": "e2e-2"},
    )
    assert created.status_code == 200, created.text
    assert created.json() == {"id": str(agent_id)}
    agent = await db_session.get(AgentEnvironment, agent_id)
    assert agent is not None
    assert agent.default_name == "e2e-2"

    runtime = await platform_client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_headers("lifecycle-runtime-upsert", request_id=request_id),
        json=_runtime_body(owner, agent_id),
    )
    assert runtime.status_code == 200, runtime.text
    assert runtime.json()["environment_id"] == str(agent_id)
    runtime_state = await db_session.get(HostedRuntimeState, agent_id)
    assert runtime_state is not None
    assert runtime_state.mcp == {"servers": {"clawdi": {"command": "clawdi", "args": ["mcp"]}}}
    assert runtime_state.skills == {"entries": {"clawdi": {"enabled": True, "version": 1}}}
    assert runtime_state.tools == _TEST_TOOLS

    secret_rows = list(
        (
            await db_session.execute(
                select(HostedRuntimeSecret)
                .where(HostedRuntimeSecret.environment_id == agent_id)
                .order_by(HostedRuntimeSecret.secret_ref)
            )
        ).scalars()
    )
    assert [row.secret_ref for row in secret_rows] == sorted(_TEST_SECRET_VALUES)
    for row in secret_rows:
        plaintext = _TEST_SECRET_VALUES[row.secret_ref]
        assert row.encrypted_value != plaintext.encode()
        assert decrypt(row.encrypted_value, row.nonce) == plaintext
        assert row.key_version == "vault.v1"

    minted = await platform_client.post(
        "/v1/platform/auth/keys",
        headers=_headers("lifecycle-key-mint", request_id=request_id),
        json={
            "owner": owner,
            "label": "platform-runtime",
            "environment_id": str(agent_id),
        },
    )
    assert minted.status_code == 200, minted.text
    key_id = uuid.UUID(minted.json()["id"])
    api_key = await db_session.get(ApiKey, key_id)
    assert api_key is not None
    assert api_key.user_id == seed_user.id
    assert api_key.environment_id == agent_id
    assert api_key.scopes == list(PLATFORM_RUNTIME_KEY_SCOPES)
    assert api_key.managed is True

    revoked = await platform_client.request(
        "DELETE",
        f"/v1/platform/auth/keys/{key_id}",
        headers=_headers("lifecycle-key-revoke", request_id=request_id),
        json={"owner": owner},
    )
    assert revoked.status_code == 200, revoked.text
    assert revoked.json() == {"status": "revoked"}
    await db_session.refresh(api_key)
    assert api_key.revoked_at is not None

    deleted_runtime = await platform_client.request(
        "DELETE",
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_headers("lifecycle-runtime-delete", request_id=request_id),
        json={"owner": owner},
    )
    assert deleted_runtime.status_code == 204, deleted_runtime.text
    assert await db_session.get(HostedRuntimeState, agent_id) is None

    deleted_agent = await platform_client.request(
        "DELETE",
        f"/v1/platform/agents/{agent_id}",
        headers=_headers("lifecycle-agent-delete", request_id=request_id),
        json={"owner": owner},
    )
    assert deleted_agent.status_code == 204, deleted_agent.text
    archived_agent = await db_session.get(AgentEnvironment, agent_id)
    assert archived_agent is not None
    assert archived_agent.archived_at is not None

    events = (
        (
            await db_session.execute(
                select(ControlPlaneAuditEvent)
                .where(
                    ControlPlaneAuditEvent.source == "api.platform",
                    ControlPlaneAuditEvent.target_user_id == seed_user.id,
                    ControlPlaneAuditEvent.details["request_id"].astext == request_id,
                )
                .order_by(ControlPlaneAuditEvent.created_at)
            )
        )
        .scalars()
        .all()
    )
    assert len(events) == 6
    assert {event.action for event in events} == {
        "agent_environment.create",
        "hosted_runtime_state.upsert",
        "api_key.mint",
        "api_key.revoke",
        "hosted_runtime_state.delete",
        "agent_environment.delete",
    }
    for event in events:
        assert event.actor_type == "platform"
        assert event.details["owner"] == owner
        assert event.details["result"] == "success"
        assert event.details["request_id"] == request_id
        assert event.details["workload_sub"] is None
        assert event.details["credential_id"] is None
        assert event.details["token_jti"] is None
        assert all(secret not in str(event.details) for secret in _TEST_SECRET_VALUES.values())


@pytest.mark.committed_db
@pytest.mark.asyncio
async def test_retirement_fences_late_runtime_state_writes_and_old_replay(
    platform_client,
    engine,
    db_session,
    seed_user,
):
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.services.runtime_observation import (
        provision_runtime_environment_fence,
        retire_runtime_environment,
    )
    from app.services.runtime_state_cleanup import cleanup_retired_runtime_state

    owner = _clerk_owner(seed_user)
    agent = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"retired-write-{uuid.uuid4().hex}",
        machine_name="retired-write-agent",
        agent_type="openclaw",
        os="linux",
    )
    provider_id = CANONICAL_CODEX_TOOL_PROVIDER_ID
    await ensure_canonical_codex_tool_provider(db_session, seed_user)
    await db_session.commit()
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async def _fresh_session():
        async with session_factory() as session:
            yield session

    previous_session_override = app.dependency_overrides[get_session]
    app.dependency_overrides[get_session] = _fresh_session
    try:
        client = platform_client
        body = _runtime_body(owner, agent.id, provider_id=provider_id)
        initial_headers = _headers("retired-write-initial")
        initial = await client.put(
            f"/v1/platform/agents/{agent.id}/runtime-state",
            headers=initial_headers,
            json=body,
        )
        assert initial.status_code == 200, initial.text

        deployment_id = str(body["deployment_id"])
        async with session_factory() as setup_session:
            await provision_runtime_environment_fence(
                setup_session,
                environment_id=agent.id,
                owner_id=seed_user.id,
                deployment_id=deployment_id,
            )
            await setup_session.commit()

        retirement_id = f"retirement-{agent.id}"
        async with session_factory() as retirement_session:
            await retire_runtime_environment(
                retirement_session,
                environment_id=agent.id,
                expected_deployment_id=deployment_id,
                retirement_id=retirement_id,
                owner_id=seed_user.id,
            )
            late_body = {**body, "generation": 2}
            late_put = asyncio.create_task(
                client.put(
                    f"/v1/platform/agents/{agent.id}/runtime-state",
                    headers=_headers("retired-write-late"),
                    json=late_body,
                )
            )
            await asyncio.sleep(0.05)
            assert not late_put.done()
            await retirement_session.commit()
            late = await asyncio.wait_for(late_put, timeout=5)

        assert late.status_code == 409, late.text
        assert late.json()["detail"]["code"] == "runtime_environment_retired"
        async with session_factory() as cleanup_session:
            await cleanup_retired_runtime_state(
                cleanup_session,
                environment_id=agent.id,
                expected_deployment_binding=deployment_id,
                retirement_id=retirement_id,
                cleanup_id=f"cleanup-{agent.id}",
            )
            await cleanup_session.commit()

        old_replay = await client.put(
            f"/v1/platform/agents/{agent.id}/runtime-state",
            headers=initial_headers,
            json=body,
        )
        assert old_replay.status_code == 200, old_replay.text
        async with session_factory() as assertion_session:
            assert await assertion_session.get(HostedRuntimeState, agent.id) is None

        admin_body = {key: value for key, value in body.items() if key != "owner"}
        admin = await client.put(
            f"/v1/admin/agents/{agent.id}/runtime-state",
            headers=_ADMIN_AUTH,
            json=admin_body,
        )
        assert admin.status_code == 409, admin.text
        assert admin.json()["detail"]["code"] == "runtime_environment_retired"
    finally:
        app.dependency_overrides[get_session] = previous_session_override


@pytest.mark.asyncio
async def test_platform_agent_reregistration_updates_its_name(
    platform_client,
    db_session,
    seed_user,
):
    owner = _clerk_owner(seed_user)
    agent_id = uuid.uuid4()
    body = _agent_body(owner, agent_id)

    first = await platform_client.post(
        "/v1/platform/agents",
        headers=_headers(f"agent-name-create-{uuid.uuid4().hex}"),
        json={**body, "default_name": "Research"},
    )
    renamed = await platform_client.post(
        "/v1/platform/agents",
        headers=_headers(f"agent-name-update-{uuid.uuid4().hex}"),
        json={**body, "default_name": "Writing"},
    )

    assert first.status_code == 200, first.text
    assert renamed.status_code == 200, renamed.text
    agent = await db_session.get(AgentEnvironment, agent_id)
    assert agent is not None
    assert agent.default_name == "Writing"


@pytest.mark.asyncio
async def test_platform_runtime_state_accepts_and_projects_filebrowser_companion(
    platform_client,
    db_session,
    seed_user,
):
    owner = _clerk_owner(seed_user)
    agent_id = uuid.uuid4()
    provider_id = CANONICAL_CODEX_TOOL_PROVIDER_ID
    await ensure_canonical_codex_tool_provider(db_session, seed_user)
    created = await _create_platform_agent(
        platform_client,
        owner,
        agent_id,
        key="runtime-companion-agent",
    )
    assert created.status_code == 200, created.text

    response = await platform_client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_headers("runtime-companion-upsert"),
        json={
            **_runtime_body(owner, agent_id, provider_id=provider_id),
            "companions": _TEST_COMPANIONS,
        },
    )

    assert response.status_code == 200, response.text
    state = await db_session.get(HostedRuntimeState, agent_id)
    assert state is not None
    assert state.companions == _TEST_COMPANIONS
    assert state.runtimes["openclaw"]["provider_ids"] == [provider_id]
    assert state.tools["codex"]["provider_id"] == provider_id

    batch = await load_runtime_source_batch(db_session, environment_ids=[agent_id])
    source = render_runtime_source(
        batch,
        environment_id=agent_id,
        public_api_url="https://cloud.test",
        vault_key_identity="test-key-version",
        decrypt_secrets=False,
    )
    assert source.manifest["runtimes"]["openclaw"]["provider_ids"] == ["clawdi"]
    assert source.manifest["terminalTooling"]["codex"]["provider_id"] == "clawdi"
    assert source.manifest["companions"]["filebrowser"] == _TEST_COMPANIONS["filebrowser"]

    cleared = await platform_client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_headers("runtime-companion-clear"),
        json={
            **_runtime_body(owner, agent_id, provider_id=provider_id),
            "generation": 2,
        },
    )
    assert cleared.status_code == 200, cleared.text
    await db_session.refresh(state)
    assert state.companions is None

    cleared_batch = await load_runtime_source_batch(db_session, environment_ids=[agent_id])
    cleared_source = render_runtime_source(
        cleared_batch,
        environment_id=agent_id,
        public_api_url="https://cloud.test",
        vault_key_identity="test-key-version",
        decrypt_secrets=False,
    )
    assert "companions" not in cleared_source.manifest


@pytest.mark.asyncio
async def test_platform_runtime_state_persists_detects_and_projects_agent_plugins(
    platform_client,
    db_session,
    seed_user,
):
    owner = _clerk_owner(seed_user)
    agent_id = uuid.uuid4()
    provider_id = CANONICAL_CODEX_TOOL_PROVIDER_ID
    await ensure_canonical_codex_tool_provider(db_session, seed_user)
    created = await _create_platform_agent(
        platform_client,
        owner,
        agent_id,
        key="agent-plugins-agent-create",
    )
    assert created.status_code == 200, created.text

    body = _runtime_body(owner, agent_id, provider_id=provider_id)
    body["agent_plugins"] = deepcopy(_TEST_AGENT_PLUGINS)
    written = await platform_client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_headers("agent-plugins-runtime-create"),
        json=body,
    )
    assert written.status_code == 200, written.text

    state = await db_session.get(HostedRuntimeState, agent_id)
    assert state is not None
    assert state.agent_plugins == _TEST_AGENT_PLUGINS
    initial_source = render_runtime_source(
        await load_runtime_source_batch(db_session, environment_ids=[agent_id]),
        environment_id=agent_id,
        public_api_url="https://cloud.test",
        vault_key_identity="test-key-version",
        decrypt_secrets=False,
    )
    assert initial_source.manifest["agentPlugins"] == _TEST_AGENT_PLUGINS

    changed_plugins = deepcopy(_TEST_AGENT_PLUGINS)
    changed_plugins["installations"]["acme.tools"]["contentDigest"] = f"sha256-tree-v1:{'c' * 64}"
    conflict = await platform_client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_headers("agent-plugins-runtime-conflict"),
        json={**body, "agent_plugins": changed_plugins},
    )
    assert conflict.status_code == 409, conflict.text
    assert conflict.json()["detail"]["code"] == "generation_conflict"

    advanced = await platform_client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_headers("agent-plugins-runtime-advance"),
        json={**body, "generation": 2, "agent_plugins": changed_plugins},
    )
    assert advanced.status_code == 200, advanced.text
    await db_session.refresh(state)
    assert state.agent_plugins == changed_plugins
    changed_source = render_runtime_source(
        await load_runtime_source_batch(db_session, environment_ids=[agent_id]),
        environment_id=agent_id,
        public_api_url="https://cloud.test",
        vault_key_identity="test-key-version",
        decrypt_secrets=False,
    )
    assert changed_source.source_revision != initial_source.source_revision
    assert changed_source.manifest["agentPlugins"] == changed_plugins

    empty = await platform_client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_headers("agent-plugins-runtime-empty"),
        json={
            **body,
            "generation": 3,
            "agent_plugins": {"schemaVersion": 1, "installations": {}},
        },
    )
    assert empty.status_code == 200, empty.text
    await db_session.refresh(state)
    assert state.agent_plugins == {"schemaVersion": 1, "installations": {}}

    cleared_body = {**body, "generation": 4}
    cleared_body.pop("agent_plugins")
    cleared = await platform_client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_headers("agent-plugins-runtime-clear"),
        json=cleared_body,
    )
    assert cleared.status_code == 200, cleared.text
    await db_session.refresh(state)
    assert state.agent_plugins is None
    cleared_source = render_runtime_source(
        await load_runtime_source_batch(db_session, environment_ids=[agent_id]),
        environment_id=agent_id,
        public_api_url="https://cloud.test",
        vault_key_identity="test-key-version",
        decrypt_secrets=False,
    )
    assert "agentPlugins" not in cleared_source.manifest


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_platform_runtime_secret_upsert_preserves_ciphertext_and_source_revision(
    platform_client,
    db_session,
    seed_user,
):
    owner = _clerk_owner(seed_user)
    agent_id = uuid.uuid4()
    provider_id = CANONICAL_CODEX_TOOL_PROVIDER_ID
    await ensure_canonical_codex_tool_provider(db_session, seed_user)
    created = await _create_platform_agent(
        platform_client,
        owner,
        agent_id,
        key="stable-runtime-secret-agent",
    )
    assert created.status_code == 200, created.text
    body = _runtime_body(owner, agent_id, provider_id=provider_id)
    first = await platform_client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_headers("stable-runtime-secret-first"),
        json=body,
    )
    assert first.status_code == 200, first.text
    rows = list(
        (
            await db_session.execute(
                select(HostedRuntimeSecret)
                .where(HostedRuntimeSecret.environment_id == agent_id)
                .order_by(HostedRuntimeSecret.secret_ref)
            )
        ).scalars()
    )
    stored_identity = {
        row.secret_ref: (row.id, row.encrypted_value, row.nonce, row.key_version) for row in rows
    }
    batch = await load_runtime_source_batch(db_session, environment_ids=[agent_id])
    first_source = render_runtime_source(
        batch,
        environment_id=agent_id,
        public_api_url=settings.public_api_url,
        vault_key_identity=vault_key_identity(settings.vault_encryption_key),
        decrypt_secrets=False,
    )
    source_authority = await platform_client.get(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_ADMIN_AUTH,
        params=owner,
    )
    assert source_authority.status_code == 200, source_authority.text
    assert set(source_authority.json()) == {
        "environmentId",
        "deploymentId",
        "instanceId",
        "sourceRevision",
        "etag",
    }
    assert source_authority.json() == {
        "environmentId": str(agent_id),
        "deploymentId": "deployment-1",
        "instanceId": "instance-1",
        "sourceRevision": first_source.source_revision,
        "etag": expected_runtime_bundle_v2_etag(first_source.source_revision),
    }

    second = await platform_client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_headers("stable-runtime-secret-second"),
        json=body,
    )
    assert second.status_code == 200, second.text
    db_session.expire_all()
    repeated_rows = list(
        (
            await db_session.execute(
                select(HostedRuntimeSecret)
                .where(HostedRuntimeSecret.environment_id == agent_id)
                .order_by(HostedRuntimeSecret.secret_ref)
            )
        ).scalars()
    )
    assert {
        row.secret_ref: (row.id, row.encrypted_value, row.nonce, row.key_version)
        for row in repeated_rows
    } == stored_identity
    repeated_batch = await load_runtime_source_batch(db_session, environment_ids=[agent_id])
    repeated_source = render_runtime_source(
        repeated_batch,
        environment_id=agent_id,
        public_api_url=settings.public_api_url,
        vault_key_identity=vault_key_identity(settings.vault_encryption_key),
        decrypt_secrets=False,
    )
    assert repeated_source.secret_values == {}
    assert repeated_source.source_revision == first_source.source_revision


@pytest.mark.asyncio
async def test_platform_runtime_secret_validation_redacts_plaintext(
    platform_client,
    db_session,
    seed_user,
    caplog,
):
    marker = "platform-secret-must-not-leak\n"
    body = _runtime_body(_clerk_owner(seed_user), uuid.uuid4())
    body["secretValues"] = {"secret://runtime/invalid": marker}
    caplog.set_level(logging.WARNING, logger="app.main")
    audit_count = await db_session.scalar(select(func.count(ControlPlaneAuditEvent.id)))
    idempotency_count = await db_session.scalar(select(func.count(PlatformMutationIdempotency.id)))

    response = await platform_client.put(
        f"/v1/platform/agents/{uuid.uuid4()}/runtime-state",
        headers=_headers("invalid-runtime-secret"),
        json=body,
    )

    assert response.status_code == 422
    assert marker.strip() not in response.text
    assert marker.strip() not in caplog.text
    assert await db_session.scalar(select(func.count(ControlPlaneAuditEvent.id))) == audit_count
    assert (
        await db_session.scalar(select(func.count(PlatformMutationIdempotency.id)))
        == idempotency_count
    )
    audits = list((await db_session.scalars(select(ControlPlaneAuditEvent))).all())
    idempotency_rows = list((await db_session.scalars(select(PlatformMutationIdempotency))).all())
    assert all(marker.strip() not in str(event.details) for event in audits)
    assert all(marker.strip() not in row.request_hash for row in idempotency_rows)
    assert all(marker.strip().encode() not in row.encrypted_response for row in idempotency_rows)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "tools",
    [
        None,
        {},
        {"codex": {"enabled": True}},
        {
            "codex": {
                "enabled": True,
                "provider_id": "managed",
                "primary_model": {"provider_id": "other", "model": "gpt-5.5"},
            }
        },
    ],
)
async def test_platform_runtime_state_requires_typed_codex_tool(
    platform_client,
    seed_user,
    tools,
):
    owner = _clerk_owner(seed_user)
    agent_id = uuid.uuid4()
    created = await _create_platform_agent(
        platform_client,
        owner,
        agent_id,
        key=f"typed-codex-agent-{uuid.uuid4()}",
    )
    assert created.status_code == 200, created.text
    body = _runtime_body(owner, agent_id)
    if tools is None:
        body.pop("tools")
    else:
        body["tools"] = tools

    response = await platform_client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_headers(f"typed-codex-runtime-{uuid.uuid4()}"),
        json=body,
    )

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
@pytest.mark.parametrize("runtime_name", ["openclaw", "hermes"])
async def test_platform_runtime_only_state_is_explicitly_unmanaged(
    platform_client,
    db_session,
    seed_user,
    runtime_name,
):
    owner = _clerk_owner(seed_user)
    agent_id = uuid.uuid4()
    created = await _create_platform_agent(
        platform_client,
        owner,
        agent_id,
        key=f"runtime-only-agent-{runtime_name}-{uuid.uuid4()}",
    )
    assert created.status_code == 200, created.text
    body = _runtime_body(owner, agent_id)
    configured_runtime = next(iter(body["runtimes"].values()))
    runtime = {key: value for key, value in configured_runtime.items() if key != "primary_model"}
    runtime.update({"providerMode": "unmanaged", "provider_ids": []})
    body["runtimes"] = {runtime_name: runtime}
    if runtime_name == "hermes":
        runtime["services"] = {
            "dashboard": {
                "args": [
                    "dashboard",
                    "--host",
                    "0.0.0.0",
                    "--port",
                    "9119",
                    "--no-open",
                ]
            }
        }
        body["system"] = {"hermesDashboardAuth": _TEST_HERMES_DASHBOARD_AUTH}
        body["live_sync"] = {
            "enabled": True,
            "agents": [{"agentType": "hermes", "environmentId": str(agent_id)}],
        }

    response = await platform_client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_headers(f"runtime-only-state-{runtime_name}-{uuid.uuid4()}"),
        json=body,
    )

    assert response.status_code == 200, response.text
    state = await db_session.get(HostedRuntimeState, agent_id)
    assert state is not None
    persisted_runtime = state.runtimes[runtime_name]
    assert persisted_runtime["providerMode"] == "unmanaged"
    assert persisted_runtime["provider_ids"] == []
    assert "primary_model" not in persisted_runtime
    assert state.tools == _TEST_TOOLS


@pytest.mark.asyncio
async def test_platform_runtime_state_rejects_removed_bridge_field(
    platform_client,
    db_session,
    seed_user,
):
    owner = _clerk_owner(seed_user)
    agent_id = uuid.uuid4()
    created = await _create_platform_agent(
        platform_client,
        owner,
        agent_id,
        key=f"removed-runtime-field-agent-{uuid.uuid4()}",
    )
    assert created.status_code == 200, created.text
    body = _runtime_body(owner, agent_id)
    body["bridge"] = {}

    response = await platform_client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_headers(f"removed-runtime-field-state-{uuid.uuid4()}"),
        json=body,
    )

    assert response.status_code == 422, response.text
    assert await db_session.get(HostedRuntimeState, agent_id) is None


@pytest.mark.asyncio
async def test_platform_runtime_state_enforces_generation_contract(
    platform_client,
    db_session,
    seed_user,
):
    owner = _clerk_owner(seed_user)
    agent_id = uuid.uuid4()
    created = await _create_platform_agent(
        platform_client,
        owner,
        agent_id,
        key="generation-agent-create",
    )
    assert created.status_code == 200, created.text

    initial_body = {**_runtime_body(owner, agent_id), "generation": 2}
    initial = await platform_client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_headers("generation-initial"),
        json=initial_body,
    )
    assert initial.status_code == 200, initial.text

    same_generation = await platform_client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_headers("generation-same-mcp-model"),
        json=initial_body,
    )
    assert same_generation.status_code == 200, same_generation.text

    stale = await platform_client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_headers("generation-stale"),
        json={**initial_body, "generation": 1},
    )
    assert stale.status_code == 409, stale.text
    assert stale.json() == {"detail": {"code": "stale_generation", "current_generation": 2}}

    conflict = await platform_client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_headers("generation-conflict"),
        json={**initial_body, "instance_id": "instance-conflict"},
    )
    assert conflict.status_code == 409, conflict.text
    assert conflict.json() == {"detail": {"code": "generation_conflict", "current_generation": 2}}

    state = await db_session.get(HostedRuntimeState, agent_id)
    assert state is not None
    assert state.generation == 2
    assert state.instance_id == initial_body["instance_id"]


@pytest.mark.asyncio
async def test_platform_runtime_state_advances_apply_generation_without_weakening_checkpoint(
    platform_client,
    db_session,
    seed_user,
):
    owner = _clerk_owner(seed_user)
    agent_id = uuid.uuid4()
    created = await _create_platform_agent(
        platform_client,
        owner,
        agent_id,
        key="apply-generation-agent-create",
    )
    assert created.status_code == 200, created.text
    body = {
        **_runtime_body(owner, agent_id),
        "generation": 2,
        "apply_generation": 1,
    }
    invalid = await platform_client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_headers("apply-generation-invalid"),
        json={**body, "apply_generation": 0},
    )
    assert invalid.status_code == 422, invalid.text

    initial = await platform_client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_headers("apply-generation-initial"),
        json=body,
    )
    assert initial.status_code == 200, initial.text
    assert initial.json()["apply_generation"] == 1

    advanced = await platform_client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_headers("apply-generation-advanced"),
        json={**body, "apply_generation": 2},
    )
    assert advanced.status_code == 200, advanced.text
    assert advanced.json()["apply_generation"] == 2

    independent_advance = await platform_client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_headers("apply-generation-independent-advance"),
        json={**body, "apply_generation": 3},
    )
    assert independent_advance.status_code == 200, independent_advance.text
    assert independent_advance.json()["generation"] == 2
    assert independent_advance.json()["apply_generation"] == 3

    for key, apply_generation, code in (
        ("apply-generation-regression", 2, "stale_apply_generation"),
        ("apply-generation-clear", None, "apply_generation_conflict"),
    ):
        rejected = await platform_client.put(
            f"/v1/platform/agents/{agent_id}/runtime-state",
            headers=_headers(key),
            json={**body, "apply_generation": apply_generation},
        )
        assert rejected.status_code == 409, rejected.text
        assert rejected.json()["detail"]["code"] == code
        assert rejected.json()["detail"]["current_apply_generation"] == 3

    checkpoint_only = await platform_client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_headers("apply-generation-checkpoint-only"),
        json={**_runtime_body(owner, agent_id), "generation": 4},
    )
    assert checkpoint_only.status_code == 200, checkpoint_only.text
    assert checkpoint_only.json()["apply_generation"] == 3

    state = await db_session.get(HostedRuntimeState, agent_id)
    assert state is not None
    assert state.generation == 4
    assert state.apply_generation == 3


@pytest.mark.asyncio
async def test_platform_runtime_state_replays_pre_apply_generation_idempotency_shape(
    platform_client,
    db_session,
    seed_user,
):
    owner = _clerk_owner(seed_user)
    agent_id = uuid.uuid4()
    created = await _create_platform_agent(
        platform_client,
        owner,
        agent_id,
        key="idempotency-shape-agent-create",
    )
    assert created.status_code == 200, created.text
    body = _runtime_body(owner, agent_id)
    parsed = PlatformRuntimeStateUpsert.model_validate(body)
    legacy_payload = {
        "agent_id": str(agent_id),
        **parsed.model_dump(mode="json", exclude={"secret_values"}),
        "secretValuesIdentity": runtime_secret_values_idempotency_identity(parsed.secret_values),
    }
    legacy_payload.pop("apply_generation")
    idempotency_key = "runtime-state-before-apply-generation"
    replay_body = {
        "environment_id": str(agent_id),
        "deployment_id": body["deployment_id"],
        "instance_id": body["instance_id"],
        "generation": body["generation"],
    }
    store_platform_response(
        db_session,
        operation="runtime_state.upsert",
        idempotency_key=idempotency_key,
        request_hash=platform_request_hash(legacy_payload),
        owner_user_id=seed_user.id,
        resource_type="hosted_runtime_state",
        resource_id=str(agent_id),
        response_status=200,
        response_body=replay_body,
    )
    await db_session.commit()

    replay = await platform_client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_headers(idempotency_key),
        json=body,
    )

    assert replay.status_code == 200, replay.text
    assert replay.json() == replay_body
    assert await db_session.get(HostedRuntimeState, agent_id) is None


@pytest.mark.asyncio
async def test_platform_partner_tenant_resolves_null_clerk_principal(
    platform_client,
    db_session,
):
    partner_ref = f"phala:{uuid.uuid4().hex}"
    partner_user = await lazy_create_partner_user_with_personal_project(
        db_session,
        partner_tenant_ref=partner_ref,
        race_loser_status=500,
    )
    await db_session.commit()
    owner = {"kind": "partner_tenant", "ref": partner_ref}
    agent_id = uuid.uuid4()
    try:
        created = await _create_platform_agent(
            platform_client,
            owner,
            agent_id,
            key="partner-agent-create",
        )
        assert created.status_code == 200, created.text

        minted = await platform_client.post(
            "/v1/platform/auth/keys",
            headers=_headers("partner-key-mint"),
            json={
                "owner": owner,
                "label": "partner-runtime",
                "environment_id": str(agent_id),
                "scopes": ["sessions:write", "skills:read"],
            },
        )
        assert minted.status_code == 200, minted.text
        await db_session.refresh(partner_user)
        assert partner_user.principal_kind == PRINCIPAL_KIND_PARTNER_TENANT
        assert partner_user.clerk_id is None
        api_key = await db_session.get(ApiKey, uuid.UUID(minted.json()["id"]))
        assert api_key is not None
        assert api_key.user_id == partner_user.id
        assert api_key.scopes == ["sessions:write", "skills:read"]
    finally:
        await db_session.delete(partner_user)
        await db_session.commit()


@pytest.mark.asyncio
async def test_platform_existing_resources_reject_owner_mismatch(
    platform_client,
    db_session,
    seed_user,
):
    other = User(
        clerk_id=f"platform_other_{uuid.uuid4().hex}",
        email="platform-other@example.test",
        name="Platform Other",
    )
    db_session.add(other)
    await db_session.commit()
    await db_session.refresh(other)
    other_agent = await create_env_with_project(
        db_session,
        user_id=other.id,
        machine_id=f"other-{uuid.uuid4().hex}",
        machine_name="other-agent",
        agent_type="openclaw",
        os="linux",
    )
    raw_key = f"clawdi_{uuid.uuid4().hex}"
    other_key = ApiKey(
        user_id=other.id,
        key_hash=hashlib.sha256(raw_key.encode()).hexdigest(),
        key_prefix=raw_key[:16],
        label="other-key",
        environment_id=other_agent.id,
        scopes=list(PLATFORM_RUNTIME_KEY_SCOPES),
        managed=True,
    )
    db_session.add(other_key)
    await db_session.commit()
    await db_session.refresh(other_key)
    owner = _clerk_owner(seed_user)
    try:
        cross_owner_read = await platform_client.get(
            f"/v1/platform/agents/{other_agent.id}/runtime-state",
            headers=_ADMIN_AUTH,
            params=owner,
        )
        assert cross_owner_read.status_code == 404, cross_owner_read.text
        assert cross_owner_read.json() == {"detail": "Runtime source not found"}

        calls = [
            (
                "POST",
                "/v1/platform/agents",
                _agent_body(owner, other_agent.id),
            ),
            (
                "DELETE",
                f"/v1/platform/agents/{other_agent.id}",
                {"owner": owner},
            ),
            (
                "PUT",
                f"/v1/platform/agents/{other_agent.id}/runtime-state",
                _runtime_body(owner, other_agent.id),
            ),
            (
                "DELETE",
                f"/v1/platform/agents/{other_agent.id}/runtime-state",
                {"owner": owner},
            ),
            (
                "POST",
                "/v1/platform/auth/keys",
                {
                    "owner": owner,
                    "label": "cross-owner",
                    "environment_id": str(other_agent.id),
                    "scopes": list(PLATFORM_RUNTIME_KEY_SCOPES),
                },
            ),
            (
                "DELETE",
                f"/v1/platform/auth/keys/{other_key.id}",
                {"owner": owner},
            ),
        ]
        for index, (method, path, body) in enumerate(calls):
            response = await platform_client.request(
                method,
                path,
                headers=_headers(f"owner-mismatch-{index}"),
                json=body,
            )
            assert response.status_code == 403, (method, path, response.text)

        await db_session.refresh(other_agent)
        await db_session.refresh(other_key)
        assert other_agent.user_id == other.id
        assert other_key.revoked_at is None
        assert await db_session.get(HostedRuntimeState, other_agent.id) is None
    finally:
        await db_session.delete(other)
        await db_session.commit()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "key_payload",
    [
        {"label": "missing-environment"},
        {"label": "null-scopes", "scopes": None},
        {"label": "empty-scopes", "scopes": []},
        {"label": "excess-scope", "scopes": ["sessions:write", "vault:resolve"]},
    ],
)
async def test_platform_key_mint_enforces_environment_and_scope_ceiling(
    platform_client,
    db_session,
    seed_user,
    key_payload,
):
    agent_id = uuid.uuid4()
    created = await _create_platform_agent(
        platform_client,
        _clerk_owner(seed_user),
        agent_id,
        key=f"scope-agent-{uuid.uuid4()}",
    )
    assert created.status_code == 200, created.text
    payload = {
        "owner": _clerk_owner(seed_user),
        "environment_id": str(agent_id),
        **key_payload,
    }
    if "environment_id" not in key_payload and key_payload["label"] == "missing-environment":
        payload.pop("environment_id")

    response = await platform_client.post(
        "/v1/platform/auth/keys",
        headers=_headers(f"scope-rejected-{uuid.uuid4()}"),
        json=payload,
    )

    assert response.status_code == 422, response.text
    key_count = await db_session.scalar(
        select(func.count()).select_from(ApiKey).where(ApiKey.environment_id == agent_id)
    )
    assert key_count == 0


@pytest.mark.asyncio
async def test_platform_idempotency_replays_every_mutation_without_second_side_effect(
    platform_client,
    db_session,
    seed_user,
):
    owner = _clerk_owner(seed_user)
    agent_id = uuid.uuid4()
    agent_body = _agent_body(owner, agent_id)
    create_headers = _headers("idem-agent-create")
    created_once = await platform_client.post(
        "/v1/platform/agents",
        headers=create_headers,
        json=agent_body,
    )
    created_twice = await platform_client.post(
        "/v1/platform/agents",
        headers=create_headers,
        json=agent_body,
    )
    assert created_once.status_code == created_twice.status_code == 200
    assert created_once.json() == created_twice.json()
    agent = await db_session.get(AgentEnvironment, agent_id)
    assert agent is not None
    db_session.add_all(
        [
            Skill(
                user_id=seed_user.id,
                project_id=agent.default_project_id,
                skill_key="platform-delete-legacy",
                name="Platform delete legacy",
                description="Legacy Cloud row",
                content_hash="9" * 64,
                authority=SKILL_AUTHORITY_CLOUD,
            ),
            Skill(
                user_id=seed_user.id,
                project_id=agent.default_project_id,
                skill_key="platform-delete-claimed",
                name="Platform delete claimed",
                description="Agent projection",
                content_hash="a" * 64,
                source=SKILL_AUTHORITY_AGENT_SYNC,
                authority=SKILL_AUTHORITY_AGENT_SYNC,
                authority_agent_id=agent_id,
            ),
        ]
    )
    await db_session.commit()
    await db_session.refresh(seed_user)
    revision_before_agent_delete = seed_user.skills_revision
    agent_project_id = agent.default_project_id

    runtime_body = _runtime_body(owner, agent_id)
    runtime_headers = _headers("idem-runtime-upsert")
    runtime_once = await platform_client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=runtime_headers,
        json=runtime_body,
    )
    runtime_twice = await platform_client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=runtime_headers,
        json=runtime_body,
    )
    assert runtime_once.status_code == runtime_twice.status_code == 200
    assert runtime_once.json() == runtime_twice.json()

    mint_body = {
        "owner": owner,
        "label": "idempotent-key",
        "environment_id": str(agent_id),
        "scopes": list(PLATFORM_RUNTIME_KEY_SCOPES),
    }
    mint_headers = _headers("idem-key-mint")
    minted_once = await platform_client.post(
        "/v1/platform/auth/keys",
        headers=mint_headers,
        json=mint_body,
    )
    minted_twice = await platform_client.post(
        "/v1/platform/auth/keys",
        headers=mint_headers,
        json=mint_body,
    )
    assert minted_once.status_code == minted_twice.status_code == 200
    assert minted_once.json() == minted_twice.json()
    key_id = minted_once.json()["id"]

    revoke_headers = _headers("idem-key-revoke")
    revoked_once = await platform_client.request(
        "DELETE",
        f"/v1/platform/auth/keys/{key_id}",
        headers=revoke_headers,
        json={"owner": owner},
    )
    revoked_twice = await platform_client.request(
        "DELETE",
        f"/v1/platform/auth/keys/{key_id}",
        headers=revoke_headers,
        json={"owner": owner},
    )
    assert revoked_once.status_code == revoked_twice.status_code == 200
    assert revoked_once.json() == revoked_twice.json()

    runtime_delete_headers = _headers("idem-runtime-delete")
    deleted_runtime_once = await platform_client.request(
        "DELETE",
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=runtime_delete_headers,
        json={"owner": owner},
    )
    deleted_runtime_twice = await platform_client.request(
        "DELETE",
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=runtime_delete_headers,
        json={"owner": owner},
    )
    assert deleted_runtime_once.status_code == deleted_runtime_twice.status_code == 204

    agent_delete_headers = _headers("idem-agent-delete")
    deleted_agent_once = await platform_client.request(
        "DELETE",
        f"/v1/platform/agents/{agent_id}",
        headers=agent_delete_headers,
        json={"owner": owner},
    )
    deleted_agent_twice = await platform_client.request(
        "DELETE",
        f"/v1/platform/agents/{agent_id}",
        headers=agent_delete_headers,
        json={"owner": owner},
    )
    assert deleted_agent_once.status_code == deleted_agent_twice.status_code == 204
    assert (
        await db_session.scalar(
            select(func.count()).select_from(Skill).where(Skill.project_id == agent_project_id)
        )
        == 2
    )
    await db_session.refresh(seed_user)
    assert seed_user.skills_revision == revision_before_agent_delete

    retained_key = await db_session.get(ApiKey, uuid.UUID(key_id))
    assert retained_key is not None
    assert retained_key.revoked_at is not None
    idempotency_count = await db_session.scalar(
        select(func.count())
        .select_from(PlatformMutationIdempotency)
        .where(
            PlatformMutationIdempotency.idempotency_key.in_(
                [
                    "idem-agent-create",
                    "idem-runtime-upsert",
                    "idem-key-mint",
                    "idem-key-revoke",
                    "idem-runtime-delete",
                    "idem-agent-delete",
                ]
            )
        )
    )
    assert idempotency_count == 6
    audit_counts = dict(
        (
            await db_session.execute(
                select(ControlPlaneAuditEvent.action, func.count())
                .where(
                    ControlPlaneAuditEvent.source == "api.platform",
                    ControlPlaneAuditEvent.details["idempotency_key"].astext.in_(
                        [
                            "idem-agent-create",
                            "idem-runtime-upsert",
                            "idem-key-mint",
                            "idem-key-revoke",
                            "idem-runtime-delete",
                            "idem-agent-delete",
                        ]
                    ),
                )
                .group_by(ControlPlaneAuditEvent.action)
            )
        ).all()
    )
    assert audit_counts == {
        "agent_environment.create": 1,
        "agent_environment.delete": 1,
        "api_key.mint": 1,
        "api_key.revoke": 1,
        "hosted_runtime_state.delete": 1,
        "hosted_runtime_state.upsert": 1,
    }


@pytest.mark.asyncio
async def test_platform_idempotency_key_reuse_with_changed_request_is_409(
    platform_client,
    db_session,
    seed_user,
):
    owner = _clerk_owner(seed_user)
    agent_id = uuid.uuid4()
    body = _agent_body(owner, agent_id)
    headers = _headers("idem-conflict")
    first = await platform_client.post(
        "/v1/platform/agents",
        headers=headers,
        json=body,
    )
    assert first.status_code == 200, first.text
    changed = {**body, "machine_name": "changed-machine-name"}

    second = await platform_client.post(
        "/v1/platform/agents",
        headers=headers,
        json=changed,
    )

    assert second.status_code == 409, second.text
    agent = await db_session.get(AgentEnvironment, agent_id)
    assert agent is not None
    assert agent.machine_name == "platform-agent"
    results = (
        await db_session.execute(
            select(ControlPlaneAuditEvent.details["result"].astext).where(
                ControlPlaneAuditEvent.source == "api.platform",
                ControlPlaneAuditEvent.details["idempotency_key"].astext == "idem-conflict",
            )
        )
    ).scalars()
    assert sorted(results) == ["idempotency_conflict", "success"]


@pytest.mark.asyncio
async def test_platform_routes_are_canonical_and_exposed_in_openapi(platform_client):
    response = await platform_client.get("/openapi.json")
    assert response.status_code == 200, response.text
    paths = response.json()["paths"]
    assert set(path for path in paths if path.startswith("/v1/platform")) == {
        "/v1/platform/agents",
        "/v1/platform/agents/{agent_id}",
        "/v1/platform/agents/{agent_id}/runtime-state",
        "/v1/platform/auth/keys",
        "/v1/platform/auth/keys/{key_id}",
        "/v1/platform/oauth/token",
    }
    assert all(not path.startswith("/api/platform") for path in paths)
    assert set(paths["/v1/platform/agents/{agent_id}/runtime-state"]) == {
        "get",
        "put",
        "delete",
    }
    companions_schema = response.json()["components"]["schemas"]["PlatformRuntimeStateUpsert"][
        "properties"
    ]["companions"]
    assert companions_schema["anyOf"][0] == {"$ref": "#/components/schemas/HostedRuntimeCompanions"}

    missing_alias = await platform_client.post(
        "/api/platform/agents",
        headers={"Idempotency-Key": "missing-alias-check"},
        json=_agent_body(
            {"kind": "clerk", "ref": "missing_alias_owner"},
            uuid.uuid4(),
        ),
    )
    assert missing_alias.status_code == 404
    assert missing_alias.json() == {"detail": "Not Found"}
