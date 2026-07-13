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
    HostedEgressEngine,
    HostedEgressProfiles,
    HostedRuntimeBridge,
    HostedRuntimeDesiredState,
    HostedRuntimeLiveSync,
    HostedRuntimeLocale,
    HostedRuntimeName,
    HostedRuntimeRecovery,
    HostedRuntimeSystem,
    validate_clawdi_cli_package_spec,
    validate_hosted_runtime_bridge,
)
from app.services.managed_ai_provider import (
    MANAGED_AI_PROVIDER_IDS,
    MANAGED_AI_PROVIDER_RUNTIME_ENV,
    managed_provider_api_mode,
)
from app.services.vault_crypto import decrypt

RUNTIME_BUNDLE_V2_MEDIA_TYPE = "application/vnd.clawdi.runtime-bundle.v2+json"
RUNTIME_BUNDLE_V2_SCHEMA_VERSION = "clawdi.hosted-runtime.bundle.v2"
_SUPPORTED_RUNTIMES = {"hermes", "openclaw"}


class RuntimeSourceError(ValueError):
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
    include_channel_authority: bool = True,
) -> RenderedRuntimeSource:
    row = batch.rows.get(environment_id)
    if row is None:
        raise RuntimeSourceError("Agent environment not found")
    if row.state is None:
        raise RuntimeSourceError("Hosted runtime state not found")
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
        bridge = (
            HostedRuntimeBridge.model_validate(state.bridge) if state.bridge is not None else None
        )
    except ValidationError as exc:
        raise RuntimeSourceError("Hosted runtime bridge state is invalid") from exc
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
        cli_package_spec = validate_clawdi_cli_package_spec(state.cli_package_spec)
    except ValueError as exc:
        raise RuntimeSourceError(
            "Hosted runtime CLI package spec is invalid or below the minimum version"
        ) from exc
    runtime_name, runtime = _runtime(state.runtimes)
    try:
        validate_hosted_runtime_bridge(runtime_name, bridge)
    except ValueError as exc:
        raise RuntimeSourceError(
            "Hosted runtime bridge state does not match the selected runtime"
        ) from exc

    providers: dict[str, Any] = {}
    secrets: dict[str, str] = {}
    secret_sources: dict[str, dict[str, str]] = {}
    for provider_id in tuple(runtime["provider_ids"]):
        provider = batch.providers.get((user_id, provider_id))
        if provider is None:
            providers[provider_id] = _unhealthy_provider(provider_id, runtime_name)
            continue
        payload = _selected_auth_payload(batch, provider)
        secret_ref = _provider_secret_ref(provider_id) if payload is not None else None
        providers[provider_id] = _provider_entry(provider, secret_ref=secret_ref)
        if payload is not None and secret_ref is not None:
            secret_sources[secret_ref] = _secret_identity(
                payload.id,
                payload.encrypted_payload,
                payload.nonce,
                vault_key_identity,
                "provider-api-key",
            )
            if decrypt_secrets:
                try:
                    secrets[secret_ref] = decrypt(payload.encrypted_payload, payload.nonce)
                except Exception as exc:
                    raise RuntimeSourceError(
                        "Hosted runtime provider secret source is invalid"
                    ) from exc

    manifest: dict[str, Any] = {
        "schemaVersion": "clawdi.hosted-runtime.manifest.v1",
        "deploymentId": state.deployment_id,
        "environmentId": str(environment_id),
        "instanceId": state.instance_id,
        "generation": state.generation,
        "issuedAt": runtime_manifest_issued_at(state),
        "runtime": runtime_name,
        "locale": locale.model_dump(),
        "system": system.model_dump(exclude_none=True, mode="json"),
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
    if bridge is not None:
        manifest["bridge"] = bridge.model_dump(exclude_none=True, exclude_unset=True, mode="json")
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
    if state.tools:
        manifest["tools"] = state.tools

    bindings: list[dict[str, str]] = []
    channel_rows = batch.channels.get(environment_id, ()) if include_channel_authority else ()
    for account, link in channel_rows:
        if not link.encrypted_agent_token or not link.agent_token_nonce:
            raise RuntimeSourceError("Active runtime channel link has no token material")
        account_key = f"clawdi_{account.id.hex[:12]}"
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
        secret_sources[agent_ref] = _secret_identity(
            link.id,
            link.encrypted_agent_token,
            link.agent_token_nonce,
            vault_key_identity,
            "channel-agent-token",
        )
        if decrypt_secrets:
            try:
                secrets[agent_ref] = decrypt(link.encrypted_agent_token, link.agent_token_nonce)
            except Exception as exc:
                raise RuntimeSourceError("Hosted runtime channel secret source is invalid") from exc
            secrets[placeholder_ref] = _placeholder(account.provider, account_key)

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
        desired = HostedRuntimeDesiredState.model_validate(raw)
    except ValidationError as exc:
        raise RuntimeSourceError(f"hosted runtime state for {name} is invalid") from exc
    runtime_name: HostedRuntimeName = "hermes" if name == "hermes" else "openclaw"
    return runtime_name, desired.model_dump(exclude_none=True, mode="json")


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
    managed = provider.provider_id in MANAGED_AI_PROVIDER_IDS or (
        provider.managed_by == "clawdi"
        and provider.auth_type == "api_key"
        and (provider.auth_metadata or {}).get("source") == "managed"
    )
    api_mode = (
        managed_provider_api_mode(provider.provider_id) or provider.api_mode
        if managed
        else provider.api_mode
    )
    runtime_env = MANAGED_AI_PROVIDER_RUNTIME_ENV if managed else provider.runtime_env_name
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


def _unhealthy_provider(provider_id: str, runtime_name: str) -> dict[str, Any]:
    return {
        "kind": "openai-compatible",
        "status": "error",
        "error": {
            "code": "provider_not_found",
            "message": f"provider required by {runtime_name} is missing or archived",
        },
    }


def _provider_secret_ref(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9._-]+", "-", value.strip().lower()).strip(".-")
    return f"provider.{normalized or 'default'}.apiKey"


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


def _placeholder(provider: str, account_key: str) -> str:
    suffix = hashlib.sha256(f"{provider}:{account_key}".encode()).hexdigest()[:32]
    return f"999999999:{suffix}" if provider == CHANNEL_PROVIDER_TELEGRAM else f"clawdi_{suffix}"


def runtime_manifest_issued_at(state: HostedRuntimeState) -> str:
    value = state.updated_at if isinstance(state.updated_at, datetime) else state.created_at
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat()


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
