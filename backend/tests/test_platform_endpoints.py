from __future__ import annotations

import hashlib
import uuid
from collections.abc import AsyncIterator

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
from app.models.hosted_runtime import HostedRuntimeState
from app.models.platform_idempotency import PlatformMutationIdempotency
from app.models.session import AgentEnvironment
from app.models.user import PRINCIPAL_KIND_PARTNER_TENANT, User
from app.schemas.platform import PLATFORM_RUNTIME_KEY_SCOPES
from app.services.user_provisioning import lazy_create_partner_user_with_personal_project
from tests.conftest import create_env_with_project

_ADMIN_KEY = "test-platform-admin-secret"
_ADMIN_AUTH = {"X-Admin-Key": _ADMIN_KEY}
_TEST_CLI_PACKAGE_SPEC = "clawdi@0.12.10-beta.57"
_TEST_LOCALE = {"language": "en", "timezone": "America/Los_Angeles"}
_TEST_SYSTEM = {}
_TEST_HERMES_DASHBOARD_AUTH = {
    "mode": "password",
    "provider": "basic",
    "username": "admin",
    "passwordSecretRef": "env://HERMES_DASHBOARD_BASIC_AUTH_PASSWORD",
    "sessionSecretRef": "env://HERMES_DASHBOARD_BASIC_AUTH_SECRET",
    "sessionTtlSeconds": 43_200,
    "publicUrl": "https://agent.example.test/hermes",
    "activation": {
        "enabled": True,
        "capability": "hermes-basic-auth-v1",
    },
}
_TEST_RUNTIME_BRIDGES = {
    "openclaw": {
        "surfaces": [
            {
                "name": "openclaw",
                "kind": "control-ui",
                "listenPort": 28789,
                "upstreamHost": "127.0.0.1",
                "upstreamPort": 18789,
            }
        ]
    },
    "hermes": {
        "surfaces": [
            {
                "name": "hermes",
                "kind": "control-ui",
                "listenPort": 28793,
                "upstreamHost": "127.0.0.1",
                "upstreamPort": 9119,
            }
        ]
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


@pytest_asyncio.fixture
async def platform_client(db_session, seed_user) -> AsyncIterator[httpx.AsyncClient]:
    async def _override_get_session():
        yield db_session

    original_admin_key = settings.admin_api_key
    settings.admin_api_key = _ADMIN_KEY
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
        "cli_package_spec": _TEST_CLI_PACKAGE_SPEC,
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
        "tools": _TEST_TOOLS,
    }


def _runtime_body(owner: dict[str, str], agent_id: uuid.UUID) -> dict[str, object]:
    return {"owner": owner, **_runtime_payload(agent_id)}


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
        json=_agent_body(owner, agent_id),
    )
    assert created.status_code == 200, created.text
    assert created.json() == {"id": str(agent_id)}

    runtime = await platform_client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_headers("lifecycle-runtime-upsert", request_id=request_id),
        json=_runtime_body(owner, agent_id),
    )
    assert runtime.status_code == 200, runtime.text
    assert runtime.json()["environment_id"] == str(agent_id)
    runtime_state = await db_session.get(HostedRuntimeState, agent_id)
    assert runtime_state is not None
    assert runtime_state.tools == _TEST_TOOLS

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
    assert await db_session.get(AgentEnvironment, agent_id) is None

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
    assert [event.action for event in events] == [
        "agent_environment.create",
        "hosted_runtime_state.upsert",
        "api_key.mint",
        "api_key.revoke",
        "hosted_runtime_state.delete",
        "agent_environment.delete",
    ]
    for event in events:
        assert event.actor_type == "platform"
        assert event.details["owner"] == owner
        assert event.details["result"] == "success"
        assert event.details["request_id"] == request_id
        assert event.details["workload_sub"] is None
        assert event.details["credential_id"] is None
        assert event.details["token_jti"] is None


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
    if runtime_name == "hermes":
        assert state.bridge is None


@pytest.mark.asyncio
@pytest.mark.parametrize("runtime_name", ["openclaw", "hermes"])
async def test_platform_runtime_state_rejects_every_v2_bridge_before_persist(
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
        key=f"v2-bridge-agent-{runtime_name}-{uuid.uuid4()}",
    )
    assert created.status_code == 200, created.text
    body = _runtime_body(owner, agent_id)
    if runtime_name == "hermes":
        runtime = next(iter(body["runtimes"].values()))
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
        body["runtimes"] = {"hermes": runtime}
        body["system"] = {"hermesDashboardAuth": _TEST_HERMES_DASHBOARD_AUTH}
        body["live_sync"] = {
            "enabled": True,
            "agents": [{"agentType": "hermes", "environmentId": str(agent_id)}],
        }
    body["bridge"] = _TEST_RUNTIME_BRIDGES[runtime_name]

    response = await platform_client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_headers(f"v2-bridge-state-{runtime_name}-{uuid.uuid4()}"),
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
            select(func.count()).select_from(ApiKey).where(ApiKey.id == uuid.UUID(key_id))
        )
        == 0
    )
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
    assert set(paths["/v1/platform/agents/{agent_id}/runtime-state"]) == {"put", "delete"}

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
