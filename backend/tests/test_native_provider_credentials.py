"""Native credentials do not make Clawdi the model-selection authority."""

import pytest
from pydantic import ValidationError

from app.models.ai_provider import AiProvider
from app.schemas.ai_provider import AiProviderUpsert
from app.schemas.native_provider import native_provider
from app.schemas.runtime import HostedRuntimeConfiguredDesiredState
from app.services.runtime_source import _provider_entry


@pytest.mark.parametrize("route", ["/v1/ai-providers", "/api/ai-providers"])
@pytest.mark.parametrize(
    ("identity", "variant"),
    [("gemini", None), ("huggingface", None), ("opencode", "go"), ("tencent", "tokenplan")],
)
async def test_native_credentials_accept_without_models(client, route, identity, variant):
    response = await client.post(
        f"{route}/accept",
        headers={"Idempotency-Key": f"native-gemini-{route.split('/')[1]}"},
        json={
            "provider": {
                "provider_id": f"gemini-{route.split('/')[1]}",
                "configuration_mode": "native",
                "native_provider": identity,
                "native_variant": variant,
                "auth": {"type": "api_key", "source": "managed"},
            },
            "credential": {"type": "api_key", "value": "native-test-key"},
        },
    )
    assert response.status_code == 201, response.text
    saved = response.json()["provider"]
    assert saved["configuration_mode"] == "native"
    assert saved["base_url"] == native_provider(identity, variant).base_url
    assert not saved.get("models")
    assert saved["readiness"]["deployable"] is True
    assert saved["readiness"]["runtime_compatibility"]["hermes"] is True
    assert saved["readiness"]["inference_verification"] == "not_tested"
    assert "native-test-key" not in response.text
    mismatched_env = await client.post(
        f"{route}/{saved['provider_id']}/auth/api-key",
        json={"value": "replacement-test-key", "runtime_env_name": "WRONG_API_KEY"},
    )
    assert mismatched_env.status_code == 422
    changed_identity = await client.patch(
        f"{route}/{saved['provider_id']}", json={"native_provider": "openai"}
    )
    assert changed_identity.status_code == 200, changed_identity.text
    assert changed_identity.json()["runtime_env_name"] == "OPENAI_API_KEY"


@pytest.mark.parametrize(
    "override",
    [
        {"native_variant": "unknown"},
        {"base_url": "https://other.example/v1"},
        {"models": [{"id": "do-not-select"}]},
        {"default_model": "do-not-select"},
        {"managed_by": "clawdi"},
        {"runtime_env_name": "WRONG_API_KEY"},
    ],
)
def test_native_identity_rejects_custom_routing_and_catalogs(override):
    with pytest.raises(ValidationError):
        AiProviderUpsert.model_validate(
            {
                "provider_id": "native-test",
                "configuration_mode": "native",
                "native_provider": "openai",
                "auth": {"type": "api_key", "source": "managed"},
                **override,
            }
        )


def test_native_region_projection_uses_runtime_auth_names_without_a_model():
    route = native_provider("qwen-dashscope", "coding-global")
    provider = AiProvider(
        provider_id="my-qwen",
        configuration_mode="native",
        native_provider=route.id,
        native_variant=route.variant,
        type=route.type,
        base_url=route.base_url,
        api_mode=route.api_mode,
        runtime_env_name=route.runtime_env_name,
        managed_by="user",
        auth_type="api_key",
        auth_metadata={"source": "managed"},
    )
    for runtime, identity, env in [
        ("hermes", "alibaba-coding-plan", "ALIBABA_CODING_PLAN_API_KEY"),
        ("openclaw", "qwen", "QWEN_API_KEY"),
    ]:
        entry = _provider_entry(
            provider,
            secret_ref="secret://provider.my-qwen.apiKey",
            credential_revision=None,
            selected_model="old-user-choice",
            runtime_name=runtime,
        )
        assert entry["nativeProvider"] == identity
        assert entry["runtimeEnvName"] == env
        assert "models" not in entry
    state = HostedRuntimeConfiguredDesiredState.model_validate(
        {
            "enabled": True,
            "providerMode": "configured",
            "provider_ids": ["my-qwen"],
            "install": {"source": "official"},
        }
    )
    assert state.primary_model is None


def test_tokenplan_projects_the_runtime_protocol_without_changing_saved_metadata():
    route = native_provider("tencent", "tokenplan")
    provider = AiProvider(
        provider_id="my-tokenplan",
        configuration_mode="native",
        native_provider=route.id,
        native_variant=route.variant,
        type=route.type,
        base_url=route.base_url,
        api_mode=route.api_mode,
        runtime_env_name=route.runtime_env_name,
        managed_by="user",
        auth_type="api_key",
        auth_metadata={"source": "managed"},
    )
    for runtime, expected_type, expected_url, expected_mode in [
        (
            "hermes",
            "anthropic",
            "https://api.lkeap.cloud.tencent.com/plan/anthropic",
            "anthropic_messages",
        ),
        (
            "openclaw",
            "custom_openai_compatible",
            "https://api.lkeap.cloud.tencent.com/plan/v3",
            "openai_chat",
        ),
    ]:
        entry = _provider_entry(
            provider,
            secret_ref="secret://provider.my-tokenplan.apiKey",
            credential_revision=None,
            selected_model=None,
            runtime_name=runtime,
        )
        assert (entry["type"], entry["baseUrl"], entry["apiMode"]) == (
            expected_type,
            expected_url,
            expected_mode,
        )
        assert entry["nativeProvider"] == "tencent-tokenplan"
        assert "models" not in entry
    assert provider.base_url == route.base_url
    assert provider.type == route.type
