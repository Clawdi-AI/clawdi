import pytest

from app.services.ai_provider_capabilities import (
    AiProviderCapabilityInput,
    is_hosted_deployable_endpoint,
    provider_readiness,
)


@pytest.mark.parametrize(
    ("base_url", "expected"),
    [
        ("https://provider.example/v1", True),
        ("https://127.0.0.1/v1?mode=test#fragment", False),
        ("https://127.0.0.1/v1", False),
        ("https://metadata.google.internal/v1", False),
        ("https://provider.example/v1?", False),
        ("https://provider.example/v1#", False),
        ("https://provider.example/v1;", False),
        ("https://provider.example;", False),
        ("https://provider.example/v1%3Fquery%3Ddata", True),
        ("https://provider.example/v1%23fragment", True),
        ("https://provider.example/v1%3Bparam", True),
        ("http://provider.example/v1", False),
        ("https:///missing-host", False),
        ("https://user@provider.example/v1", False),
        ("https://user:password@provider.example/v1", False),
    ],
)
def test_hosted_deployable_endpoint_matches_hosted_url_policy(
    base_url: str, expected: bool
) -> None:
    assert is_hosted_deployable_endpoint(base_url) is expected


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
