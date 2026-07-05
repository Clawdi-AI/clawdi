from __future__ import annotations

import json
from collections.abc import AsyncIterator
from datetime import UTC, datetime
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
from app.models.hosted_runtime import HostedRuntimeState
from app.models.user import User
from app.services.audit import _sanitize_audit_details
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
        "provider_id": "clawdi-managed-v2",
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
        f"/v1/admin/environments/{environment_id}/runtime-state",
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
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    etag = response.headers.get("etag")
    assert etag is not None
    assert response.headers["cache-control"] == "no-store"
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
    bridge = {
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

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
        assert response.status_code == 200, response.text
        etag = response.headers["etag"]

        heartbeat = await client.post(
            f"/v1/agents/{env.id}/sync-heartbeat",
            json={
                "last_revision_seen": 1,
                "queue_depth": 0,
                "runtime_observed": {
                    "schemaVersion": "clawdi.hostedRuntimeObserved.v1",
                    "reportedAt": "2026-06-11T00:00:00+00:00",
                    "status": "ok",
                    "generation": expected["generation"],
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
    assert latest["details"]["enabled_runtimes"] == ["openclaw"]
    assert latest["details"]["changed_fields"] == ["generation"]
    assert "secret" not in json.dumps(payload).lower()
    assert "token" not in json.dumps(payload).lower()


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
async def test_runtime_manifest_generation_reset_keeps_etag_but_returns_generation(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"generation-reset-{uuid4().hex[:8]}",
        machine_name="Runtime generation reset",
        agent_type="openclaw",
    )
    initial = await _write_runtime_state(admin_client, str(env.id), generation=7)

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")

    assert response.status_code == 200, response.text
    etag = response.headers["etag"]
    assert response.json()["manifest"]["generation"] == 7

    await _write_runtime_state(admin_client, str(env.id), **{**initial, "generation": 6})

    state = await db_session.get(HostedRuntimeState, env.id)
    assert state is not None
    assert state.generation == 6

    async with await _runtime_client(db_session, seed_user, api_key) as client:
        reset = await client.get("/v1/runtime/manifest")
        not_modified = await client.get(
            "/v1/runtime/manifest",
            headers={"If-None-Match": etag},
        )
    app.dependency_overrides.clear()

    assert reset.status_code == 200, reset.text
    assert reset.headers["etag"] == etag
    assert reset.json()["manifest"]["generation"] == 6
    assert not_modified.status_code == 304
    assert not_modified.headers["etag"] == etag
    assert not_modified.content == b""


@pytest.mark.asyncio
async def test_admin_runtime_state_preserves_optional_state_when_omitted_as_none(
    admin_client,
    db_session,
    seed_user,
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
        mitm_profiles={"profiles": [{"id": "profile-1", "enabled": True}]},
        mcp={"enabled": True},
        tools={"catalog": "clawdi-default"},
    )
    await _write_runtime_state(
        admin_client,
        str(env.id),
        **{
            key: value
            for key, value in {**initial, "generation": 8}.items()
            if key not in {"mitm_profiles", "mcp", "tools"}
        },
    )

    state = await db_session.get(HostedRuntimeState, env.id)
    assert state is not None
    assert state.generation == 8
    assert state.mitm_profiles == {"profiles": [{"id": "profile-1", "enabled": True}]}
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
async def test_runtime_manifest_projects_per_runtime_provider_bindings(
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
        runtimes={
            "openclaw": {
                "enabled": True,
                "provider_ids": ["openai-managed", "anthropic-managed"],
                "primary_model": {
                    "provider_id": "openai-managed",
                    "model": "gpt-5.5",
                },
            },
            "hermes": {
                "enabled": True,
                "provider_ids": ["openai-managed", "anthropic-managed"],
                "primary_model": {
                    "provider_id": "anthropic-managed",
                    "model": "claude-opus-4-6",
                },
            },
        },
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
    assert payload["manifest"]["runtimes"]["hermes"]["provider_ids"] == [
        "openai-managed",
        "anthropic-managed",
    ]
    assert payload["manifest"]["runtimes"]["hermes"]["primary_model"] == {
        "provider_id": "anthropic-managed",
        "model": "claude-opus-4-6",
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
        runtimes={
            "openclaw": {
                "enabled": True,
                "provider_id": "anthropic-byok",
                "model": "claude-opus-4-6",
            },
            "hermes": {
                "enabled": True,
                "provider_id": "gemini-byok",
                "model": "gemini-2.5-pro",
            },
        },
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
    assert payload["manifest"]["runtimes"]["hermes"]["primary_model"] == {
        "provider_id": "gemini-byok",
        "model": "gemini-2.5-pro",
    }
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
        runtimes={
            "openclaw": {
                "enabled": True,
                "provider_id": "missing-key-provider",
                "model": "claude-opus-4-6",
            },
            "hermes": {"enabled": False},
        },
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
    assert body["manifest"]["runtimes"]["openclaw"]["provider_ids"] == [
        "missing-key-provider"
    ]
    assert body["manifest"]["runtimes"]["openclaw"]["primary_model"] == {
        "provider_id": "missing-key-provider",
        "model": "claude-opus-4-6",
    }
    assert body["secretValues"] == {}


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
        runtimes={
            "openclaw": {
                "enabled": True,
                "provider_id": "deleted-custom-provider",
            },
            "hermes": {"enabled": False},
        },
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
            "message": "explicit runtime provider is missing or archived",
        },
        "providerId": "deleted-custom-provider",
    }
    assert payload["manifest"]["runtimes"]["openclaw"]["provider_ids"] == [
        "deleted-custom-provider"
    ]
    assert "primary_model" not in payload["manifest"]["runtimes"]["openclaw"]
    assert payload["secretValues"] == {}


@pytest.mark.asyncio
async def test_runtime_manifest_keeps_default_archived_provider_fallback(
    admin_client,
    db_session,
    seed_user,
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"default-archived-provider-{uuid4().hex[:8]}",
        machine_name="Runtime default archived provider",
        agent_type="openclaw",
    )
    ciphertext, nonce = encrypt("sk-managed-provider")
    db_session.add_all(
        [
            AiProvider(
                owner_user_id=seed_user.id,
                provider_id="deleted-default-provider",
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
        provider_id="deleted-default-provider",
        runtimes={
            "openclaw": {"enabled": True},
            "hermes": {"enabled": False},
        },
    )

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["manifest"]["providers"]["clawdi-managed-v2"] == {
        "kind": "openai-compatible",
        "type": "custom_openai_compatible",
        "baseUrl": "https://managed-provider.test/v1",
        "apiMode": "openai_chat",
        "models": [{"id": "gpt-5.5"}],
        "runtimeEnvName": "CLAWDI_MANAGED_OPENAI_API_KEY",
        "apiKeySecretRef": "provider.clawdi-managed-v2.apiKey",
    }
    assert payload["manifest"]["runtimes"]["openclaw"]["provider_ids"] == [
        "clawdi-managed-v2"
    ]
    assert payload["manifest"]["runtimes"]["openclaw"]["primary_model"] == {
        "provider_id": "clawdi-managed-v2",
        "model": "gpt-5.5",
    }
    assert payload["secretValues"] == {
        "provider.clawdi-managed-v2.apiKey": "sk-managed-provider"
    }


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
        "app_id": "app-test",
        "instance_id": f"hri_{uuid4().hex}",
        "generation": 7,
        "provider_id": "clawdi-managed",
        "runtimes": {"openclaw": {"enabled": True}},
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
        "app_id": "app-test",
        "instance_id": f"hri_{uuid4().hex}",
        "generation": 7,
        "provider_id": "clawdi-managed",
        "runtimes": {"openclaw": {"enabled": True}},
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
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json=body,
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
        "app_id": "app-test",
        "instance_id": f"hri_{uuid4().hex}",
        "generation": 7,
        "provider_id": "clawdi-managed",
        "runtimes": {
            "openclaw": {"enabled": True},
            "claude_code": {"enabled": True},
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
            app_id="app-test",
            instance_id=f"hri_{uuid4().hex}",
            generation=7,
            provider_id="clawdi-managed-v2",
            runtimes={
                "claude_code": {"enabled": True},
                "openclaw": {"enabled": False},
            },
            system=None,
            control_plane=None,
            clawdi_cli=None,
            live_sync=None,
            recovery=None,
            mitm_profiles=None,
            mcp=None,
            tools=None,
            observed=None,
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
async def test_runtime_manifest_allows_codex_enabled_runtime_state(
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
    db_session.add_all(
        [
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
            ),
            HostedRuntimeState(
                environment_id=env.id,
                deployment_id=f"dep_{uuid4().hex}",
                app_id="app-test",
                instance_id=f"hri_{uuid4().hex}",
                generation=7,
                provider_id="openai-codex",
                runtimes={
                    "codex": {
                        "enabled": True,
                        "provider_ids": ["openai-codex"],
                        "primary_model": {
                            "provider_id": "openai-codex",
                            "model": "gpt-5.5",
                        },
                    },
                    "openclaw": {"enabled": False},
                },
                system=None,
                control_plane=None,
                clawdi_cli=None,
                live_sync=None,
                recovery=None,
                mitm_profiles=None,
                mcp=None,
                tools=None,
                observed=None,
            ),
        ]
    )
    await db_session.commit()

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
    assert payload["manifest"]["runtimes"]["codex"]["provider_ids"] == ["openai-codex"]
    assert payload["manifest"]["runtimes"]["codex"]["primary_model"] == {
        "provider_id": "openai-codex",
        "model": "gpt-5.5",
    }


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
            provider_id="clawdi-managed-v2",
            type="custom_openai_compatible",
            base_url="https://sub2api.test/v1",
            models=[{"id": "gpt-5.5"}],
            # Simulate a stale v2 managed provider row from before the chat-completions contract.
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

    api_key = ApiKey(user_id=seed_user.id, environment_id=env.id, label="hosted")
    async with await _runtime_client(db_session, seed_user, api_key) as client:
        response = await client.get("/v1/runtime/manifest")
    app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["manifest"]["providers"]["clawdi-managed-v2"] == {
        "kind": "openai-compatible",
        "type": "custom_openai_compatible",
        "baseUrl": "https://sub2api.test/v1",
        "apiMode": "openai_chat",
        "models": [{"id": "gpt-5.5"}],
        "runtimeEnvName": "CLAWDI_MANAGED_OPENAI_API_KEY",
        "apiKeySecretRef": "provider.clawdi-managed-v2.apiKey",
    }
    assert payload["manifest"]["runtimes"]["openclaw"]["provider_ids"] == [
        "clawdi-managed-v2"
    ]
    assert payload["manifest"]["runtimes"]["openclaw"]["primary_model"] == {
        "provider_id": "clawdi-managed-v2",
        "model": "gpt-5.5",
    }
    assert payload["secretValues"] == {
        "provider.clawdi-managed-v2.apiKey": "sk-test-provider"
    }
    etag = response.headers["etag"]

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
        rotated = await client.get("/v1/runtime/manifest", headers={"If-None-Match": etag})
    app.dependency_overrides.clear()

    assert rotated.status_code == 200, rotated.text
    assert rotated.headers["etag"] != etag
    assert rotated.json()["secretValues"] == {
        "provider.clawdi-managed-v2.apiKey": "sk-rotated-provider"
    }


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
    await _write_runtime_state(admin_client, str(env.id), provider_id="clawdi-managed")

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
        "models": [{"id": "openai-codex/gpt-5.5"}],
        "runtimeEnvName": "CLAWDI_MANAGED_OPENAI_API_KEY",
        "apiKeySecretRef": "provider.clawdi-managed.apiKey",
    }
    assert payload["manifest"]["runtimes"]["openclaw"]["primary_model"] == {
        "provider_id": "clawdi-managed",
        "model": "openai-codex/gpt-5.5",
    }
    assert payload["secretValues"] == {
        "provider.clawdi-managed.apiKey": "sk-test-legacy-provider"
    }


@pytest.mark.asyncio
async def test_runtime_manifest_uses_runtime_model_when_provider_default_is_missing(
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
        provider_id="custom-openai",
        runtimes={
            "openclaw": {
                "enabled": True,
                "provider_id": "custom-openai",
                "model": "gpt-5.5",
            },
            "hermes": {"enabled": False},
        },
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
        provider_id="openai-codex",
        runtimes={
            "openclaw": {
                "enabled": True,
                "provider_id": "openai-codex",
                "model": "gpt-5.5",
            },
            "hermes": {"enabled": False},
        },
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
async def test_admin_runtime_state_accepts_codex_hosted_runtime(
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
        "app_id": "app-test",
        "instance_id": f"hri_{uuid4().hex}",
        "generation": 7,
        "provider_id": "clawdi-managed",
        "runtimes": {"codex": {"enabled": True}},
    }

    response = await admin_client.put(
        f"/v1/admin/environments/{env.id}/runtime-state",
        headers=_AUTH,
        json=body,
    )

    assert response.status_code == 200, response.text
    assert response.json()["environment_id"] == str(env.id)
