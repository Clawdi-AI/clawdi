"""Canonical AI Provider readiness and runtime compatibility contract."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse

from app.schemas.ai_provider import (
    AiProviderReadiness,
    AiProviderRuntimeCompatibility,
    CredentialMaterialState,
    VerificationState,
)

_DEFAULT_API_MODES = {
    "openai": "openai_responses",
    "anthropic": "anthropic_messages",
    "openrouter": "openai_chat",
    "gemini": "google_generate_content",
    "mistral": "openai_chat",
}
_RUNTIME_API_MODES = {
    "openclaw": frozenset(
        {
            "openai_chat",
            "openai_responses",
            "anthropic_messages",
            "google_generate_content",
        }
    ),
    "hermes": frozenset(
        {
            "openai_chat",
            "openai_responses",
            "anthropic_messages",
        }
    ),
    "codex": frozenset({"openai_responses"}),
}
_CANONICAL_OPENAI_BASE_URL = "https://api.openai.com/v1"


@dataclass(frozen=True, slots=True)
class AiProviderCapabilityInput:
    provider_type: str
    api_mode: str | None
    base_url: str
    auth_type: str
    auth_source: str | None = None
    auth_tool: str | None = None
    auth_ref: str | None = None
    runtime_env_name: str | None = None


def provider_runtime_compatibility(
    provider: AiProviderCapabilityInput,
) -> AiProviderRuntimeCompatibility:
    """Return runtime projection support from the same fields agents consume."""

    api_mode = effective_provider_api_mode(provider.provider_type, provider.api_mode)
    native_codex_auth = provider.auth_type == "agent_profile" and provider.auth_tool == "codex"
    native_codex_shape = (
        native_codex_auth
        and provider.provider_type == "openai"
        and api_mode == "openai_responses"
        and provider.base_url.rstrip("/") == _CANONICAL_OPENAI_BASE_URL
    )
    has_runtime_auth = (
        provider.auth_type == "none"
        or native_codex_auth
        or bool(provider.runtime_env_name)
        or bool(provider.auth_ref and provider.auth_ref.startswith("env:"))
    )
    openclaw = api_mode in _RUNTIME_API_MODES["openclaw"]
    hermes = api_mode in _RUNTIME_API_MODES["hermes"]
    codex = api_mode in _RUNTIME_API_MODES["codex"]
    if provider.auth_type == "oauth_profile":
        openclaw = hermes = codex = False
    elif native_codex_auth:
        openclaw = hermes = codex = native_codex_shape
    elif not has_runtime_auth:
        openclaw = hermes = codex = False
    return AiProviderRuntimeCompatibility(
        openclaw=openclaw,
        hermes=hermes,
        codex=codex,
    )


def effective_provider_api_mode(provider_type: str, api_mode: str | None) -> str | None:
    """Resolve the protocol a provider uses when no explicit mode is stored."""

    return api_mode or _DEFAULT_API_MODES.get(provider_type)


def provider_readiness(
    provider: AiProviderCapabilityInput,
    *,
    credential_material: CredentialMaterialState,
    endpoint_reachability: VerificationState = "not_tested",
    inference_verification: VerificationState = "not_tested",
) -> AiProviderReadiness:
    compatibility = provider_runtime_compatibility(provider)
    hosted_auth_delivery = (
        provider.auth_type == "api_key"
        and provider.auth_source == "managed"
        and bool(provider.runtime_env_name)
    ) or (provider.auth_type == "agent_profile" and provider.auth_tool == "codex")
    deployable = (
        credential_material == "available"
        and hosted_auth_delivery
        and any((compatibility.openclaw, compatibility.hermes))
        and is_hosted_deployable_endpoint(provider.base_url)
    )
    return AiProviderReadiness(
        credential_material=credential_material,
        runtime_compatibility=compatibility,
        deployable=deployable,
        endpoint_reachability=endpoint_reachability,
        inference_verification=inference_verification,
    )


def is_hosted_deployable_endpoint(base_url: str) -> bool:
    """Match Hosted's saved-provider URL admission without adding SSRF policy."""

    try:
        parsed = urlparse(base_url)
        hostname = parsed.hostname
    except ValueError:
        return False
    return (
        parsed.scheme.lower() == "https"
        and bool(hostname)
        and parsed.username is None
        and parsed.password is None
    )


__all__ = [
    "AiProviderCapabilityInput",
    "effective_provider_api_mode",
    "is_hosted_deployable_endpoint",
    "provider_readiness",
    "provider_runtime_compatibility",
]
