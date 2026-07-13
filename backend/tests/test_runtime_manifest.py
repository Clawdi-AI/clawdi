from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from fastapi import HTTPException
from httpx import ASGITransport
from pydantic import ValidationError
from sqlalchemy import event, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.auth import AuthContext, get_auth
from app.core.config import settings
from app.core.database import get_runtime_snapshot_session, get_session
from app.main import app
from app.models.ai_provider import AiProvider, AiProviderAuthPayload
from app.models.api_key import ApiKey
from app.models.audit import ControlPlaneAuditEvent
from app.models.channel import ChannelAccount, ChannelBotAgentLink
from app.models.hosted_runtime import HostedRuntimeConfigObservation, HostedRuntimeState
from app.models.session import AgentEnvironment
from app.models.user import User
from app.routes.admin import _admin_upsert_runtime_state
from app.routes.runtime import _runtime_manifest_issued_at
from app.schemas.admin import AdminRuntimeStateUpsert
from app.schemas.runtime import (
    HostedEgressEngine,
    HostedRuntimeBridge,
    validate_clawdi_cli_package_spec,
)
from app.services import sync_events
from app.services.audit import _sanitize_audit_details
from app.services.runtime_source import (
    RUNTIME_BUNDLE_V2_MEDIA_TYPE,
    expected_runtime_bundle_v2_etag,
)
from app.services.vault_crypto import encrypt
from scripts.seed_dashboard_dev import _create_hosted_runtime_graph, _seed_ai_provider
from tests.conftest import create_env_with_project

_ADMIN_KEY = "runtime-state-admin-secret"
_AUTH = {"X-Admin-Key": _ADMIN_KEY}
TEST_LOCALE = {"language": "en", "timezone": "America/Los_Angeles"}
TEST_SYSTEM = {
    "user": "clawdi",
    "home": "/home/clawdi",
    "workspace": "/home/clawdi/clawdi",
    "persistentPaths": ["/home/clawdi"],
}
TEST_RUNTIME_PATHS = {
    "home": "/home/clawdi",
    "workspace": "/home/clawdi/clawdi",
}
TEST_EGRESS_ENGINE_PIN = {
    "type": "mitmproxy",
    "version": "12.2.3",
    "url": "https://downloads.mitmproxy.org/12.2.3/mitmproxy-12.2.3-linux-x86_64.tar.gz",
    "sha256": "2e95286b618fa6fd33e5e62a78c2e5112571d85f42ec2bac29b97ee242bdb5c5",
}
TEST_INVALID_EGRESS_ENGINE_URLS = (
    "https://exa mple.com/a",
    "https://.example.com/a",
    "https://user:pass@example.com/a",
    "http://example.com/a",
    "https://example.com:bad/a",
)
TEST_EGRESS_PROFILES = {
    "profiles": [
        {
            "id": "managed-provider",
            "enabled": True,
            "kind": "provider",
            "match": {
                "scheme": "https",
                "host": "ai-gateway.example.test",
                "headers": {},
                "query": {},
            },
            "rewrite": {
                "preservePath": True,
                "setHeaders": {
                    "authorization": {
                        "type": "secretRef",
                        "secretRef": "secret://provider.default.apiKey",
                        "prefix": "Bearer ",
                    }
                },
            },
            "logging": {
                "redactHeaders": ["authorization"],
                "redactUrlPatterns": [],
            },
            "priority": 80,
            "owner": "provider-projection",
        }
    ]
}
TEST_OPENCLAW_BRIDGE = {
    "surfaces": [
        {
            "name": "openclaw",
            "kind": "control-ui",
            "listenPort": 28789,
            "upstreamHost": "127.0.0.1",
            "upstreamPort": 18789,
        }
    ]
}
TEST_HERMES_BRIDGE = {
    "surfaces": [
        {
            "name": "hermes",
            "kind": "control-ui",
            "listenPort": 28793,
            "upstreamHost": "127.0.0.1",
            "upstreamPort": 9119,
        }
    ]
}
OPTIONAL_RUNTIME_STATE_FIELDS = ("egress_engine", "egress_profiles", "mcp", "tools")
TEST_CLI_PACKAGE_SPEC = "clawdi@0.12.10-beta.51"


async def _create_bundle_runtime(admin_client, db_session, seed_user):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"bundle-runtime-{uuid4().hex[:8]}",
        machine_name="Bundle runtime",
        agent_type="openclaw",
    )
    provider = _seed_ai_provider(seed_user)
    provider.provider_id = f"bundle-provider-{uuid4().hex[:8]}"
    provider.label = "Bundle provider"
    provider.auth_metadata = {"source": "managed"}
    ciphertext, nonce = encrypt("sk-bundle-provider")
    payload = AiProviderAuthPayload(
        owner_user_id=seed_user.id,
        provider_id=provider.provider_id,
        auth_profile="default",
        kind="api_key",
        source="managed",
        encrypted_payload=ciphertext,
        nonce=nonce,
    )
    account = ChannelAccount(
        user_id=seed_user.id,
        provider="telegram",
        name="Bundle Telegram",
        status="active",
        visibility="private",
        webhook_secret_hash="bundle-webhook-hash",
    )
    db_session.add_all([provider, payload, account])
    await db_session.flush()
    token_ciphertext, token_nonce = encrypt("123456789:bundle-agent-token")
    link = ChannelBotAgentLink(
        account_id=account.id,
        user_id=seed_user.id,
        agent_id=env.id,
        status="active",
        encrypted_agent_token=token_ciphertext,
        agent_token_nonce=token_nonce,
    )
    db_session.add(link)
    await db_session.commit()
    await _write_runtime_state(
        admin_client,
        str(env.id),
        runtimes=_runtime_state(provider_ids=[provider.provider_id]),
    )
    return env, provider, payload, account, link


def test_runtime_manifest_issued_at_falls_back_to_desired_created_at() -> None:
    created_at = datetime(2026, 7, 13, 1, 2, 3, tzinfo=UTC)
    state = SimpleNamespace(updated_at=None, created_at=created_at)

    assert _runtime_manifest_issued_at(state) == created_at.isoformat()


def _live_sync(environment_id: str, agent_type: str = "openclaw") -> dict:
    return {
        "enabled": True,
        "agents": [{"agentType": agent_type, "environmentId": environment_id}],
    }


@pytest_asyncio.fixture
async def admin_client(db_session) -> AsyncIterator[httpx.AsyncClient]:
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


async def _runtime_client(db_session, seed_user, api_key: ApiKey | None):
    async def _override_get_session():
        yield db_session

    async def _override_get_auth():
        return AuthContext(user=seed_user, api_key=api_key)

    app.dependency_overrides[get_session] = _override_get_session
    app.dependency_overrides[get_runtime_snapshot_session] = _override_get_session
    app.dependency_overrides[get_auth] = _override_get_auth
    transport = ASGITransport(app=app)
    return httpx.AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"Accept": RUNTIME_BUNDLE_V2_MEDIA_TYPE},
    )


@asynccontextmanager
async def _isolated_admin_client(engine) -> AsyncIterator[httpx.AsyncClient]:
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)

    async def _override_get_session():
        async with sessionmaker() as session:
            yield session

    original_admin_key = settings.admin_api_key
    settings.admin_api_key = _ADMIN_KEY
    app.dependency_overrides[get_session] = _override_get_session
    try:
        async with httpx.AsyncClient(
            transport=ASGITransport(app=app, raise_app_exceptions=False),
            base_url="http://test",
        ) as client:
            yield client
    finally:
        app.dependency_overrides.clear()
        settings.admin_api_key = original_admin_key


async def _concurrent_initial_runtime_state_responses(
    engine,
    client: httpx.AsyncClient,
    environment_id,
    bodies: tuple[dict, dict],
) -> list[httpx.Response]:
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    async with sessionmaker() as blocker:
        await blocker.execute(
            select(AgentEnvironment).where(AgentEnvironment.id == environment_id).with_for_update()
        )
        requests = [
            asyncio.create_task(
                client.put(
                    f"/v1/admin/environments/{environment_id}/runtime-state",
                    headers=_AUTH,
                    json=body,
                )
            )
            for body in bodies
        ]
        done, _ = await asyncio.wait(requests, timeout=0.1)
        both_waited_for_parent_lock = not done
        await blocker.commit()

    responses = await asyncio.gather(*requests)
    assert both_waited_for_parent_lock
    return responses


def _runtime_state(
    runtime_name: str = "openclaw",
    *,
    provider_ids: list[str] | None = None,
    primary_model: dict | None = None,
    **overrides,
) -> dict:
    selected_provider_ids = provider_ids or ["clawdi-managed-v2"]
    runtime = {
        "enabled": True,
        "provider_ids": selected_provider_ids,
        "primary_model": primary_model
        or {"provider_id": selected_provider_ids[0], "model": "gpt-5.5"},
        "install": {"source": "official"},
        "run": {"args": ["gateway", "run"]},
        "services": {},
        "paths": TEST_RUNTIME_PATHS,
    }
    runtime.update(overrides)
    return {runtime_name: runtime}


def _runtime_state_body(environment_id: str, **overrides) -> dict:
    body = {
        "deployment_id": f"dep_{uuid4().hex}",
        "instance_id": f"hri_{uuid4().hex}",
        "generation": 7,
        "cli_package_spec": TEST_CLI_PACKAGE_SPEC,
        "locale": TEST_LOCALE,
        "system": TEST_SYSTEM,
        "runtimes": _runtime_state(),
        "live_sync": _live_sync(environment_id),
        "recovery": {"cacheManifest": True, "allowOfflineBoot": True},
    }
    body.update(overrides)
    return body


async def _write_runtime_state(admin_client: httpx.AsyncClient, environment_id: str, **overrides):
    body = _runtime_state_body(environment_id, **overrides)
    response = await admin_client.put(
        f"/v1/admin/environments/{environment_id}/runtime-state",
        headers=_AUTH,
        json=body,
    )
    assert response.status_code == 200, response.text
    return body


async def _runtime_state_audit_count(db: AsyncSession, environment_id) -> int:
    return int(
        (
            await db.execute(
                select(func.count())
                .select_from(ControlPlaneAuditEvent)
                .where(
                    ControlPlaneAuditEvent.resource_type == "hosted_runtime_state",
                    ControlPlaneAuditEvent.environment_id == environment_id,
                )
            )
        ).scalar_one()
    )


@pytest.mark.parametrize(
    ("cli_package_spec", "accepted"),
    [
        ("clawdi@0.12.10-beta.51", True),
        ("clawdi@1.2.3-rc-1.2", True),
        ("clawdi@1.2.3-beta..1", False),
        ("clawdi@1.2.3-beta.", False),
        ("clawdi@1.2.3-.beta", False),
        ("clawdi@1.2.3-01", False),
        ("clawdi@1.2.3-1٢", False),
        ("clawdi@1.2.3+build.1", False),
    ],
)
def test_cli_package_spec_semver_contract_vectors(cli_package_spec, accepted):
    if accepted:
        assert validate_clawdi_cli_package_spec(cli_package_spec) == cli_package_spec
        return
    with pytest.raises(ValueError):
        validate_clawdi_cli_package_spec(cli_package_spec)


@pytest.mark.parametrize("listen_port", [True, "28789"])
def test_hosted_runtime_bridge_rejects_numeric_coercion(listen_port):
    bridge = {
        "surfaces": [
            {
                **TEST_OPENCLAW_BRIDGE["surfaces"][0],
                "listenPort": listen_port,
            }
        ]
    }

    with pytest.raises(ValidationError):
        HostedRuntimeBridge.model_validate(bridge)


@pytest.mark.parametrize("url", TEST_INVALID_EGRESS_ENGINE_URLS)
def test_hosted_egress_engine_rejects_unsupported_urls(url):
    with pytest.raises(ValidationError):
        HostedEgressEngine.model_validate({**TEST_EGRESS_ENGINE_PIN, "url": url})


@pytest.mark.asyncio
@pytest.mark.parametrize("runtime", ["openclaw", "hermes"])
async def test_dashboard_dev_seed_runtime_state_validates_and_serves_manifest(
    db_session,
    seed_user,
    workspace_project,
    runtime,
):
    _, env = await _create_hosted_runtime_graph(
        db_session,
        user=seed_user,
        workspace=workspace_project,
        clerk_id=seed_user.clerk_id,
        runtime=runtime,
        now=datetime.now(UTC),
        sort_order=1,
    )
    db_session.add(_seed_ai_provider(seed_user))
    await db_session.commit()

    state = await db_session.get(HostedRuntimeState, env.id)
    assert state is not None
    validated = AdminRuntimeStateUpsert.model_validate(
        {
            "deployment_id": state.deployment_id,
            "instance_id": state.instance_id,
            "generation": state.generation,
            "cli_package_spec": state.cli_package_spec,
            "locale": state.locale,
            "system": state.system,
            "egress_engine": state.egress_engine,
            "runtimes": state.runtimes,
            "bridge": state.bridge,
            "live_sync": state.live_sync,
            "recovery": state.recovery,
            "egress_profiles": state.egress_profiles,
            "mcp": state.mcp,
            "tools": state.tools,
        }
    )
    assert validated.live_sync.model_dump(mode="json") == {
        "enabled": True,
        "agents": [{"agentType": runtime, "environmentId": str(env.id)}],
    }
    assert validated.recovery.model_dump(mode="json") == {
        "cacheManifest": True,
        "allowOfflineBoot": True,
    }

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    assert response.json()["manifest"]["liveSync"] == {
        "enabled": True,
        "agents": [{"agentType": runtime, "environmentId": str(env.id)}],
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("runtime_entry", "error_field"),
    [
        (
            {
                key: value
                for key, value in next(iter(_runtime_state().values())).items()
                if key != "install"
            },
            "install",
        ),
        (
            {
                **next(iter(_runtime_state().values())),
                "install": {"source": "official", "channel": "stable"},
            },
            "channel",
        ),
        (
            {
                **next(iter(_runtime_state().values())),
                "install": {"source": "official", "args": []},
            },
            "args",
        ),
    ],
)
async def test_admin_runtime_state_requires_only_official_install_source(
    admin_client,
    db_session,
    seed_user,
    runtime_entry,
    error_field,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"required-install-{uuid4().hex[:8]}",
        machine_name="Runtime required install",
        agent_type="openclaw",
    )
    response = await admin_client.put(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json={
            "deployment_id": f"dep_{uuid4().hex}",
            "instance_id": f"hri_{uuid4().hex}",
            "generation": 7,
            "locale": TEST_LOCALE,
            "system": TEST_SYSTEM,
            "runtimes": {"openclaw": runtime_entry},
            "live_sync": _live_sync(str(env.id)),
            "recovery": {"cacheManifest": True, "allowOfflineBoot": True},
        },
    )

    assert response.status_code == 422, response.text
    assert error_field in response.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "cli_package_spec",
    [
        "clawdi@0.12.10-beta.50",
        "clawdi@agent-v2",
        "clawdi@latest",
        "clawdi@beta",
        "clawdi@^1.2.3",
        "clawdi@1.2.x",
        "clawdi@1.2.3+build.1",
        "file:/tmp/clawdi.tgz",
        "/tmp/clawdi.tgz",
        "clawdi",
        "1.2.3",
    ],
)
async def test_admin_runtime_state_rejects_invalid_or_below_floor_cli_package_spec(
    admin_client,
    db_session,
    seed_user,
    cli_package_spec,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-cli-invalid-{uuid4().hex[:8]}",
        machine_name="Runtime CLI invalid",
        agent_type="openclaw",
    )
    response = await admin_client.put(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json=_runtime_state_body(str(env.id), cli_package_spec=cli_package_spec),
    )

    assert response.status_code == 422, response.text
    assert "cli_package_spec" in response.text
    assert "exact" in response.text or "minimum" in response.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "cli_package_spec",
    [
        "clawdi@0.12.10-beta.51",
        "clawdi@0.12.10-beta.52",
        "clawdi@0.12.10-rc.1",
        "clawdi@0.12.10",
        "clawdi@0.12.11-beta.0",
        "clawdi@1.0.0",
    ],
)
async def test_admin_runtime_state_accepts_cli_package_spec_at_or_above_floor(
    admin_client,
    db_session,
    seed_user,
    cli_package_spec,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-cli-valid-{uuid4().hex[:8]}",
        machine_name="Runtime CLI valid",
        agent_type="openclaw",
    )
    response = await admin_client.put(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json=_runtime_state_body(str(env.id), cli_package_spec=cli_package_spec),
    )

    assert response.status_code == 200, response.text
    state = await db_session.get(HostedRuntimeState, env.id)
    assert state is not None
    assert state.cli_package_spec == cli_package_spec


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["source", "registry"])
async def test_admin_runtime_state_rejects_cli_manifest_authority_injection(
    admin_client,
    db_session,
    seed_user,
    field,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-cli-injection-{uuid4().hex[:8]}",
        machine_name="Runtime CLI injection",
        agent_type="openclaw",
    )
    body = _runtime_state_body(str(env.id))
    body[field] = "https://registry.example" if field == "registry" else "npm:other"
    response = await admin_client.put(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json=body,
    )

    assert response.status_code == 422, response.text
    assert field in response.text


@pytest.mark.asyncio
async def test_admin_upsert_runtime_state_and_manifest_omit_channels(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-{uuid4().hex[:8]}",
        machine_name="Runtime v2",
        agent_type="openclaw",
    )
    expected = await _write_runtime_state(admin_client, str(env.id))

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    etag = response.headers.get("etag")
    assert etag is not None
    assert response.headers["cache-control"] == "no-store"
    payload = response.json()
    manifest = payload["manifest"]
    assert manifest["schemaVersion"] == "clawdi.hosted-runtime.manifest.v1"
    assert manifest["minimumCliVersion"] == "0.12.10-beta.51"
    assert manifest["runtime"] == "openclaw"
    assert set(manifest["runtimes"]) == {"openclaw"}
    assert manifest["locale"] == TEST_LOCALE
    assert set(manifest["locale"]) == {"language", "timezone"}
    assert manifest["system"] == TEST_SYSTEM
    assert manifest["runtimes"]["openclaw"] == expected["runtimes"]["openclaw"]
    assert "personality" not in manifest
    assert manifest["clawdiCli"] == {
        "source": "npm:clawdi",
        "packageSpec": TEST_CLI_PACKAGE_SPEC,
        "registry": "https://registry.npmjs.org",
    }
    assert manifest["deploymentId"] == expected["deployment_id"]
    assert manifest["environmentId"] == str(env.id)
    assert manifest["instanceId"] == expected["instance_id"]
    assert manifest["generation"] == expected["generation"]
    assert manifest["controlPlane"] == {
        "cloudApiUrl": settings.public_api_url.rstrip("/"),
    }
    assert manifest["liveSync"]["agents"] == [
        {"agentType": "openclaw", "environmentId": str(env.id)}
    ]
    assert "appId" not in manifest
    assert "channels" not in manifest
    assert payload["secretValues"] == {}
    assert etag == expected_runtime_bundle_v2_etag(payload["sourceRevision"])

    async with await _runtime_client(db_session, seed_user, api_key) as client:
        not_modified = await client.get(
            "/v1/runtime/manifest",
            headers={"If-None-Match": etag},
        )
    app.dependency_overrides.clear()

    assert not_modified.status_code == 304
    assert not_modified.headers["etag"] == etag
    assert not_modified.headers["cache-control"] == "no-store"
    assert not_modified.content == b""


@pytest.mark.asyncio
async def test_runtime_selection_changes_manifest_and_etag(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-selection-{uuid4().hex[:8]}",
        machine_name="Runtime selection",
        agent_type="openclaw",
    )
    body = await _write_runtime_state(admin_client, str(env.id))
    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")

    async with await _runtime_client(db_session, seed_user, api_key) as client:
        first = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()
    assert first.status_code == 200, first.text

    body["runtimes"] = _runtime_state("hermes")
    body["bridge"] = TEST_HERMES_BRIDGE
    body["live_sync"] = _live_sync(str(env.id), "hermes")
    body["generation"] = 8
    updated = await admin_client.put(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json=body,
    )
    assert updated.status_code == 200, updated.text

    async with await _runtime_client(db_session, seed_user, api_key) as client:
        second = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert second.status_code == 200, second.text
    assert first.json()["manifest"]["runtime"] == "openclaw"
    assert second.json()["manifest"]["runtime"] == "hermes"
    assert set(second.json()["manifest"]["runtimes"]) == {"hermes"}
    assert second.headers["etag"] != first.headers["etag"]


@pytest.mark.asyncio
async def test_unchanged_runtime_state_upsert_does_not_emit_invalidation(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-unchanged-{uuid4().hex[:8]}",
        machine_name="Runtime unchanged",
        agent_type="openclaw",
    )
    body = await _write_runtime_state(admin_client, str(env.id))
    audit_count = await _runtime_state_audit_count(db_session, env.id)
    queue = sync_events.subscribe(
        seed_user.id,
        frozenset(),
        environment_id=env.id,
    )
    try:
        response = await admin_client.put(
            f"/v1/admin/environments/{env.id}/runtime-state",
            headers=_AUTH,
            json=body,
        )

        assert response.status_code == 200, response.text
        await asyncio.sleep(0)
        assert queue.empty()
        assert await _runtime_state_audit_count(db_session, env.id) == audit_count
    finally:
        sync_events.unsubscribe(seed_user.id, queue)


@pytest.mark.asyncio
async def test_stale_runtime_state_generation_returns_current_generation_without_side_effects(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-stale-{uuid4().hex[:8]}",
        machine_name="Runtime stale generation",
        agent_type="openclaw",
    )
    body = await _write_runtime_state(admin_client, str(env.id))
    environment_id = env.id
    user_id = seed_user.id
    audit_count = await _runtime_state_audit_count(db_session, environment_id)
    queue = sync_events.subscribe(user_id, frozenset(), environment_id=environment_id)
    try:
        response = await admin_client.put(
            f"/v1/admin/environments/{environment_id}/runtime-state",
            headers=_AUTH,
            json={
                **body,
                "generation": 6,
                "cli_package_spec": "clawdi@0.12.10-beta.52",
            },
        )

        assert response.status_code == 409, response.text
        assert response.json() == {"detail": {"code": "stale_generation", "current_generation": 7}}
        await asyncio.sleep(0)
        assert queue.empty()
        assert await _runtime_state_audit_count(db_session, environment_id) == audit_count
        state = await db_session.get(HostedRuntimeState, environment_id)
        assert state is not None
        assert state.generation == 7
        assert state.cli_package_spec == TEST_CLI_PACKAGE_SPEC
    finally:
        sync_events.unsubscribe(user_id, queue)


@pytest.mark.asyncio
async def test_equal_generation_material_conflict_returns_current_generation_without_side_effects(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-conflict-{uuid4().hex[:8]}",
        machine_name="Runtime generation conflict",
        agent_type="openclaw",
    )
    body = await _write_runtime_state(admin_client, str(env.id))
    environment_id = env.id
    user_id = seed_user.id
    audit_count = await _runtime_state_audit_count(db_session, environment_id)
    queue = sync_events.subscribe(user_id, frozenset(), environment_id=environment_id)
    try:
        response = await admin_client.put(
            f"/v1/admin/environments/{environment_id}/runtime-state",
            headers=_AUTH,
            json={**body, "cli_package_spec": "clawdi@0.12.10-beta.52"},
        )

        assert response.status_code == 409, response.text
        assert response.json() == {
            "detail": {"code": "generation_conflict", "current_generation": 7}
        }
        await asyncio.sleep(0)
        assert queue.empty()
        assert await _runtime_state_audit_count(db_session, environment_id) == audit_count
        state = await db_session.get(HostedRuntimeState, environment_id)
        assert state is not None
        assert state.generation == 7
        assert state.cli_package_spec == TEST_CLI_PACKAGE_SPEC
    finally:
        sync_events.unsubscribe(user_id, queue)


@pytest.mark.asyncio
async def test_concurrent_same_generation_runtime_state_updates_allow_one_winner(
    admin_client,
    db_session,
    engine,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-concurrent-{uuid4().hex[:8]}",
        machine_name="Runtime concurrent generation",
        agent_type="openclaw",
    )
    body = await _write_runtime_state(admin_client, str(env.id))
    audit_count = await _runtime_state_audit_count(db_session, env.id)
    queue = sync_events.subscribe(seed_user.id, frozenset(), environment_id=env.id)
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    try:
        candidate_specs = (
            "clawdi@0.12.10-beta.52",
            "clawdi@0.12.10-beta.53",
        )
        candidate_bodies = [
            AdminRuntimeStateUpsert.model_validate(
                {**body, "generation": 8, "cli_package_spec": cli_package_spec}
            )
            for cli_package_spec in candidate_specs
        ]
        async with sessionmaker() as session_a, sessionmaker() as session_b:
            results = await asyncio.gather(
                _admin_upsert_runtime_state(env.id, candidate_bodies[0], session_a),
                _admin_upsert_runtime_state(env.id, candidate_bodies[1], session_b),
                return_exceptions=True,
            )

        failures = [result for result in results if isinstance(result, HTTPException)]
        successes = [result for result in results if not isinstance(result, BaseException)]
        assert len(successes) == 1
        assert len(failures) == 1
        assert failures[0].status_code == 409
        assert failures[0].detail == {
            "code": "generation_conflict",
            "current_generation": 8,
        }
        assert queue.get_nowait() == {
            "type": "runtime_manifest_changed",
            "environment_id": str(env.id),
        }
        assert queue.empty()

        async with sessionmaker() as verify_db:
            state = await verify_db.get(HostedRuntimeState, env.id)
            assert state is not None
            assert state.generation == 8
            assert state.cli_package_spec in candidate_specs
            assert await _runtime_state_audit_count(verify_db, env.id) == audit_count + 1
    finally:
        sync_events.unsubscribe(seed_user.id, queue)


@pytest.mark.asyncio
async def test_concurrent_initial_identical_runtime_state_upserts_are_idempotent(
    db_session,
    engine,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-concurrent-create-idempotent-{uuid4().hex[:8]}",
        machine_name="Runtime concurrent initial idempotent",
        agent_type="openclaw",
    )
    body = _runtime_state_body(str(env.id))
    audit_count = await _runtime_state_audit_count(db_session, env.id)
    queue = sync_events.subscribe(seed_user.id, frozenset(), environment_id=env.id)
    try:
        async with _isolated_admin_client(engine) as client:
            responses = await _concurrent_initial_runtime_state_responses(
                engine,
                client,
                env.id,
                (body, body),
            )

        assert [response.status_code for response in responses] == [200, 200]
        assert responses[0].json() == responses[1].json()
        assert queue.get_nowait() == {
            "type": "runtime_manifest_changed",
            "environment_id": str(env.id),
        }
        assert queue.empty()
        assert await _runtime_state_audit_count(db_session, env.id) == audit_count + 1
        states = (
            (
                await db_session.execute(
                    select(HostedRuntimeState).where(HostedRuntimeState.environment_id == env.id)
                )
            )
            .scalars()
            .all()
        )
        assert len(states) == 1
        assert states[0].generation == body["generation"]
        assert states[0].cli_package_spec == body["cli_package_spec"]
    finally:
        sync_events.unsubscribe(seed_user.id, queue)


@pytest.mark.asyncio
async def test_concurrent_initial_conflicting_runtime_state_upserts_return_generation_conflict(
    db_session,
    engine,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-concurrent-create-conflict-{uuid4().hex[:8]}",
        machine_name="Runtime concurrent initial conflict",
        agent_type="openclaw",
    )
    body = _runtime_state_body(str(env.id))
    candidate_specs = (
        "clawdi@0.12.10-beta.52",
        "clawdi@0.12.10-beta.53",
    )
    audit_count = await _runtime_state_audit_count(db_session, env.id)
    queue = sync_events.subscribe(seed_user.id, frozenset(), environment_id=env.id)
    try:
        async with _isolated_admin_client(engine) as client:
            responses = await _concurrent_initial_runtime_state_responses(
                engine,
                client,
                env.id,
                tuple(
                    {**body, "cli_package_spec": cli_package_spec}
                    for cli_package_spec in candidate_specs
                ),
            )

        assert sorted(response.status_code for response in responses) == [200, 409]
        conflict = next(response for response in responses if response.status_code == 409)
        assert conflict.json() == {
            "detail": {
                "code": "generation_conflict",
                "current_generation": body["generation"],
            }
        }
        assert queue.get_nowait() == {
            "type": "runtime_manifest_changed",
            "environment_id": str(env.id),
        }
        assert queue.empty()
        assert await _runtime_state_audit_count(db_session, env.id) == audit_count + 1
        states = (
            (
                await db_session.execute(
                    select(HostedRuntimeState).where(HostedRuntimeState.environment_id == env.id)
                )
            )
            .scalars()
            .all()
        )
        assert len(states) == 1
        assert states[0].generation == body["generation"]
        assert states[0].cli_package_spec in candidate_specs
    finally:
        sync_events.unsubscribe(seed_user.id, queue)


@pytest.mark.asyncio
async def test_cli_package_spec_change_updates_etag_audit_and_invalidation(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-cli-change-{uuid4().hex[:8]}",
        machine_name="Runtime CLI change",
        agent_type="openclaw",
    )
    body = await _write_runtime_state(admin_client, str(env.id))
    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        initial = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()
    assert initial.status_code == 200, initial.text

    queue = sync_events.subscribe(seed_user.id, frozenset(), environment_id=env.id)
    try:
        updated_spec = "clawdi@0.12.10-beta.52"
        updated = await admin_client.put(
            f"/v1/admin/environments/{env.id}/runtime-state",
            headers=_AUTH,
            json={**body, "generation": 8, "cli_package_spec": updated_spec},
        )
        assert updated.status_code == 200, updated.text
        assert queue.get_nowait() == {
            "type": "runtime_manifest_changed",
            "environment_id": str(env.id),
        }
    finally:
        sync_events.unsubscribe(seed_user.id, queue)

    async with await _runtime_client(db_session, seed_user, api_key) as client:
        changed = await client.get(
            "/v1/runtime/manifest",
            headers={"If-None-Match": initial.headers["etag"]},
        )
        audit = await client.get(
            "/v1/audit/events",
            params={
                "resource_type": "hosted_runtime_state",
                "environment_id": str(env.id),
            },
        )
    app.dependency_overrides.clear()

    assert changed.status_code == 200, changed.text
    assert changed.headers["etag"] != initial.headers["etag"]
    assert changed.json()["manifest"]["generation"] == 8
    assert changed.json()["manifest"]["clawdiCli"]["packageSpec"] == updated_spec
    latest = audit.json()["items"][0]
    assert latest["details"]["cli_package_spec"] == updated_spec
    assert latest["details"]["previous_generation"] == 7
    assert latest["details"]["changed_fields"] == ["generation", "cli_package_spec"]


@pytest.mark.asyncio
async def test_agent_type_refresh_does_not_invalidate_explicit_live_sync_manifest(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-agent-type-{uuid4().hex[:8]}",
        machine_name="Runtime agent type",
        agent_type="openclaw",
    )
    await _write_runtime_state(admin_client, str(env.id))
    queue = sync_events.subscribe(
        seed_user.id,
        frozenset(),
        environment_id=env.id,
    )
    try:
        response = await admin_client.post(
            "/v1/admin/agents",
            headers=_AUTH,
            json={
                "target_clerk_id": seed_user.clerk_id,
                "agent_id": str(env.id),
                "machine_id": env.machine_id,
                "machine_name": env.machine_name,
                "agent_type": "hermes",
                "agent_version": "test",
                "os_name": env.os,
            },
        )

        assert response.status_code == 200, response.text
        await asyncio.sleep(0)
        assert queue.empty()
    finally:
        sync_events.unsubscribe(seed_user.id, queue)


@pytest.mark.asyncio
async def test_environment_delete_invalidates_cascaded_runtime_manifest(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-delete-env-{uuid4().hex[:8]}",
        machine_name="Runtime delete environment",
        agent_type="openclaw",
    )
    await _write_runtime_state(admin_client, str(env.id))
    queue = sync_events.subscribe(
        seed_user.id,
        frozenset(),
        environment_id=env.id,
    )
    try:
        response = await admin_client.delete(
            f"/v1/admin/agents/{env.id}",
            headers=_AUTH,
        )

        assert response.status_code == 204, response.text
        assert queue.get_nowait() == {
            "type": "runtime_manifest_changed",
            "environment_id": str(env.id),
        }
    finally:
        sync_events.unsubscribe(seed_user.id, queue)


@pytest.mark.asyncio
async def test_agent_v2_manifest_cli_package_and_protocol_are_cloud_owned(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-cli-authority-{uuid4().hex[:8]}",
        machine_name="Runtime CLI authority",
        agent_type="openclaw",
    )
    await _write_runtime_state(admin_client, str(env.id))
    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    assert response.json()["manifest"]["clawdiCli"] == {
        "source": "npm:clawdi",
        "packageSpec": TEST_CLI_PACKAGE_SPEC,
        "registry": "https://registry.npmjs.org",
    }
    assert response.json()["manifest"]["minimumCliVersion"] == "0.12.10-beta.51"


@pytest.mark.asyncio
async def test_admin_runtime_state_rejects_manifest_protocol_metadata(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-protocol-metadata-{uuid4().hex[:8]}",
        machine_name="Runtime protocol metadata",
        agent_type="openclaw",
    )

    response = await admin_client.put(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json={
            "deployment_id": "dep-protocol-metadata",
            "instance_id": "hri-protocol-metadata",
            "generation": 1,
            "locale": TEST_LOCALE,
            "system": TEST_SYSTEM,
            "runtimes": _runtime_state(),
            "minimumCliVersion": "0.12.10-beta.51",
        },
    )

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_admin_runtime_state_rejects_cli_desired_state_authority(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-cli-metadata-{uuid4().hex[:8]}",
        machine_name="Runtime CLI metadata",
        agent_type="openclaw",
    )

    response = await admin_client.put(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json={
            "deployment_id": "dep-cli-metadata",
            "instance_id": "hri-cli-metadata",
            "generation": 1,
            "locale": TEST_LOCALE,
            "system": TEST_SYSTEM,
            "runtimes": _runtime_state(),
            "clawdi_cli": {"packageSpec": "clawdi@0.12.9"},
        },
    )

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "locale",
    [
        None,
        {"language": "it", "timezone": "Europe/Rome"},
        {"language": "en", "timezone": "Mars/Olympus"},
        {"language": "en", "timezone": "UTC", "region": "global"},
        {"language": "en"},
    ],
)
async def test_admin_runtime_state_requires_strict_locale(
    admin_client,
    db_session,
    seed_user,
    locale,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-locale-{uuid4().hex[:8]}",
        machine_name="Runtime locale",
        agent_type="openclaw",
    )
    body = {
        "deployment_id": "dep-locale",
        "instance_id": "hri-locale",
        "generation": 1,
        "system": TEST_SYSTEM,
        "runtimes": _runtime_state(),
    }
    if locale is not None:
        body["locale"] = locale

    response = await admin_client.put(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json=body,
    )

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_admin_runtime_state_rejects_personality_desired_state(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-personality-{uuid4().hex[:8]}",
        machine_name="Runtime personality",
        agent_type="openclaw",
    )

    response = await admin_client.put(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json={
            "deployment_id": "dep-personality",
            "instance_id": "hri-personality",
            "generation": 1,
            "locale": TEST_LOCALE,
            "system": TEST_SYSTEM,
            "runtimes": _runtime_state(),
            "personality": "helpful",
        },
    )

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "runtime_entry",
    [
        {**next(iter(_runtime_state().values())), "providerIds": ["clawdi-managed-v2"]},
        {**next(iter(_runtime_state().values())), "provider_id": "clawdi-managed-v2"},
        {**next(iter(_runtime_state().values())), "providerId": "clawdi-managed-v2"},
        {
            **next(iter(_runtime_state().values())),
            "primaryModel": {"provider_id": "clawdi-managed-v2", "model": "gpt-5.5"},
        },
        {**next(iter(_runtime_state().values())), "primary_model": "gpt-5.5"},
        {**next(iter(_runtime_state().values())), "model": "gpt-5.5"},
        {
            **next(iter(_runtime_state().values())),
            "primary_model": {"providerId": "clawdi-managed-v2", "model": "gpt-5.5"},
        },
        {
            key: value
            for key, value in next(iter(_runtime_state().values())).items()
            if key != "primary_model"
        },
        {
            key: value
            for key, value in next(iter(_runtime_state().values())).items()
            if key != "paths"
        },
        {**next(iter(_runtime_state().values())), "paths": {"home": "/home/clawdi"}},
        {
            **next(iter(_runtime_state().values())),
            "paths": {**TEST_RUNTIME_PATHS, "stateDir": "/var/lib/clawdi"},
        },
        {
            **next(iter(_runtime_state().values())),
            "install": {"source": "official", "unknown": True},
        },
        {**next(iter(_runtime_state().values())), "run": {"args": ["gateway"], "x": 1}},
        {
            **next(iter(_runtime_state().values())),
            "services": {"dashboard": {"args": ["dashboard"], "x": 1}},
        },
        {**next(iter(_runtime_state().values())), "provider_ids": [""]},
        {
            **next(iter(_runtime_state().values())),
            "install": {"source": "official", "args": [""]},
        },
        {**next(iter(_runtime_state().values())), "run": {"args": [""]}},
        {**next(iter(_runtime_state().values())), "run": {"prependPath": [""]}},
    ],
)
async def test_admin_runtime_state_rejects_noncanonical_runtime_entries(
    admin_client,
    db_session,
    seed_user,
    runtime_entry,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-noncanonical-{uuid4().hex[:8]}",
        machine_name="Runtime noncanonical",
        agent_type="openclaw",
    )
    response = await admin_client.put(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json={
            "deployment_id": f"dep_{uuid4().hex}",
            "instance_id": f"hri_{uuid4().hex}",
            "generation": 7,
            "locale": TEST_LOCALE,
            "system": TEST_SYSTEM,
            "runtimes": {"openclaw": runtime_entry},
        },
    )

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "system",
    [
        None,
        {"home": "/home/clawdi"},
        {**TEST_SYSTEM, "persistentPaths": [""]},
        {**TEST_SYSTEM, "openclawControlUiAllowedOrigins": ["ftp://cloud.test"]},
        {**TEST_SYSTEM, "openclawControlUiAllowedOrigins": ["https://cloud.test/path"]},
        {**TEST_SYSTEM, "openclawControlUiAllowedOrigins": ["https://cloud.test/"]},
    ],
)
async def test_admin_runtime_state_requires_canonical_system(
    admin_client,
    db_session,
    seed_user,
    system,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-system-{uuid4().hex[:8]}",
        machine_name="Runtime system",
        agent_type="openclaw",
    )
    body = {
        "deployment_id": f"dep_{uuid4().hex}",
        "instance_id": f"hri_{uuid4().hex}",
        "generation": 7,
        "locale": TEST_LOCALE,
        "runtimes": _runtime_state(),
    }
    if system is not None:
        body["system"] = system
    response = await admin_client.put(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json=body,
    )

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
@pytest.mark.parametrize("missing_field", ["live_sync", "recovery"])
async def test_admin_runtime_state_requires_live_sync_and_recovery(
    admin_client,
    db_session,
    seed_user,
    missing_field,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-required-state-{uuid4().hex[:8]}",
        machine_name="Runtime required state",
        agent_type="openclaw",
    )
    body = {
        "deployment_id": f"dep_{uuid4().hex}",
        "instance_id": f"hri_{uuid4().hex}",
        "generation": 7,
        "locale": TEST_LOCALE,
        "system": TEST_SYSTEM,
        "runtimes": _runtime_state(),
        "live_sync": _live_sync(str(env.id)),
        "recovery": {"cacheManifest": True, "allowOfflineBoot": True},
    }
    del body[missing_field]

    response = await admin_client.put(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json=body,
    )

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("live_sync", "recovery"),
    [
        ({"enabled": True, "agents": []}, {"cacheManifest": True, "allowOfflineBoot": True}),
        (_live_sync("env-placeholder"), {"cacheManifest": True}),
    ],
)
async def test_runtime_manifest_rejects_invalid_stored_live_sync_or_recovery(
    db_session,
    seed_user,
    live_sync,
    recovery,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-invalid-required-state-{uuid4().hex[:8]}",
        machine_name="Runtime invalid required state",
        agent_type="openclaw",
    )
    if live_sync.get("agents"):
        live_sync["agents"][0]["environmentId"] = str(env.id)
    db_session.add(
        HostedRuntimeState(
            environment_id=env.id,
            deployment_id=f"dep_{uuid4().hex}",
            instance_id=f"hri_{uuid4().hex}",
            generation=7,
            cli_package_spec=TEST_CLI_PACKAGE_SPEC,
            locale=TEST_LOCALE,
            system=TEST_SYSTEM,
            runtimes=_runtime_state(),
            live_sync=live_sync,
            recovery=recovery,
        )
    )
    await db_session.commit()

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 409, response.text


@pytest.mark.asyncio
async def test_runtime_manifest_rejects_invalid_stored_locale(
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-invalid-locale-{uuid4().hex[:8]}",
        machine_name="Runtime invalid locale",
        agent_type="openclaw",
    )
    db_session.add(
        HostedRuntimeState(
            environment_id=env.id,
            deployment_id="dep-invalid-locale",
            instance_id="hri-invalid-locale",
            generation=1,
            cli_package_spec=TEST_CLI_PACKAGE_SPEC,
            locale={
                "language": "en",
                "timezone": "UTC",
                "personality": "helpful",
            },
            system=TEST_SYSTEM,
            runtimes=_runtime_state(),
            live_sync=_live_sync(str(env.id)),
            recovery={"cacheManifest": True, "allowOfflineBoot": True},
        )
    )
    await db_session.commit()

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        canonical = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert canonical.status_code == 409, canonical.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("runtimes", "system"),
    [
        (
            {
                "openclaw": {
                    **next(iter(_runtime_state().values())),
                    "providerId": "clawdi-managed-v2",
                }
            },
            TEST_SYSTEM,
        ),
        (_runtime_state(), {"home": "/home/clawdi"}),
    ],
)
async def test_runtime_manifest_rejects_malformed_stored_contract(
    db_session,
    seed_user,
    runtimes,
    system,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-stored-invalid-{uuid4().hex[:8]}",
        machine_name="Runtime stored invalid",
        agent_type="openclaw",
    )
    db_session.add(
        HostedRuntimeState(
            environment_id=env.id,
            deployment_id=f"dep_{uuid4().hex}",
            instance_id=f"hri_{uuid4().hex}",
            generation=7,
            cli_package_spec=TEST_CLI_PACKAGE_SPEC,
            locale=TEST_LOCALE,
            system=system,
            runtimes=runtimes,
            live_sync=_live_sync(str(env.id)),
            recovery={"cacheManifest": True, "allowOfflineBoot": True},
        )
    )
    await db_session.commit()

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 409, response.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("egress_engine", {}),
        ("egress_engine", {**TEST_EGRESS_ENGINE_PIN, "sha256": "not-a-sha256"}),
        *[
            ("egress_engine", {**TEST_EGRESS_ENGINE_PIN, "url": url})
            for url in TEST_INVALID_EGRESS_ENGINE_URLS
        ],
        (
            "egress_profiles",
            {
                "profiles": [
                    {
                        **TEST_EGRESS_PROFILES["profiles"][0],
                        "unexpected": True,
                    }
                ]
            },
        ),
        (
            "egress_profiles",
            {
                "profiles": [
                    {
                        **TEST_EGRESS_PROFILES["profiles"][0],
                        "priority": True,
                    }
                ]
            },
        ),
        (
            "egress_profiles",
            {
                "profiles": [
                    {
                        **TEST_EGRESS_PROFILES["profiles"][0],
                        "priority": "100",
                    }
                ]
            },
        ),
        (
            "egress_profiles",
            {
                "profiles": [
                    {
                        **TEST_EGRESS_PROFILES["profiles"][0],
                        "owner": None,
                    }
                ]
            },
        ),
    ],
)
async def test_runtime_manifest_rejects_invalid_stored_egress_state(
    db_session,
    seed_user,
    field,
    value,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-stored-egress-{uuid4().hex[:8]}",
        machine_name="Runtime stored egress invalid",
        agent_type="openclaw",
    )
    state_values = {
        "environment_id": env.id,
        "deployment_id": f"dep_{uuid4().hex}",
        "instance_id": f"hri_{uuid4().hex}",
        "generation": 7,
        "cli_package_spec": TEST_CLI_PACKAGE_SPEC,
        "locale": TEST_LOCALE,
        "system": TEST_SYSTEM,
        "runtimes": _runtime_state(),
        "live_sync": _live_sync(str(env.id)),
        "recovery": {"cacheManifest": True, "allowOfflineBoot": True},
        field: value,
    }
    db_session.add(HostedRuntimeState(**state_values))
    await db_session.commit()

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 409, response.text
    assert response.json() == {"detail": "Hosted runtime egress state is invalid"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("runtime", "bridge"),
    [
        ("hermes", None),
        ("hermes", TEST_OPENCLAW_BRIDGE),
        ("openclaw", TEST_HERMES_BRIDGE),
        (
            "openclaw",
            {
                "surfaces": [
                    {
                        key: value
                        for key, value in TEST_OPENCLAW_BRIDGE["surfaces"][0].items()
                        if key != "upstreamHost"
                    }
                ]
            },
        ),
    ],
)
async def test_runtime_manifest_rejects_stored_runtime_bridge_mismatch(
    db_session,
    seed_user,
    runtime,
    bridge,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-stored-bridge-{runtime}-{uuid4().hex[:8]}",
        machine_name=f"Runtime stored bridge mismatch {runtime}",
        agent_type=runtime,
    )
    db_session.add(
        HostedRuntimeState(
            environment_id=env.id,
            deployment_id=f"dep_{uuid4().hex}",
            instance_id=f"hri_{uuid4().hex}",
            generation=7,
            cli_package_spec=TEST_CLI_PACKAGE_SPEC,
            locale=TEST_LOCALE,
            system=TEST_SYSTEM,
            runtimes=_runtime_state(runtime),
            bridge=bridge,
            live_sync=_live_sync(str(env.id), runtime),
            recovery={"cacheManifest": True, "allowOfflineBoot": True},
        )
    )
    await db_session.commit()

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 409, response.text
    assert response.json() == {
        "detail": "Hosted runtime bridge state does not match the selected runtime"
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bridge",
    [
        {},
        {
            "surfaces": [
                {
                    **TEST_OPENCLAW_BRIDGE["surfaces"][0],
                    "listenPort": "28789",
                }
            ]
        },
    ],
)
async def test_runtime_manifest_rejects_invalid_stored_bridge(
    db_session,
    seed_user,
    bridge,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-stored-bridge-coercion-{uuid4().hex[:8]}",
        machine_name="Runtime stored bridge coercion",
        agent_type="openclaw",
    )
    db_session.add(
        HostedRuntimeState(
            environment_id=env.id,
            deployment_id=f"dep_{uuid4().hex}",
            instance_id=f"hri_{uuid4().hex}",
            generation=7,
            cli_package_spec=TEST_CLI_PACKAGE_SPEC,
            locale=TEST_LOCALE,
            system=TEST_SYSTEM,
            runtimes=_runtime_state(),
            bridge=bridge,
            live_sync=_live_sync(str(env.id)),
            recovery={"cacheManifest": True, "allowOfflineBoot": True},
        )
    )
    await db_session.commit()

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 409, response.text
    assert response.json() == {"detail": "Hosted runtime bridge state is invalid"}


@pytest.mark.asyncio
async def test_runtime_manifest_includes_egress_engine_pin(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-egress-engine-{uuid4().hex[:8]}",
        machine_name="Runtime egress engine",
        agent_type="openclaw",
    )
    await _write_runtime_state(admin_client, str(env.id), egress_engine=TEST_EGRESS_ENGINE_PIN)

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    assert response.json()["manifest"]["egressEngine"] == TEST_EGRESS_ENGINE_PIN


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("runtime", "bridge"),
    [
        ("openclaw", None),
        ("openclaw", TEST_OPENCLAW_BRIDGE),
        ("hermes", TEST_HERMES_BRIDGE),
    ],
)
async def test_admin_runtime_state_accepts_final_hosted_egress_and_bridge_contract(
    admin_client,
    db_session,
    seed_user,
    runtime,
    bridge,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-hosted-contract-{runtime}-{uuid4().hex[:8]}",
        machine_name=f"Runtime hosted contract {runtime}",
        agent_type=runtime,
    )
    body = _runtime_state_body(
        str(env.id),
        runtimes=_runtime_state(runtime),
        bridge=bridge,
        live_sync=_live_sync(str(env.id), runtime),
        egress_engine=TEST_EGRESS_ENGINE_PIN,
        egress_profiles=TEST_EGRESS_PROFILES,
    )

    written = await admin_client.put(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json=body,
    )

    assert written.status_code == 200, written.text
    state = await db_session.get(HostedRuntimeState, env.id)
    assert state is not None
    assert state.egress_engine == TEST_EGRESS_ENGINE_PIN
    assert state.egress_profiles == TEST_EGRESS_PROFILES
    assert state.bridge == bridge

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    manifest = response.json()["manifest"]
    assert manifest["runtime"] == runtime
    assert manifest["egressEngine"] == TEST_EGRESS_ENGINE_PIN
    assert manifest["egressProfiles"] == TEST_EGRESS_PROFILES
    if bridge is None:
        assert "bridge" not in manifest
    else:
        assert manifest["bridge"] == bridge


@pytest.mark.asyncio
async def test_runtime_manifest_includes_declared_bridge_surfaces(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-bridge-{uuid4().hex[:8]}",
        machine_name="Runtime bridge",
        agent_type="openclaw",
    )
    bridge = TEST_OPENCLAW_BRIDGE
    await _write_runtime_state(admin_client, str(env.id), bridge=bridge)

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["manifest"]["bridge"] == bridge


@pytest.mark.asyncio
async def test_runtime_manifest_etag_ignores_heartbeat_liveness(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-heartbeat-{uuid4().hex[:8]}",
        machine_name="Runtime heartbeat",
        agent_type="openclaw",
    )
    expected = await _write_runtime_state(admin_client, str(env.id))
    state = await db_session.get(HostedRuntimeState, env.id)
    assert state is not None
    await db_session.refresh(state)
    desired_updated_at = state.updated_at

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
        assert response.status_code == 200, response.text
        etag = response.headers["etag"]
        bundle = response.json()
        issued_at = bundle["manifest"]["issuedAt"]
        assert issued_at == desired_updated_at.isoformat()

        heartbeat = await client.post(
            f"/v1/agents/{env.id}/sync-heartbeat",
            json={
                "last_revision_seen": 1,
                "queue_depth": 0,
                "runtime_observed": {
                    "schemaVersion": "clawdi.hostedRuntimeObserved.v2",
                    "reportedAt": "2026-06-11T00:00:00+00:00",
                    "runtimeMode": "hosted",
                    "status": "ok",
                    "activeCliVersion": TEST_CLI_PACKAGE_SPEC.split("@", 1)[1],
                    "applied": {
                        "etag": etag,
                        "sourceRevision": bundle["sourceRevision"],
                        "generation": expected["generation"],
                        "instanceId": expected["instance_id"],
                        "appliedProviderIds": sorted(bundle["manifest"]["providers"]),
                    },
                    "boot": None,
                    "cli": None,
                    "providers": {
                        provider_id: {"status": "ok", "configured": True}
                        for provider_id in bundle["manifest"]["providers"]
                    },
                },
            },
        )
        assert heartbeat.status_code == 204, heartbeat.text

        not_modified = await client.get(
            "/v1/runtime/manifest",
            headers={"If-None-Match": etag},
        )
    app.dependency_overrides.clear()

    assert not_modified.status_code == 304
    assert not_modified.headers["etag"] == etag
    assert not_modified.content == b""
    await db_session.refresh(state)
    assert state.updated_at == desired_updated_at
    observation = await db_session.get(HostedRuntimeConfigObservation, env.id)
    assert observation is not None
    assert observation.observed_config_generation == expected["generation"]
    assert observation.observed_manifest_etag == etag


@pytest.mark.asyncio
async def test_runtime_manifest_etag_hashes_issued_at_and_keeps_config_generation(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-issued-at-{uuid4().hex[:8]}",
        machine_name="Runtime issued at",
        agent_type="openclaw",
    )
    expected = await _write_runtime_state(admin_client, str(env.id), generation=7)
    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")

    async with await _runtime_client(db_session, seed_user, api_key) as client:
        initial = await client.get("/v1/runtime/manifest")
    assert initial.status_code == 200, initial.text
    initial_etag = initial.headers["etag"]
    initial_issued_at = initial.json()["manifest"]["issuedAt"]
    assert initial.json()["manifest"]["generation"] == expected["generation"]

    state = await db_session.get(HostedRuntimeState, env.id)
    assert state is not None
    state.updated_at = state.updated_at + timedelta(seconds=1)
    await db_session.commit()

    async with await _runtime_client(db_session, seed_user, api_key) as client:
        refreshed = await client.get("/v1/runtime/manifest")
        not_modified = await client.get(
            "/v1/runtime/manifest",
            headers={"If-None-Match": initial_etag},
        )
    app.dependency_overrides.clear()

    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["manifest"]["issuedAt"] != initial_issued_at
    assert refreshed.json()["manifest"]["generation"] == expected["generation"]
    assert refreshed.headers["etag"] == expected_runtime_bundle_v2_etag(
        refreshed.json()["sourceRevision"]
    )
    assert refreshed.headers["etag"] != initial_etag
    assert not_modified.status_code == 200, not_modified.text
    assert not_modified.headers["etag"] == refreshed.headers["etag"]


@pytest.mark.asyncio
async def test_runtime_manifest_provider_label_is_not_projected_but_projected_fields_change_etag(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-provider-etag-{uuid4().hex[:8]}",
        machine_name="Runtime provider ETag",
        agent_type="openclaw",
    )
    provider = AiProvider(
        owner_user_id=seed_user.id,
        provider_id="custom-provider-etag",
        type="custom_openai_compatible",
        label="Original label",
        base_url="https://provider-a.test/v1",
        api_mode="openai_responses",
        auth_type="none",
        managed_by="user",
    )
    db_session.add(provider)
    await db_session.commit()
    await _write_runtime_state(
        admin_client,
        str(env.id),
        runtimes=_runtime_state(
            provider_ids=[provider.provider_id],
            primary_model={"provider_id": provider.provider_id, "model": "gpt-5.5"},
        ),
    )

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        initial = await client.get("/v1/runtime/manifest")
    assert initial.status_code == 200, initial.text
    initial_etag = initial.headers["etag"]
    initial_issued_at = initial.json()["manifest"]["issuedAt"]

    provider.label = "Renamed label"
    await db_session.commit()
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        label_only = await client.get(
            "/v1/runtime/manifest",
            headers={"If-None-Match": initial_etag},
        )
    assert label_only.status_code == 304
    assert label_only.headers["etag"] == initial_etag

    provider.base_url = "https://provider-b.test/v1"
    await db_session.commit()
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        projected_change = await client.get(
            "/v1/runtime/manifest",
            headers={"If-None-Match": initial_etag},
        )
    app.dependency_overrides.clear()

    assert projected_change.status_code == 200, projected_change.text
    assert projected_change.headers["etag"] == expected_runtime_bundle_v2_etag(
        projected_change.json()["sourceRevision"]
    )
    assert projected_change.headers["etag"] != initial_etag
    assert projected_change.json()["manifest"]["issuedAt"] == initial_issued_at
    assert projected_change.json()["manifest"]["providers"][provider.provider_id]["baseUrl"] == (
        "https://provider-b.test/v1"
    )


@pytest.mark.asyncio
async def test_admin_runtime_state_upsert_writes_redacted_audit_event(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"audit-runtime-{uuid4().hex[:8]}",
        machine_name="Runtime Audit",
        agent_type="openclaw",
    )
    initial = await _write_runtime_state(admin_client, str(env.id))
    updated = {**initial, "generation": 8}
    await _write_runtime_state(admin_client, str(env.id), **updated)

    async with await _runtime_client(db_session, seed_user, None) as client:
        response = await client.get(
            "/v1/audit/events",
            params={
                "resource_type": "hosted_runtime_state",
                "environment_id": str(env.id),
            },
        )
    app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    payload = response.json()
    assert len(payload["items"]) == 2
    latest = payload["items"][0]
    assert latest["action"] == "hosted_runtime_state.upsert"
    assert latest["resource_type"] == "hosted_runtime_state"
    assert latest["environment_id"] == str(env.id)
    assert latest["target_user_id"] == str(seed_user.id)
    assert latest["details"]["generation"] == 8
    assert latest["details"]["previous_generation"] == 7
    assert latest["details"]["cli_package_spec"] == TEST_CLI_PACKAGE_SPEC
    assert latest["details"]["enabled_runtimes"] == ["openclaw"]
    assert latest["details"]["changed_fields"] == ["generation"]
    assert "secret" not in json.dumps(payload).lower()
    assert "token" not in json.dumps(payload).lower()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "cli_package_spec",
    [
        "clawdi@latest",
        "clawdi@beta",
        "clawdi@0.12.10-beta.50",
        "clawdi@1.2.3+build.1",
    ],
)
async def test_runtime_manifest_rejects_invalid_or_below_floor_stored_cli_package_spec(
    db_session,
    seed_user,
    cli_package_spec,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-stored-cli-{uuid4().hex[:8]}",
        machine_name="Runtime stored CLI invalid",
        agent_type="openclaw",
    )
    db_session.add(
        HostedRuntimeState(
            environment_id=env.id,
            deployment_id=f"dep_{uuid4().hex}",
            instance_id=f"hri_{uuid4().hex}",
            generation=7,
            cli_package_spec=cli_package_spec,
            locale=TEST_LOCALE,
            system=TEST_SYSTEM,
            runtimes=_runtime_state(),
            live_sync=_live_sync(str(env.id)),
            recovery={"cacheManifest": True, "allowOfflineBoot": True},
        )
    )
    await db_session.commit()

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 409, response.text
    assert response.json() == {
        "detail": "Hosted runtime CLI package spec is invalid or below the minimum version"
    }


@pytest.mark.asyncio
async def test_admin_delete_runtime_state_clears_existing_state_and_writes_audit_event(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"delete-runtime-{uuid4().hex[:8]}",
        machine_name="Runtime Delete",
        agent_type="openclaw",
    )
    expected = await _write_runtime_state(admin_client, str(env.id))

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    assert response.status_code == 200, response.text
    etag = response.headers["etag"]

    deleted = await admin_client.delete(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
    )

    assert deleted.status_code == 204, deleted.text
    assert deleted.content == b""
    assert await db_session.get(HostedRuntimeState, env.id) is None

    async with await _runtime_client(db_session, seed_user, api_key) as client:
        missing = await client.get(
            "/v1/runtime/manifest",
            headers={"If-None-Match": etag},
        )
        audit = await client.get(
            "/v1/audit/events",
            params={
                "resource_type": "hosted_runtime_state",
                "environment_id": str(env.id),
            },
        )
    app.dependency_overrides.clear()

    assert missing.status_code == 404, missing.text
    assert missing.json() == {"detail": "Hosted runtime state not found"}
    assert audit.status_code == 200, audit.text
    payload = audit.json()
    assert len(payload["items"]) == 2
    latest = payload["items"][0]
    assert latest["action"] == "hosted_runtime_state.delete"
    assert latest["resource_type"] == "hosted_runtime_state"
    assert latest["environment_id"] == str(env.id)
    assert latest["target_user_id"] == str(seed_user.id)
    assert latest["details"]["deployment_id"] == expected["deployment_id"]
    assert latest["details"]["generation"] == expected["generation"]
    assert latest["details"]["enabled_runtimes"] == ["openclaw"]
    assert "secret" not in json.dumps(payload).lower()
    assert "token" not in json.dumps(payload).lower()


@pytest.mark.asyncio
async def test_admin_delete_runtime_state_missing_row_is_idempotent(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"delete-missing-{uuid4().hex[:8]}",
        machine_name="Runtime Delete Missing",
        agent_type="openclaw",
    )

    deleted = await admin_client.delete(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
    )

    assert deleted.status_code == 204, deleted.text
    assert deleted.content == b""
    assert await db_session.get(HostedRuntimeState, env.id) is None

    async with await _runtime_client(db_session, seed_user, None) as client:
        audit = await client.get(
            "/v1/audit/events",
            params={
                "resource_type": "hosted_runtime_state",
                "environment_id": str(env.id),
            },
        )
    app.dependency_overrides.clear()

    assert audit.status_code == 200, audit.text
    payload = audit.json()
    assert len(payload["items"]) == 1
    latest = payload["items"][0]
    assert latest["action"] == "hosted_runtime_state.delete"
    assert latest["details"] == {"existed": False}


@pytest.mark.asyncio
async def test_admin_delete_runtime_state_requires_admin_key(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"delete-auth-{uuid4().hex[:8]}",
        machine_name="Runtime Delete Auth",
        agent_type="openclaw",
    )
    await _write_runtime_state(admin_client, str(env.id))

    rejected = await admin_client.delete(f"/v1/admin/environments/{env.id}/runtime-state")

    assert rejected.status_code == 401, rejected.text
    assert await db_session.get(HostedRuntimeState, env.id) is not None


@pytest.mark.asyncio
@pytest.mark.parametrize("resource_name", ["agents", "environments"])
async def test_admin_runtime_state_accepts_matching_optional_owner(
    admin_client,
    db_session,
    seed_user,
    resource_name,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-owner-match-{uuid4().hex[:8]}",
        machine_name="Runtime Owner Match",
        agent_type="openclaw",
    )
    body = _runtime_state_body(
        str(env.id),
        target_clerk_id=seed_user.clerk_id,
    )

    upserted = await admin_client.put(
        f"/v1/admin/{resource_name}/{env.id}/runtime-state",
        headers=_AUTH,
        json=body,
    )
    assert upserted.status_code == 200, upserted.text
    state = await db_session.get(HostedRuntimeState, env.id)
    assert state is not None
    assert state.deployment_id == body["deployment_id"]

    deleted = await admin_client.delete(
        f"/v1/admin/{resource_name}/{env.id}/runtime-state",
        headers=_AUTH,
        params={"target_clerk_id": seed_user.clerk_id},
    )
    assert deleted.status_code == 204, deleted.text
    assert await db_session.get(HostedRuntimeState, env.id) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("resource_name", ["agents", "environments"])
async def test_admin_runtime_state_rejects_mismatched_optional_owner_without_mutating(
    admin_client,
    db_session,
    seed_user,
    resource_name,
):
    other_user = User(
        clerk_id=f"runtime_owner_{uuid4().hex[:12]}",
        email=f"runtime-owner-{uuid4().hex[:8]}@clawdi.local",
        name="Runtime Owner",
    )
    db_session.add(other_user)
    await db_session.commit()
    await db_session.refresh(other_user)
    upsert_env = await create_env_with_project(
        db_session,
        user_id=other_user.id,
        machine_id=f"runtime-upsert-owner-{uuid4().hex[:8]}",
        machine_name="Runtime Upsert Owner",
        agent_type="openclaw",
    )
    delete_env = await create_env_with_project(
        db_session,
        user_id=other_user.id,
        machine_id=f"runtime-delete-owner-{uuid4().hex[:8]}",
        machine_name="Runtime Delete Owner",
        agent_type="openclaw",
    )
    await _write_runtime_state(admin_client, str(delete_env.id))

    upsert_response = await admin_client.put(
        f"/v1/admin/{resource_name}/{upsert_env.id}/runtime-state",
        headers=_AUTH,
        json=_runtime_state_body(
            str(upsert_env.id),
            target_clerk_id=seed_user.clerk_id,
        ),
    )
    assert upsert_response.status_code == 403, upsert_response.text
    assert await db_session.get(HostedRuntimeState, upsert_env.id) is None

    delete_response = await admin_client.delete(
        f"/v1/admin/{resource_name}/{delete_env.id}/runtime-state",
        headers=_AUTH,
        params={"target_clerk_id": seed_user.clerk_id},
    )
    assert delete_response.status_code == 403, delete_response.text
    assert await db_session.get(HostedRuntimeState, delete_env.id) is not None


@pytest.mark.asyncio
async def test_runtime_manifest_generation_advance_changes_etag_and_returns_generation(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"generation-advance-{uuid4().hex[:8]}",
        machine_name="Runtime generation advance",
        agent_type="openclaw",
    )
    initial = await _write_runtime_state(admin_client, str(env.id), generation=7)

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")

    assert response.status_code == 200, response.text
    etag = response.headers["etag"]
    assert response.json()["manifest"]["generation"] == 7

    await _write_runtime_state(admin_client, str(env.id), **{**initial, "generation": 8})

    state = await db_session.get(HostedRuntimeState, env.id)
    assert state is not None
    assert state.generation == 8

    async with await _runtime_client(db_session, seed_user, api_key) as client:
        advanced = await client.get("/v1/runtime/manifest")
        not_modified = await client.get(
            "/v1/runtime/manifest",
            headers={"If-None-Match": etag},
        )
    app.dependency_overrides.clear()

    assert advanced.status_code == 200, advanced.text
    assert advanced.headers["etag"] != etag
    assert advanced.json()["manifest"]["generation"] == 8
    assert not_modified.status_code == 200, not_modified.text
    assert not_modified.headers["etag"] == advanced.headers["etag"]
    assert not_modified.json()["manifest"]["generation"] == 8


def _clear_optional_runtime_state(body: dict, clear_mode: str) -> dict:
    cleared = dict(body)
    if clear_mode == "omitted":
        for field in OPTIONAL_RUNTIME_STATE_FIELDS:
            cleared.pop(field, None)
        return cleared
    for field in OPTIONAL_RUNTIME_STATE_FIELDS:
        cleared[field] = None
    return cleared


@pytest.mark.asyncio
@pytest.mark.parametrize("clear_mode", ["omitted", "null"])
async def test_admin_runtime_state_clears_optional_state(
    admin_client,
    db_session,
    seed_user,
    clear_mode,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"state-preserve-{uuid4().hex[:8]}",
        machine_name="Runtime state preserve",
        agent_type="openclaw",
    )
    initial = await _write_runtime_state(
        admin_client,
        str(env.id),
        egress_engine=TEST_EGRESS_ENGINE_PIN,
        egress_profiles=TEST_EGRESS_PROFILES,
        mcp={"enabled": True},
        tools={"catalog": "clawdi-default"},
    )
    update = _clear_optional_runtime_state({**initial, "generation": 8}, clear_mode)
    response = await admin_client.put(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json=update,
    )

    assert response.status_code == 200, response.text
    state = await db_session.get(HostedRuntimeState, env.id)
    assert state is not None
    assert state.generation == 8
    assert state.egress_engine is None
    assert state.egress_profiles is None
    assert state.mcp is None
    assert state.tools is None


@pytest.mark.asyncio
@pytest.mark.parametrize("clear_mode", ["omitted", "null"])
async def test_equal_generation_optional_state_clear_is_material_conflict(
    admin_client,
    db_session,
    seed_user,
    clear_mode,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"state-clear-conflict-{clear_mode}-{uuid4().hex[:8]}",
        machine_name=f"Runtime state clear conflict {clear_mode}",
        agent_type="openclaw",
    )
    initial = await _write_runtime_state(
        admin_client,
        str(env.id),
        egress_engine=TEST_EGRESS_ENGINE_PIN,
        egress_profiles=TEST_EGRESS_PROFILES,
        mcp={"enabled": True},
        tools={"catalog": "clawdi-default"},
    )
    environment_id = env.id
    candidate = _clear_optional_runtime_state(initial, clear_mode)

    response = await admin_client.put(
        f"/v1/admin/environments/{environment_id}/runtime-state",
        headers=_AUTH,
        json=candidate,
    )

    assert response.status_code == 409, response.text
    assert response.json() == {"detail": {"code": "generation_conflict", "current_generation": 7}}
    state = await db_session.get(HostedRuntimeState, environment_id)
    assert state is not None
    assert state.generation == 7
    assert state.egress_engine == TEST_EGRESS_ENGINE_PIN
    assert state.egress_profiles == TEST_EGRESS_PROFILES
    assert state.mcp == {"enabled": True}
    assert state.tools == {"catalog": "clawdi-default"}


def test_control_plane_audit_sanitizes_auth_cookie_and_credential_keys():
    sanitized = _sanitize_audit_details(
        {
            "authorization": "Bearer secret",
            "cookie": "session=secret",
            "providerCredential": "secret",
            "has_provider_credential": True,
            "pin_code": 123456,
            "nested": {"bearer": "secret"},
        }
    )

    assert sanitized == {
        "authorization": "[REDACTED]",
        "cookie": "[REDACTED]",
        "providerCredential": "[REDACTED]",
        "has_provider_credential": True,
        "pin_code": "[REDACTED]",
        "nested": {"bearer": "[REDACTED]"},
    }


@pytest.mark.asyncio
async def test_runtime_manifest_projects_mcp_and_tools_desired_state(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"mcp-{uuid4().hex[:8]}",
        machine_name="Runtime MCP",
        agent_type="openclaw",
    )
    await _write_runtime_state(
        admin_client,
        str(env.id),
        mcp={"enabled": True, "profile": "clawdi-default"},
        tools={"catalog": "clawdi-default", "enabled": ["memory", "connectors"]},
    )

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    manifest = response.json()["manifest"]
    assert manifest["mcp"] == {"enabled": True, "profile": "clawdi-default"}
    assert manifest["tools"] == {
        "catalog": "clawdi-default",
        "enabled": ["memory", "connectors"],
    }
    assert "channels" not in manifest


@pytest.mark.asyncio
async def test_runtime_manifest_projects_selected_runtime_provider_pool(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"provider-conflict-{uuid4().hex[:8]}",
        machine_name="Runtime provider conflict",
        agent_type="openclaw",
    )
    openclaw_ciphertext, openclaw_nonce = encrypt("sk-openclaw-provider")
    hermes_ciphertext, hermes_nonce = encrypt("sk-hermes-provider")
    db_session.add_all(
        [
            AiProvider(
                owner_user_id=seed_user.id,
                provider_id="openai-managed",
                type="custom_openai_compatible",
                base_url="https://openclaw-provider.test/v1",
                models=[{"id": "gpt-5.5"}],
                api_mode="openai_responses",
                auth_type="api_key",
                auth_metadata={"source": "managed"},
                managed_by="user",
                runtime_env_name="OPENCLAW_PROVIDER_API_KEY",
            ),
            AiProviderAuthPayload(
                owner_user_id=seed_user.id,
                provider_id="openai-managed",
                auth_profile="default",
                kind="api_key",
                source="managed",
                encrypted_payload=openclaw_ciphertext,
                nonce=openclaw_nonce,
            ),
            AiProvider(
                owner_user_id=seed_user.id,
                provider_id="anthropic-managed",
                type="custom_openai_compatible",
                base_url="https://hermes-provider.test/v1",
                models=[{"id": "claude-opus-4-6"}],
                api_mode="openai_chat",
                auth_type="api_key",
                auth_metadata={"source": "managed"},
                managed_by="user",
                runtime_env_name="HERMES_PROVIDER_API_KEY",
            ),
            AiProviderAuthPayload(
                owner_user_id=seed_user.id,
                provider_id="anthropic-managed",
                auth_profile="default",
                kind="api_key",
                source="managed",
                encrypted_payload=hermes_ciphertext,
                nonce=hermes_nonce,
            ),
        ]
    )
    await db_session.commit()
    await _write_runtime_state(
        admin_client,
        str(env.id),
        runtimes=_runtime_state(
            provider_ids=["openai-managed", "anthropic-managed"],
            primary_model={"provider_id": "openai-managed", "model": "gpt-5.5"},
        ),
    )

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    payload = response.json()
    assert "default" not in payload["manifest"]["providers"]
    assert "openclaw" not in payload["manifest"]["providers"]
    assert payload["manifest"]["providers"]["openai-managed"] == {
        "kind": "openai-compatible",
        "type": "custom_openai_compatible",
        "baseUrl": "https://openclaw-provider.test/v1",
        "apiMode": "openai_responses",
        "models": [{"id": "gpt-5.5"}],
        "runtimeEnvName": "OPENCLAW_PROVIDER_API_KEY",
        "apiKeySecretRef": "provider.openai-managed.apiKey",
    }
    assert payload["manifest"]["providers"]["anthropic-managed"] == {
        "kind": "openai-compatible",
        "type": "custom_openai_compatible",
        "baseUrl": "https://hermes-provider.test/v1",
        "apiMode": "openai_chat",
        "models": [{"id": "claude-opus-4-6"}],
        "runtimeEnvName": "HERMES_PROVIDER_API_KEY",
        "apiKeySecretRef": "provider.anthropic-managed.apiKey",
    }
    assert payload["manifest"]["runtimes"]["openclaw"]["provider_ids"] == [
        "openai-managed",
        "anthropic-managed",
    ]
    assert payload["manifest"]["runtimes"]["openclaw"]["primary_model"] == {
        "provider_id": "openai-managed",
        "model": "gpt-5.5",
    }
    assert payload["secretValues"] == {
        "provider.anthropic-managed.apiKey": "sk-hermes-provider",
        "provider.openai-managed.apiKey": "sk-openclaw-provider",
    }


@pytest.mark.asyncio
async def test_runtime_manifest_preserves_non_openai_provider_protocols(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"provider-protocol-{uuid4().hex[:8]}",
        machine_name="Runtime provider protocol",
        agent_type="openclaw",
    )
    anthropic_ciphertext, anthropic_nonce = encrypt("sk-anthropic-provider")
    gemini_ciphertext, gemini_nonce = encrypt("sk-gemini-provider")
    db_session.add_all(
        [
            AiProvider(
                owner_user_id=seed_user.id,
                provider_id="anthropic-byok",
                type="anthropic",
                base_url="https://api.anthropic.com",
                models=[{"id": "claude-opus-4-6"}],
                api_mode="anthropic_messages",
                auth_type="api_key",
                auth_metadata={"source": "managed"},
                managed_by="user",
                runtime_env_name="ANTHROPIC_API_KEY",
            ),
            AiProviderAuthPayload(
                owner_user_id=seed_user.id,
                provider_id="anthropic-byok",
                auth_profile="default",
                kind="api_key",
                source="managed",
                encrypted_payload=anthropic_ciphertext,
                nonce=anthropic_nonce,
            ),
            AiProvider(
                owner_user_id=seed_user.id,
                provider_id="gemini-byok",
                type="gemini",
                base_url="https://generativelanguage.googleapis.com/v1beta",
                models=[{"id": "gemini-2.5-pro"}],
                api_mode="google_generate_content",
                auth_type="api_key",
                auth_metadata={"source": "managed"},
                managed_by="user",
                runtime_env_name="GEMINI_API_KEY",
            ),
            AiProviderAuthPayload(
                owner_user_id=seed_user.id,
                provider_id="gemini-byok",
                auth_profile="default",
                kind="api_key",
                source="managed",
                encrypted_payload=gemini_ciphertext,
                nonce=gemini_nonce,
            ),
        ]
    )
    await db_session.commit()
    await _write_runtime_state(
        admin_client,
        str(env.id),
        runtimes=_runtime_state(
            provider_ids=["anthropic-byok", "gemini-byok"],
            primary_model={
                "provider_id": "anthropic-byok",
                "model": "claude-opus-4-6",
            },
        ),
    )

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["manifest"]["providers"]["anthropic-byok"] == {
        "kind": "openai-compatible",
        "type": "anthropic",
        "baseUrl": "https://api.anthropic.com",
        "apiMode": "anthropic_messages",
        "models": [{"id": "claude-opus-4-6"}],
        "runtimeEnvName": "ANTHROPIC_API_KEY",
        "apiKeySecretRef": "provider.anthropic-byok.apiKey",
    }
    assert payload["manifest"]["providers"]["gemini-byok"] == {
        "kind": "openai-compatible",
        "type": "gemini",
        "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
        "apiMode": "google_generate_content",
        "models": [{"id": "gemini-2.5-pro"}],
        "runtimeEnvName": "GEMINI_API_KEY",
        "apiKeySecretRef": "provider.gemini-byok.apiKey",
    }
    assert payload["manifest"]["runtimes"]["openclaw"]["primary_model"] == {
        "provider_id": "anthropic-byok",
        "model": "claude-opus-4-6",
    }
    assert payload["manifest"]["runtimes"]["openclaw"]["provider_ids"] == [
        "anthropic-byok",
        "gemini-byok",
    ]
    assert payload["secretValues"] == {
        "provider.gemini-byok.apiKey": "sk-gemini-provider",
        "provider.anthropic-byok.apiKey": "sk-anthropic-provider",
    }


@pytest.mark.asyncio
async def test_runtime_manifest_marks_key_required_provider_unhealthy_without_secret(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"provider-missing-key-{uuid4().hex[:8]}",
        machine_name="Runtime provider missing key",
        agent_type="openclaw",
    )
    db_session.add(
        AiProvider(
            owner_user_id=seed_user.id,
            provider_id="missing-key-provider",
            type="anthropic",
            base_url="https://api.anthropic.com",
            models=[{"id": "claude-opus-4-6"}],
            api_mode="anthropic_messages",
            auth_type="api_key",
            auth_metadata={"source": "managed"},
            managed_by="user",
            runtime_env_name="ANTHROPIC_API_KEY",
        )
    )
    await db_session.commit()
    await _write_runtime_state(
        admin_client,
        str(env.id),
        runtimes=_runtime_state(
            provider_ids=["missing-key-provider"],
            primary_model={
                "provider_id": "missing-key-provider",
                "model": "claude-opus-4-6",
            },
        ),
    )

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    body = response.json()
    provider = body["manifest"]["providers"]["missing-key-provider"]
    assert provider == {
        "kind": "openai-compatible",
        "type": "anthropic",
        "baseUrl": "https://api.anthropic.com",
        "apiMode": "anthropic_messages",
        "models": [{"id": "claude-opus-4-6"}],
        "runtimeEnvName": "ANTHROPIC_API_KEY",
        "apiKeyRequired": True,
        "status": "error",
        "error": {
            "code": "provider_secret_unavailable",
            "message": "provider requires an API key but no runtime secret value is available",
        },
    }
    assert "apiKeySecretRef" not in provider
    assert body["manifest"]["runtimes"]["openclaw"]["provider_ids"] == ["missing-key-provider"]
    assert body["manifest"]["runtimes"]["openclaw"]["primary_model"] == {
        "provider_id": "missing-key-provider",
        "model": "claude-opus-4-6",
    }
    assert body["secretValues"] == {}


@pytest.mark.asyncio
async def test_runtime_manifest_does_not_select_secret_without_managed_source(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"provider-missing-source-{uuid4().hex[:8]}",
        machine_name="Runtime provider missing source",
        agent_type="openclaw",
    )
    ciphertext, nonce = encrypt("sk-must-not-project")
    db_session.add_all(
        [
            AiProvider(
                owner_user_id=seed_user.id,
                provider_id="missing-source-provider",
                type="anthropic",
                base_url="https://api.anthropic.com",
                models=[{"id": "claude-opus-4-6"}],
                api_mode="anthropic_messages",
                auth_type="api_key",
                auth_metadata={},
                managed_by="user",
                runtime_env_name="ANTHROPIC_API_KEY",
            ),
            AiProviderAuthPayload(
                owner_user_id=seed_user.id,
                provider_id="missing-source-provider",
                auth_profile="default",
                kind="api_key",
                source="managed",
                encrypted_payload=ciphertext,
                nonce=nonce,
            ),
        ]
    )
    await db_session.commit()
    await _write_runtime_state(
        admin_client,
        str(env.id),
        runtimes=_runtime_state(provider_ids=["missing-source-provider"]),
    )

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    provider = response.json()["manifest"]["providers"]["missing-source-provider"]
    assert provider["status"] == "error"
    assert provider["error"]["code"] == "provider_secret_unavailable"
    assert response.json()["secretValues"] == {}


@pytest.mark.asyncio
async def test_runtime_manifest_marks_explicit_archived_provider_binding_unhealthy(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"archived-provider-{uuid4().hex[:8]}",
        machine_name="Runtime archived provider",
        agent_type="openclaw",
    )
    ciphertext, nonce = encrypt("sk-managed-provider")
    db_session.add_all(
        [
            AiProvider(
                owner_user_id=seed_user.id,
                provider_id="deleted-custom-provider",
                type="custom_openai_compatible",
                base_url="https://deleted-provider.test/v1",
                models=[{"id": "deleted-model"}],
                api_mode="openai_responses",
                auth_type="api_key",
                auth_metadata={"source": "managed"},
                managed_by="user",
                runtime_env_name="DELETED_PROVIDER_API_KEY",
                archived_at=datetime.now(UTC),
            ),
            AiProvider(
                owner_user_id=seed_user.id,
                provider_id="clawdi-managed-v2",
                type="custom_openai_compatible",
                base_url="https://managed-provider.test/v1",
                models=[{"id": "gpt-5.5"}],
                api_mode="openai_responses",
                auth_type="api_key",
                auth_metadata={"source": "managed"},
                managed_by="clawdi",
                runtime_env_name="CLAWDI_MANAGED_OPENAI_API_KEY",
            ),
            AiProviderAuthPayload(
                owner_user_id=seed_user.id,
                provider_id="clawdi-managed-v2",
                auth_profile="default",
                kind="api_key",
                source="managed",
                encrypted_payload=ciphertext,
                nonce=nonce,
            ),
        ]
    )
    await db_session.commit()
    await _write_runtime_state(
        admin_client,
        str(env.id),
        runtimes=_runtime_state(provider_ids=["deleted-custom-provider"]),
    )

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["manifest"]["providers"]["deleted-custom-provider"] == {
        "kind": "openai-compatible",
        "status": "error",
        "error": {
            "code": "provider_not_found",
            "message": "provider required by openclaw is missing or archived",
        },
    }
    assert payload["manifest"]["runtimes"]["openclaw"]["provider_ids"] == [
        "deleted-custom-provider"
    ]
    assert payload["manifest"]["runtimes"]["openclaw"]["primary_model"] == {
        "provider_id": "deleted-custom-provider",
        "model": "gpt-5.5",
    }
    assert payload["secretValues"] == {}


@pytest.mark.asyncio
async def test_admin_runtime_state_rejects_top_level_provider_binding(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"state-provider-{uuid4().hex[:8]}",
        machine_name="Runtime state provider",
        agent_type="openclaw",
    )
    body = {
        "deployment_id": f"dep_{uuid4().hex}",
        "instance_id": f"hri_{uuid4().hex}",
        "generation": 7,
        "provider_id": "clawdi-managed-v2",
        "locale": TEST_LOCALE,
        "system": TEST_SYSTEM,
        "runtimes": _runtime_state(),
    }

    response = await admin_client.put(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json=body,
    )

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("app_id", "app-test"),
        ("channels", {}),
        ("providers", {}),
        ("secretValues", {}),
    ],
)
async def test_admin_runtime_state_rejects_legacy_top_level_fields(
    admin_client,
    db_session,
    seed_user,
    field,
    value,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"legacy-{uuid4().hex[:8]}",
        machine_name="Runtime legacy field",
        agent_type="openclaw",
    )
    body = _runtime_state_body(str(env.id), **{field: value})

    response = await admin_client.put(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json=body,
    )

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("egress_engine", {**TEST_EGRESS_ENGINE_PIN, "sha256": "not-a-sha256"}),
        ("egress_engine", {**TEST_EGRESS_ENGINE_PIN, "unexpected": True}),
        *[
            ("egress_engine", {**TEST_EGRESS_ENGINE_PIN, "url": url})
            for url in TEST_INVALID_EGRESS_ENGINE_URLS
        ],
        ("egress_profiles", {**TEST_EGRESS_PROFILES, "unexpected": True}),
        (
            "egress_profiles",
            {
                "profiles": [
                    {
                        **TEST_EGRESS_PROFILES["profiles"][0],
                        "rewrite": {"preservePath": True, "unexpected": True},
                    }
                ]
            },
        ),
        (
            "egress_profiles",
            {
                "profiles": [
                    {
                        **TEST_EGRESS_PROFILES["profiles"][0],
                        "priority": True,
                    }
                ]
            },
        ),
        (
            "egress_profiles",
            {
                "profiles": [
                    {
                        **TEST_EGRESS_PROFILES["profiles"][0],
                        "priority": "100",
                    }
                ]
            },
        ),
        (
            "egress_profiles",
            {
                "profiles": [
                    {
                        **TEST_EGRESS_PROFILES["profiles"][0],
                        "enabled": "true",
                    }
                ]
            },
        ),
        (
            "egress_profiles",
            {
                "profiles": [
                    {
                        **TEST_EGRESS_PROFILES["profiles"][0],
                        "owner": None,
                    }
                ]
            },
        ),
    ],
)
async def test_admin_runtime_state_rejects_invalid_egress_contract(
    admin_client,
    db_session,
    seed_user,
    field,
    value,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"egress-invalid-{uuid4().hex[:8]}",
        machine_name="Runtime invalid egress",
        agent_type="openclaw",
    )

    response = await admin_client.put(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json=_runtime_state_body(str(env.id), **{field: value}),
    )

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("runtime", "bridge"),
    [
        ("hermes", None),
        ("hermes", TEST_OPENCLAW_BRIDGE),
        ("openclaw", TEST_HERMES_BRIDGE),
        (
            "openclaw",
            {
                "surfaces": [
                    {
                        key: value
                        for key, value in TEST_OPENCLAW_BRIDGE["surfaces"][0].items()
                        if key != "upstreamHost"
                    }
                ]
            },
        ),
    ],
)
async def test_admin_runtime_state_rejects_runtime_bridge_mismatch(
    admin_client,
    db_session,
    seed_user,
    runtime,
    bridge,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"bridge-mismatch-{runtime}-{uuid4().hex[:8]}",
        machine_name=f"Runtime bridge mismatch {runtime}",
        agent_type=runtime,
    )
    body = _runtime_state_body(
        str(env.id),
        runtimes=_runtime_state(runtime),
        bridge=bridge,
        live_sync=_live_sync(str(env.id), runtime),
    )

    response = await admin_client.put(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json=body,
    )

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bridge",
    [
        {
            "surfaces": [
                {
                    "name": "openclaw",
                    "kind": "shell",
                    "listenPort": 28789,
                    "upstreamPort": 18789,
                }
            ]
        },
        {
            "surfaces": [
                {
                    "name": "OpenClaw",
                    "kind": "control-ui",
                    "listenPort": 28789,
                    "upstreamPort": 18789,
                }
            ]
        },
        {
            "surfaces": [
                {
                    "name": "openclaw",
                    "kind": "control-ui",
                    "listenPort": 0,
                    "upstreamPort": 18789,
                }
            ]
        },
        {
            "surfaces": [
                {
                    "name": "openclaw",
                    "kind": "control-ui",
                    "listenPort": 28789,
                    "upstreamPort": 18789,
                    "token": "must-not-be-here",
                }
            ]
        },
        {
            "surfaces": [
                {
                    **TEST_OPENCLAW_BRIDGE["surfaces"][0],
                    "listenPort": "28789",
                }
            ]
        },
    ],
)
async def test_admin_runtime_state_rejects_invalid_bridge_surfaces(
    admin_client,
    db_session,
    seed_user,
    bridge,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"bridge-invalid-{uuid4().hex[:8]}",
        machine_name="Runtime invalid bridge",
        agent_type="openclaw",
    )
    body = {
        "deployment_id": f"dep_{uuid4().hex}",
        "instance_id": f"hri_{uuid4().hex}",
        "generation": 7,
        "locale": TEST_LOCALE,
        "system": TEST_SYSTEM,
        "runtimes": _runtime_state(),
        "bridge": bridge,
    }

    response = await admin_client.put(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json=body,
    )

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("mcp", {"headers": {"authorization": "Bearer secret"}}),
        ("tools", {"connectors": [{"apiKey": "secret"}]}),
    ],
)
async def test_admin_runtime_state_rejects_mcp_tool_plaintext_secrets(
    admin_client,
    db_session,
    seed_user,
    field,
    value,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"mcp-secret-{uuid4().hex[:8]}",
        machine_name="Runtime MCP secret",
        agent_type="openclaw",
    )
    body = {
        "deployment_id": f"dep_{uuid4().hex}",
        "instance_id": f"hri_{uuid4().hex}",
        "generation": 7,
        "locale": TEST_LOCALE,
        "system": TEST_SYSTEM,
        "runtimes": _runtime_state(),
        field: value,
    }

    response = await admin_client.put(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json=body,
    )

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_admin_runtime_state_rejects_nested_runtime_channels(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"nested-{uuid4().hex[:8]}",
        machine_name="Runtime nested legacy field",
        agent_type="openclaw",
    )
    body = {
        "deployment_id": f"dep_{uuid4().hex}",
        "instance_id": f"hri_{uuid4().hex}",
        "generation": 7,
        "locale": TEST_LOCALE,
        "system": TEST_SYSTEM,
        "runtimes": {
            **_runtime_state(),
            "channels": {},
        },
    }

    response = await admin_client.put(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json=body,
    )

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "runtimes",
    [
        {},
        {"openclaw": {"enabled": False}},
        {
            "openclaw": {"enabled": True},
            "hermes": {"enabled": False},
        },
        {
            "openclaw": {"enabled": True},
            "hermes": {"enabled": True},
        },
    ],
)
async def test_admin_runtime_state_requires_exactly_one_enabled_runtime(
    admin_client,
    db_session,
    seed_user,
    runtimes,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-selection-{uuid4().hex[:8]}",
        machine_name="Runtime selection invalid",
        agent_type="openclaw",
    )
    response = await admin_client.put(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json={
            "deployment_id": f"dep_{uuid4().hex}",
            "instance_id": f"hri_{uuid4().hex}",
            "generation": 7,
            "locale": TEST_LOCALE,
            "system": TEST_SYSTEM,
            "runtimes": runtimes,
        },
    )

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_admin_runtime_state_rejects_unknown_runtime_names(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"unknown-runtime-{uuid4().hex[:8]}",
        machine_name="Runtime unknown name",
        agent_type="openclaw",
    )
    body = {
        "deployment_id": f"dep_{uuid4().hex}",
        "instance_id": f"hri_{uuid4().hex}",
        "generation": 7,
        "locale": TEST_LOCALE,
        "system": TEST_SYSTEM,
        "runtimes": {
            **_runtime_state(),
            "claude_code": next(iter(_runtime_state().values())),
        },
    }

    response = await admin_client.put(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json=body,
    )

    assert response.status_code == 422, response.text
    assert "unsupported runtime desired state" in response.text


@pytest.mark.asyncio
async def test_runtime_manifest_requires_exact_v2_media_type(admin_client, db_session, seed_user):
    env, _, _, _, _ = await _create_bundle_runtime(admin_client, db_session, seed_user)
    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="bundle")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        missing_accept = await client.get("/v1/runtime/manifest", headers={"Accept": "*/*"})
        bundle = await client.get("/v1/runtime/manifest")
        bundle_not_modified = await client.get(
            "/v1/runtime/manifest",
            headers={
                "Accept": RUNTIME_BUNDLE_V2_MEDIA_TYPE,
                "If-None-Match": bundle.headers["etag"],
            },
        )
        unsupported = await client.get(
            "/v1/runtime/manifest",
            headers={"Accept": "application/vnd.clawdi.runtime-bundle.v3+json"},
        )
    app.dependency_overrides.clear()
    assert missing_accept.status_code == 406
    assert missing_accept.headers["cache-control"] == "no-store"
    assert missing_accept.headers["vary"] == "Accept"
    body = bundle.json()
    assert bundle.status_code == 200
    assert set(body) == {
        "schemaVersion",
        "sourceRevision",
        "manifest",
        "channelBindings",
        "secretValues",
    }
    assert body["schemaVersion"] == "clawdi.hosted-runtime.bundle.v2"
    assert set(body["channelBindings"][0]) == {
        "provider",
        "accountKey",
        "agentTokenSecretRef",
        "placeholderTokenSecretRef",
    }
    assert bundle.headers["content-type"] == RUNTIME_BUNDLE_V2_MEDIA_TYPE
    assert bundle.headers["vary"] == "Accept"
    assert bundle.headers["etag"] == expected_runtime_bundle_v2_etag(body["sourceRevision"])
    assert bundle_not_modified.status_code == 304
    assert bundle_not_modified.headers["etag"] == bundle.headers["etag"]
    assert bundle_not_modified.headers["vary"] == "Accept"
    assert unsupported.status_code == 406
    assert unsupported.headers["cache-control"] == "no-store"
    assert unsupported.headers["vary"] == "Accept"


@pytest.mark.asyncio
async def test_runtime_bundle_revision_tracks_projected_and_secret_changes_only(
    admin_client, db_session, seed_user
):
    env, provider, payload, account, _ = await _create_bundle_runtime(
        admin_client, db_session, seed_user
    )
    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="bundle")

    async def fetch(client):
        response = await client.get(
            "/v1/runtime/manifest", headers={"Accept": RUNTIME_BUNDLE_V2_MEDIA_TYPE}
        )
        assert response.status_code == 200, response.text
        return response

    async with await _runtime_client(db_session, seed_user, api_key) as client:
        initial = await fetch(client)
        provider.label = "Renamed provider"
        provider.capabilities = {"irrelevant": True}
        account.name = "Renamed channel"
        await db_session.commit()
        irrelevant = await fetch(client)
        provider.base_url = "https://rotated-provider.test/v1"
        await db_session.commit()
        projected = await fetch(client)
        payload.encrypted_payload, payload.nonce = encrypt("sk-rotated-bundle-provider")
        await db_session.commit()
        key_rotated = await fetch(client)
        second_account = ChannelAccount(
            user_id=seed_user.id,
            provider="discord",
            name="Bundle Discord",
            status="active",
            visibility="private",
            webhook_secret_hash="discord-hash",
        )
        db_session.add(second_account)
        await db_session.flush()
        token_ciphertext, token_nonce = encrypt("discord-agent-token")
        second_link = ChannelBotAgentLink(
            account_id=second_account.id,
            user_id=seed_user.id,
            agent_id=env.id,
            status="active",
            encrypted_agent_token=token_ciphertext,
            agent_token_nonce=token_nonce,
        )
        db_session.add(second_link)
        await db_session.commit()
        channel_added = await fetch(client)
        second_link.status = "archived"
        second_link.archived_at = datetime.now(UTC)
        await db_session.commit()
        channel_removed = await fetch(client)
    app.dependency_overrides.clear()

    def identity(response):
        return response.json()["sourceRevision"], response.headers["etag"]

    assert identity(irrelevant) == identity(initial)
    assert identity(projected) != identity(initial)
    assert identity(key_rotated) != identity(projected)
    assert identity(channel_added) != identity(key_rotated)
    assert identity(channel_removed) == identity(key_rotated)


@pytest.mark.asyncio
async def test_runtime_bundle_missing_token_fails_closed_and_query_count_is_constant(
    admin_client, db_session, seed_user
):
    env, _, _, _, link = await _create_bundle_runtime(admin_client, db_session, seed_user)
    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="bundle")
    engine = db_session.bind.sync_engine
    select_count = 0

    def count_selects(_connection, _cursor, statement, _parameters, _context, _many):
        nonlocal select_count
        if statement.lstrip().upper().startswith("SELECT"):
            select_count += 1

    event.listen(engine, "before_cursor_execute", count_selects)
    try:
        async with await _runtime_client(db_session, seed_user, api_key) as client:
            select_count = 0
            healthy = await client.get(
                "/v1/runtime/manifest", headers={"Accept": RUNTIME_BUNDLE_V2_MEDIA_TYPE}
            )
            healthy_query_count = select_count
            link.encrypted_agent_token = None
            link.agent_token_nonce = None
            await db_session.commit()
            missing = await client.get(
                "/v1/runtime/manifest", headers={"Accept": RUNTIME_BUNDLE_V2_MEDIA_TYPE}
            )
            wrong_media_type = await client.get(
                "/v1/runtime/manifest", headers={"Accept": "application/json"}
            )
    finally:
        event.remove(engine, "before_cursor_execute", count_selects)
        app.dependency_overrides.clear()
    assert healthy.status_code == 200
    assert healthy_query_count == 4
    assert missing.status_code == 409
    assert missing.json() == {"detail": "Active runtime channel link has no token material"}
    assert wrong_media_type.status_code == 406


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "runtimes",
    [
        {},
        {
            **_runtime_state("openclaw"),
            **_runtime_state("hermes"),
        },
    ],
)
async def test_runtime_manifest_rejects_state_without_exactly_one_enabled_runtime(
    db_session,
    seed_user,
    runtimes,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"manifest-runtime-selection-{uuid4().hex[:8]}",
        machine_name="Manifest runtime selection invalid",
        agent_type="openclaw",
    )
    db_session.add(
        HostedRuntimeState(
            environment_id=env.id,
            deployment_id=f"dep_{uuid4().hex}",
            instance_id=f"hri_{uuid4().hex}",
            generation=7,
            cli_package_spec=TEST_CLI_PACKAGE_SPEC,
            locale=TEST_LOCALE,
            system=TEST_SYSTEM,
            runtimes=runtimes,
            live_sync=_live_sync(str(env.id)),
            recovery={"cacheManifest": True, "allowOfflineBoot": True},
        )
    )
    await db_session.commit()

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 409, response.text
    assert response.json() == {
        "detail": "hosted runtime state must select exactly one enabled runtime"
    }


@pytest.mark.asyncio
async def test_runtime_manifest_rejects_unknown_enabled_runtime_state(
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"manifest-unknown-runtime-{uuid4().hex[:8]}",
        machine_name="Manifest unknown runtime",
        agent_type="openclaw",
    )
    db_session.add(
        HostedRuntimeState(
            environment_id=env.id,
            deployment_id=f"dep_{uuid4().hex}",
            instance_id=f"hri_{uuid4().hex}",
            generation=7,
            cli_package_spec=TEST_CLI_PACKAGE_SPEC,
            locale=TEST_LOCALE,
            runtimes={
                "claude_code": next(iter(_runtime_state().values())),
            },
            system=TEST_SYSTEM,
            live_sync=_live_sync(str(env.id)),
            recovery={"cacheManifest": True, "allowOfflineBoot": True},
            egress_profiles=None,
            mcp=None,
            tools=None,
        )
    )
    await db_session.commit()

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 409, response.text
    assert response.json() == {"detail": "unsupported enabled runtime: claude_code"}


@pytest.mark.asyncio
async def test_runtime_manifest_rejects_codex_selected_runtime_state(
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"manifest-codex-runtime-{uuid4().hex[:8]}",
        machine_name="Manifest codex runtime",
        agent_type="codex",
    )
    db_session.add(
        HostedRuntimeState(
            environment_id=env.id,
            deployment_id=f"dep_{uuid4().hex}",
            instance_id=f"hri_{uuid4().hex}",
            generation=7,
            cli_package_spec=TEST_CLI_PACKAGE_SPEC,
            locale=TEST_LOCALE,
            runtimes={"codex": next(iter(_runtime_state(provider_ids=["openai-codex"]).values()))},
            system=TEST_SYSTEM,
            live_sync=_live_sync(str(env.id), "codex"),
            recovery={"cacheManifest": True, "allowOfflineBoot": True},
        )
    )
    await db_session.commit()

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 409, response.text
    assert response.json() == {"detail": "unsupported enabled runtime: codex"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "control_plane",
    [
        {"cloudApiUrl": "https://cloud-api.test"},
        {"manifestUrl": "https://cloud-api.test/v1/runtime/manifest"},
        {"apiUrl": "https://cloud-api.test"},
        {"unknown": "https://cloud-api.test"},
    ],
)
async def test_admin_runtime_state_rejects_hosted_control_plane_authority(
    admin_client,
    db_session,
    seed_user,
    control_plane,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"control-{uuid4().hex[:8]}",
        machine_name="Runtime control plane legacy field",
        agent_type="openclaw",
    )
    body = {
        "deployment_id": f"dep_{uuid4().hex}",
        "instance_id": f"hri_{uuid4().hex}",
        "generation": 7,
        "locale": TEST_LOCALE,
        "system": TEST_SYSTEM,
        "control_plane": control_plane,
        "runtimes": _runtime_state(),
    }

    response = await admin_client.put(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json=body,
    )

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_runtime_manifest_requires_environment_bound_cli_key(client):
    clerk_response = await client.get("/v1/runtime/manifest")
    assert clerk_response.status_code == 403


@pytest.mark.asyncio
async def test_runtime_manifest_rejects_unbound_cli_key(db_session, seed_user):
    api_key = ApiKey(user_id=seed_user.id, label="unbound")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_runtime_manifest_allows_unbound_cli_key_with_explicit_environment_id(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-unbound-{uuid4().hex[:8]}",
        machine_name="Runtime Unbound",
        agent_type="openclaw",
    )
    await _write_runtime_state(admin_client, str(env.id))

    api_key = ApiKey(user_id=seed_user.id, label="unbound")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get(
            "/v1/runtime/manifest",
            params={"environment_id": str(env.id)},
        )
    app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    assert response.json()["manifest"]["environmentId"] == str(env.id)


@pytest.mark.asyncio
async def test_runtime_manifest_rejects_unbound_cli_key_for_other_user_environment(
    admin_client,
    db_session,
    seed_user,
):
    other_user = User(
        clerk_id=f"runtime_other_{uuid4().hex[:12]}",
        email=f"runtime-other-{uuid4().hex[:8]}@clawdi.local",
        name="Runtime Other User",
    )
    db_session.add(other_user)
    await db_session.flush()
    other_env = await create_env_with_project(
        db_session,
        user_id=other_user.id,
        machine_id=f"runtime-cross-user-{uuid4().hex[:8]}",
        machine_name="Runtime Cross User",
        agent_type="openclaw",
    )
    await _write_runtime_state(admin_client, str(other_env.id))

    api_key = ApiKey(user_id=seed_user.id, label="unbound")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get(
            "/v1/runtime/manifest",
            params={"environment_id": str(other_env.id)},
        )
    app.dependency_overrides.clear()

    assert response.status_code == 404, response.text
    assert response.json() == {"detail": "Agent environment not found"}


@pytest.mark.asyncio
async def test_runtime_manifest_rejects_bound_cli_key_environment_id_mismatch(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-bound-{uuid4().hex[:8]}",
        machine_name="Runtime Bound",
        agent_type="openclaw",
    )
    other_env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-other-{uuid4().hex[:8]}",
        machine_name="Runtime Other",
        agent_type="codex",
    )
    await _write_runtime_state(admin_client, str(env.id))
    await _write_runtime_state(admin_client, str(other_env.id))

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="bound")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get(
            "/v1/runtime/manifest",
            params={"environment_id": str(other_env.id)},
        )
    app.dependency_overrides.clear()

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_runtime_manifest_projects_provider_secret_values_for_managed_account_key(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"provider-{uuid4().hex[:8]}",
        machine_name="Runtime Provider",
        agent_type="openclaw",
    )
    ciphertext, nonce = encrypt("sk-test-provider")
    managed_models = [
        {
            "id": "gpt-5.5",
            "context_window": 272000,
            "max_tokens": 128000,
            "input_modalities": ["text", "image"],
            "supports_vision": True,
            "supports_tools": True,
            "supports_reasoning": True,
        }
    ]
    provider = AiProvider(
        owner_user_id=seed_user.id,
        provider_id="clawdi-managed-v2",
        type="custom_openai_compatible",
        base_url="https://sub2api.test/v1",
        models=managed_models,
        # Simulate a stale v2 managed provider row from before the chat-completions contract.
        api_mode="openai_responses",
        auth_type="api_key",
        auth_metadata={"source": "managed"},
        managed_by="clawdi",
        runtime_env_name="CLAWDI_MANAGED_OPENAI_API_KEY",
    )
    db_session.add(provider)
    db_session.add(
        AiProviderAuthPayload(
            owner_user_id=seed_user.id,
            provider_id="clawdi-managed-v2",
            auth_profile="default",
            kind="api_key",
            source="managed",
            encrypted_payload=ciphertext,
            nonce=nonce,
        )
    )
    await db_session.commit()
    await _write_runtime_state(admin_client, str(env.id))

    api_key = ApiKey(user_id=seed_user.id, environment_id=None, managed=True, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get(
            "/v1/runtime/manifest",
            params={"environment_id": str(env.id)},
        )
    app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    payload = response.json()
    issued_at = payload["manifest"]["issuedAt"]
    assert payload["manifest"]["providers"]["clawdi-managed-v2"] == {
        "kind": "openai-compatible",
        "type": "custom_openai_compatible",
        "baseUrl": "https://sub2api.test/v1",
        "apiMode": "openai_chat",
        "managed_by": "clawdi",
        "models": managed_models,
        "runtimeEnvName": "OPENAI_API_KEY",
        "apiKeySecretRef": "provider.clawdi-managed-v2.apiKey",
    }
    assert payload["manifest"]["runtimes"]["openclaw"]["provider_ids"] == ["clawdi-managed-v2"]
    assert payload["manifest"]["runtimes"]["openclaw"]["primary_model"] == {
        "provider_id": "clawdi-managed-v2",
        "model": "gpt-5.5",
    }
    assert payload["secretValues"] == {"provider.clawdi-managed-v2.apiKey": "sk-test-provider"}
    etag = response.headers["etag"]

    provider.label = "Presentation-only label"
    await db_session.commit()

    async with await _runtime_client(db_session, seed_user, api_key) as client:
        presentation_only = await client.get(
            "/v1/runtime/manifest",
            params={"environment_id": str(env.id)},
            headers={"If-None-Match": etag},
        )
    app.dependency_overrides.clear()

    assert presentation_only.status_code == 304, presentation_only.text
    assert presentation_only.headers["etag"] == etag

    ciphertext, nonce = encrypt("sk-rotated-provider")
    provider_payload = (
        await db_session.execute(
            AiProviderAuthPayload.__table__.select().where(
                AiProviderAuthPayload.owner_user_id == seed_user.id,
                AiProviderAuthPayload.provider_id == "clawdi-managed-v2",
            )
        )
    ).first()
    assert provider_payload is not None
    await db_session.execute(
        AiProviderAuthPayload.__table__.update()
        .where(
            AiProviderAuthPayload.owner_user_id == seed_user.id,
            AiProviderAuthPayload.provider_id == "clawdi-managed-v2",
        )
        .values(encrypted_payload=ciphertext, nonce=nonce)
    )
    await db_session.commit()

    async with await _runtime_client(db_session, seed_user, api_key) as client:
        rotated = await client.get(
            "/v1/runtime/manifest",
            params={"environment_id": str(env.id)},
            headers={"If-None-Match": etag},
        )
    app.dependency_overrides.clear()

    assert rotated.status_code == 200, rotated.text
    assert rotated.headers["etag"] != etag
    assert rotated.headers["etag"] == expected_runtime_bundle_v2_etag(
        rotated.json()["sourceRevision"]
    )
    assert rotated.json()["manifest"]["issuedAt"] == issued_at
    assert rotated.json()["secretValues"] == {
        "provider.clawdi-managed-v2.apiKey": "sk-rotated-provider"
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("active_profile", ["default", "work_team"])
async def test_runtime_manifest_selects_managed_provider_secret_by_auth_profile(
    admin_client,
    db_session,
    seed_user,
    active_profile: str,
):
    provider_id = f"profile-{active_profile.replace('_', '-')}"
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"provider-profile-{uuid4().hex[:8]}",
        machine_name="Runtime Provider Profile",
        agent_type="openclaw",
    )
    default_ciphertext, default_nonce = encrypt("sk-default-profile")
    work_ciphertext, work_nonce = encrypt("sk-work-profile")
    db_session.add_all(
        [
            AiProvider(
                owner_user_id=seed_user.id,
                provider_id=provider_id,
                type="custom_openai_compatible",
                base_url="https://profile-provider.test/v1",
                models=[{"id": "gpt-5.5"}],
                api_mode="openai_chat",
                auth_type="api_key",
                auth_metadata={"source": "managed", "profile": active_profile},
                managed_by="user",
                runtime_env_name="PROFILE_PROVIDER_API_KEY",
            ),
            AiProviderAuthPayload(
                owner_user_id=seed_user.id,
                provider_id=provider_id,
                auth_profile="default",
                kind="api_key",
                source="managed",
                encrypted_payload=default_ciphertext,
                nonce=default_nonce,
            ),
            AiProviderAuthPayload(
                owner_user_id=seed_user.id,
                provider_id=provider_id,
                auth_profile="work_team",
                kind="api_key",
                source="managed",
                encrypted_payload=work_ciphertext,
                nonce=work_nonce,
            ),
        ]
    )
    await db_session.commit()
    await _write_runtime_state(
        admin_client,
        str(env.id),
        runtimes=_runtime_state(provider_ids=[provider_id]),
    )

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    expected_secret = "sk-default-profile" if active_profile == "default" else "sk-work-profile"
    assert response.json()["secretValues"] == {f"provider.{provider_id}.apiKey": expected_secret}


@pytest.mark.asyncio
async def test_admin_managed_provider_models_project_exact_hosted_wire_contract(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"provider-full-model-{uuid4().hex[:8]}",
        machine_name="Runtime Provider Full Model",
        agent_type="openclaw",
    )
    model = {
        "id": "gpt-5.5",
        "label": "GPT 5.5",
        "alias": "gpt-stable",
        "api_mode": "openai_responses",
        "input_modalities": ["text", "image", "video", "audio"],
        "supports_vision": True,
        "supports_tools": True,
        "supports_reasoning": False,
        "context_window": 272000,
        "max_tokens": 128000,
        "cost": {"input": 1, "output": 2, "cache_read": 0.1, "cache_write": 0.2},
        "capabilities": {
            "chat": True,
            "responses": True,
            "tools": True,
            "vision": True,
            "embeddings": False,
            "image_generation": False,
        },
    }
    upsert = await admin_client.put(
        "/v1/admin/ai-providers/clawdi-managed-v2",
        headers=_AUTH,
        json={
            "target_clerk_id": seed_user.clerk_id,
            "base_url": "https://sub2api.test/v1",
            "api_key": "sk-complete-provider",
            "models": [model],
        },
    )
    assert upsert.status_code == 200, upsert.text
    await _write_runtime_state(admin_client, str(env.id))

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    projected_model = response.json()["manifest"]["providers"]["clawdi-managed-v2"]["models"][0]
    assert projected_model == model
    assert set(projected_model) == {
        "id",
        "label",
        "alias",
        "api_mode",
        "input_modalities",
        "supports_vision",
        "supports_tools",
        "supports_reasoning",
        "context_window",
        "max_tokens",
        "cost",
        "capabilities",
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "stored_models",
    [
        [
            {
                "id": "gpt-5.5",
                "context_window": 0,
                "capabilities": {"audio": True},
                "cost": {"input": 1, "output": 2, "currency": "USD"},
            }
        ],
        {},
    ],
    ids=["invalid-model-fields", "invalid-top-level-object"],
)
async def test_runtime_manifest_rejects_invalid_stored_provider_model_metadata(
    admin_client,
    db_session,
    seed_user,
    stored_models,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"provider-invalid-stored-model-{uuid4().hex[:8]}",
        machine_name="Runtime Provider Invalid Stored Model",
        agent_type="openclaw",
    )
    db_session.add(
        AiProvider(
            owner_user_id=seed_user.id,
            provider_id="clawdi-managed-v2",
            type="custom_openai_compatible",
            base_url="https://sub2api.test/v1",
            models=stored_models,
            api_mode="openai_chat",
            auth_type="none",
            managed_by="clawdi",
            runtime_env_name="CLAWDI_MANAGED_OPENAI_API_KEY",
        )
    )
    await db_session.commit()
    await _write_runtime_state(admin_client, str(env.id))

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 409, response.text
    assert response.json() == {"detail": "Stored AI provider model metadata is invalid"}


@pytest.mark.asyncio
async def test_runtime_manifest_projects_legacy_managed_provider_as_responses(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"legacy-provider-{uuid4().hex[:8]}",
        machine_name="Runtime Legacy Provider",
        agent_type="openclaw",
    )
    ciphertext, nonce = encrypt("sk-test-legacy-provider")
    db_session.add(
        AiProvider(
            owner_user_id=seed_user.id,
            provider_id="clawdi-managed",
            type="custom_openai_compatible",
            base_url="https://sub2api.test/v1",
            models=[{"id": "openai-codex/gpt-5.5"}],
            api_mode="openai_responses",
            auth_type="api_key",
            auth_metadata={"source": "managed"},
            managed_by="clawdi",
            runtime_env_name="CLAWDI_MANAGED_OPENAI_API_KEY",
        )
    )
    db_session.add(
        AiProviderAuthPayload(
            owner_user_id=seed_user.id,
            provider_id="clawdi-managed",
            auth_profile="default",
            kind="api_key",
            source="managed",
            encrypted_payload=ciphertext,
            nonce=nonce,
        )
    )
    await db_session.commit()
    await _write_runtime_state(
        admin_client,
        str(env.id),
        runtimes=_runtime_state(
            provider_ids=["clawdi-managed"],
            primary_model={
                "provider_id": "clawdi-managed",
                "model": "openai-codex/gpt-5.5",
            },
        ),
    )

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["manifest"]["providers"]["clawdi-managed"] == {
        "kind": "openai-compatible",
        "type": "custom_openai_compatible",
        "baseUrl": "https://sub2api.test/v1",
        "apiMode": "openai_responses",
        "managed_by": "clawdi",
        "models": [{"id": "openai-codex/gpt-5.5"}],
        "runtimeEnvName": "OPENAI_API_KEY",
        "apiKeySecretRef": "provider.clawdi-managed.apiKey",
    }
    assert payload["manifest"]["runtimes"]["openclaw"]["primary_model"] == {
        "provider_id": "clawdi-managed",
        "model": "openai-codex/gpt-5.5",
    }
    assert payload["secretValues"] == {"provider.clawdi-managed.apiKey": "sk-test-legacy-provider"}


@pytest.mark.asyncio
async def test_runtime_manifest_uses_structured_primary_model_without_catalog_model(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-model-{uuid4().hex[:8]}",
        machine_name="Runtime Model Provider",
        agent_type="openclaw",
    )
    ciphertext, nonce = encrypt("sk-user-provider")
    db_session.add(
        AiProvider(
            owner_user_id=seed_user.id,
            provider_id="custom-openai",
            type="custom_openai_compatible",
            base_url="https://provider.test/v1",
            api_mode="openai_responses",
            auth_type="api_key",
            auth_metadata={"source": "managed"},
            managed_by="user",
            runtime_env_name="CUSTOM_OPENAI_API_KEY",
        )
    )
    db_session.add(
        AiProviderAuthPayload(
            owner_user_id=seed_user.id,
            provider_id="custom-openai",
            auth_profile="default",
            kind="api_key",
            source="managed",
            encrypted_payload=ciphertext,
            nonce=nonce,
        )
    )
    await db_session.commit()
    await _write_runtime_state(
        admin_client,
        str(env.id),
        runtimes=_runtime_state(
            provider_ids=["custom-openai"],
            primary_model={
                "provider_id": "custom-openai",
                "model": "gpt-5.5",
            },
        ),
    )

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["manifest"]["providers"]["custom-openai"] == {
        "kind": "openai-compatible",
        "type": "custom_openai_compatible",
        "baseUrl": "https://provider.test/v1",
        "apiMode": "openai_responses",
        "runtimeEnvName": "CUSTOM_OPENAI_API_KEY",
        "apiKeySecretRef": "provider.custom-openai.apiKey",
    }
    assert "models" not in payload["manifest"]["providers"]["custom-openai"]
    assert payload["manifest"]["runtimes"]["openclaw"]["primary_model"] == {
        "provider_id": "custom-openai",
        "model": "gpt-5.5",
    }


@pytest.mark.asyncio
async def test_runtime_manifest_projects_codex_agent_profile_auth(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-codex-oauth-{uuid4().hex[:8]}",
        machine_name="Runtime Codex OAuth Provider",
        agent_type="openclaw",
    )
    db_session.add(
        AiProvider(
            owner_user_id=seed_user.id,
            provider_id="openai-codex",
            type="openai",
            base_url="https://api.openai.com/v1",
            models=[{"id": "gpt-5.5"}],
            api_mode="openai_responses",
            auth_type="agent_profile",
            auth_metadata={"tool": "codex", "profile": "default"},
            managed_by="user",
            runtime_env_name=None,
        )
    )
    await db_session.commit()
    await _write_runtime_state(
        admin_client,
        str(env.id),
        runtimes=_runtime_state(
            provider_ids=["openai-codex"],
            primary_model={
                "provider_id": "openai-codex",
                "model": "gpt-5.5",
            },
        ),
    )

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["manifest"]["providers"]["openai-codex"] == {
        "kind": "openai-compatible",
        "type": "openai",
        "baseUrl": "https://api.openai.com/v1",
        "apiMode": "openai_responses",
        "models": [{"id": "gpt-5.5"}],
        "auth": {
            "type": "agent_profile",
            "tool": "codex",
            "profile": "default",
        },
    }
    assert payload["manifest"]["runtimes"]["openclaw"]["primary_model"] == {
        "provider_id": "openai-codex",
        "model": "gpt-5.5",
    }
    assert response.json()["secretValues"] == {}


@pytest.mark.asyncio
async def test_admin_runtime_state_rejects_codex_hosted_runtime(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"codex-hosted-{uuid4().hex[:8]}",
        machine_name="Codex hosted unsupported",
        agent_type="codex",
    )
    body = {
        "deployment_id": f"dep_{uuid4().hex}",
        "instance_id": f"hri_{uuid4().hex}",
        "generation": 7,
        "locale": TEST_LOCALE,
        "system": TEST_SYSTEM,
        "runtimes": {"codex": next(iter(_runtime_state(provider_ids=["clawdi-managed"]).values()))},
    }

    response = await admin_client.put(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json=body,
    )

    assert response.status_code == 422, response.text
    assert "unsupported runtime desired state" in response.text
