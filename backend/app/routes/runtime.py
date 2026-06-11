from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
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
    auth: AuthContext = Depends(require_cli_auth),
    db: AsyncSession = Depends(get_session),
) -> Response:
    environment_id = auth.api_key.environment_id if auth.api_key is not None else None
    if environment_id is None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "runtime manifest requires an environment-bound API key",
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
    issued_at = _version_timestamp([state, env, *provider_version_sources])
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
    etag = strong_json_etag(payload)
    headers = {"ETag": etag, "Cache-Control": "no-store"}
    if if_none_match_contains(request.headers.get("if-none-match"), etag):
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    return JSONResponse(payload, headers=headers)


def _version_timestamp(sources: list[Any]) -> str:
    timestamps: list[datetime] = []
    for source in sources:
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
    provider = await _select_provider(db, auth=auth, provider_id=state.provider_id)
    if provider is None:
        return {}, {}, []

    secret, payload = await _provider_secret(db, auth=auth, provider=provider)
    projection: dict[str, Any] = {
        "kind": "openai-compatible",
        "baseUrl": provider.base_url,
    }
    if provider.default_model:
        projection["model"] = provider.default_model
    if secret:
        projection["apiKeySecretRef"] = _DEFAULT_PROVIDER_SECRET_REF

    secret_values = {_DEFAULT_PROVIDER_SECRET_REF: secret} if secret else {}
    version_sources: list[Any] = [provider]
    if payload is not None:
        version_sources.append(payload)
    return {"default": projection}, secret_values, version_sources


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
