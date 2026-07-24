from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai_provider import AiProvider, AiProviderAuthPayload
from app.models.channel import (
    BOT_AGENT_LINK_STATUS_ACTIVE,
    CHANNEL_PROVIDER_DISCORD,
    CHANNEL_PROVIDER_TELEGRAM,
    CHANNEL_STATUS_ACTIVE,
    ChannelAccount,
    ChannelBotAgentLink,
)
from app.models.hosted_runtime import HostedRuntimeState
from app.models.session import AgentEnvironment
from app.schemas.ai_provider import AiProviderModel
from app.schemas.runtime import (
    _AGENT_V2_MANIFEST_MINIMUM_CLI_VERSION,
    HostedCodexProviderProjection,
    HostedEgressEngine,
    HostedEgressProfiles,
    HostedRuntimeLiveSync,
    HostedRuntimeLocale,
    HostedRuntimeName,
    HostedRuntimeRecovery,
    HostedRuntimeSystem,
    HostedRuntimeTools,
    validate_clawdi_cli_package_spec,
    validate_hosted_runtime_desired_state,
)
from app.services.channels import channel_runtime_account_key, channel_runtime_placeholder_token
from app.services.managed_ai_provider import (
    CLAWDI_MANAGED_PROVIDER_ID,
    V2_LEGACY_MANAGED_AI_PROVIDER_ID,
    V2_MANAGED_AI_PROVIDER_ID,
    is_managed_provider_id,
    managed_provider_api_mode,
    runtime_managed_provider_id,
    v2_deployment_managed_provider_id,
)
from app.services.vault_crypto import decrypt

RUNTIME_BUNDLE_V2_MEDIA_TYPE = "application/vnd.clawdi.runtime-bundle.v2+json"
RUNTIME_BUNDLE_V2_SCHEMA_VERSION = "clawdi.hosted-runtime.bundle.v2"
_SUPPORTED_RUNTIMES = {"hermes", "openclaw"}
_MANAGED_PROVIDER_RUNTIME_ENV = "OPENAI_API_KEY"
_CODEX_TOOL_SECRET_REF = "tool.codex.apiKey"
_CODEX_TOOL_API_MODE = "openai_responses"
_CODEX_PROVIDER_SOURCE_API_MODES = {"openai_chat", "openai_responses"}


class RuntimeSourceError(ValueError):
    pass


class RuntimeSourceNotFoundError(RuntimeSourceError):
    pass


def expected_runtime_bundle_v2_etag(source_revision: str) -> str:
    """Return the frozen v2 validator derived from its complete source identity."""
    if not re.fullmatch(r"[0-9a-f]{64}", source_revision):
        raise ValueError("runtime bundle source revision must be a SHA-256 digest")
    return f'"sha256:{source_revision}"'


@dataclass(frozen=True)
class RuntimeSourceRow:
    environment: AgentEnvironment
    state: HostedRuntimeState | None


@dataclass(frozen=True)
class RuntimeSourceBatch:
    rows: dict[UUID, RuntimeSourceRow]
    providers: dict[tuple[UUID, str], AiProvider]
    auth_payloads: dict[tuple[UUID, str, str], AiProviderAuthPayload]
    channels: dict[UUID, tuple[tuple[ChannelAccount, ChannelBotAgentLink], ...]]


@dataclass(frozen=True)
class RenderedRuntimeSource:
    manifest: dict[str, Any]
    channel_bindings: list[dict[str, str]]
    secret_values: dict[str, str]
    source_revision: str


@dataclass(frozen=True)
class RuntimeSecretMaterial:
    secret_ref: str
    ciphertext: bytes
    nonce: bytes
    error_message: str


async def load_runtime_source_batch(
    db: AsyncSession,
    *,
    environment_ids: list[UUID],
    owner_user_id: UUID | None = None,
) -> RuntimeSourceBatch:
    if not environment_ids:
        return RuntimeSourceBatch({}, {}, {}, {})
    env_filters = [AgentEnvironment.id.in_(environment_ids)]
    if owner_user_id is not None:
        env_filters.append(AgentEnvironment.user_id == owner_user_id)
    env_rows = (
        await db.execute(
            select(AgentEnvironment, HostedRuntimeState)
            .outerjoin(HostedRuntimeState, HostedRuntimeState.environment_id == AgentEnvironment.id)
            .where(*env_filters)
        )
    ).all()
    rows = {env.id: RuntimeSourceRow(environment=env, state=state) for env, state in env_rows}
    user_ids = sorted({row.environment.user_id for row in rows.values()}, key=str)
    if not user_ids:
        return RuntimeSourceBatch(rows, {}, {}, {})
    providers = list(
        (
            await db.execute(
                select(AiProvider).where(
                    AiProvider.owner_user_id.in_(user_ids),
                    AiProvider.archived_at.is_(None),
                )
            )
        ).scalars()
    )
    auth_payloads = list(
        (
            await db.execute(
                select(AiProviderAuthPayload).where(
                    AiProviderAuthPayload.owner_user_id.in_(user_ids),
                    AiProviderAuthPayload.archived_at.is_(None),
                )
            )
        ).scalars()
    )
    channel_rows = (
        await db.execute(
            select(ChannelBotAgentLink.agent_id, ChannelAccount, ChannelBotAgentLink)
            .join(ChannelAccount, ChannelAccount.id == ChannelBotAgentLink.account_id)
            .where(
                ChannelBotAgentLink.agent_id.in_(list(rows)),
                ChannelBotAgentLink.user_id.in_(user_ids),
                ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
                ChannelBotAgentLink.archived_at.is_(None),
                ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
                ChannelAccount.archived_at.is_(None),
                ChannelAccount.provider.in_((CHANNEL_PROVIDER_TELEGRAM, CHANNEL_PROVIDER_DISCORD)),
            )
            .order_by(
                ChannelBotAgentLink.agent_id,
                ChannelAccount.provider,
                ChannelAccount.id,
                ChannelBotAgentLink.id,
            )
        )
    ).all()
    channels: dict[UUID, list[tuple[ChannelAccount, ChannelBotAgentLink]]] = {}
    for environment_id, account, link in channel_rows:
        channels.setdefault(environment_id, []).append((account, link))
    return RuntimeSourceBatch(
        rows,
        {(item.owner_user_id, item.provider_id): item for item in providers},
        {(item.owner_user_id, item.provider_id, item.auth_profile): item for item in auth_payloads},
        {key: tuple(value) for key, value in channels.items()},
    )


def render_runtime_source(
    batch: RuntimeSourceBatch,
    *,
    environment_id: UUID,
    public_api_url: str,
    vault_key_identity: str,
    decrypt_secrets: bool,
) -> RenderedRuntimeSource:
    row = batch.rows.get(environment_id)
    if row is None:
        raise RuntimeSourceNotFoundError("Agent environment not found")
    if row.state is None:
        raise RuntimeSourceNotFoundError("Hosted runtime state not found")
    state = row.state
    user_id = row.environment.user_id
    try:
        locale = HostedRuntimeLocale.model_validate(state.locale)
        system = HostedRuntimeSystem.model_validate(state.system)
        live_sync = HostedRuntimeLiveSync.model_validate(state.live_sync)
        recovery = HostedRuntimeRecovery.model_validate(state.recovery)
    except ValidationError as exc:
        raise RuntimeSourceError(
            "Hosted runtime locale, system, live sync, or recovery state "
            "is invalid or not configured"
        ) from exc
    try:
        egress_engine = (
            HostedEgressEngine.model_validate(state.egress_engine)
            if state.egress_engine is not None
            else None
        )
        egress_profiles = (
            HostedEgressProfiles.model_validate(state.egress_profiles)
            if state.egress_profiles is not None
            else None
        )
    except ValidationError as exc:
        raise RuntimeSourceError("Hosted runtime egress state is invalid") from exc
    try:
        tools = HostedRuntimeTools.model_validate(state.tools)
    except ValidationError as exc:
        raise RuntimeSourceError("Hosted runtime tools state is invalid") from exc
    try:
        cli_package_spec = validate_clawdi_cli_package_spec(state.cli_package_spec)
    except ValueError as exc:
        raise RuntimeSourceError(
            "Hosted runtime CLI package spec is invalid or below the minimum version"
        ) from exc
    runtime_name, runtime = _runtime(state.runtimes)
    bound_runtime_provider_ids = list(runtime["provider_ids"])
    runtime = _agent_runtime_binding(runtime)
    dashboard_auth = system.hermesDashboardAuth
    if runtime_name == "hermes" and dashboard_auth is None:
        raise RuntimeSourceError(
            "Hermes direct dashboard requires official password authentication"
        )
    if runtime_name == "hermes" and dashboard_auth.activation.enabled is not True:
        raise RuntimeSourceError("Hermes password authentication must be explicitly enabled")
    if runtime_name == "hermes" and (
        runtime.get("services", {}).get("dashboard", {}).get("args")
        != ["dashboard", "--host", "0.0.0.0", "--port", "9119", "--no-open"]
    ):
        raise RuntimeSourceError("Hermes dashboard must bind directly to 0.0.0.0:9119")
    if runtime_name != "hermes" and dashboard_auth is not None:
        raise RuntimeSourceError("Hermes dashboard auth is only valid for Hermes runtimes")

    providers: dict[str, Any] = {}
    secrets: dict[str, str] = {}
    secret_sources: dict[str, dict[str, str]] = {}
    secret_materials: list[RuntimeSecretMaterial] = []
    codex_tool = tools.codex
    codex_agent_provider_id = runtime_managed_provider_id(codex_tool.provider_id)
    provider_sources: dict[str, str] = {}
    for bound_provider_id in [*bound_runtime_provider_ids, codex_tool.provider_id]:
        agent_provider_id = runtime_managed_provider_id(bound_provider_id)
        source_provider_id = _provider_source_id(
            batch,
            user_id=user_id,
            deployment_id=state.deployment_id,
            bound_provider_id=bound_provider_id,
        )
        existing_source = provider_sources.get(agent_provider_id)
        if existing_source is not None and existing_source != source_provider_id:
            raise RuntimeSourceError(
                f"multiple provider bindings project to agent provider {agent_provider_id}"
            )
        provider_sources[agent_provider_id] = source_provider_id
    provider_material: dict[str, dict[str, Any]] = {}
    runtime_provider_ids = set(runtime["provider_ids"])
    for agent_provider_id, source_provider_id in sorted(provider_sources.items()):
        provider = batch.providers.get((user_id, source_provider_id))
        is_codex_provider = agent_provider_id == codex_agent_provider_id
        if provider is None:
            if is_codex_provider:
                raise RuntimeSourceError("Hosted Codex tool provider is missing or archived")
            consumer = runtime_name if agent_provider_id in runtime_provider_ids else "codex tool"
            provider_material[agent_provider_id] = _unhealthy_provider(agent_provider_id, consumer)
            continue
        payload = _selected_auth_payload(batch, provider)
        if is_codex_provider and (
            provider.managed_by != "clawdi"
            or payload is None
            or payload.kind != "api_key"
            or payload.source != "managed"
        ):
            raise RuntimeSourceError(
                "Hosted Codex tool provider must use a Clawdi-managed provider auth payload"
            )
        secret_ref = (
            _CODEX_TOOL_SECRET_REF
            if payload is not None and is_codex_provider
            else _provider_secret_ref(source_provider_id)
            if payload is not None
            else None
        )
        provider_entry = _provider_entry(provider, secret_ref=secret_ref)
        if is_codex_provider and (
            provider_entry.get("apiMode") not in _CODEX_PROVIDER_SOURCE_API_MODES
            or provider_entry.get("runtimeEnvName") != _MANAGED_PROVIDER_RUNTIME_ENV
        ):
            raise RuntimeSourceError(
                "Hosted Codex tool provider must use a supported managed OpenAI projection"
            )
        provider_material[agent_provider_id] = provider_entry
        if payload is not None and secret_ref is not None:
            _add_secret_source(
                secret_sources,
                secret_ref,
                _secret_identity(
                    payload.id,
                    payload.encrypted_payload,
                    payload.nonce,
                    vault_key_identity,
                    ("tool-codex-api-key" if is_codex_provider else "provider-api-key"),
                ),
            )
            secret_materials.append(
                RuntimeSecretMaterial(
                    secret_ref=secret_ref,
                    ciphertext=payload.encrypted_payload,
                    nonce=payload.nonce,
                    error_message="Hosted runtime provider secret source is invalid",
                )
            )

    providers = {
        provider_id: provider_material[provider_id] for provider_id in runtime["provider_ids"]
    }
    tool_projection = tools.model_dump(
        exclude={"codex"},
        exclude_none=True,
        exclude_unset=True,
        mode="json",
    )
    codex_provider_input = {
        **provider_material[codex_agent_provider_id],
        "apiMode": _CODEX_TOOL_API_MODE,
    }
    try:
        codex_provider = HostedCodexProviderProjection.model_validate(
            codex_provider_input
        ).model_dump(exclude_none=True, mode="json")
    except ValidationError as exc:
        raise RuntimeSourceError("Hosted Codex tool provider projection is invalid") from exc
    terminal_tooling = {
        "codex": {
            **_agent_codex_tool(codex_tool.model_dump(mode="json")),
            "provider": codex_provider,
        }
    }

    manifest: dict[str, Any] = {
        "schemaVersion": "clawdi.hosted-runtime.manifest.v1",
        "deploymentId": state.deployment_id,
        "environmentId": str(environment_id),
        "instanceId": state.instance_id,
        "generation": state.generation,
        "issuedAt": runtime_manifest_issued_at(state),
        "runtime": runtime_name,
        "locale": locale.model_dump(),
        "system": system.model_dump(
            exclude={"hermesDashboardAuth"}, exclude_none=True, mode="json"
        ),
        "controlPlane": {"cloudApiUrl": public_api_url.rstrip("/")},
        "clawdiCli": {
            "source": "npm:clawdi",
            "packageSpec": cli_package_spec,
            "registry": "https://registry.npmjs.org",
        },
        "runtimes": {runtime_name: runtime},
        "providers": providers,
        "liveSync": live_sync.model_dump(mode="json"),
        "recovery": recovery.model_dump(mode="json"),
        "minimumCliVersion": _AGENT_V2_MANIFEST_MINIMUM_CLI_VERSION,
    }
    if dashboard_auth is not None:
        manifest["system"]["hermesDashboardAuth"] = dashboard_auth.model_dump(
            exclude_none=True, mode="json"
        )
    if egress_engine is not None:
        manifest["egressEngine"] = egress_engine.model_dump(
            exclude_none=True, exclude_unset=True, mode="json"
        )
    if egress_profiles is not None:
        manifest["egressProfiles"] = egress_profiles.model_dump(
            exclude_none=True, exclude_unset=True, mode="json"
        )
    if state.mcp:
        manifest["mcp"] = state.mcp
    if tool_projection:
        manifest["tools"] = tool_projection
    manifest["terminalTooling"] = terminal_tooling

    bindings: list[dict[str, str]] = []
    channel_rows = batch.channels.get(environment_id, ())
    for account, link in channel_rows:
        if not link.encrypted_agent_token or not link.agent_token_nonce:
            raise RuntimeSourceError("Active runtime channel link has no token material")
        account_key = channel_runtime_account_key(account.id)
        agent_ref = f"secret://channels/{account.provider}/{account_key}/agent-token"
        placeholder_ref = f"secret://channels/{account.provider}/{account_key}/placeholder-token"
        bindings.append(
            {
                "provider": account.provider,
                "accountKey": account_key,
                "agentTokenSecretRef": agent_ref,
                "placeholderTokenSecretRef": placeholder_ref,
            }
        )
        _add_secret_source(
            secret_sources,
            agent_ref,
            _secret_identity(
                link.id,
                link.encrypted_agent_token,
                link.agent_token_nonce,
                vault_key_identity,
                "channel-agent-token",
            ),
        )
        secret_materials.append(
            RuntimeSecretMaterial(
                secret_ref=agent_ref,
                ciphertext=link.encrypted_agent_token,
                nonce=link.agent_token_nonce,
                error_message="Hosted runtime channel secret source is invalid",
            )
        )

    if decrypt_secrets:
        for material in secret_materials:
            try:
                secrets[material.secret_ref] = decrypt(material.ciphertext, material.nonce)
            except Exception as exc:
                raise RuntimeSourceError(material.error_message) from exc
        for binding in bindings:
            placeholder_ref = binding["placeholderTokenSecretRef"]
            secrets[placeholder_ref] = channel_runtime_placeholder_token(
                binding["provider"], binding["accountKey"]
            )

    descriptor = {
        "schemaVersion": RUNTIME_BUNDLE_V2_SCHEMA_VERSION,
        "manifest": manifest,
        "channelBindings": bindings,
        "secretSources": secret_sources,
    }
    source_revision = hashlib.sha256(_canonical(descriptor).encode()).hexdigest()
    return RenderedRuntimeSource(manifest, bindings, secrets, source_revision)


def render_runtime_bundle(source: RenderedRuntimeSource) -> dict[str, Any]:
    return {
        "schemaVersion": RUNTIME_BUNDLE_V2_SCHEMA_VERSION,
        "sourceRevision": source.source_revision,
        "manifest": source.manifest,
        "channelBindings": source.channel_bindings,
        "secretValues": source.secret_values,
    }


def vault_key_identity(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _runtime(value: dict | None) -> tuple[HostedRuntimeName, dict[str, Any]]:
    if not isinstance(value, dict) or len(value) != 1:
        raise RuntimeSourceError("hosted runtime state must select exactly one enabled runtime")
    name, raw = next(iter(value.items()))
    if name not in _SUPPORTED_RUNTIMES:
        raise RuntimeSourceError(f"unsupported enabled runtime: {name}")
    try:
        desired = validate_hosted_runtime_desired_state(raw)
    except ValidationError as exc:
        raise RuntimeSourceError(f"hosted runtime state for {name} is invalid") from exc
    runtime_name: HostedRuntimeName = "hermes" if name == "hermes" else "openclaw"
    return runtime_name, desired.model_dump(exclude_none=True, mode="json")


def _agent_runtime_binding(runtime: dict[str, Any]) -> dict[str, Any]:
    provider_ids = [
        runtime_managed_provider_id(provider_id) for provider_id in runtime["provider_ids"]
    ]
    if len(provider_ids) != len(set(provider_ids)):
        duplicate = next(
            provider_id
            for index, provider_id in enumerate(provider_ids)
            if provider_id in provider_ids[:index]
        )
        raise RuntimeSourceError(
            f"multiple provider bindings project to agent provider {duplicate}"
        )
    projected = {**runtime, "provider_ids": provider_ids}
    primary_model = runtime.get("primary_model")
    if isinstance(primary_model, dict):
        projected["primary_model"] = {
            **primary_model,
            "provider_id": runtime_managed_provider_id(primary_model["provider_id"]),
        }
    return projected


def _agent_codex_tool(codex_tool: dict[str, Any]) -> dict[str, Any]:
    provider_id = runtime_managed_provider_id(codex_tool["provider_id"])
    return {
        **codex_tool,
        "provider_id": provider_id,
        "primary_model": {
            **codex_tool["primary_model"],
            "provider_id": provider_id,
        },
    }


def _provider_source_id(
    batch: RuntimeSourceBatch,
    *,
    user_id: UUID,
    deployment_id: str,
    bound_provider_id: str,
) -> str:
    """Resolve an agent alias to the deployment-scoped credential/catalog row."""

    if bound_provider_id not in {
        CLAWDI_MANAGED_PROVIDER_ID,
        V2_MANAGED_AI_PROVIDER_ID,
    }:
        return bound_provider_id
    deployment_provider_id = v2_deployment_managed_provider_id(deployment_id)
    if deployment_provider_id is not None and (user_id, deployment_provider_id) in batch.providers:
        return deployment_provider_id
    if (user_id, V2_MANAGED_AI_PROVIDER_ID) in batch.providers:
        return V2_MANAGED_AI_PROVIDER_ID
    if (user_id, V2_LEGACY_MANAGED_AI_PROVIDER_ID) in batch.providers:
        return V2_LEGACY_MANAGED_AI_PROVIDER_ID
    return V2_MANAGED_AI_PROVIDER_ID


def _selected_auth_payload(
    batch: RuntimeSourceBatch, provider: AiProvider
) -> AiProviderAuthPayload | None:
    if provider.auth_type != "api_key" or (provider.auth_metadata or {}).get("source") != "managed":
        return None
    raw = (provider.auth_metadata or {}).get("profile")
    profile = raw if isinstance(raw, str) else "default"
    return batch.auth_payloads.get((provider.owner_user_id, provider.provider_id, profile))


def _provider_entry(provider: AiProvider, *, secret_ref: str | None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "kind": "openai-compatible",
        "type": provider.type,
        "baseUrl": provider.base_url,
    }
    managed = is_managed_provider_id(provider.provider_id) or (
        provider.managed_by == "clawdi"
        and provider.auth_type == "api_key"
        and (provider.auth_metadata or {}).get("source") == "managed"
    )
    api_mode = (
        managed_provider_api_mode(provider.provider_id) or provider.api_mode
        if managed
        else provider.api_mode
    )
    runtime_env = _MANAGED_PROVIDER_RUNTIME_ENV if managed else provider.runtime_env_name
    if api_mode:
        result["apiMode"] = api_mode
    if provider.managed_by == "clawdi":
        result["managed_by"] = provider.managed_by
    if provider.models is not None:
        if not isinstance(provider.models, list):
            raise RuntimeSourceError("Stored AI provider model metadata is invalid")
        try:
            models = [
                AiProviderModel.model_validate(item).model_dump(exclude_none=True)
                for item in provider.models
            ]
        except ValidationError as exc:
            raise RuntimeSourceError("Stored AI provider model metadata is invalid") from exc
        if models:
            result["models"] = models
    if runtime_env:
        result["runtimeEnvName"] = runtime_env
    if provider.auth_type in {"api_key", "secret_ref"} and not secret_ref:
        result["apiKeyRequired"] = True
        result["status"] = "error"
        result["error"] = {
            "code": "provider_secret_unavailable",
            "message": "provider requires an API key but no runtime secret value is available",
        }
    if secret_ref:
        result["apiKeySecretRef"] = secret_ref
    metadata = provider.auth_metadata or {}
    if provider.auth_type == "agent_profile" and metadata.get("tool") == "codex":
        profile = metadata.get("profile")
        if isinstance(profile, str) and profile.strip():
            result["auth"] = {"type": "agent_profile", "tool": "codex", "profile": profile.strip()}
    return result


def _unhealthy_provider(provider_id: str, consumer: str) -> dict[str, Any]:
    return {
        "kind": "openai-compatible",
        "status": "error",
        "error": {
            "code": "provider_not_found",
            "message": f"provider required by {consumer} is missing or archived",
        },
    }


def _provider_secret_ref(value: str) -> str:
    return f"provider.{value}.apiKey"


def _secret_identity(
    row_id: UUID, ciphertext: bytes, nonce: bytes, key_identity: str, kind: str
) -> dict[str, str]:
    return {
        "kind": kind,
        "codecVersion": "aes-256-gcm.v1",
        "keyIdentity": key_identity,
        "rowIdentity": str(row_id),
        "ciphertextSha256": hashlib.sha256(ciphertext).hexdigest(),
        "nonceSha256": hashlib.sha256(nonce).hexdigest(),
    }


def _add_secret_source(
    sources: dict[str, dict[str, str]],
    secret_ref: str,
    identity: dict[str, str],
) -> None:
    if secret_ref in sources:
        raise RuntimeSourceError(f"Runtime secret reference collision: {secret_ref}")
    sources[secret_ref] = identity


def runtime_manifest_issued_at(state: HostedRuntimeState) -> str:
    value = state.updated_at if isinstance(state.updated_at, datetime) else state.created_at
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat()


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
