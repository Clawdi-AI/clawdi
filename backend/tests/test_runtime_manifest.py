from __future__ import annotations

from collections.abc import AsyncIterator
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport

from app.core.auth import AuthContext, get_auth
from app.core.config import settings
from app.core.database import get_session
from app.main import app
from app.models.ai_provider import AiProvider, AiProviderAuthPayload
from app.models.api_key import ApiKey
from app.services.vault_crypto import encrypt
from tests.conftest import create_env_with_project

_ADMIN_KEY = "runtime-state-admin-secret"
_AUTH = {"X-Admin-Key": _ADMIN_KEY}


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
    app.dependency_overrides[get_auth] = _override_get_auth
    transport = ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


async def _write_runtime_state(admin_client: httpx.AsyncClient, environment_id: str, **overrides):
    body = {
        "deployment_id": f"dep_{uuid4().hex}",
        "app_id": "app-test",
        "instance_id": f"hri_{uuid4().hex}",
        "generation": 7,
        "provider_id": "clawdi-managed",
        "runtimes": {
            "openclaw": {
                "enabled": True,
                "install": {"source": "official", "channel": "stable"},
                "run": {"args": ["gateway", "run"]},
            },
            "hermes": {"enabled": False},
        },
    }
    body.update(overrides)
    response = await admin_client.put(
        f"/api/admin/environments/{environment_id}/runtime-state",
        headers=_AUTH,
        json=body,
    )
    assert response.status_code == 200, response.text
    return body


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
        response = await client.get("/api/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    payload = response.json()
    manifest = payload["manifest"]
    assert manifest["schemaVersion"] == "clawdi.hosted-runtime.manifest.v1"
    assert manifest["deploymentId"] == expected["deployment_id"]
    assert manifest["environmentId"] == str(env.id)
    assert manifest["instanceId"] == expected["instance_id"]
    assert manifest["generation"] == expected["generation"]
    assert manifest["liveSync"]["agents"] == [
        {"agentType": "openclaw", "environmentId": str(env.id)}
    ]
    assert "apiUrl" not in manifest["controlPlane"]
    assert "channels" not in manifest
    assert payload["secretValues"] == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["channels", "providers", "secretValues"])
async def test_admin_runtime_state_rejects_legacy_top_level_fields(
    admin_client,
    db_session,
    seed_user,
    field,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"legacy-{uuid4().hex[:8]}",
        machine_name="Runtime legacy field",
        agent_type="openclaw",
    )
    body = {
        "deployment_id": f"dep_{uuid4().hex}",
        "app_id": "app-test",
        "instance_id": f"hri_{uuid4().hex}",
        "generation": 7,
        "provider_id": "clawdi-managed",
        "runtimes": {"openclaw": {"enabled": True}},
        field: {},
    }

    response = await admin_client.put(
        f"/api/admin/environments/{env.id}/runtime-state",
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
        "app_id": "app-test",
        "instance_id": f"hri_{uuid4().hex}",
        "generation": 7,
        "provider_id": "clawdi-managed",
        "runtimes": {
            "openclaw": {"enabled": True},
            "channels": {},
        },
    }

    response = await admin_client.put(
        f"/api/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json=body,
    )

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_admin_runtime_state_rejects_legacy_control_plane_api_url(
    admin_client,
    db_session,
    seed_user,
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
        "app_id": "app-test",
        "instance_id": f"hri_{uuid4().hex}",
        "generation": 7,
        "provider_id": "clawdi-managed",
        "control_plane": {
            "manifestUrl": "https://cloud-api.test/api/runtime/manifest",
            "apiUrl": "https://api.clawdi.test",
            "cloudApiUrl": "https://cloud-api.test",
        },
        "runtimes": {"openclaw": {"enabled": True}},
    }

    response = await admin_client.put(
        f"/api/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json=body,
    )

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_runtime_manifest_requires_environment_bound_cli_key(client):
    clerk_response = await client.get("/api/runtime/manifest")
    assert clerk_response.status_code == 403


@pytest.mark.asyncio
async def test_runtime_manifest_rejects_unbound_cli_key(db_session, seed_user):
    api_key = ApiKey(user_id=seed_user.id, label="unbound")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/api/runtime/manifest")
    app.dependency_overrides.clear()
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_runtime_manifest_projects_provider_secret_values(
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
    db_session.add(
        AiProvider(
            owner_user_id=seed_user.id,
            provider_id="clawdi-managed",
            type="custom_openai_compatible",
            base_url="https://sub2api.test/v1",
            default_model="gpt-5.5",
            api_mode="codex_responses",
            auth_type="api_key",
            auth_metadata={"source": "managed"},
            managed_by="clawdi",
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
    await _write_runtime_state(admin_client, str(env.id))

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/api/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["manifest"]["providers"]["default"] == {
        "kind": "openai-compatible",
        "baseUrl": "https://sub2api.test/v1",
        "model": "gpt-5.5",
        "apiKeySecretRef": "provider.default.apiKey",
    }
    assert payload["secretValues"] == {"provider.default.apiKey": "sk-test-provider"}
