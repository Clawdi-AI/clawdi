import hashlib
import json
from pathlib import Path

import pytest

from app.services.ai_provider_capabilities import (
    AiProviderCapabilityInput,
    is_hosted_deployable_endpoint,
    provider_readiness,
)

_CONTRACT_FIXTURE_PATH = (
    Path(__file__).parents[2] / "test-fixtures" / "hosted-ai-provider-contract.json"
)
_CONTRACT_FIXTURE = json.loads(_CONTRACT_FIXTURE_PATH.read_text(encoding="utf-8"))
_PUBLIC_HTTPS_URL_CASES = _CONTRACT_FIXTURE["payload"]["public_https_url_cases"]


def test_hosted_provider_contract_fixture_payload_hash() -> None:
    canonical_payload = json.dumps(
        _CONTRACT_FIXTURE["payload"],
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    assert hashlib.sha256(canonical_payload).hexdigest() == _CONTRACT_FIXTURE["payload_sha256"]


@pytest.mark.parametrize(
    "case",
    _PUBLIC_HTTPS_URL_CASES,
    ids=[case["url"] for case in _PUBLIC_HTTPS_URL_CASES],
)
def test_hosted_deployable_endpoint_matches_hosted_url_policy(case: dict[str, object]) -> None:
    assert is_hosted_deployable_endpoint(str(case["url"])) is case["valid"]


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
