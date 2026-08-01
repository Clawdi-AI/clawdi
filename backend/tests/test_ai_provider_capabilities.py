from app.services.ai_provider_capabilities import (
    AiProviderCapabilityInput,
    provider_readiness,
)


def test_readiness_requires_hosted_deployable_https_endpoint() -> None:
    provider = AiProviderCapabilityInput(
        provider_type="openai",
        api_mode="openai_responses",
        base_url="http://127.0.0.1:11434/v1",
        auth_type="api_key",
        auth_source="managed",
        runtime_env_name="OPENAI_API_KEY",
    )

    readiness = provider_readiness(provider, credential_material="available")

    assert readiness.runtime_compatibility.openclaw is True
    assert readiness.runtime_compatibility.hermes is True
    assert readiness.deployable is False
