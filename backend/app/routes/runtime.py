from __future__ import annotations

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
from app.services.vault_crypto import decrypt

router = APIRouter(prefix="/api/runtime", tags=["runtime"])

_DEFAULT_PROVIDER_SECRET_REF = "provider.default.apiKey"
_MANAGED_PROVIDER_ID = "clawdi-managed"


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
    provider_id = _runtime_provider_id(state)
    provider = await _select_provider(db, auth=auth, provider_id=provider_id)
    if provider is None:
        return {}, {}, []

    secret, payload = await _provider_secret(db, auth=auth, provider=provider)
    projection: dict[str, Any] = {
        "kind": "openai-compatible",
        "baseUrl": provider.base_url,
    }
    if provider.default_model:
        projection["model"] = provider.default_model
    if provider.api_mode:
        projection["apiMode"] = provider.api_mode
    if provider.runtime_env_name:
        projection["runtimeEnvName"] = provider.runtime_env_name
    if secret:
        projection["apiKeySecretRef"] = _DEFAULT_PROVIDER_SECRET_REF

    secret_values = {_DEFAULT_PROVIDER_SECRET_REF: secret} if secret else {}
    version_sources: list[Any] = [provider]
    if payload is not None:
        version_sources.append(payload)
    return {"default": projection}, secret_values, version_sources


def _runtime_provider_id(state: HostedRuntimeState) -> str | None:
    declared_provider_ids: set[str] = set()
    for runtime in (state.runtimes or {}).values():
        if not isinstance(runtime, dict) or runtime.get("enabled") is not True:
            continue
        provider_id = runtime.get("provider_id", runtime.get("providerId"))
        if provider_id is None:
            continue
        if not isinstance(provider_id, str) or not provider_id.strip():
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "enabled runtime provider id must be a non-empty string",
            )
        declared_provider_ids.add(provider_id)

    if len(declared_provider_ids) > 1:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "enabled runtimes must use a single provider id",
        )

    declared_provider_id = next(iter(declared_provider_ids), None)
    if state.provider_id and declared_provider_id and state.provider_id != declared_provider_id:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "runtime state provider id does not match enabled runtime provider id",
        )
    return state.provider_id or declared_provider_id


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

    result = await db.execute(
        select(AiProvider).where(*filters, AiProvider.provider_id == _MANAGED_PROVIDER_ID)
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
