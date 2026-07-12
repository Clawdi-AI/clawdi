from __future__ import annotations

import re
from copy import deepcopy
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_cli_auth
from app.core.config import settings
from app.core.database import get_session
from app.models.ai_provider import AiProvider, AiProviderAuthPayload
from app.models.hosted_runtime import HostedRuntimeState
from app.models.session import AgentEnvironment
from app.schemas.runtime import HostedRuntimeLocale
from app.services.http_cache import if_none_match_contains, strong_json_etag
from app.services.managed_ai_provider import (
    MANAGED_AI_PROVIDER_ID,
    MANAGED_AI_PROVIDER_IDS,
    MANAGED_AI_PROVIDER_RUNTIME_ENV,
    V1_MANAGED_AI_PROVIDER_ID,
    managed_provider_api_mode,
)
from app.services.vault_crypto import decrypt

router = APIRouter(prefix="/runtime", tags=["runtime"])


@dataclass(frozen=True)
class _RuntimeProviderBinding:
    provider_ids: tuple[str | None, ...]
    primary_provider_id: str | None
    primary_model: str | None
    explicit_provider_ids: bool


@dataclass(frozen=True)
class _RuntimeProviderManifestBinding:
    provider_ids: tuple[str, ...]
    primary_provider_id: str | None
    primary_model: str | None


_SUPPORTED_PROVIDER_RUNTIMES = {"codex", "hermes", "openclaw"}
# Deployment bootstrap seeds the CLI before its first manifest. Once connected,
# this manifest is the ongoing channel authority and the CLI persists/resolves it.
_AGENT_V2_MANIFEST_MINIMUM_CLI_VERSION = "0.12.10-beta.51"
_AGENT_V2_CLAWDI_CLI = {
    "source": "npm:clawdi",
    "packageSpec": "clawdi@agent-v2",
    "registry": "https://registry.npmjs.org",
}


@router.get("/manifest")
async def get_runtime_manifest(
    request: Request,
    requested_environment_id: UUID | None = Query(default=None, alias="environment_id"),
    auth: AuthContext = Depends(require_cli_auth),
    db: AsyncSession = Depends(get_session),
) -> Response:
    bound_environment_id = auth.api_key.environment_id if auth.api_key is not None else None
    if bound_environment_id is not None:
        if (
            requested_environment_id is not None
            and requested_environment_id != bound_environment_id
        ):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "api key bound to a different environment",
            )
        environment_id = bound_environment_id
    else:
        environment_id = requested_environment_id
    if environment_id is None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "runtime manifest requires an environment id",
        )

    env = (
        await db.execute(
            select(AgentEnvironment).where(
                AgentEnvironment.id == environment_id,
                AgentEnvironment.user_id == auth.user_id,
            )
        )
    ).scalar_one_or_none()
    if env is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent environment not found")

    state = (
        await db.execute(
            select(HostedRuntimeState).where(HostedRuntimeState.environment_id == environment_id)
        )
    ).scalar_one_or_none()
    if state is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Hosted runtime state not found")
    try:
        locale = HostedRuntimeLocale.model_validate(state.locale)
    except ValidationError as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Hosted runtime locale is invalid or not configured",
        ) from exc
    runtime = _selected_runtime(state.runtimes)

    (
        providers,
        secret_values,
        provider_version_sources,
        runtime_provider_bindings,
    ) = await _provider_projection(db, auth=auth, state=state)
    issued_at = _runtime_manifest_issued_at(state, provider_version_sources)
    manifest: dict[str, Any] = {
        "schemaVersion": "clawdi.hosted-runtime.manifest.v1",
        "deploymentId": state.deployment_id,
        "environmentId": str(environment_id),
        "instanceId": state.instance_id,
        "generation": state.generation,
        "issuedAt": issued_at,
        "runtime": runtime,
        "locale": locale.model_dump(),
        "system": state.system or _default_system(),
        "controlPlane": _control_plane(),
        "clawdiCli": _AGENT_V2_CLAWDI_CLI,
        "runtimes": _runtime_manifest_runtimes(
            state.runtimes,
            runtime_provider_bindings,
            runtime,
        ),
        "providers": providers,
        "liveSync": state.live_sync or _default_live_sync(env),
        "recovery": state.recovery or {"cacheManifest": True, "allowOfflineBoot": True},
    }
    manifest["minimumCliVersion"] = _AGENT_V2_MANIFEST_MINIMUM_CLI_VERSION
    if state.bridge:
        manifest["bridge"] = state.bridge
    if state.egress_engine:
        manifest["egressEngine"] = state.egress_engine
    if state.egress_profiles:
        manifest["egressProfiles"] = state.egress_profiles
    if state.mcp:
        manifest["mcp"] = state.mcp
    if state.tools:
        manifest["tools"] = state.tools
    payload = {"manifest": manifest, "secretValues": secret_values}
    # Include generation in the ETag. The hosted CLI does not treat generation
    # as a no-op bookkeeping field: runtime watch applies any non-304 manifest,
    # writes generation into managed state/run-config outputs, and caches it as
    # last-good. A generation-only control-plane bump must therefore wake the
    # watcher immediately instead of waiting for the self-heal refetch path.
    etag_payload = {
        "manifest": manifest,
        "secretValues": secret_values,
    }
    etag = strong_json_etag(etag_payload)
    headers = {"ETag": etag, "Cache-Control": "no-store"}
    if if_none_match_contains(request.headers.get("if-none-match"), etag):
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    return JSONResponse(payload, headers=headers)


def _runtime_manifest_issued_at(
    state: HostedRuntimeState,
    provider_version_sources: list[Any],
) -> str:
    # `HostedRuntimeState.updated_at` also moves when the daemon writes
    # observed liveness into the row. Runtime manifests must version desired
    # state, not heartbeat state, so only use the stable state creation time
    # plus provider config/secret timestamps here. Desired field changes still
    # alter the manifest payload and ETag directly.
    timestamps: list[datetime] = []
    if isinstance(state.created_at, datetime):
        timestamps.append(_as_utc(state.created_at))
    for source in provider_version_sources:
        for attr in ("updated_at", "created_at"):
            value = getattr(source, attr, None)
            if isinstance(value, datetime):
                timestamps.append(_as_utc(value))
                break
    if not timestamps:
        return datetime.now(UTC).isoformat()
    return max(timestamps).isoformat()


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _default_system() -> dict[str, Any]:
    return {
        "user": "clawdi",
        "home": "/home/clawdi",
        "workspace": "/home/clawdi/clawdi",
        "persistentPaths": ["/home/clawdi"],
    }


def _control_plane() -> dict[str, str]:
    api_url = settings.public_api_url.rstrip("/")
    return {"cloudApiUrl": api_url}


def _default_live_sync(env: AgentEnvironment) -> dict[str, Any]:
    return {
        "enabled": True,
        "agents": [
            {
                "agentType": env.agent_type,
                "environmentId": str(env.id),
            }
        ],
    }


async def _provider_projection(
    db: AsyncSession,
    *,
    auth: AuthContext,
    state: HostedRuntimeState,
) -> tuple[
    dict[str, Any],
    dict[str, str],
    list[Any],
    dict[str, _RuntimeProviderManifestBinding],
]:
    bindings = _runtime_provider_bindings(state)
    providers: dict[str, Any] = {}
    secret_values: dict[str, str] = {}
    version_sources: list[Any] = []
    provider_cache: dict[str | None, AiProvider | None] = {}
    secret_cache: dict[str, tuple[str | None, AiProviderAuthPayload | None]] = {}
    manifest_bindings: dict[str, _RuntimeProviderManifestBinding] = {}

    for runtime_name, binding in sorted(bindings.items()):
        resolved_providers: list[AiProvider] = []
        missing_provider_ids: list[str] = []
        for provider_id in binding.provider_ids:
            provider = await _select_provider_for_binding(
                db,
                auth=auth,
                provider_id=provider_id,
                allow_default_fallback=not binding.explicit_provider_ids,
                provider_cache=provider_cache,
            )
            if provider is None:
                if provider_id is not None:
                    missing_provider_ids.append(provider_id)
                continue
            if provider.provider_id not in {entry.provider_id for entry in resolved_providers}:
                resolved_providers.append(provider)

        if (
            not resolved_providers
            and not missing_provider_ids
            and not binding.explicit_provider_ids
        ):
            provider = await _select_provider_for_binding(
                db,
                auth=auth,
                provider_id=None,
                allow_default_fallback=True,
                provider_cache=provider_cache,
            )
            if provider is not None:
                resolved_providers.append(provider)

        primary_provider = _primary_provider_for_binding(binding, resolved_providers)
        primary_model = binding.primary_model or _managed_provider_catalog_model(primary_provider)
        manifest_provider_ids = _manifest_provider_ids(binding, resolved_providers)
        manifest_primary_provider_id = (
            primary_provider.provider_id
            if primary_provider is not None
            else binding.primary_provider_id
        )
        manifest_bindings[runtime_name] = _RuntimeProviderManifestBinding(
            provider_ids=manifest_provider_ids,
            primary_provider_id=manifest_primary_provider_id,
            primary_model=primary_model,
        )

        for missing_provider_id in missing_provider_ids:
            providers.setdefault(
                missing_provider_id,
                _unhealthy_provider_manifest_entry(
                    provider_id=missing_provider_id,
                    code="provider_not_found",
                    message="explicit runtime provider is missing or archived",
                ),
            )

        for provider in resolved_providers:
            if provider.provider_id in providers:
                continue
            if provider.provider_id not in secret_cache:
                secret_cache[provider.provider_id] = await _provider_secret(
                    db,
                    auth=auth,
                    provider=provider,
                )
            secret, payload = secret_cache[provider.provider_id]
            secret_ref = _provider_secret_ref(provider.provider_id) if secret else None
            missing_required_secret = _provider_requires_secret(provider) and not secret_ref
            providers[provider.provider_id] = _provider_manifest_entry(
                provider,
                secret_ref=secret_ref,
                error=(
                    {
                        "code": "provider_secret_unavailable",
                        "message": (
                            "provider requires an API key but no runtime secret value is available"
                        ),
                    }
                    if missing_required_secret
                    else None
                ),
            )
            if secret and secret_ref:
                secret_values[secret_ref] = secret
            if provider not in version_sources:
                version_sources.append(provider)
            if payload is not None and payload not in version_sources:
                version_sources.append(payload)

    return providers, secret_values, version_sources, manifest_bindings


def _primary_provider_for_binding(
    binding: _RuntimeProviderBinding,
    providers: list[AiProvider],
) -> AiProvider | None:
    if binding.primary_provider_id:
        for provider in providers:
            if provider.provider_id == binding.primary_provider_id:
                return provider
    return providers[0] if providers else None


def _manifest_provider_ids(
    binding: _RuntimeProviderBinding,
    providers: list[AiProvider],
) -> tuple[str, ...]:
    provider_ids = (
        tuple(provider_id for provider_id in binding.provider_ids if provider_id is not None)
        if binding.explicit_provider_ids
        else tuple(provider.provider_id for provider in providers)
    )
    if not provider_ids:
        provider_ids = tuple(provider.provider_id for provider in providers)
    seen: set[str] = set()
    normalized: list[str] = []
    for provider_id in (*provider_ids, *(provider.provider_id for provider in providers)):
        if provider_id in seen:
            continue
        seen.add(provider_id)
        normalized.append(provider_id)
    return tuple(normalized)


def _managed_provider_catalog_model(provider: AiProvider | None) -> str | None:
    if provider is None or not _is_clawdi_managed_provider(provider):
        return None
    for model in provider.models or []:
        if not isinstance(model, dict):
            continue
        model_id = model.get("id")
        if isinstance(model_id, str) and model_id.strip():
            return model_id.strip()
    return None


def _runtime_manifest_runtimes(
    runtimes: dict | None,
    bindings: dict[str, _RuntimeProviderManifestBinding],
    runtime_name: str,
) -> dict[str, Any]:
    raw_entry = (runtimes or {}).get(runtime_name)
    entry = deepcopy(raw_entry) if isinstance(raw_entry, dict) else {}
    binding = bindings.get(runtime_name)
    if binding is not None:
        for legacy_key in ("provider_id", "providerId", "model"):
            entry.pop(legacy_key, None)
        entry["provider_ids"] = list(binding.provider_ids)
        if binding.primary_provider_id and binding.primary_model:
            entry["primary_model"] = {
                "provider_id": binding.primary_provider_id,
                "model": binding.primary_model,
            }
        else:
            entry.pop("primary_model", None)
    return {runtime_name: entry}


def _provider_manifest_entry(
    provider: AiProvider,
    *,
    secret_ref: str | None,
    error: dict[str, str] | None = None,
) -> dict[str, Any]:
    projection: dict[str, Any] = {
        "kind": "openai-compatible",
        "type": provider.type,
        "baseUrl": provider.base_url,
    }
    is_managed = _is_clawdi_managed_provider(provider)
    api_mode = provider.api_mode
    runtime_env_name = provider.runtime_env_name
    if is_managed:
        api_mode = managed_provider_api_mode(provider.provider_id) or provider.api_mode
        runtime_env_name = MANAGED_AI_PROVIDER_RUNTIME_ENV
    if api_mode:
        projection["apiMode"] = api_mode
    if provider.managed_by == "clawdi":
        projection["managed_by"] = provider.managed_by
    if provider.models:
        projection["models"] = provider.models
    if runtime_env_name:
        projection["runtimeEnvName"] = runtime_env_name
    if _provider_requires_secret(provider) and not secret_ref:
        projection["apiKeyRequired"] = True
    if secret_ref:
        projection["apiKeySecretRef"] = secret_ref
    auth = _provider_manifest_auth(provider)
    if auth is not None:
        projection["auth"] = auth
    if error is not None:
        projection["status"] = "error"
        projection["error"] = error
    return projection


def _unhealthy_provider_manifest_entry(
    *,
    provider_id: str | None,
    code: str,
    message: str,
) -> dict[str, Any]:
    projection: dict[str, Any] = {
        "kind": "openai-compatible",
        "status": "error",
        "error": {"code": code, "message": message},
    }
    if provider_id:
        projection["providerId"] = provider_id
    return projection


def _provider_manifest_auth(provider: AiProvider) -> dict[str, str] | None:
    if provider.auth_type != "agent_profile":
        return None
    metadata = provider.auth_metadata or {}
    tool = metadata.get("tool")
    profile = metadata.get("profile")
    if tool != "codex" or not isinstance(profile, str) or not profile.strip():
        return None
    return {
        "type": "agent_profile",
        "tool": "codex",
        "profile": profile.strip(),
    }


def _provider_requires_secret(provider: AiProvider) -> bool:
    return provider.auth_type in {"api_key", "secret_ref"}


def _provider_secret_ref(runtime_name: str) -> str:
    normalized = re.sub(r"[^a-z0-9._-]+", "-", runtime_name.strip().lower())
    normalized = normalized.strip(".-") or "default"
    return f"provider.{normalized}.apiKey"


def _is_clawdi_managed_provider(provider: AiProvider) -> bool:
    return provider.provider_id in MANAGED_AI_PROVIDER_IDS or (
        provider.managed_by == "clawdi"
        and provider.auth_type == "api_key"
        and (provider.auth_metadata or {}).get("source") == "managed"
    )


def _runtime_provider_bindings(state: HostedRuntimeState) -> dict[str, _RuntimeProviderBinding]:
    bindings: dict[str, _RuntimeProviderBinding] = {}
    for runtime_name, runtime in (state.runtimes or {}).items():
        if not isinstance(runtime, dict) or runtime.get("enabled") is not True:
            continue
        runtime_key = str(runtime_name)
        if runtime_key not in _SUPPORTED_PROVIDER_RUNTIMES:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"unsupported enabled runtime: {runtime_key}",
            )
        provider_ids, explicit_provider_ids = _runtime_provider_ids(runtime, state.provider_id)
        primary_provider_id, primary_model = _runtime_primary_model(runtime)
        if primary_provider_id and primary_provider_id not in provider_ids:
            provider_ids = (*provider_ids, primary_provider_id)
            explicit_provider_ids = True
        if primary_provider_id is None and len(provider_ids) == 1:
            primary_provider_id = provider_ids[0]
        bindings[runtime_key] = _RuntimeProviderBinding(
            provider_ids=provider_ids,
            primary_provider_id=primary_provider_id,
            primary_model=primary_model,
            explicit_provider_ids=explicit_provider_ids,
        )
    return bindings


def _selected_runtime(runtimes: dict | None) -> str:
    enabled: list[str] = []
    for runtime_name, runtime in (runtimes or {}).items():
        if not isinstance(runtime, dict) or runtime.get("enabled") is not True:
            continue
        runtime_key = str(runtime_name)
        if runtime_key not in _SUPPORTED_PROVIDER_RUNTIMES:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"unsupported enabled runtime: {runtime_key}",
            )
        enabled.append(runtime_key)
    if len(enabled) != 1:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "hosted runtime state must select exactly one enabled runtime",
        )
    return enabled[0]


def _runtime_provider_ids(
    runtime: dict[str, Any],
    state_provider_id: str | None,
) -> tuple[tuple[str | None, ...], bool]:
    raw_provider_ids = runtime.get("provider_ids", runtime.get("providerIds"))
    if raw_provider_ids is not None:
        if not isinstance(raw_provider_ids, list) or not raw_provider_ids:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "enabled runtime provider_ids must be a non-empty array",
            )
        provider_ids = tuple(_runtime_provider_id(value) for value in raw_provider_ids)
        return provider_ids, True

    raw_provider_id = runtime.get("provider_id", runtime.get("providerId"))
    if raw_provider_id is not None:
        return (_runtime_provider_id(raw_provider_id),), True
    if state_provider_id is not None:
        return (_runtime_provider_id(state_provider_id),), False
    return (None,), False


def _runtime_provider_id(value: Any) -> str:
    if isinstance(value, str) and value.strip():
        return value.strip()
    raise HTTPException(
        status.HTTP_409_CONFLICT,
        "runtime state provider id must be a non-empty string",
    )


def _runtime_primary_model(runtime: dict[str, Any]) -> tuple[str | None, str | None]:
    raw_primary = runtime.get("primary_model", runtime.get("primaryModel"))
    if isinstance(raw_primary, dict):
        raw_provider_id = raw_primary.get("provider_id", raw_primary.get("providerId"))
        raw_model = raw_primary.get("model")
        provider_id = _runtime_provider_id(raw_provider_id) if raw_provider_id is not None else None
        model = _runtime_model(raw_model)
        return provider_id, model
    if raw_primary is not None:
        return None, _runtime_model(raw_primary)
    raw_model = runtime.get("model")
    if raw_model is not None:
        return None, _runtime_model(raw_model)
    return None, None


def _runtime_model(value: Any) -> str:
    if isinstance(value, str) and value.strip():
        return value.strip()
    raise HTTPException(
        status.HTTP_409_CONFLICT,
        "enabled runtime provider model must be a non-empty string",
    )


async def _select_provider_for_binding(
    db: AsyncSession,
    *,
    auth: AuthContext,
    provider_id: str | None,
    allow_default_fallback: bool,
    provider_cache: dict[str | None, AiProvider | None],
) -> AiProvider | None:
    if provider_id not in provider_cache:
        provider_cache[provider_id] = await _select_provider(
            db,
            auth=auth,
            provider_id=provider_id,
        )
    provider = provider_cache[provider_id]
    if provider is not None or provider_id is None:
        return provider
    if not allow_default_fallback:
        return None
    if None not in provider_cache:
        provider_cache[None] = await _select_provider(
            db,
            auth=auth,
            provider_id=None,
        )
    return provider_cache[None]


async def _select_provider(
    db: AsyncSession,
    *,
    auth: AuthContext,
    provider_id: str | None,
) -> AiProvider | None:
    filters = [AiProvider.owner_user_id == auth.user_id, AiProvider.archived_at.is_(None)]
    if provider_id:
        result = await db.execute(
            select(AiProvider).where(*filters, AiProvider.provider_id == provider_id)
        )
        return result.scalar_one_or_none()

    for managed_provider_id in (MANAGED_AI_PROVIDER_ID, V1_MANAGED_AI_PROVIDER_ID):
        result = await db.execute(
            select(AiProvider).where(
                *filters,
                AiProvider.provider_id == managed_provider_id,
            )
        )
        managed = result.scalar_one_or_none()
        if managed is not None:
            return managed

    result = await db.execute(select(AiProvider).where(*filters).order_by(AiProvider.provider_id))
    return result.scalars().first()


async def _provider_secret(
    db: AsyncSession,
    *,
    auth: AuthContext,
    provider: AiProvider,
) -> tuple[str | None, AiProviderAuthPayload | None]:
    if provider.auth_type != "api_key":
        return None, None
    metadata = provider.auth_metadata or {}
    if metadata.get("source") not in {None, "managed"}:
        return None, None
    profile = metadata.get("profile") if isinstance(metadata.get("profile"), str) else "default"
    payload = (
        await db.execute(
            select(AiProviderAuthPayload).where(
                AiProviderAuthPayload.owner_user_id == auth.user_id,
                AiProviderAuthPayload.provider_id == provider.provider_id,
                AiProviderAuthPayload.auth_profile == profile,
                AiProviderAuthPayload.archived_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if payload is None:
        return None, None
    return decrypt(payload.encrypted_payload, payload.nonce), payload
