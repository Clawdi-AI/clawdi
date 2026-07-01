from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_cli_auth
from app.core.config import settings
from app.core.database import get_session
from app.models.ai_provider import AiProvider, AiProviderAuthPayload
from app.models.hosted_runtime import HostedRuntimeState
from app.models.session import AgentEnvironment
from app.services.http_cache import if_none_match_contains, strong_json_etag
from app.services.managed_ai_provider import (
    MANAGED_AI_PROVIDER_ID,
    MANAGED_AI_PROVIDER_IDS,
    MANAGED_AI_PROVIDER_RUNTIME_ENV,
    V1_MANAGED_AI_PROVIDER_ID,
    managed_provider_api_mode,
)
from app.services.vault_crypto import decrypt

router = APIRouter(prefix="/api/runtime", tags=["runtime"])


@dataclass(frozen=True)
class _RuntimeProviderBinding:
    provider_id: str | None
    model: str | None


_SUPPORTED_PROVIDER_RUNTIMES = {"codex", "hermes", "openclaw"}


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

    providers, secret_values, provider_version_sources = await _provider_projection(
        db, auth=auth, state=state
    )
    issued_at = _runtime_manifest_issued_at(state, provider_version_sources)
    manifest: dict[str, Any] = {
        "schemaVersion": "clawdi.hosted-runtime.manifest.v1",
        "deploymentId": state.deployment_id,
        "environmentId": str(environment_id),
        "instanceId": state.instance_id,
        "generation": state.generation,
        "issuedAt": issued_at,
        "system": state.system or _default_system(),
        "controlPlane": _control_plane(state.control_plane),
        "clawdiCli": state.clawdi_cli or _default_clawdi_cli(),
        "runtimes": state.runtimes,
        "providers": providers,
        "liveSync": state.live_sync or _default_live_sync(env),
        "recovery": state.recovery or {"cacheManifest": True, "allowOfflineBoot": True},
    }
    if state.bridge:
        manifest["bridge"] = state.bridge
    if state.app_id:
        manifest["appId"] = state.app_id
    if state.mitm_profiles:
        manifest["mitmProfiles"] = state.mitm_profiles
    if state.mcp:
        manifest["mcp"] = state.mcp
    if state.tools:
        manifest["tools"] = state.tools
    payload = {"manifest": manifest, "secretValues": secret_values}
    etag_payload = {
        "manifest": {key: value for key, value in manifest.items() if key != "generation"},
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


def _control_plane(value: dict[str, Any] | None) -> dict[str, Any]:
    if value:
        return value
    api_url = settings.public_api_url.rstrip("/")
    return {
        "manifestUrl": f"{api_url}/api/runtime/manifest",
        "cloudApiUrl": api_url,
    }


def _default_clawdi_cli() -> dict[str, Any]:
    return {
        "source": "npm:clawdi",
        "packageSpec": "clawdi@latest",
        "managedConfig": True,
        "userEditableConfig": False,
    }


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
) -> tuple[dict[str, Any], dict[str, str], list[Any]]:
    bindings = _runtime_provider_bindings(state)
    providers: dict[str, Any] = {}
    secret_values: dict[str, str] = {}
    version_sources: list[Any] = []
    provider_cache: dict[str | None, AiProvider | None] = {}
    secret_cache: dict[str, tuple[str | None, AiProviderAuthPayload | None]] = {}

    for runtime_name, binding in sorted(bindings.items()):
        if binding.provider_id not in provider_cache:
            provider_cache[binding.provider_id] = await _select_provider(
                db,
                auth=auth,
                provider_id=binding.provider_id,
            )
        provider = provider_cache[binding.provider_id]
        if provider is None:
            continue

        if provider.provider_id not in secret_cache:
            secret_cache[provider.provider_id] = await _provider_secret(
                db,
                auth=auth,
                provider=provider,
            )
        secret, payload = secret_cache[provider.provider_id]
        secret_ref = _provider_secret_ref(runtime_name) if secret else None
        providers[runtime_name] = _provider_manifest_entry(
            provider,
            model=binding.model,
            secret_ref=secret_ref,
        )
        if secret and secret_ref:
            secret_values[secret_ref] = secret
        if provider not in version_sources:
            version_sources.append(provider)
        if payload is not None and payload not in version_sources:
            version_sources.append(payload)

    return providers, secret_values, version_sources


def _provider_manifest_entry(
    provider: AiProvider,
    *,
    model: str | None,
    secret_ref: str | None,
) -> dict[str, Any]:
    projection: dict[str, Any] = {
        "kind": "openai-compatible",
        "baseUrl": provider.base_url,
    }
    is_managed = _is_clawdi_managed_provider(provider)
    api_mode = provider.api_mode
    runtime_env_name = provider.runtime_env_name
    if is_managed:
        api_mode = managed_provider_api_mode(provider.provider_id) or provider.api_mode
        runtime_env_name = MANAGED_AI_PROVIDER_RUNTIME_ENV
    selected_model = model or provider.default_model
    if selected_model:
        projection["model"] = selected_model
    if api_mode:
        projection["apiMode"] = api_mode
    if runtime_env_name:
        projection["runtimeEnvName"] = runtime_env_name
    if secret_ref:
        projection["apiKeySecretRef"] = secret_ref
    auth = _provider_manifest_auth(provider)
    if auth is not None:
        projection["type"] = provider.type
        projection["auth"] = auth
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
        raw_provider_id = runtime.get("provider_id", runtime.get("providerId"))
        if raw_provider_id is None:
            provider_id = state.provider_id
        elif isinstance(raw_provider_id, str) and raw_provider_id.strip():
            provider_id = raw_provider_id.strip()
        else:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "enabled runtime provider id must be a non-empty string",
            )
        if provider_id is not None:
            if not isinstance(provider_id, str) or not provider_id.strip():
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "runtime state provider id must be a non-empty string",
                )
            provider_id = provider_id.strip()
        model = runtime.get("model", runtime.get("primary_model"))
        if model is not None and (not isinstance(model, str) or not model.strip()):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "enabled runtime provider model must be a non-empty string",
            )
        bindings[runtime_key] = _RuntimeProviderBinding(
            provider_id=provider_id,
            model=model.strip() if isinstance(model, str) else None,
        )
    if not bindings and state.provider_id:
        bindings["default"] = _RuntimeProviderBinding(
            provider_id=state.provider_id,
            model=None,
        )
    return bindings


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
