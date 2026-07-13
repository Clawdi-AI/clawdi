from __future__ import annotations

import re
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
from app.services.http_cache import if_none_match_contains, strong_json_etag
from app.services.managed_ai_provider import (
    MANAGED_AI_PROVIDER_IDS,
    MANAGED_AI_PROVIDER_RUNTIME_ENV,
    managed_provider_api_mode,
)
from app.services.vault_crypto import decrypt

router = APIRouter(prefix="/runtime", tags=["runtime"])


_SUPPORTED_PROVIDER_RUNTIMES = {"hermes", "openclaw"}


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
        system = HostedRuntimeSystem.model_validate(state.system)
        live_sync = HostedRuntimeLiveSync.model_validate(state.live_sync)
        recovery = HostedRuntimeRecovery.model_validate(state.recovery)
    except ValidationError as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Hosted runtime locale, system, live sync, or recovery state "
            "is invalid or not configured",
        ) from exc
    try:
        bridge = (
            HostedRuntimeBridge.model_validate(state.bridge) if state.bridge is not None else None
        )
    except ValidationError as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Hosted runtime bridge state is invalid",
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
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Hosted runtime egress state is invalid",
        ) from exc
    try:
        cli_package_spec = validate_clawdi_cli_package_spec(state.cli_package_spec)
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Hosted runtime CLI package spec is invalid or below the minimum version",
        ) from exc
    runtime, runtime_state = _validated_runtime_state(state.runtimes)
    try:
        validate_hosted_runtime_bridge(runtime, bridge)
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Hosted runtime bridge state does not match the selected runtime",
        ) from exc

    providers, secret_values = await _provider_projection(
        db,
        auth=auth,
        runtime_name=runtime,
        runtime=runtime_state,
    )
    issued_at = _as_utc(state.created_at).isoformat()
    manifest: dict[str, Any] = {
        "schemaVersion": "clawdi.hosted-runtime.manifest.v1",
        "deploymentId": state.deployment_id,
        "environmentId": str(environment_id),
        "instanceId": state.instance_id,
        "generation": state.generation,
        "issuedAt": issued_at,
        "runtime": runtime,
        "locale": locale.model_dump(),
        "system": system.model_dump(exclude_none=True, mode="json"),
        "controlPlane": _control_plane(),
        "clawdiCli": {
            "source": "npm:clawdi",
            "packageSpec": cli_package_spec,
            "registry": "https://registry.npmjs.org",
        },
        "runtimes": {runtime: runtime_state},
        "providers": providers,
        "liveSync": live_sync.model_dump(mode="json"),
        "recovery": recovery.model_dump(mode="json"),
    }
    manifest["minimumCliVersion"] = _AGENT_V2_MANIFEST_MINIMUM_CLI_VERSION
    if bridge is not None:
        manifest["bridge"] = bridge.model_dump(exclude_none=True, exclude_unset=True, mode="json")
    if egress_engine is not None:
        manifest["egressEngine"] = egress_engine.model_dump(
            exclude_none=True,
            exclude_unset=True,
            mode="json",
        )
    if egress_profiles is not None:
        manifest["egressProfiles"] = egress_profiles.model_dump(
            exclude_none=True,
            exclude_unset=True,
            mode="json",
        )
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


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _control_plane() -> dict[str, str]:
    api_url = settings.public_api_url.rstrip("/")
    return {"cloudApiUrl": api_url}


def _validated_runtime_state(
    runtimes: dict | None,
) -> tuple[HostedRuntimeName, dict[str, Any]]:
    if not isinstance(runtimes, dict) or len(runtimes) != 1:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "hosted runtime state must select exactly one enabled runtime",
        )
    raw_runtime_name, raw_runtime = next(iter(runtimes.items()))
    if raw_runtime_name not in _SUPPORTED_PROVIDER_RUNTIMES:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"unsupported enabled runtime: {raw_runtime_name}",
        )
    runtime_name: HostedRuntimeName = "hermes" if raw_runtime_name == "hermes" else "openclaw"
    try:
        runtime = HostedRuntimeDesiredState.model_validate(raw_runtime)
    except ValidationError as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"hosted runtime state for {runtime_name} is invalid",
        ) from exc
    return runtime_name, runtime.model_dump(exclude_none=True, mode="json")


def _runtime_provider_binding(runtime: dict[str, Any]) -> tuple[str, ...]:
    return tuple(runtime["provider_ids"])


async def _provider_projection(
    db: AsyncSession,
    *,
    auth: AuthContext,
    runtime_name: str,
    runtime: dict[str, Any],
) -> tuple[
    dict[str, Any],
    dict[str, str],
]:
    provider_ids = _runtime_provider_binding(runtime)
    providers: dict[str, Any] = {}
    secret_values: dict[str, str] = {}
    provider_cache: dict[str, AiProvider | None] = {}
    secret_cache: dict[str, str | None] = {}
    resolved_providers: list[AiProvider] = []
    for provider_id in provider_ids:
        if provider_id not in provider_cache:
            provider_cache[provider_id] = await _select_provider(
                db,
                auth=auth,
                provider_id=provider_id,
            )
        provider = provider_cache[provider_id]
        if provider is None:
            providers[provider_id] = _unhealthy_provider_manifest_entry(
                code="provider_not_found",
                message=f"provider required by {runtime_name} is missing or archived",
            )
            continue
        resolved_providers.append(provider)

    for provider in resolved_providers:
        if provider.provider_id not in secret_cache:
            secret_cache[provider.provider_id] = await _provider_secret(
                db,
                auth=auth,
                provider=provider,
            )
        secret = secret_cache[provider.provider_id]
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
    return providers, secret_values


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
    if provider.models is not None:
        try:
            if not isinstance(provider.models, list):
                raise ValueError("provider models must be a list")
            models = [
                AiProviderModel.model_validate(model).model_dump(exclude_none=True)
                for model in provider.models
            ]
        except (ValidationError, ValueError) as exc:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Stored AI provider model metadata is invalid",
            ) from exc
        if models:
            projection["models"] = models
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
    code: str,
    message: str,
) -> dict[str, Any]:
    return {
        "kind": "openai-compatible",
        "status": "error",
        "error": {"code": code, "message": message},
    }


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


async def _select_provider(
    db: AsyncSession,
    *,
    auth: AuthContext,
    provider_id: str,
) -> AiProvider | None:
    filters = [AiProvider.owner_user_id == auth.user_id, AiProvider.archived_at.is_(None)]
    result = await db.execute(
        select(AiProvider).where(*filters, AiProvider.provider_id == provider_id)
    )
    return result.scalar_one_or_none()


async def _provider_secret(
    db: AsyncSession,
    *,
    auth: AuthContext,
    provider: AiProvider,
) -> str | None:
    if provider.auth_type != "api_key":
        return None
    metadata = provider.auth_metadata or {}
    if metadata.get("source") not in {None, "managed"}:
        return None
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
        return None
    return decrypt(payload.encrypted_payload, payload.nonce)
