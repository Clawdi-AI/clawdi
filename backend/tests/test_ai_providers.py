import base64
import json
import uuid
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from app.core.auth import AuthContext, get_auth
from app.core.config import settings
from app.main import app
from app.models.ai_provider import AiProvider
from app.models.api_key import ApiKey
from app.models.hosted_runtime import HostedRuntimeState
from app.services import sync_events
from app.services.managed_ai_provider import (
    V2_DEPLOYMENT_MANAGED_AI_PROVIDER_PREFIX,
    V2_LEGACY_MANAGED_AI_PROVIDER_ID,
    V2_MANAGED_AI_PROVIDER_API_MODE,
    V2_MANAGED_AI_PROVIDER_ID,
    is_v2_managed_provider_id,
    managed_provider_api_mode,
)
from tests.conftest import create_env_with_project

_TEST_SYSTEM = {}


@pytest.mark.parametrize(
    "provider_id",
    [
        V2_MANAGED_AI_PROVIDER_ID,
        V2_LEGACY_MANAGED_AI_PROVIDER_ID,
    ],
)
def test_v2_managed_ai_provider_ids_resolve_to_chat_mode(provider_id: str):
    assert is_v2_managed_provider_id(provider_id)
    assert managed_provider_api_mode(provider_id) == V2_MANAGED_AI_PROVIDER_API_MODE


def test_v1_provider_mode_resolution_does_not_accept_deployment_scoped_ids():
    provider_id = f"{V2_DEPLOYMENT_MANAGED_AI_PROVIDER_PREFIX}42"

    assert is_v2_managed_provider_id(provider_id)
    assert managed_provider_api_mode(provider_id) is None


@pytest.mark.parametrize(
    "provider_id",
    [
        "clawdi-v2-deployment-",
        "clawdi-v2-deployment-0",
        "clawdi-v2-deployment-01",
        "clawdi-v2-deployment-not-a-number",
        f"{V2_DEPLOYMENT_MANAGED_AI_PROVIDER_PREFIX}{'9' * 43}",
    ],
)
def test_v2_managed_ai_provider_rejects_invalid_deployment_ids(provider_id: str):
    assert not is_v2_managed_provider_id(provider_id)
    assert managed_provider_api_mode(provider_id) is None


_VALID_AUTH_VARIANTS = [
    pytest.param(
        "secret-env",
        {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        id="secret-ref-env",
    ),
    pytest.param(
        "secret-vault",
        {"type": "secret_ref", "ref": "clawdi://providers/openai"},
        id="secret-ref-vault",
    ),
    pytest.param(
        "api-env",
        {
            "type": "api_key",
            "source": "env",
            "ref": "env:OPENAI_API_KEY",
            "profile": "work_team",
        },
        id="api-key-env",
    ),
    pytest.param(
        "api-vault",
        {
            "type": "api_key",
            "source": "vault",
            "ref": "clawdi://providers/openai",
            "profile": "personal",
        },
        id="api-key-vault",
    ),
    pytest.param(
        "api-managed",
        {"type": "api_key", "source": "managed", "profile": "work_team"},
        id="api-key-managed",
    ),
    pytest.param(
        "agent-profile",
        {"type": "agent_profile", "tool": "codex", "profile": "work_team"},
        id="agent-profile",
    ),
    pytest.param("none", {"type": "none"}, id="none"),
]

_INVALID_AUTH_VARIANTS = [
    pytest.param(
        {"type": "secret_ref", "ref": "env:OPENAI_API_KEY", "source": "env"},
        id="secret-ref-with-source",
    ),
    pytest.param(
        {"type": "api_key", "source": "managed", "ref": "env:OPENAI_API_KEY"},
        id="managed-with-ref",
    ),
    pytest.param(
        {"type": "api_key", "source": "env"},
        id="env-without-ref",
    ),
    pytest.param(
        {"type": "api_key", "source": "vault", "ref": "env:OPENAI_API_KEY"},
        id="vault-with-env-ref",
    ),
    pytest.param(
        {"type": "api_key", "source": "managed", "profile": "../work-team"},
        id="invalid-api-key-profile",
    ),
    pytest.param(
        {
            "type": "agent_profile",
            "tool": "codex",
            "profile": "default",
            "ref": "env:OPENAI_API_KEY",
        },
        id="agent-profile-with-ref",
    ),
    pytest.param(
        {"type": "none", "profile": "default"},
        id="none-with-profile",
    ),
    pytest.param(
        {"type": "api_key", "source": "managed", "profiel": "default"},
        id="misspelled-profile",
    ),
    pytest.param(
        {"type": "api_key", "source": "managed", "value": "sk-should-not-be-here"},
        id="plaintext-value",
    ),
    pytest.param(
        {"type": "oauth_profile", "provider": "codex", "profile": "default"},
        id="unsupported-oauth-profile",
    ),
]


def _test_jwt(account_id: str = "account-123") -> str:
    def encode(value: dict) -> str:
        raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")

    return ".".join(
        [
            encode({"alg": "none", "typ": "JWT"}),
            encode({"https://api.openai.com/auth": {"chatgpt_account_id": account_id}}),
            "sig",
        ]
    )


@pytest.mark.asyncio
async def test_ai_provider_crud_is_account_scoped_metadata(client: httpx.AsyncClient):
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-main",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "models": [{"id": "gpt-5.2"}],
            "api_mode": "openai_responses",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
            "runtime_env_name": "OPENAI_API_KEY",
            "capabilities": {"chat": True, "tools": True},
        },
    )
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["scope"] == "account_global"
    assert body["auth"] == {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"}

    duplicate = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-main",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert duplicate.status_code == 409, duplicate.text

    patched = await client.patch(
        "/v1/ai-providers/openai-main",
        json={
            "models": [{"id": "gpt-5.3"}],
            "auth": {"type": "agent_profile", "tool": "codex", "profile": "default"},
        },
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["models"] == [{"id": "gpt-5.3"}]
    assert "default_model" not in patched.json()
    assert patched.json()["auth"] == {
        "type": "agent_profile",
        "tool": "codex",
        "profile": "default",
    }

    bad_patch = await client.patch("/v1/ai-providers/openai-main", json={"auth": None})
    assert bad_patch.status_code == 422, bad_patch.text
    assert "auth cannot be null" in bad_patch.text

    listing = await client.get("/v1/ai-providers")
    assert listing.status_code == 200, listing.text
    assert [item["provider_id"] for item in listing.json()["providers"]] == ["openai-main"]

    deleted = await client.delete("/v1/ai-providers/openai-main")
    assert deleted.status_code == 200, deleted.text
    assert deleted.json() == {"status": "deleted", "provider_id": "openai-main"}
    empty = await client.get("/v1/ai-providers")
    assert empty.status_code == 200, empty.text
    assert empty.json()["providers"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "model",
    [
        {"id": "gpt-test", "context_window": 0},
        {"id": "gpt-test", "max_tokens": 0},
        {"id": "gpt-test", "label": ""},
        {"id": "gpt-test", "alias": ""},
        {"id": "gpt-test", "label": None},
        {"id": "gpt-test", "unknown": True},
        {"id": "gpt-test", "capabilities": {"audio": True}},
        {"id": "gpt-test", "capabilities": {"chat": "yes"}},
        {"id": "gpt-test", "capabilities": {"chat": None}},
        {"id": "gpt-test", "cost": {"input": 1, "output": 2, "currency": "USD"}},
        {"id": "gpt-test", "cost": {"input": 1, "output": 2, "cache_read": None}},
    ],
    ids=[
        "zero-context-window",
        "zero-max-tokens",
        "empty-label",
        "empty-alias",
        "null-model-field",
        "unknown-model-field",
        "unknown-capability",
        "non-bool-capability",
        "null-capability",
        "unknown-cost-field",
        "null-cost-field",
    ],
)
async def test_ai_provider_rejects_models_outside_hosted_wire_contract(
    client: httpx.AsyncClient,
    model: dict,
):
    response = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "strict-model-provider",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
            "models": [model],
        },
    )

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_ai_provider_accepts_complete_hosted_model_contract(client: httpx.AsyncClient):
    model = {
        "id": "gpt-test",
        "label": "GPT Test",
        "alias": "gpt-test-stable",
        "api_mode": "openai_responses",
        "input_modalities": ["text", "image", "video", "audio"],
        "supports_vision": True,
        "supports_tools": True,
        "supports_reasoning": False,
        "context_window": 128000,
        "max_tokens": 16384,
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
    response = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "complete-model-provider",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
            "models": [model],
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["models"] == [model]


@pytest.mark.asyncio
async def test_provider_and_secret_mutations_invalidate_only_bound_runtime(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
):
    env_a = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"provider-event-a-{uuid.uuid4().hex[:8]}",
        machine_name="Provider event A",
        agent_type="openclaw",
    )
    env_b = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"provider-event-b-{uuid.uuid4().hex[:8]}",
        machine_name="Provider event B",
        agent_type="openclaw",
    )
    for env, provider_id in ((env_a, "openai-main"), (env_b, "anthropic-main")):
        db_session.add(
            HostedRuntimeState(
                environment_id=env.id,
                deployment_id=f"dep-{provider_id}",
                instance_id=f"hri-{provider_id}",
                generation=1,
                cli_package_spec="clawdi@0.12.10-beta.55",
                locale={"language": "en", "timezone": "UTC"},
                system=_TEST_SYSTEM,
                live_sync={"enabled": False, "agents": []},
                recovery={"cacheManifest": True, "allowOfflineBoot": True},
                runtimes={
                    "openclaw": {
                        "enabled": True,
                        "providerMode": "configured",
                        "provider_ids": [provider_id],
                        "primary_model": {"provider_id": provider_id, "model": "test-model"},
                        "install": {"source": "official"},
                    }
                },
            )
        )
    await db_session.commit()

    q_a = sync_events.subscribe(seed_user.id, frozenset(), environment_id=env_a.id)
    q_b = sync_events.subscribe(seed_user.id, frozenset(), environment_id=env_b.id)
    try:
        created = await client.post(
            "/v1/ai-providers",
            json={
                "provider_id": "openai-main",
                "type": "openai",
                "base_url": "https://api.openai.com/v1",
                "auth": {"type": "api_key", "source": "managed"},
                "runtime_env_name": "OPENAI_API_KEY",
            },
        )
        assert created.status_code == 200, created.text
        assert q_a.get_nowait() == {
            "type": "runtime_manifest_changed",
            "environment_id": str(env_a.id),
        }
        assert q_b.empty()

        presentation_only = await client.patch(
            "/v1/ai-providers/openai-main",
            json={
                "label": "OpenAI presentation label",
                "capabilities": {"chat": True},
            },
        )
        assert presentation_only.status_code == 200, presentation_only.text
        assert q_a.empty()
        assert q_b.empty()

        rotated = await client.post(
            "/v1/ai-providers/openai-main/auth/api-key",
            json={"value": "sk-rotated", "runtime_env_name": "OPENAI_API_KEY"},
        )
        assert rotated.status_code == 200, rotated.text
        assert q_a.get_nowait() == {
            "type": "runtime_manifest_changed",
            "environment_id": str(env_a.id),
        }
        assert q_b.empty()
    finally:
        sync_events.unsubscribe(seed_user.id, q_a)
        sync_events.unsubscribe(seed_user.id, q_b)


@pytest.mark.asyncio
async def test_ai_provider_accepts_catalog_derived_known_provider_bodies(
    client: httpx.AsyncClient,
):
    known = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-derived",
            "type": "openai",
            "label": "OpenAI",
            "base_url": "https://api.openai.com/v1",
            "models": [{"id": "gpt-5.5"}, {"id": "gpt-5.4"}, {"id": "gpt-5.4-mini"}],
            "api_mode": "openai_responses",
            "auth": {"type": "api_key", "source": "managed"},
            "managed_by": "user",
            "runtime_env_name": "OPENAI_API_KEY",
        },
    )
    assert known.status_code == 200, known.text
    assert known.json()["provider_id"] == "openai-derived"
    assert known.json()["runtime_env_name"] == "OPENAI_API_KEY"
    assert known.json()["models"] == [
        {"id": "gpt-5.5"},
        {"id": "gpt-5.4"},
        {"id": "gpt-5.4-mini"},
    ]

    codex = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-codex",
            "type": "openai",
            "label": "Codex (ChatGPT)",
            "base_url": "https://api.openai.com/v1",
            "models": [
                {"id": "gpt-5.5"},
                {"id": "gpt-5.4"},
                {"id": "gpt-5.3-codex"},
                {"id": "gpt-5.4-mini"},
            ],
            "api_mode": "openai_responses",
            "auth": {"type": "agent_profile", "tool": "codex", "profile": "default"},
            "managed_by": "user",
        },
    )
    assert codex.status_code == 200, codex.text
    assert codex.json()["provider_id"] == "openai-codex"
    assert codex.json()["auth"] == {
        "type": "agent_profile",
        "tool": "codex",
        "profile": "default",
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(("provider_id", "auth"), _VALID_AUTH_VARIANTS)
async def test_ai_provider_auth_variants_round_trip_through_upsert_and_patch(
    client: httpx.AsyncClient,
    provider_id: str,
    auth: dict,
):
    provider = {
        "provider_id": f"auth-{provider_id}",
        "type": "custom_openai_compatible",
        "base_url": "http://127.0.0.1:1234/v1",
        "api_mode": "openai_chat",
        "auth": auth,
    }

    created = await client.post("/v1/ai-providers", json=provider)
    assert created.status_code == 200, created.text
    assert created.json()["auth"] == auth

    fetched = await client.get(f"/v1/ai-providers/auth-{provider_id}")
    assert fetched.status_code == 200, fetched.text
    assert fetched.json()["auth"] == auth

    label_patch = await client.patch(
        f"/v1/ai-providers/auth-{provider_id}",
        json={"label": "Preserve auth"},
    )
    assert label_patch.status_code == 200, label_patch.text
    assert label_patch.json()["auth"] == auth

    auth_patch = await client.patch(
        f"/v1/ai-providers/auth-{provider_id}",
        json={"auth": auth},
    )
    assert auth_patch.status_code == 200, auth_patch.text
    assert auth_patch.json()["auth"] == auth


@pytest.mark.asyncio
async def test_ai_provider_patch_preserves_persisted_oauth_auth_when_auth_is_omitted(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
):
    provider = AiProvider(
        owner_user_id=seed_user.id,
        provider_id="persisted-oauth",
        type="openai",
        label="Before",
        base_url="https://api.openai.com/v1",
        api_mode="openai_responses",
        auth_type="oauth_profile",
        auth_metadata={
            "provider": "codex",
            "profile": "default",
            "source": "oauth_pkce",
        },
        managed_by="user",
    )
    db_session.add(provider)
    await db_session.commit()

    patched = await client.patch(
        "/v1/ai-providers/persisted-oauth",
        json={"label": "After"},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["label"] == "After"
    assert patched.json()["auth"] == {
        "type": "oauth_profile",
        "provider": "codex",
        "profile": "default",
    }
    await db_session.refresh(provider)
    assert provider.auth_metadata == {
        "provider": "codex",
        "profile": "default",
        "source": "oauth_pkce",
    }

    explicit_oauth = await client.patch(
        "/v1/ai-providers/persisted-oauth",
        json={
            "auth": {
                "type": "oauth_profile",
                "provider": "codex",
                "profile": "default",
            }
        },
    )
    assert explicit_oauth.status_code == 422, explicit_oauth.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "auth_metadata",
    [{}, {"source": "unknown"}],
    ids=["missing-source", "unknown-source"],
)
async def test_ai_provider_rejects_invalid_persisted_api_key_source(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
    auth_metadata: dict,
):
    db_session.add(
        AiProvider(
            owner_user_id=seed_user.id,
            provider_id="invalid-persisted-source",
            type="openai",
            base_url="https://api.openai.com/v1",
            api_mode="openai_responses",
            auth_type="api_key",
            auth_metadata=auth_metadata,
            managed_by="user",
        )
    )
    await db_session.commit()

    response = await client.get("/v1/ai-providers/invalid-persisted-source")

    assert response.status_code == 409, response.text
    assert response.json()["detail"] == "Stored AI provider auth metadata is invalid"


@pytest.mark.asyncio
@pytest.mark.parametrize("auth", _INVALID_AUTH_VARIANTS)
async def test_ai_provider_auth_variants_reject_cross_fields_on_upsert_and_patch(
    client: httpx.AsyncClient,
    auth: dict,
):
    provider = {
        "provider_id": "strict-auth-provider",
        "type": "custom_openai_compatible",
        "base_url": "http://127.0.0.1:1234/v1",
        "api_mode": "openai_chat",
        "auth": auth,
    }

    rejected_upsert = await client.post("/v1/ai-providers", json=provider)
    assert rejected_upsert.status_code == 422, rejected_upsert.text
    assert "sk-should-not-be-here" not in rejected_upsert.text

    provider["auth"] = {"type": "none"}
    created = await client.post("/v1/ai-providers", json=provider)
    assert created.status_code == 200, created.text

    rejected_patch = await client.patch(
        "/v1/ai-providers/strict-auth-provider",
        json={"auth": auth},
    )
    assert rejected_patch.status_code == 422, rejected_patch.text
    assert "sk-should-not-be-here" not in rejected_patch.text

    fetched = await client.get("/v1/ai-providers/strict-auth-provider")
    assert fetched.status_code == 200, fetched.text
    assert fetched.json()["auth"] == {"type": "none"}


@pytest.mark.asyncio
async def test_ai_provider_rejects_invalid_auth_and_api_mode(client: httpx.AsyncClient):
    invalid_mode = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "anthropic-main",
            "type": "anthropic",
            "base_url": "https://api.anthropic.com",
            "api_mode": "openai_chat",
            "auth": {"type": "secret_ref", "ref": "env:ANTHROPIC_API_KEY"},
        },
    )
    assert invalid_mode.status_code == 422, invalid_mode.text
    assert "incompatible" in invalid_mode.text

    codex_responses_mode = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "custom-openai",
            "type": "custom_openai_compatible",
            "base_url": "https://managed.example/v1",
            "models": [{"id": "gpt-5.5"}],
            "api_mode": "codex_responses",
            "auth": {"type": "api_key", "source": "managed"},
            "managed_by": "user",
            "runtime_env_name": "CUSTOM_OPENAI_API_KEY",
        },
    )
    assert codex_responses_mode.status_code == 422, codex_responses_mode.text
    assert "codex_responses" in codex_responses_mode.text

    legacy_model_prefix = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "legacy-model",
            "type": "custom_openai_compatible",
            "base_url": "https://managed.example/v1",
            "models": [{"id": "openai-codex/gpt-5.5"}],
            "api_mode": "openai_responses",
            "auth": {"type": "api_key", "source": "managed"},
            "managed_by": "user",
            "runtime_env_name": "CUSTOM_OPENAI_API_KEY",
        },
    )
    assert legacy_model_prefix.status_code == 422, legacy_model_prefix.text
    assert "legacy openai-codex prefix" in legacy_model_prefix.text

    for managed_provider_id in (
        V2_MANAGED_AI_PROVIDER_ID,
        V2_LEGACY_MANAGED_AI_PROVIDER_ID,
    ):
        managed = await client.post(
            "/v1/ai-providers",
            json={
                "provider_id": managed_provider_id,
                "type": "custom_openai_compatible",
                "base_url": "https://managed.example/v1",
                "models": [{"id": "gpt-5.5"}],
                "api_mode": "openai_chat",
                "auth": {"type": "api_key", "source": "managed"},
                "managed_by": "clawdi",
                "runtime_env_name": "CLAWDI_MANAGED_OPENAI_API_KEY",
            },
        )
        assert managed.status_code == 200, managed.text
        assert managed.json()["provider_id"] == managed_provider_id
        assert managed.json()["api_mode"] == "openai_chat"
        assert managed.json()["models"] == [{"id": "gpt-5.5"}]

    v1_managed = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "clawdi-managed",
            "type": "custom_openai_compatible",
            "base_url": "https://managed.example/v1",
            "models": [{"id": "openai-codex/gpt-5.5"}],
            "api_mode": "openai_responses",
            "auth": {"type": "api_key", "source": "managed"},
            "managed_by": "clawdi",
            "runtime_env_name": "CLAWDI_MANAGED_OPENAI_API_KEY",
        },
    )
    assert v1_managed.status_code == 200, v1_managed.text
    assert v1_managed.json()["provider_id"] == "clawdi-managed"
    assert v1_managed.json()["api_mode"] == "openai_responses"

    v1_managed_wrong_mode = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "clawdi-managed",
            "type": "custom_openai_compatible",
            "base_url": "https://managed.example/v1",
            "models": [{"id": "openai-codex/gpt-5.5"}],
            "api_mode": "openai_chat",
            "auth": {"type": "api_key", "source": "managed"},
            "managed_by": "clawdi",
            "runtime_env_name": "CLAWDI_MANAGED_OPENAI_API_KEY",
        },
    )
    assert v1_managed_wrong_mode.status_code == 422, v1_managed_wrong_mode.text
    assert "must use api_mode openai_responses" in v1_managed_wrong_mode.text

    unsupported_agent_profile = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "anthropic-profile",
            "type": "anthropic",
            "base_url": "https://api.anthropic.com",
            "auth": {
                "type": "agent_profile",
                "tool": "claude-code",
                "profile": "default",
            },
        },
    )
    assert unsupported_agent_profile.status_code == 422, unsupported_agent_profile.text
    assert "codex only" in unsupported_agent_profile.text.lower()

    public_no_auth = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "public-local",
            "type": "custom_openai_compatible",
            "base_url": "https://example.com/v1",
            "api_mode": "openai_chat",
            "auth": {"type": "none"},
        },
    )
    assert public_no_auth.status_code == 422, public_no_auth.text
    assert "none auth" in public_no_auth.text


@pytest.mark.asyncio
async def test_ai_provider_allows_no_auth_local_endpoints(client: httpx.AsyncClient):
    for index, base_url in enumerate(
        [
            "http://localhost:1234/v1",
            "http://127.0.0.1:1234/v1",
            "http://[::1]:1234/v1",
            "http://0.0.0.0:1234/v1",
        ],
    ):
        created = await client.post(
            "/v1/ai-providers",
            json={
                "provider_id": f"local-model-{index}",
                "type": "custom_openai_compatible",
                "base_url": base_url,
                "api_mode": "openai_chat",
                "auth": {"type": "none"},
            },
        )
        assert created.status_code == 200, created.text


@pytest.mark.asyncio
async def test_ai_provider_managed_api_key_is_redacted(client: httpx.AsyncClient):
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-main",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text

    updated = await client.post(
        "/v1/ai-providers/openai-main/auth/api-key",
        json={
            "value": "sk-managed-secret",
            "runtime_env_name": "OPENAI_API_KEY",
        },
    )
    assert updated.status_code == 200, updated.text
    assert "sk-managed-secret" not in updated.text
    body = updated.json()
    assert body["auth"] == {
        "type": "api_key",
        "source": "managed",
        "profile": "default",
    }
    assert body["runtime_env_name"] == "OPENAI_API_KEY"


@pytest.mark.asyncio
async def test_ai_provider_imports_agent_profile_payload_without_echo(client: httpx.AsyncClient):
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-codex",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text

    imported = await client.post(
        "/v1/ai-providers/openai-codex/auth/import",
        json={
            "type": "agent_profile",
            "tool": "codex",
            "profile": "work_team",
            "payload": '{"token":"codex-secret"}',
        },
    )
    assert imported.status_code == 200, imported.text
    assert "codex-secret" not in imported.text
    assert imported.json()["auth"] == {
        "type": "agent_profile",
        "tool": "codex",
        "profile": "work_team",
    }

    unsupported_agent_profile = await client.post(
        "/v1/ai-providers/openai-codex/auth/import",
        json={
            "type": "agent_profile",
            "tool": "claude-code",
            "profile": "default",
            "payload": '{"token":"claude-secret"}',
        },
    )
    assert unsupported_agent_profile.status_code == 422, unsupported_agent_profile.text
    assert "Codex only" in unsupported_agent_profile.text

    unsupported_oauth_profile = await client.post(
        "/v1/ai-providers/openai-codex/auth/import",
        json={
            "type": "oauth_profile",
            "provider": "codex",
            "profile": "default",
            "payload": '{"token":"oauth-secret"}',
        },
    )
    assert unsupported_oauth_profile.status_code == 422, unsupported_oauth_profile.text
    assert "oauth_profile import is not supported" in unsupported_oauth_profile.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        pytest.param(
            {
                "type": "agent_profile",
                "tool": "codex",
                "provider": "codex",
                "profile": "default",
                "payload": "agent-import-secret",
            },
            id="agent-profile-with-provider",
        ),
        pytest.param(
            {
                "type": "oauth_profile",
                "provider": "codex",
                "tool": "codex",
                "profile": "default",
                "payload": "oauth-import-secret",
            },
            id="oauth-profile-with-tool",
        ),
        pytest.param(
            {
                "type": "agent_profile",
                "profile": "default",
                "payload": "missing-tool-secret",
            },
            id="agent-profile-missing-tool",
        ),
        pytest.param(
            {
                "type": "oauth_profile",
                "profile": "default",
                "payload": "missing-provider-secret",
            },
            id="oauth-profile-missing-provider",
        ),
    ],
)
async def test_ai_provider_auth_import_variants_reject_cross_fields_without_echo(
    client: httpx.AsyncClient,
    body: dict,
):
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "strict-import-provider",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text

    response = await client.post(
        "/v1/ai-providers/strict-import-provider/auth/import",
        json=body,
    )

    assert response.status_code == 422, response.text
    assert body["payload"] not in response.text


@pytest.mark.asyncio
async def test_ai_provider_resolve_uses_only_active_auth_profile(
    client: httpx.AsyncClient,
    seed_user,
):
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-codex",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text

    first = await client.post(
        "/v1/ai-providers/openai-codex/auth/import",
        json={
            "type": "agent_profile",
            "tool": "codex",
            "profile": "default",
            "payload": '{"token":"old"}',
        },
    )
    assert first.status_code == 200, first.text

    second = await client.post(
        "/v1/ai-providers/openai-codex/auth/import",
        json={
            "type": "agent_profile",
            "tool": "codex",
            "profile": "work_team",
            "payload": '{"token":"active"}',
        },
    )
    assert second.status_code == 200, second.text
    assert second.json()["auth"] == {
        "type": "agent_profile",
        "tool": "codex",
        "profile": "work_team",
    }

    api_key = ApiKey(
        user_id=seed_user.id,
        key_hash="unused",
        key_prefix="clawdi_test",
        label="test-cli",
        scopes=None,
    )

    async def _override_get_auth() -> AuthContext:
        return AuthContext(user=seed_user, api_key=api_key)

    app.dependency_overrides[get_auth] = _override_get_auth
    try:
        old_profile = await client.post(
            "/v1/ai-providers/openai-codex/auth/resolve",
            json={"profile": "default"},
        )
        assert old_profile.status_code == 404, old_profile.text

        active_profile = await client.post(
            "/v1/ai-providers/openai-codex/auth/resolve",
            json={"profile": "work_team"},
        )
        assert active_profile.status_code == 200, active_profile.text
        assert active_profile.json()["payload"] == '{"token":"active"}'
    finally:
        app.dependency_overrides.pop(get_auth, None)


@pytest.mark.asyncio
async def test_ai_provider_codex_profiles_are_scoped_by_provider_id(
    client: httpx.AsyncClient,
    seed_user,
):
    for provider_id, label, payload in [
        ("openai-codex-work", "Work Codex", '{"token":"work"}'),
        ("openai-codex-personal", "Personal Codex", '{"token":"personal"}'),
    ]:
        created = await client.post(
            "/v1/ai-providers",
            json={
                "provider_id": provider_id,
                "type": "openai",
                "label": label,
                "base_url": "https://api.openai.com/v1",
                "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
            },
        )
        assert created.status_code == 200, created.text
        imported = await client.post(
            f"/v1/ai-providers/{provider_id}/auth/import",
            json={
                "type": "agent_profile",
                "tool": "codex",
                "profile": "default",
                "payload": payload,
            },
        )
        assert imported.status_code == 200, imported.text
        assert payload not in imported.text
        assert imported.json()["auth"] == {
            "type": "agent_profile",
            "tool": "codex",
            "profile": "default",
        }

    api_key = ApiKey(
        user_id=seed_user.id,
        key_hash="unused",
        key_prefix="clawdi_test",
        label="test-cli",
        scopes=None,
    )

    async def _override_get_auth() -> AuthContext:
        return AuthContext(user=seed_user, api_key=api_key)

    original_get_auth = app.dependency_overrides[get_auth]
    app.dependency_overrides[get_auth] = _override_get_auth
    try:
        work = await client.post(
            "/v1/ai-providers/openai-codex-work/auth/resolve",
            json={"profile": "default"},
        )
        personal = await client.post(
            "/v1/ai-providers/openai-codex-personal/auth/resolve",
            json={"profile": "default"},
        )
    finally:
        app.dependency_overrides[get_auth] = original_get_auth

    assert work.status_code == 200, work.text
    assert personal.status_code == 200, personal.text
    assert work.json()["payload"] == '{"token":"work"}'
    assert personal.json()["payload"] == '{"token":"personal"}'
    assert work.json()["tool"] == "codex"
    assert personal.json()["tool"] == "codex"


@pytest.mark.asyncio
async def test_ai_provider_oauth_start_returns_backend_generated_link(client: httpx.AsyncClient):
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-codex",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text
    previous = settings.ai_provider_oauth_config_json
    settings.ai_provider_oauth_config_json = json.dumps(
        {
            "codex": {
                "authorization_url": "https://oauth.example/authorize",
                "token_url": "https://oauth.example/token",
                "client_id": "clawdi-client",
                "scope": "openid profile",
            }
        }
    )
    try:
        started = await client.post(
            "/v1/ai-providers/openai-codex/auth/oauth/start",
            json={
                "provider": "codex",
                "redirect_uri": "https://cloud.example/oauth/callback",
            },
        )
    finally:
        settings.ai_provider_oauth_config_json = previous

    assert started.status_code == 200, started.text
    body = started.json()
    assert body["provider_id"] == "openai-codex"
    assert body["oauth_provider"] == "codex"
    assert body["profile"] == "default"
    parsed = urlparse(body["auth_url"])
    params = parse_qs(parsed.query)
    assert parsed.scheme == "https"
    assert parsed.netloc == "oauth.example"
    assert params["client_id"] == ["clawdi-client"]
    assert params["response_type"] == ["code"]
    assert params["redirect_uri"] == ["https://cloud.example/oauth/callback"]
    assert params["code_challenge_method"] == ["S256"]
    assert params["scope"] == ["openid profile"]
    assert params["state"] == [body["state"]]


@pytest.mark.asyncio
async def test_ai_provider_oauth_start_uses_builtin_codex_config(client: httpx.AsyncClient):
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-codex",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text
    previous = settings.ai_provider_oauth_config_json
    settings.ai_provider_oauth_config_json = ""
    try:
        started = await client.post(
            "/v1/ai-providers/openai-codex/auth/oauth/start",
            json={
                "provider": "codex",
                "redirect_uri": "http://localhost:1455/auth/callback",
            },
        )
    finally:
        settings.ai_provider_oauth_config_json = previous

    assert started.status_code == 200, started.text
    parsed = urlparse(started.json()["auth_url"])
    params = parse_qs(parsed.query)
    assert parsed.scheme == "https"
    assert parsed.netloc == "auth.openai.com"
    assert parsed.path == "/oauth/authorize"
    assert params["client_id"] == ["app_EMoamEEZ73f0CkXaXp7hrann"]
    assert params["redirect_uri"] == ["http://localhost:1455/auth/callback"]
    assert params["scope"] == [
        "openid profile email offline_access api.connectors.read api.connectors.invoke"
    ]
    assert params["id_token_add_organizations"] == ["true"]
    assert params["codex_cli_simplified_flow"] == ["true"]
    assert params["originator"] == ["codex_cli_rs"]


@pytest.mark.asyncio
async def test_ai_provider_oauth_start_allows_dev_web_origin_http_redirect(
    client: httpx.AsyncClient,
):
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-codex",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "agent_profile", "tool": "codex", "profile": "default"},
        },
    )
    assert created.status_code == 200, created.text
    previous_environment = settings.environment
    previous_web_origin = settings.web_origin
    previous_cors_origins = settings.cors_origins
    settings.environment = "development"
    settings.web_origin = "http://dev.clawdi.test:33221"
    settings.cors_origins = ["http://localhost:33221"]
    try:
        started = await client.post(
            "/v1/ai-providers/openai-codex/auth/oauth/start",
            json={
                "provider": "codex",
                "redirect_uri": "http://dev.clawdi.test:33221/onboarding?step=provider&provider_oauth=codex",
            },
        )
        wrong_port = await client.post(
            "/v1/ai-providers/openai-codex/auth/oauth/start",
            json={
                "provider": "codex",
                "redirect_uri": "http://dev.clawdi.test:33222/onboarding?step=provider&provider_oauth=codex",
            },
        )
    finally:
        settings.environment = previous_environment
        settings.web_origin = previous_web_origin
        settings.cors_origins = previous_cors_origins

    assert started.status_code == 200, started.text
    assert wrong_port.status_code == 422, wrong_port.text
    params = parse_qs(urlparse(started.json()["auth_url"]).query)
    assert params["redirect_uri"] == [
        "http://dev.clawdi.test:33221/onboarding?step=provider&provider_oauth=codex"
    ]


@pytest.mark.asyncio
async def test_ai_provider_oauth_start_requires_clean_redirect_and_params(
    client: httpx.AsyncClient,
):
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-codex",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text
    previous = settings.ai_provider_oauth_config_json
    settings.ai_provider_oauth_config_json = json.dumps(
        {
            "codex": {
                "authorization_url": "https://oauth.example/authorize",
                "token_url": "https://oauth.example/token",
                "client_id": "clawdi-client",
            }
        }
    )
    try:
        missing_redirect = await client.post(
            "/v1/ai-providers/openai-codex/auth/oauth/start",
            json={"provider": "codex"},
        )
        assert missing_redirect.status_code == 503, missing_redirect.text
        assert "missing redirect_uri" in missing_redirect.text

        settings.ai_provider_oauth_config_json = json.dumps(
            {
                "codex": {
                    "authorization_url": "https://oauth.example/authorize",
                    "token_url": "https://oauth.example/token",
                    "client_id": "clawdi-client",
                    "redirect_uri": "https://cloud.example/oauth/callback",
                    "extra_authorize_params": {"state": "attacker-state"},
                }
            }
        )
        reserved_override = await client.post(
            "/v1/ai-providers/openai-codex/auth/oauth/start",
            json={"provider": "codex"},
        )
        assert reserved_override.status_code == 503, reserved_override.text
        assert "cannot override state" in reserved_override.text

        unsupported_provider = await client.post(
            "/v1/ai-providers/openai-codex/auth/oauth/start",
            json={
                "provider": "claude-code",
                "redirect_uri": "http://localhost:1455/auth/callback",
            },
        )
        assert unsupported_provider.status_code == 422, unsupported_provider.text
        assert "Codex only" in unsupported_provider.text
    finally:
        settings.ai_provider_oauth_config_json = previous


@pytest.mark.asyncio
async def test_ai_provider_oauth_complete_exchanges_and_redacts_token(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    seed_user,
):
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-codex",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text
    previous = settings.ai_provider_oauth_config_json
    settings.ai_provider_oauth_config_json = json.dumps(
        {
            "codex": {
                "authorization_url": "https://oauth.example/authorize",
                "token_url": "https://oauth.example/token",
                "client_id": "clawdi-client",
                "client_secret": "oauth-client-secret",
            }
        }
    )
    token_requests: list[dict] = []

    class FakeOAuthClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, data):
            token_requests.append({"url": url, "data": data})
            if data["grant_type"] == "urn:ietf:params:oauth:grant-type:token-exchange":
                return httpx.Response(200, json={"access_token": "sk-codex-api-key"})
            return httpx.Response(
                200,
                json={
                    "id_token": _test_jwt(),
                    "access_token": "oauth-access-token",
                    "refresh_token": "oauth-refresh-token",
                },
            )

    monkeypatch.setattr("app.routes.ai_providers.httpx.AsyncClient", FakeOAuthClient)
    try:
        invalid_state = await client.post(
            "/v1/ai-providers/openai-codex/auth/oauth/complete",
            json={
                "state": "not-valid",
                "code": "oauth-code",
                "redirect_uri": "https://cloud.example/oauth/callback",
            },
        )
        assert invalid_state.status_code == 400, invalid_state.text
        assert token_requests == []

        started = await client.post(
            "/v1/ai-providers/openai-codex/auth/oauth/start",
            json={
                "provider": "codex",
                "redirect_uri": "https://cloud.example/oauth/callback",
            },
        )
        assert started.status_code == 200, started.text
        mismatch = await client.post(
            "/v1/ai-providers/openai-codex/auth/oauth/complete",
            json={
                "state": started.json()["state"],
                "code": "oauth-code",
                "redirect_uri": "https://cloud.example/other-callback",
            },
        )
        assert mismatch.status_code == 400, mismatch.text
        assert token_requests == []
        completed = await client.post(
            "/v1/ai-providers/openai-codex/auth/oauth/complete",
            json={
                "state": started.json()["state"],
                "code": "oauth-code",
                "redirect_uri": "https://cloud.example/oauth/callback",
            },
        )
    finally:
        settings.ai_provider_oauth_config_json = previous

    assert completed.status_code == 200, completed.text
    assert "oauth-access-token" not in completed.text
    assert "oauth-refresh-token" not in completed.text
    assert "sk-codex-api-key" not in completed.text
    assert completed.json()["auth"] == {
        "type": "agent_profile",
        "tool": "codex",
        "profile": "default",
    }
    assert token_requests[0]["url"] == "https://oauth.example/token"
    assert token_requests[0]["data"]["grant_type"] == "authorization_code"
    assert token_requests[0]["data"]["client_id"] == "clawdi-client"
    assert token_requests[0]["data"]["client_secret"] == "oauth-client-secret"
    assert token_requests[0]["data"]["code"] == "oauth-code"
    assert token_requests[0]["data"]["code_verifier"]
    assert token_requests[1]["url"] == "https://oauth.example/token"
    assert token_requests[1]["data"] == {
        "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
        "client_id": "clawdi-client",
        "requested_token": "openai-api-key",
        "subject_token": _test_jwt(),
        "subject_token_type": "urn:ietf:params:oauth:token-type:id_token",
    }
    api_key = ApiKey(
        user_id=seed_user.id,
        key_hash="unused",
        key_prefix="clawdi_test",
        label="test-cli",
        scopes=None,
    )

    async def _override_get_auth() -> AuthContext:
        return AuthContext(user=seed_user, api_key=api_key)

    original_get_auth = app.dependency_overrides[get_auth]
    app.dependency_overrides[get_auth] = _override_get_auth
    try:
        resolved = await client.post(
            "/v1/ai-providers/openai-codex/auth/resolve",
            json={"profile": "default"},
        )
    finally:
        app.dependency_overrides[get_auth] = original_get_auth
    assert resolved.status_code == 200, resolved.text
    payload = json.loads(resolved.json()["payload"])
    assert payload["kind"] == "local_agent_profile"
    assert payload["tool"] == "codex"
    auth_json = json.loads(payload["files"][0]["content"])
    assert auth_json["auth_mode"] == "chatgpt"
    assert auth_json["OPENAI_API_KEY"] == "sk-codex-api-key"
    assert auth_json["tokens"]["access_token"] == "oauth-access-token"
    assert auth_json["tokens"]["refresh_token"] == "oauth-refresh-token"
    assert auth_json["tokens"]["account_id"] == "account-123"


@pytest.mark.asyncio
async def test_ai_provider_oauth_complete_omits_missing_codex_api_key(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    seed_user,
):
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-codex",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text
    previous = settings.ai_provider_oauth_config_json
    settings.ai_provider_oauth_config_json = json.dumps(
        {
            "codex": {
                "authorization_url": "https://oauth.example/authorize",
                "token_url": "https://oauth.example/token",
                "client_id": "clawdi-client",
            }
        }
    )

    class FakeOAuthClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, data):
            return httpx.Response(
                200,
                json={
                    "id_token": _test_jwt(),
                    "access_token": "oauth-access-token",
                    "refresh_token": "oauth-refresh-token",
                },
            )

    async def fake_obtain_codex_api_key(client, config, id_token):
        return None

    monkeypatch.setattr("app.routes.ai_providers.httpx.AsyncClient", FakeOAuthClient)
    monkeypatch.setattr(
        "app.routes.ai_providers._obtain_codex_api_key",
        fake_obtain_codex_api_key,
    )
    try:
        started = await client.post(
            "/v1/ai-providers/openai-codex/auth/oauth/start",
            json={
                "provider": "codex",
                "redirect_uri": "https://cloud.example/oauth/callback",
            },
        )
        assert started.status_code == 200, started.text
        completed = await client.post(
            "/v1/ai-providers/openai-codex/auth/oauth/complete",
            json={
                "state": started.json()["state"],
                "code": "oauth-code",
                "redirect_uri": "https://cloud.example/oauth/callback",
            },
        )
    finally:
        settings.ai_provider_oauth_config_json = previous

    assert completed.status_code == 200, completed.text
    api_key = ApiKey(
        user_id=seed_user.id,
        key_hash="unused",
        key_prefix="clawdi_test",
        label="test-cli",
        scopes=None,
    )

    async def _override_get_auth() -> AuthContext:
        return AuthContext(user=seed_user, api_key=api_key)

    original_get_auth = app.dependency_overrides[get_auth]
    app.dependency_overrides[get_auth] = _override_get_auth
    try:
        resolved = await client.post(
            "/v1/ai-providers/openai-codex/auth/resolve",
            json={"profile": "default"},
        )
    finally:
        app.dependency_overrides[get_auth] = original_get_auth
    assert resolved.status_code == 200, resolved.text
    payload = json.loads(resolved.json()["payload"])
    auth_json = json.loads(payload["files"][0]["content"])
    assert auth_json["auth_mode"] == "chatgpt"
    assert "OPENAI_API_KEY" not in auth_json
    assert auth_json["tokens"]["access_token"] == "oauth-access-token"
    assert auth_json["tokens"]["refresh_token"] == "oauth-refresh-token"


@pytest.mark.asyncio
async def test_ai_provider_account_mutations_reject_environment_api_keys(
    client: httpx.AsyncClient,
    seed_user,
):
    env_key = ApiKey(
        user_id=seed_user.id,
        key_hash="unused",
        key_prefix="clawdi_env",
        label="agent-env",
        environment_id=uuid.uuid4(),
        scopes=None,
    )

    async def _override_get_auth() -> AuthContext:
        return AuthContext(user=seed_user, api_key=env_key)

    original_get_auth = app.dependency_overrides[get_auth]
    app.dependency_overrides[get_auth] = _override_get_auth
    try:
        created = await client.post(
            "/v1/ai-providers",
            json={
                "provider_id": "openai-main",
                "type": "openai",
                "base_url": "https://api.openai.com/v1",
                "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
            },
        )
    finally:
        app.dependency_overrides[get_auth] = original_get_auth

    assert created.status_code == 403, created.text
    assert "Agent API keys" in created.text


@pytest.mark.asyncio
async def test_ai_provider_resolve_managed_auth_requires_cli(
    client: httpx.AsyncClient,
    seed_user,
):
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-main",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text
    managed = await client.post(
        "/v1/ai-providers/openai-main/auth/api-key",
        json={"value": "sk-managed-secret"},
    )
    assert managed.status_code == 200, managed.text

    web_resolve = await client.post(
        "/v1/ai-providers/openai-main/auth/resolve",
        json={"profile": "default"},
    )
    assert web_resolve.status_code == 403, web_resolve.text

    api_key = ApiKey(
        user_id=seed_user.id,
        key_hash="unused",
        key_prefix="clawdi_test",
        label="test-cli",
        scopes=None,
    )

    async def _override_get_auth() -> AuthContext:
        return AuthContext(user=seed_user, api_key=api_key)

    app.dependency_overrides[get_auth] = _override_get_auth
    resolved = await client.post(
        "/v1/ai-providers/openai-main/auth/resolve",
        json={"profile": "default"},
    )
    assert resolved.status_code == 200, resolved.text
    assert resolved.json() == {
        "provider_id": "openai-main",
        "auth_type": "api_key",
        "value": "sk-managed-secret",
        "payload": None,
        "tool": None,
        "provider": None,
        "profile": "default",
    }

    deleted = await client.delete("/v1/ai-providers/openai-main")
    assert deleted.status_code == 200, deleted.text

    recreated = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-main",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {
                "type": "api_key",
                "source": "managed",
            },
        },
    )
    assert recreated.status_code == 200, recreated.text

    stale_resolve = await client.post(
        "/v1/ai-providers/openai-main/auth/resolve",
        json={"profile": "default"},
    )
    assert stale_resolve.status_code == 404, stale_resolve.text
