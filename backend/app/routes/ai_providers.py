import base64
import binascii
import hashlib
import json
import logging
import re
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal
from urllib.parse import urlencode, urlparse
from uuid import UUID, uuid4

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import (
    AuthContext,
    get_auth_short_session,
    require_user_auth,
    require_user_auth_unbound,
    require_user_cli,
)
from app.core.config import settings
from app.core.database import async_session_factory, get_session
from app.models.ai_provider import (
    AiProvider,
    AiProviderAuthPayload,
    AiProviderOAuthAttempt,
)
from app.models.user import User
from app.schemas.ai_provider import (
    AiProviderAcceptRequest,
    AiProviderAcceptResponse,
    AiProviderApiKeyAcceptCredential,
    AiProviderAuth,
    AiProviderAuthImportRequest,
    AiProviderAuthResolveRequest,
    AiProviderAuthResolveResponse,
    AiProviderConnectionError,
    AiProviderConnectionTestRequest,
    AiProviderConnectionTestResponse,
    AiProviderConsumer,
    AiProviderDeleteResponse,
    AiProviderListResponse,
    AiProviderManagedApiKeyRequest,
    AiProviderModel,
    AiProviderOAuthAcceptCredential,
    AiProviderOAuthCompleteRequest,
    AiProviderOAuthDevicePendingResponse,
    AiProviderOAuthDevicePollRequest,
    AiProviderOAuthDevicePollResponse,
    AiProviderOAuthDeviceReadyResponse,
    AiProviderOAuthDeviceStartRequest,
    AiProviderOAuthDeviceStartResponse,
    AiProviderOAuthPendingAcceptResponse,
    AiProviderOAuthStartRequest,
    AiProviderOAuthStartResponse,
    AiProviderPatch,
    AiProviderReadiness,
    AiProviderReadyAcceptResponse,
    AiProviderResponse,
    AiProviderSavedConnectionTestRequest,
    AiProviderUpsert,
    AiProviderValidationResponse,
    ConnectionErrorCategory,
    CredentialMaterialState,
    ai_provider_auth_from_persistence,
)
from app.services.ai_provider_auth_transition import (
    AuthCredentialWrite,
    OAuthRevokeTombstoneRef,
    cancel_oauth_revoke_tombstone,
    enqueue_oauth_revoke_tombstone,
    transition_ai_provider_auth,
)
from app.services.ai_provider_capabilities import (
    AiProviderCapabilityInput,
    effective_provider_api_mode,
    provider_readiness,
)
from app.services.ai_provider_connection import test_ai_provider_connection
from app.services.ai_provider_credentials import (
    OAuthCredentialClaimConflict,
    OAuthCredentialConsumer,
    claim_oauth_payload,
    environment_binds_provider,
    environment_matches_runtime,
)
from app.services.ai_provider_oauth_lifecycle import terminal_oauth_attempt
from app.services.codex_oauth import (
    CODEX_DEVICE_VERIFICATION_URL,
    CODEX_OAUTH_CLIENT_ID,
    CODEX_OAUTH_TOKEN_URL,
    CodexOAuthUpstreamError,
    exchange_device_code,
    poll_device_authorization,
    start_device_authorization,
)
from app.services.managed_ai_provider import (
    MANAGED_AI_PROVIDER_IDS,
    MANAGED_AI_PROVIDER_RUNTIME_ENV,
    V2_MANAGED_AI_PROVIDER_ID,
    V2_MANAGED_AI_PROVIDER_IDS,
    is_v2_deployment_managed_provider_id,
    managed_provider_api_mode,
    runtime_managed_provider_id,
)
from app.services.platform_contract import (
    PlatformReplay,
    lock_platform_idempotency,
    platform_request_hash,
    read_platform_replay,
    store_platform_response,
)
from app.services.sync_events import queue_provider_runtime_manifest_changed
from app.services.vault_crypto import decrypt, encrypt

router = APIRouter(prefix="/ai-providers", tags=["ai-providers"])
logger = logging.getLogger(__name__)
AI_PROVIDER_SCOPE = "account_global"

ALLOWED_API_MODES: dict[str, set[str]] = {
    "openai": {"openai_chat", "openai_responses"},
    "anthropic": {"anthropic_messages"},
    "openrouter": {"openai_chat"},
    "gemini": {"google_generate_content"},
    "mistral": {"openai_chat"},
    "custom_openai_compatible": {
        "openai_chat",
        "openai_responses",
    },
}
OAUTH_STATE_TTL_SECONDS = 10 * 60
OAUTH_DEVICE_STATE_TTL_SECONDS = 15 * 60
OAUTH_EXCHANGE_STALE_SECONDS = 2 * 60
CODEX_OAUTH_PROVIDER = "codex"
CODEX_OPENAI_BASE_URL = "https://api.openai.com/v1"
SUPPORTED_AGENT_PROFILE_TOOLS = {CODEX_OAUTH_PROVIDER}
SUPPORTED_OAUTH_PROVIDERS = {CODEX_OAUTH_PROVIDER}
CODEX_OAUTH_CONFIG = {
    "authorization_url": "https://auth.openai.com/oauth/authorize",
    "token_url": CODEX_OAUTH_TOKEN_URL,
    "client_id": CODEX_OAUTH_CLIENT_ID,
    "scope": "openid profile email offline_access api.connectors.read api.connectors.invoke",
    "extra_authorize_params": {
        "id_token_add_organizations": "true",
        "codex_cli_simplified_flow": "true",
        "originator": "codex_cli_rs",
    },
}
BUILTIN_OAUTH_CONFIGS = {CODEX_OAUTH_PROVIDER: CODEX_OAUTH_CONFIG}
RESERVED_OAUTH_AUTHORIZE_PARAMS = {
    "audience",
    "client_id",
    "code_challenge",
    "code_challenge_method",
    "redirect_uri",
    "response_type",
    "scope",
    "state",
}

IdempotencyKey = Annotated[
    str,
    Header(alias="Idempotency-Key", min_length=1, max_length=200),
]

_AI_PROVIDER_ACCEPT_OPERATION = "ai_provider.accept"


async def _require_ai_provider_accept_auth(
    auth: AuthContext = Depends(get_auth_short_session),
) -> AuthContext:
    if auth.is_cli and auth.api_key is not None:
        if auth.api_key.scopes is not None:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "This endpoint is not available to scoped api keys",
            )
        if auth.api_key.environment_id is not None:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "user-level auth is required (Agent API keys cannot manage account resources)",
            )
    return auth


@router.get("", response_model=AiProviderListResponse, response_model_exclude_none=True)
async def list_ai_providers(
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> AiProviderListResponse:
    rows = (
        (
            await db.execute(
                select(AiProvider)
                .where(AiProvider.owner_user_id == auth.user_id, AiProvider.archived_at.is_(None))
                .order_by(AiProvider.provider_id)
            )
        )
        .scalars()
        .all()
    )
    visible_rows = [
        row for row in rows if not is_v2_deployment_managed_provider_id(row.provider_id)
    ]
    responses = await _to_responses(db, auth, visible_rows)
    providers_by_public_id: dict[str, AiProviderResponse] = {}
    for response in responses:
        providers_by_public_id.setdefault(response.provider_id, response)
    return AiProviderListResponse(providers=list(providers_by_public_id.values()))


@router.post("", response_model=AiProviderResponse, response_model_exclude_none=True)
async def upsert_ai_provider(
    body: AiProviderUpsert,
    replace: bool = Query(default=False),
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> AiProviderResponse:
    _raise_if_deployment_managed_provider_id(body.provider_id)
    if body.provider_id in V2_MANAGED_AI_PROVIDER_IDS:
        body = body.model_copy(update={"provider_id": V2_MANAGED_AI_PROVIDER_ID})
    errors = _validate_provider(body)
    if errors:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"errors": errors})
    await _lock_provider_pool(db, auth.user_id)
    await _validate_runtime_env_unique(db, auth, body)
    existing = await _find_provider(db, auth, body.provider_id, include_archived=True)
    if existing is not None and existing.archived_at is None and not replace:
        raise HTTPException(status.HTTP_409_CONFLICT, "AI Provider already exists")
    previous_non_auth_signature = _runtime_manifest_provider_non_auth_signature(existing)
    auth_event_queued = False
    provider = existing or AiProvider(owner_user_id=auth.user_id, provider_id=body.provider_id)
    _apply_provider_body(provider, body, apply_auth=False)
    auth_ref, auth_metadata = body.auth.persistence_fields()
    if existing is None:
        provider.auth_type = body.auth.type
        provider.auth_ref = auth_ref
        provider.auth_metadata = auth_metadata
    else:
        transition = await transition_ai_provider_auth(
            db,
            owner_user_id=auth.user_id,
            provider=provider,
            auth_type=body.auth.type,
            auth_ref=auth_ref,
            auth_metadata=auth_metadata,
        )
        auth_event_queued = transition.manifest_event_queued
    provider.archived_at = None
    db.add(provider)
    if (
        previous_non_auth_signature != _runtime_manifest_provider_non_auth_signature(provider)
        and not auth_event_queued
    ):
        await queue_provider_runtime_manifest_changed(db, auth.user_id, provider.provider_id)
    await db.commit()
    await db.refresh(provider)
    return await _to_response(db, auth, provider)


@router.post(
    "/{provider_id}/auth/oauth/device/poll",
    response_model=AiProviderOAuthDevicePollResponse,
    response_model_exclude_none=True,
)
async def poll_ai_provider_oauth_device(
    provider_id: str,
    body: AiProviderOAuthDevicePollRequest,
    auth: AuthContext = Depends(require_user_auth_unbound),
    request_db: AsyncSession = Depends(get_session),
) -> AiProviderOAuthDevicePollResponse:
    await _get_provider_or_404(request_db, auth, provider_id)
    async with async_session_factory() as db:
        attempt = await _load_oauth_attempt(
            db,
            state_identity=_oauth_attempt_state_identity(body.state),
            owner_user_id=auth.user_id,
            provider_id=provider_id,
            flow_kind="device_code",
        )
        replay = _oauth_attempt_replay(attempt)
        if replay is not None:
            return AiProviderOAuthDeviceReadyResponse(status="ready", provider=replay)
        if attempt.status != "pending":
            raise HTTPException(status.HTTP_409_CONFLICT, "OAuth completion is not pending")
        oauth_state = _oauth_attempt_flow_payload(attempt)
        oauth_provider = attempt.oauth_provider
        await db.rollback()

    interval_seconds = oauth_state.get("poll_interval_seconds")
    retry_after_seconds = (
        min(max(interval_seconds, 1), 30) if isinstance(interval_seconds, int) else 5
    )
    config = _oauth_config_for(oauth_provider)
    client_id = _required_oauth_config(config, "client_id", oauth_provider)
    if client_id != CODEX_OAUTH_CLIENT_ID:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "ChatGPT device sign-in requires the official Codex OAuth client",
        )
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            poll_result = await poll_device_authorization(
                client,
                device_auth_id=str(oauth_state.get("device_auth_id") or ""),
                user_code=str(oauth_state.get("user_code") or ""),
            )
            if poll_result.pending:
                return AiProviderOAuthDevicePendingResponse(
                    status="pending",
                    retry_after_seconds=retry_after_seconds,
                )
            if poll_result.authorization_code is None or poll_result.code_verifier is None:
                raise HTTPException(
                    status.HTTP_502_BAD_GATEWAY,
                    "ChatGPT device authorization response was incomplete",
                )
    except CodexOAuthUpstreamError as exc:
        if exc.pending_retry and exc.retry_after is not None:
            return AiProviderOAuthDevicePendingResponse(
                status="pending",
                retry_after_seconds=exc.retry_after,
            )
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS
            if exc.retry_after is not None
            else (
                status.HTTP_503_SERVICE_UNAVAILABLE
                if exc.unavailable
                else status.HTTP_502_BAD_GATEWAY
            ),
            str(exc),
            headers=(
                {"Retry-After": str(exc.retry_after)} if exc.retry_after is not None else None
            ),
        ) from exc

    attempt_id, replay = await _begin_oauth_attempt_exchange(
        owner_user_id=auth.user_id,
        provider_id=provider_id,
        state=body.state,
        flow_kind="device_code",
        payload_updates={
            "authorization_code": poll_result.authorization_code,
            "code_verifier": poll_result.code_verifier,
        },
    )
    if replay is not None:
        return AiProviderOAuthDeviceReadyResponse(status="ready", provider=replay)
    provider_response = await _exchange_and_commit_oauth_attempt(attempt_id, auth)
    return AiProviderOAuthDeviceReadyResponse(status="ready", provider=provider_response)


@router.post(
    "/accept",
    response_model=AiProviderAcceptResponse,
    response_model_exclude_none=True,
    status_code=status.HTTP_201_CREATED,
)
async def accept_ai_provider(
    body: AiProviderAcceptRequest,
    idempotency_key: IdempotencyKey,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> AiProviderAcceptResponse | JSONResponse:
    """Atomically create or explicitly replace a provider and credential."""

    request_hash = _ai_provider_accept_request_hash(body)
    try:
        replay = await _load_ai_provider_accept_replay(
            db,
            operation=_AI_PROVIDER_ACCEPT_OPERATION,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            owner_user_id=auth.user_id,
        )
        if replay is not None:
            await db.commit()
            return JSONResponse(status_code=replay.status_code, content=replay.body)

        result = await _accept_ai_provider(db, auth, body)
        response_body = result.model_dump(mode="json", exclude_none=True)
        store_platform_response(
            db,
            operation=_AI_PROVIDER_ACCEPT_OPERATION,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            owner_user_id=auth.user_id,
            resource_type=(
                "ai_provider_oauth_setup"
                if isinstance(result, AiProviderOAuthPendingAcceptResponse)
                else "ai_provider"
            ),
            resource_id=result.provider.provider_id,
            response_status=status.HTTP_201_CREATED,
            response_body=response_body,
        )
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    return result


@router.post(
    "/test",
    response_model=AiProviderConnectionTestResponse,
    response_model_exclude_none=True,
)
async def test_ai_provider(
    body: AiProviderConnectionTestRequest,
    _auth: AuthContext = Depends(_require_ai_provider_accept_auth),
) -> AiProviderConnectionTestResponse:
    """Verify a draft credential, endpoint, protocol, and model without persisting it."""

    provider = body.provider
    errors = _validate_provider(provider)
    if errors:
        return _connection_test_failure(
            provider,
            credential_material="available",
            category="validation",
            code="invalid_provider",
            message="Provider configuration is invalid.",
            retryable=False,
        )

    credential_material = "available"
    if provider.auth.type != "api_key" or provider.auth.source != "managed":
        return _connection_test_failure(
            provider,
            credential_material=credential_material,
            category="credential",
            code="credential_contract_mismatch",
            message="The supplied credential does not match the provider auth configuration.",
            retryable=False,
        )
    credential = body.credential.value.get_secret_value()

    model, model_api_mode = _connection_test_model(provider, body.model)
    if not model:
        return _connection_test_failure(
            provider,
            credential_material=credential_material,
            category="validation",
            code="model_required",
            message="Choose a model before testing the provider.",
            retryable=False,
        )
    api_mode = effective_provider_api_mode(provider.type, model_api_mode or provider.api_mode)
    if api_mode is None:
        return _connection_test_failure(
            provider,
            credential_material=credential_material,
            category="validation",
            code="protocol_required",
            message="Choose a provider protocol before testing the provider.",
            retryable=False,
        )

    result = await test_ai_provider_connection(
        provider_type=provider.type,
        base_url=provider.base_url,
        api_mode=api_mode,
        model=model,
        credential=credential,
    )
    endpoint_state = (
        "verified" if result.ok or (result.error and result.error.endpoint_reachable) else "failed"
    )
    readiness = provider_readiness(
        _provider_capability_input(provider, effective_api_mode=api_mode),
        credential_material=credential_material,
        endpoint_reachability=endpoint_state,
        inference_verification="verified" if result.ok else "failed",
    )
    if result.ok:
        return AiProviderConnectionTestResponse(ok=True, readiness=readiness)
    if result.error is None:  # pragma: no cover - service result invariant
        raise RuntimeError("failed connection test is missing an error")
    return AiProviderConnectionTestResponse(
        ok=False,
        readiness=readiness,
        error=AiProviderConnectionError(
            category=result.error.category,
            code=result.error.code,
            message=result.error.message,
            retryable=result.error.retryable,
        ),
    )


@router.post(
    "/{provider_id}/test",
    response_model=AiProviderConnectionTestResponse,
    response_model_exclude_none=True,
)
async def test_saved_ai_provider(
    provider_id: str,
    body: AiProviderSavedConnectionTestRequest,
    auth: AuthContext = Depends(_require_ai_provider_accept_auth),
) -> AiProviderConnectionTestResponse:
    """Verify a saved managed API key without exposing it to the caller."""

    async with async_session_factory() as db:
        provider = await _get_provider_or_404(db, auth, provider_id)
        active_profile = _active_auth_profile(provider)
        payload = (
            await _find_auth_payload(db, auth, provider.provider_id, active_profile)
            if active_profile is not None
            else None
        )
        payload_keys = (
            {(payload.provider_id, payload.auth_profile, payload.kind)}
            if payload is not None and payload.archived_at is None
            else set()
        )
        credential_material = _provider_credential_material(provider, payload_keys)
        readiness = provider_readiness(
            _provider_capability_input(provider),
            credential_material=credential_material,
        )
        metadata = provider.auth_metadata or {}
        auth_source = metadata.get("source")
        auth_ref = provider.auth_ref or ""
        if auth_source == "env" or auth_ref.startswith("env:"):
            return _connection_test_failure_with_readiness(
                readiness,
                category="credential",
                code="env_credential_not_testable",
                message=(
                    "Environment credentials are resolved inside the target runtime. Test this "
                    "provider there or replace the credential with a managed API key."
                ),
                retryable=False,
            )
        if auth_source == "vault" or auth_ref.startswith("clawdi://"):
            return _connection_test_failure_with_readiness(
                readiness,
                category="credential",
                code="vault_credential_not_testable",
                message=(
                    "Vault credentials are resolved inside the target runtime. Test this "
                    "provider there or replace the credential with a managed API key."
                ),
                retryable=False,
            )
        if provider.auth_type in {"oauth_profile", "agent_profile"}:
            return _connection_test_failure_with_readiness(
                readiness,
                category="credential",
                code="oauth_credential_not_testable",
                message=(
                    "OAuth credentials cannot be used for this connection test. Use the provider "
                    "sign-in flow or replace the credential with a managed API key."
                ),
                retryable=False,
            )
        if provider.auth_type == "none":
            return _connection_test_failure_with_readiness(
                readiness,
                category="credential",
                code="none_auth_not_testable",
                message=(
                    "Providers without authentication cannot be tested by the service. Test this "
                    "provider from its target runtime."
                ),
                retryable=False,
            )
        if provider.auth_type != "api_key" or auth_source != "managed":
            return _connection_test_failure_with_readiness(
                readiness,
                category="credential",
                code="saved_auth_not_testable",
                message=(
                    "This saved authentication method cannot be tested by the service. Replace "
                    "it with a managed API key to test it here."
                ),
                retryable=False,
            )
        if (
            payload is None
            or payload.archived_at is not None
            or payload.kind != "api_key"
            or payload.source != "managed"
        ):
            return _connection_test_failure_with_readiness(
                readiness,
                category="credential",
                code="saved_credential_missing",
                message="Save the managed API key again before testing this provider.",
                retryable=False,
            )
        try:
            credential = decrypt(payload.encrypted_payload, payload.nonce)
        except Exception:
            return _connection_test_failure_with_readiness(
                provider_readiness(
                    _provider_capability_input(provider),
                    credential_material="missing",
                ),
                category="credential",
                code="saved_credential_unreadable",
                message="The saved API key could not be read. Save it again before testing.",
                retryable=False,
            )
        if not credential.strip():
            return _connection_test_failure_with_readiness(
                provider_readiness(
                    _provider_capability_input(provider),
                    credential_material="missing",
                ),
                category="credential",
                code="saved_credential_invalid",
                message="The saved API key is empty. Save it again before testing.",
                retryable=False,
            )
        model, model_api_mode = _connection_test_model(provider, body.model)
        if not model:
            return _connection_test_failure_with_readiness(
                readiness,
                category="validation",
                code="model_required",
                message="Choose a model before testing the provider.",
                retryable=False,
            )
        api_mode = effective_provider_api_mode(
            provider.type,
            model_api_mode or provider.api_mode,
        )
        if api_mode is None:
            return _connection_test_failure_with_readiness(
                readiness,
                category="validation",
                code="protocol_required",
                message="Choose a provider protocol before testing the provider.",
                retryable=False,
            )
        provider_type = provider.type
        base_url = provider.base_url
        capability_input = _provider_capability_input(provider, effective_api_mode=api_mode)

    result = await test_ai_provider_connection(
        provider_type=provider_type,
        base_url=base_url,
        api_mode=api_mode,
        model=model,
        credential=credential,
    )
    endpoint_state = (
        "verified" if result.ok or (result.error and result.error.endpoint_reachable) else "failed"
    )
    readiness = provider_readiness(
        capability_input,
        credential_material="available",
        endpoint_reachability=endpoint_state,
        inference_verification="verified" if result.ok else "failed",
    )
    if result.ok:
        return AiProviderConnectionTestResponse(ok=True, readiness=readiness)
    if result.error is None:  # pragma: no cover - service result invariant
        return _connection_test_failure_with_readiness(
            readiness,
            category="network",
            code="request_failed",
            message="Provider request failed.",
            retryable=True,
        )
    return AiProviderConnectionTestResponse(
        ok=False,
        readiness=readiness,
        error=AiProviderConnectionError(
            category=result.error.category,
            code=result.error.code,
            message=result.error.message,
            retryable=result.error.retryable,
        ),
    )


@router.get("/{provider_id}", response_model=AiProviderResponse, response_model_exclude_none=True)
async def get_ai_provider(
    provider_id: str,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> AiProviderResponse:
    provider = await _get_provider_or_404(db, auth, provider_id)
    return await _to_response(db, auth, provider)


@router.patch("/{provider_id}", response_model=AiProviderResponse, response_model_exclude_none=True)
async def patch_ai_provider(
    provider_id: str,
    body: AiProviderPatch,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> AiProviderResponse:
    await _lock_provider_pool(db, auth.user_id)
    provider = await _get_provider_or_404_for_update(db, auth, provider_id)
    previous_non_auth_signature = _runtime_manifest_provider_non_auth_signature(provider)
    auth_event_queued = False
    merged = await _to_response(db, auth, provider)
    update = {field: getattr(body, field) for field in body.model_fields_set}
    null_errors = _validate_patch_nulls(update)
    if null_errors:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"errors": null_errors})
    for key, value in update.items():
        setattr(merged, key, value)
    errors = _validate_provider(merged)
    if errors:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"errors": errors})
    await _validate_runtime_env_unique(db, auth, merged, exclude_provider_id=provider.provider_id)
    _apply_provider_body(provider, merged, apply_auth=False)
    if "auth" in body.model_fields_set:
        auth_ref, auth_metadata = merged.auth.persistence_fields()
        transition = await transition_ai_provider_auth(
            db,
            owner_user_id=auth.user_id,
            provider=provider,
            auth_type=merged.auth.type,
            auth_ref=auth_ref,
            auth_metadata=auth_metadata,
        )
        auth_event_queued = transition.manifest_event_queued
    if (
        previous_non_auth_signature != _runtime_manifest_provider_non_auth_signature(provider)
        and not auth_event_queued
    ):
        await queue_provider_runtime_manifest_changed(db, auth.user_id, provider.provider_id)
    await db.commit()
    await db.refresh(provider)
    return await _to_response(db, auth, provider)


@router.delete("/{provider_id}", response_model=AiProviderDeleteResponse)
async def delete_ai_provider(
    provider_id: str,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> AiProviderDeleteResponse:
    await _lock_provider_pool(db, auth.user_id)
    provider = await _get_provider_or_404_for_update(db, auth, provider_id)
    result = await transition_ai_provider_auth(
        db,
        owner_user_id=auth.user_id,
        provider=provider,
        auth_type=provider.auth_type,
        auth_ref=provider.auth_ref,
        auth_metadata=provider.auth_metadata,
        archive_provider=True,
    )
    response_provider_id = runtime_managed_provider_id(provider.provider_id)
    await db.commit()
    return AiProviderDeleteResponse(
        status="deleted",
        provider_id=response_provider_id,
        remote_revoke_status=result.remote_revoke_status,
    )


@router.post("/{provider_id}/validate", response_model=AiProviderValidationResponse)
async def validate_ai_provider(
    provider_id: str,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> AiProviderValidationResponse:
    provider = await _get_provider_or_404(db, auth, provider_id)
    body = await _to_response(db, auth, provider)
    errors = _validate_provider(body)
    return AiProviderValidationResponse(valid=not errors, errors=errors, warnings=[])


@router.post(
    "/{provider_id}/auth/api-key",
    response_model=AiProviderResponse,
    response_model_exclude_none=True,
)
async def set_ai_provider_api_key(
    provider_id: str,
    body: AiProviderManagedApiKeyRequest,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> AiProviderResponse:
    await _lock_provider_pool(db, auth.user_id)
    provider = await _get_provider_or_404_for_update(db, auth, provider_id)
    profile = "default"
    runtime_env_name = body.runtime_env_name
    if runtime_env_name is not None and not _is_runtime_env_name(runtime_env_name):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid runtime_env_name")
    proposed_runtime_env_name = runtime_env_name or provider.runtime_env_name
    await _validate_runtime_env_name_unique(
        db,
        auth,
        proposed_runtime_env_name,
        exclude_provider_id=provider.provider_id,
    )
    metadata = {"source": "managed", "profile": profile}
    await transition_ai_provider_auth(
        db,
        owner_user_id=auth.user_id,
        provider=provider,
        auth_type="api_key",
        auth_ref=None,
        auth_metadata=metadata,
        credential=AuthCredentialWrite(
            profile=profile,
            kind="api_key",
            plaintext=body.value.get_secret_value(),
            metadata=_compact({"runtime_env_name": runtime_env_name}),
        ),
    )
    if runtime_env_name is not None:
        provider.runtime_env_name = runtime_env_name
    await db.commit()
    await db.refresh(provider)
    return await _to_response(db, auth, provider)


@router.post(
    "/{provider_id}/auth/import",
    response_model=AiProviderResponse,
    response_model_exclude_none=True,
)
async def import_ai_provider_auth(
    provider_id: str,
    body: AiProviderAuthImportRequest,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> AiProviderResponse:
    provider = await _get_provider_or_404_for_update(db, auth, provider_id)
    auth_import = body.root
    profile = _normalize_profile(auth_import.profile)
    if auth_import.type == "agent_profile":
        tool = _normalize_profile(auth_import.tool)
        _validate_supported_agent_profile_tool(tool)
        metadata = {
            "tool": tool,
            "profile": profile,
        }
    elif auth_import.type == "oauth_profile":
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "oauth_profile import is not supported; use Codex OAuth connect",
        )
    try:
        await transition_ai_provider_auth(
            db,
            owner_user_id=auth.user_id,
            provider=provider,
            auth_type=auth_import.type,
            auth_ref=None,
            auth_metadata=metadata,
            credential=AuthCredentialWrite(
                profile=profile,
                kind=auth_import.type,
                plaintext=auth_import.payload.get_secret_value(),
                metadata=metadata,
            ),
        )
    except OAuthCredentialClaimConflict as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    await db.commit()
    await db.refresh(provider)
    return await _to_response(db, auth, provider)


def _validate_codex_oauth_provider_shape(provider: AiProvider | AiProviderUpsert) -> None:
    if (
        provider.type != "openai"
        or effective_provider_api_mode(provider.type, provider.api_mode) != "openai_responses"
        or provider.base_url.rstrip("/") != CODEX_OPENAI_BASE_URL
    ):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "ChatGPT sign-in requires the canonical OpenAI Responses provider",
        )


async def _build_codex_device_authorization(
    *,
    db: AsyncSession,
    auth: AuthContext,
    provider: AiProvider,
    oauth_provider: str,
) -> AiProviderOAuthDeviceStartResponse:
    _validate_supported_oauth_provider(oauth_provider)
    _validate_codex_oauth_provider_shape(provider)
    config = _oauth_config_for(oauth_provider)
    client_id = _required_oauth_config(config, "client_id", oauth_provider)
    if client_id != CODEX_OAUTH_CLIENT_ID:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "ChatGPT device sign-in requires the official Codex OAuth client",
        )
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            authorization = await start_device_authorization(client, client_id)
    except CodexOAuthUpstreamError as exc:
        headers = {"Retry-After": str(exc.retry_after)} if exc.retry_after is not None else None
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS
            if exc.retry_after is not None
            else (
                status.HTTP_503_SERVICE_UNAVAILABLE
                if exc.unavailable
                else status.HTTP_502_BAD_GATEWAY
            ),
            str(exc),
            headers=headers,
        ) from exc
    profile = "default"
    expires_at = datetime.now(UTC) + timedelta(seconds=OAUTH_DEVICE_STATE_TTL_SECONDS)
    state_value = await _persist_oauth_attempt(
        db,
        owner_user_id=auth.user_id,
        provider=provider,
        oauth_provider=oauth_provider,
        profile=profile,
        flow_kind="device_code",
        expires_at=expires_at,
        flow_payload={
            "device_auth_id": authorization.device_auth_id,
            "user_code": authorization.user_code,
            "poll_interval_seconds": authorization.poll_interval_seconds,
        },
    )
    return AiProviderOAuthDeviceStartResponse(
        provider_id=runtime_managed_provider_id(provider.provider_id),
        oauth_provider=oauth_provider,
        profile=profile,
        verification_url=CODEX_DEVICE_VERIFICATION_URL,
        user_code=authorization.user_code,
        state=state_value,
        expires_at=expires_at,
        poll_interval_seconds=authorization.poll_interval_seconds,
    )


@router.post(
    "/{provider_id}/auth/oauth/device/start",
    response_model=AiProviderOAuthDeviceStartResponse,
)
async def start_ai_provider_oauth_device(
    provider_id: str,
    body: AiProviderOAuthDeviceStartRequest,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> AiProviderOAuthDeviceStartResponse:
    provider = await _get_provider_or_404(db, auth, provider_id)
    response = await _build_codex_device_authorization(
        db=db,
        auth=auth,
        provider=provider,
        oauth_provider=_normalize_profile(body.provider),
    )
    await db.commit()
    return response


@router.post(
    "/{provider_id}/auth/oauth/start",
    response_model=AiProviderOAuthStartResponse,
)
async def start_ai_provider_oauth(
    provider_id: str,
    body: AiProviderOAuthStartRequest,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> AiProviderOAuthStartResponse:
    provider = await _get_provider_or_404(db, auth, provider_id)
    _validate_codex_oauth_provider_shape(provider)
    oauth_provider = _normalize_profile(body.provider)
    _validate_supported_oauth_provider(oauth_provider)
    profile = "default"
    config = _oauth_config_for(oauth_provider)
    authorization_url = _required_oauth_config(config, "authorization_url", oauth_provider)
    client_id = _required_oauth_config(config, "client_id", oauth_provider)
    redirect_uri = _oauth_authorization_code_redirect_uri(
        config=config,
        client_id=client_id,
        requested=body.redirect_uri,
        oauth_provider=oauth_provider,
    )
    _validate_oauth_url(authorization_url, "authorization_url")

    code_verifier = secrets.token_urlsafe(48)
    code_challenge = _code_challenge(code_verifier)
    expires_at = datetime.now(UTC) + timedelta(seconds=OAUTH_STATE_TTL_SECONDS)
    state = await _persist_oauth_attempt(
        db,
        owner_user_id=auth.user_id,
        provider=provider,
        oauth_provider=oauth_provider,
        profile=profile,
        flow_kind="authorization_code",
        expires_at=expires_at,
        flow_payload={
            "redirect_uri": redirect_uri,
            "code_verifier": code_verifier,
        },
    )
    params: dict[str, str] = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    scope = str(config.get("scope") or "")
    if scope:
        params["scope"] = scope
    audience = str(config.get("audience") or "")
    if audience:
        params["audience"] = audience
    extra = config.get("extra_authorize_params")
    if isinstance(extra, dict):
        for key, value in extra.items():
            if isinstance(key, str) and isinstance(value, str):
                if key in RESERVED_OAUTH_AUTHORIZE_PARAMS:
                    raise HTTPException(
                        status.HTTP_503_SERVICE_UNAVAILABLE,
                        f"AI Provider OAuth config for {oauth_provider} cannot override {key}",
                    )
                params[key] = value

    separator = "&" if "?" in authorization_url else "?"
    auth_url = f"{authorization_url}{separator}{urlencode(params)}"
    response = AiProviderOAuthStartResponse(
        provider_id=runtime_managed_provider_id(provider.provider_id),
        oauth_provider=oauth_provider,
        profile=profile,
        auth_url=auth_url,
        state=state,
        redirect_uri=redirect_uri,
        expires_at=expires_at,
    )
    await db.commit()
    return response


@router.post(
    "/{provider_id}/auth/oauth/complete",
    response_model=AiProviderResponse,
    response_model_exclude_none=True,
)
async def complete_ai_provider_oauth(
    provider_id: str,
    body: AiProviderOAuthCompleteRequest,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> AiProviderResponse:
    await _get_provider_or_404(db, auth, provider_id)
    attempt_id, replay = await _begin_oauth_attempt_exchange(
        owner_user_id=auth.user_id,
        provider_id=provider_id,
        state=body.state,
        flow_kind="authorization_code",
        payload_updates={
            "authorization_code": body.code,
            "requested_redirect_uri": body.redirect_uri,
        },
    )
    if replay is not None:
        return replay
    return await _exchange_and_commit_oauth_attempt(attempt_id, auth)


async def _persist_oauth_attempt(
    db: AsyncSession,
    *,
    owner_user_id: UUID,
    provider: AiProvider,
    oauth_provider: str,
    profile: str,
    flow_kind: Literal["authorization_code", "device_code"],
    expires_at: datetime,
    flow_payload: dict,
) -> str:
    locked_provider = (
        await db.execute(
            select(AiProvider)
            .where(
                AiProvider.id == provider.id,
                AiProvider.owner_user_id == owner_user_id,
                AiProvider.archived_at.is_(None),
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if locked_provider is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "AI Provider not found")
    _validate_codex_oauth_provider_shape(locked_provider)
    now = datetime.now(UTC)
    await db.execute(
        update(AiProviderOAuthAttempt)
        .where(
            AiProviderOAuthAttempt.provider_row_id == locked_provider.id,
            AiProviderOAuthAttempt.status.in_(("pending", "exchanging")),
        )
        .values(**terminal_oauth_attempt("failed", completed_at=now).update_values())
    )
    payload = (
        await db.execute(
            select(AiProviderAuthPayload)
            .where(
                AiProviderAuthPayload.owner_user_id == owner_user_id,
                AiProviderAuthPayload.provider_id == locked_provider.provider_id,
                AiProviderAuthPayload.auth_profile == profile,
                AiProviderAuthPayload.archived_at.is_(None),
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    base_revision = payload.credential_revision if payload is not None else None
    flow_id = uuid4()
    state = _encode_oauth_state(
        {
            "flow_id": str(flow_id),
            "fence": secrets.token_urlsafe(24),
        }
    )
    encrypted_payload, payload_nonce = encrypt(
        json.dumps(flow_payload, separators=(",", ":"), sort_keys=True)
    )
    attempt = AiProviderOAuthAttempt(
        id=uuid4(),
        flow_id=flow_id,
        owner_user_id=owner_user_id,
        provider_row_id=locked_provider.id,
        provider_id=locked_provider.provider_id,
        oauth_provider=oauth_provider,
        auth_profile=profile,
        flow_kind=flow_kind,
        status="pending",
        base_credential_revision=base_revision,
        state_sha256=hashlib.sha256(state.encode()).hexdigest(),
        encrypted_flow_payload=encrypted_payload,
        flow_payload_nonce=payload_nonce,
        expires_at=expires_at,
    )
    db.add(attempt)
    await db.flush()
    return state


# Transaction and lock boundary for the durable attempt state machine:
# - the request transaction creates `pending` while holding provider -> credential locks;
# - begin uses one short provider -> attempt transaction to commit `exchanging`;
# - token exchange runs without an open database transaction;
# - commit uses the same provider -> attempt lock order for `committed`;
# - stale or failed exchanges use a separate best-effort transition to `failed`.
@dataclass(frozen=True, slots=True)
class _OAuthAttemptStateIdentity:
    flow_id: UUID
    state_sha256: str


def _oauth_attempt_state_identity(state: str) -> _OAuthAttemptStateIdentity:
    decoded = _decode_oauth_state(state)
    try:
        flow_id = UUID(str(decoded.get("flow_id") or ""))
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid OAuth state") from exc
    if not isinstance(decoded.get("fence"), str):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid OAuth state")
    return _OAuthAttemptStateIdentity(
        flow_id=flow_id,
        state_sha256=hashlib.sha256(state.encode()).hexdigest(),
    )


async def _load_oauth_attempt(
    db: AsyncSession,
    *,
    state_identity: _OAuthAttemptStateIdentity,
    owner_user_id: UUID,
    provider_id: str,
    flow_kind: Literal["authorization_code", "device_code"],
    for_update: bool = False,
) -> AiProviderOAuthAttempt:
    statement = select(AiProviderOAuthAttempt).where(
        AiProviderOAuthAttempt.flow_id == state_identity.flow_id,
        AiProviderOAuthAttempt.owner_user_id == owner_user_id,
        AiProviderOAuthAttempt.provider_id == provider_id,
        AiProviderOAuthAttempt.flow_kind == flow_kind,
        AiProviderOAuthAttempt.state_sha256 == state_identity.state_sha256,
    )
    if for_update:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    attempt = (await db.execute(statement)).scalar_one_or_none()
    if attempt is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "OAuth state does not match this user")
    if attempt.status != "committed" and attempt.expires_at < datetime.now(UTC):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "OAuth state expired")
    return attempt


def _oauth_attempt_flow_payload(attempt: AiProviderOAuthAttempt) -> dict:
    if attempt.encrypted_flow_payload is None or attempt.flow_payload_nonce is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Stored OAuth attempt is invalid")
    try:
        payload = json.loads(decrypt(attempt.encrypted_flow_payload, attempt.flow_payload_nonce))
    except Exception as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, "Stored OAuth attempt is invalid") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status.HTTP_409_CONFLICT, "Stored OAuth attempt is invalid")
    return payload


def _oauth_attempt_replay(attempt: AiProviderOAuthAttempt) -> AiProviderResponse | None:
    if attempt.status != "committed":
        return None
    if not isinstance(attempt.receipt, dict):
        raise HTTPException(status.HTTP_409_CONFLICT, "Stored OAuth receipt is invalid")
    try:
        return AiProviderResponse.model_validate(attempt.receipt)
    except ValidationError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, "Stored OAuth receipt is invalid") from exc


async def _begin_oauth_attempt_exchange(
    *,
    owner_user_id: UUID,
    provider_id: str,
    state: str,
    flow_kind: Literal["authorization_code", "device_code"],
    payload_updates: dict,
) -> tuple[UUID, AiProviderResponse | None]:
    state_identity = _oauth_attempt_state_identity(state)
    async with async_session_factory() as db:
        identity = await _load_oauth_attempt(
            db,
            state_identity=state_identity,
            owner_user_id=owner_user_id,
            provider_id=provider_id,
            flow_kind=flow_kind,
        )
        replay = _oauth_attempt_replay(identity)
        if replay is not None:
            attempt_id = identity.id
            await db.rollback()
            return attempt_id, replay
        attempt_id = identity.id
        provider_row_id = identity.provider_row_id
        attempt_provider_id = identity.provider_id
        provider = (
            await db.execute(
                select(AiProvider)
                .where(
                    AiProvider.id == provider_row_id,
                    AiProvider.owner_user_id == owner_user_id,
                    AiProvider.provider_id == attempt_provider_id,
                )
                .with_for_update()
            )
        ).scalar_one_or_none()
        attempt = await _load_oauth_attempt(
            db,
            state_identity=state_identity,
            owner_user_id=owner_user_id,
            provider_id=provider_id,
            flow_kind=flow_kind,
            for_update=True,
        )
        replay = _oauth_attempt_replay(attempt)
        if replay is not None:
            await db.rollback()
            return attempt_id, replay
        if provider is None or provider.archived_at is not None:
            terminal_oauth_attempt("failed").apply(attempt)
            await db.commit()
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "AI Provider changed after sign-in started",
            )
        if attempt.status != "pending":
            if _oauth_attempt_exchange_is_stale(attempt):
                terminal_oauth_attempt("failed").apply(attempt)
                await db.commit()
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "OAuth completion became stale; start sign-in again",
                )
            await db.rollback()
            raise HTTPException(status.HTTP_409_CONFLICT, "OAuth completion is not pending")
        _validate_codex_oauth_provider_shape(provider)
        current_payload = (
            await db.execute(
                select(AiProviderAuthPayload)
                .where(
                    AiProviderAuthPayload.owner_user_id == owner_user_id,
                    AiProviderAuthPayload.provider_id == attempt.provider_id,
                    AiProviderAuthPayload.auth_profile == attempt.auth_profile,
                    AiProviderAuthPayload.archived_at.is_(None),
                )
                .with_for_update()
            )
        ).scalar_one_or_none()
        current_revision = (
            current_payload.credential_revision if current_payload is not None else None
        )
        if current_revision != attempt.base_credential_revision:
            terminal_oauth_attempt("failed").apply(attempt)
            await db.commit()
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "AI Provider credentials changed after this sign-in started",
            )
        flow_payload = _oauth_attempt_flow_payload(attempt)
        requested_redirect_uri = payload_updates.get("requested_redirect_uri")
        if flow_kind == "authorization_code":
            redirect_uri = str(flow_payload.get("redirect_uri") or "")
            _validate_redirect_uri(redirect_uri)
            if requested_redirect_uri is not None:
                _validate_redirect_uri(str(requested_redirect_uri))
                if not secrets.compare_digest(str(requested_redirect_uri), redirect_uri):
                    raise HTTPException(
                        status.HTTP_400_BAD_REQUEST,
                        "OAuth redirect_uri does not match state",
                    )
        flow_payload.update(
            {
                key: value
                for key, value in payload_updates.items()
                if key != "requested_redirect_uri" and value is not None
            }
        )
        attempt.encrypted_flow_payload, attempt.flow_payload_nonce = encrypt(
            json.dumps(flow_payload, separators=(",", ":"), sort_keys=True)
        )
        attempt.status = "exchanging"
        attempt.exchange_started_at = datetime.now(UTC)
        await db.commit()
    return attempt_id, None


async def _exchange_and_commit_oauth_attempt(
    attempt_id: UUID,
    auth: AuthContext,
) -> AiProviderResponse:
    async with async_session_factory() as db:
        attempt = await db.get(AiProviderOAuthAttempt, attempt_id)
        if attempt is None or attempt.owner_user_id != auth.user_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "OAuth attempt not found")
        replay = _oauth_attempt_replay(attempt)
        if replay is not None:
            await db.rollback()
            return replay
        if attempt.status != "exchanging":
            raise HTTPException(status.HTTP_409_CONFLICT, "OAuth completion is not exchanging")
        oauth_provider = attempt.oauth_provider
        profile = attempt.auth_profile
        flow_kind = attempt.flow_kind
        attempt_provider_id = attempt.provider_id
        flow_payload = _oauth_attempt_flow_payload(attempt)
        await db.rollback()

    config = _oauth_config_for(oauth_provider)
    client_id = _required_oauth_config(config, "client_id", oauth_provider)
    compensation = None
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            if flow_kind == "device_code":
                response = await exchange_device_code(
                    client,
                    client_id=client_id,
                    authorization_code=str(flow_payload.get("authorization_code") or ""),
                    code_verifier=str(flow_payload.get("code_verifier") or ""),
                )
                source = "device_code"
            else:
                token_url = _required_oauth_config(config, "token_url", oauth_provider)
                _validate_oauth_url(token_url, "token_url")
                form = {
                    "grant_type": "authorization_code",
                    "client_id": client_id,
                    "code": str(flow_payload.get("authorization_code") or ""),
                    "redirect_uri": str(flow_payload.get("redirect_uri") or ""),
                    "code_verifier": str(flow_payload.get("code_verifier") or ""),
                }
                client_secret = str(config.get("client_secret") or "")
                if client_secret:
                    form["client_secret"] = client_secret
                response = await client.post(token_url, data=form)
                if response.status_code >= 400:
                    raise HTTPException(
                        status.HTTP_502_BAD_GATEWAY,
                        "OAuth token exchange failed",
                    )
                source = "oauth_pkce"
            revocable = _revocable_token_from_token_response(response)
            if revocable is not None:
                async with async_session_factory() as compensation_db:
                    compensation = await enqueue_oauth_revoke_tombstone(
                        compensation_db,
                        owner_user_id=auth.user_id,
                        provider_id=attempt_provider_id,
                        oauth_provider=oauth_provider,
                        revocable=revocable,
                        oauth_attempt_id=attempt_id,
                    )
                    await compensation_db.commit()
            payload_text, provider_auth_type, metadata = await _oauth_payload_from_token_response(
                client,
                oauth_provider,
                config,
                response,
                profile,
                source=source,
            )
    except CodexOAuthUpstreamError as exc:
        await _fail_oauth_attempt(attempt_id)
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE if exc.unavailable else status.HTTP_502_BAD_GATEWAY,
            str(exc),
        ) from exc
    except httpx.HTTPError as exc:
        await _fail_oauth_attempt(attempt_id)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "OAuth token exchange failed") from exc
    except Exception:
        await _fail_oauth_attempt(attempt_id)
        raise

    try:
        return await _commit_oauth_attempt(
            attempt_id=attempt_id,
            auth=auth,
            provider_auth_type=provider_auth_type,
            payload_text=payload_text,
            metadata=metadata,
            compensation=compensation,
        )
    except Exception:
        await _fail_oauth_attempt(attempt_id)
        raise


async def _commit_oauth_attempt(
    *,
    attempt_id: UUID,
    auth: AuthContext,
    provider_auth_type: str,
    payload_text: str,
    metadata: dict,
    compensation: OAuthRevokeTombstoneRef | None,
) -> AiProviderResponse:
    async with async_session_factory() as db:
        identity = (
            await db.execute(
                select(AiProviderOAuthAttempt).where(
                    AiProviderOAuthAttempt.id == attempt_id,
                    AiProviderOAuthAttempt.owner_user_id == auth.user_id,
                )
            )
        ).scalar_one_or_none()
        if identity is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "OAuth attempt not found")
        replay = _oauth_attempt_replay(identity)
        if replay is not None:
            await db.rollback()
            return replay
        provider_row_id = identity.provider_row_id
        attempt_provider_id = identity.provider_id
        provider = (
            await db.execute(
                select(AiProvider)
                .where(
                    AiProvider.id == provider_row_id,
                    AiProvider.owner_user_id == auth.user_id,
                    AiProvider.provider_id == attempt_provider_id,
                )
                .with_for_update()
            )
        ).scalar_one_or_none()
        attempt = (
            await db.execute(
                select(AiProviderOAuthAttempt)
                .where(
                    AiProviderOAuthAttempt.id == attempt_id,
                    AiProviderOAuthAttempt.owner_user_id == auth.user_id,
                    AiProviderOAuthAttempt.provider_row_id == provider_row_id,
                    AiProviderOAuthAttempt.provider_id == attempt_provider_id,
                )
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()
        if attempt is None:
            raise HTTPException(status.HTTP_409_CONFLICT, "OAuth completion lost its fence")
        replay = _oauth_attempt_replay(attempt)
        if replay is not None:
            await db.rollback()
            return replay
        if provider is None or provider.archived_at is not None:
            terminal_oauth_attempt("failed").apply(attempt)
            await db.commit()
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "AI Provider changed after sign-in started",
            )
        if attempt.status != "exchanging":
            raise HTTPException(status.HTTP_409_CONFLICT, "OAuth completion lost its fence")
        try:
            _validate_codex_oauth_provider_shape(provider)
        except HTTPException as exc:
            terminal_oauth_attempt("failed").apply(attempt)
            await db.commit()
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "AI Provider changed after sign-in started",
            ) from exc
        current_payload = (
            await db.execute(
                select(AiProviderAuthPayload)
                .where(
                    AiProviderAuthPayload.owner_user_id == auth.user_id,
                    AiProviderAuthPayload.provider_id == attempt.provider_id,
                    AiProviderAuthPayload.auth_profile == attempt.auth_profile,
                    AiProviderAuthPayload.archived_at.is_(None),
                )
                .with_for_update()
            )
        ).scalar_one_or_none()
        current_revision = (
            current_payload.credential_revision if current_payload is not None else None
        )
        if current_revision != attempt.base_credential_revision:
            terminal_oauth_attempt("failed").apply(attempt)
            await db.commit()
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "AI Provider credentials changed after this sign-in started",
            )
        if compensation is not None and not await cancel_oauth_revoke_tombstone(
            db,
            compensation.id,
            oauth_attempt_id=attempt.id,
        ):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "OAuth completion compensation already started; sign in again",
            )
        try:
            await transition_ai_provider_auth(
                db,
                owner_user_id=auth.user_id,
                provider=provider,
                auth_type=provider_auth_type,
                auth_ref=None,
                auth_metadata=metadata,
                credential=AuthCredentialWrite(
                    profile=attempt.auth_profile,
                    kind=provider_auth_type,
                    plaintext=payload_text,
                    metadata=metadata,
                ),
                keep_oauth_attempt_id=attempt.id,
            )
        except OAuthCredentialClaimConflict as exc:
            raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
        await db.flush()
        await db.refresh(provider)
        response = await _to_response(db, auth, provider)
        terminal_oauth_attempt(
            "committed",
            receipt=response.model_dump(mode="json", exclude_none=True),
        ).apply(attempt)
        await db.commit()
        return response


def _oauth_attempt_exchange_is_stale(attempt: AiProviderOAuthAttempt) -> bool:
    started_at = attempt.exchange_started_at
    return (
        attempt.status == "exchanging"
        and started_at is not None
        and started_at <= datetime.now(UTC) - timedelta(seconds=OAUTH_EXCHANGE_STALE_SECONDS)
    )


async def _fail_oauth_attempt(attempt_id: UUID) -> None:
    try:
        async with async_session_factory() as db:
            await db.execute(
                update(AiProviderOAuthAttempt)
                .where(
                    AiProviderOAuthAttempt.id == attempt_id,
                    AiProviderOAuthAttempt.status == "exchanging",
                )
                .values(**terminal_oauth_attempt("failed").update_values())
            )
            await db.commit()
    except Exception:
        logger.exception("oauth_attempt_failure_state_write_failed attempt_id=%s", attempt_id)


def _revocable_token_from_token_response(response: httpx.Response) -> tuple[str, str] | None:
    data = _token_response_json(response)
    refresh_token = data.get("refresh_token")
    if isinstance(refresh_token, str) and refresh_token:
        return refresh_token, "refresh_token"
    access_token = data.get("access_token")
    if isinstance(access_token, str) and access_token:
        return access_token, "access_token"
    return None


def _ai_provider_accept_request_hash(body: AiProviderAcceptRequest) -> str:
    credential = body.credential
    if isinstance(credential, AiProviderApiKeyAcceptCredential):
        credential_payload = {
            "type": credential.type,
            "value_sha256": hashlib.sha256(
                credential.value.get_secret_value().encode()
            ).hexdigest(),
        }
    else:
        credential_payload = credential.model_dump(mode="json", exclude_none=False)
    request_payload = {
        "provider": body.provider.model_dump(mode="json", exclude_none=False),
        "credential": credential_payload,
    }
    # Preserve hashes written before the optional replacement contract existed.
    # A default create retry must continue replaying across a rolling deploy.
    if body.replace:
        request_payload["replace"] = True
    return platform_request_hash(request_payload)


async def _load_ai_provider_accept_replay(
    db: AsyncSession,
    *,
    operation: str,
    idempotency_key: str,
    request_hash: str,
    owner_user_id: UUID,
) -> PlatformReplay | None:
    existing = await lock_platform_idempotency(
        db,
        operation=operation,
        idempotency_key=idempotency_key,
    )
    if existing is None:
        return None
    if existing.request_hash != request_hash or existing.owner_user_id != owner_user_id:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Idempotency-Key was already used with a different request",
        )
    return read_platform_replay(existing)


async def _accept_ai_provider(
    db: AsyncSession,
    auth: AuthContext,
    body: AiProviderAcceptRequest,
) -> AiProviderAcceptResponse:
    provider_body = body.provider
    _raise_if_deployment_managed_provider_id(provider_body.provider_id)
    if provider_body.provider_id in V2_MANAGED_AI_PROVIDER_IDS:
        provider_body = provider_body.model_copy(update={"provider_id": V2_MANAGED_AI_PROVIDER_ID})
    _validate_ai_provider_accept_contract(provider_body, body.credential)
    errors = _validate_provider(provider_body)
    if errors:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"errors": errors})

    await _lock_provider_pool(db, auth.user_id)
    await _validate_runtime_env_unique(db, auth, provider_body)
    existing = await _find_provider(
        db,
        auth,
        provider_body.provider_id,
        include_archived=True,
    )
    if existing is not None and existing.archived_at is None:
        existing_response = await _to_response(db, auth, existing)
        can_resume = not existing_response.usable and _accept_can_resume(
            existing,
            body.credential,
        )
        if not body.replace and not can_resume:
            raise HTTPException(status.HTTP_409_CONFLICT, "AI Provider already exists")

    previous_non_auth_signature = _runtime_manifest_provider_non_auth_signature(existing)
    provider = existing or AiProvider(
        owner_user_id=auth.user_id,
        provider_id=provider_body.provider_id,
    )
    auth_ref, auth_metadata = provider_body.auth.persistence_fields()
    _apply_provider_body(provider, provider_body, apply_auth=False)
    if existing is None:
        provider.auth_type = provider_body.auth.type
        provider.auth_ref = auth_ref
        provider.auth_metadata = auth_metadata
    provider.archived_at = None
    db.add(provider)
    # Make the provider row real inside the transaction before the credential
    # write. A later failure must roll this flush back, never expose a half row.
    await db.flush()

    if isinstance(body.credential, AiProviderApiKeyAcceptCredential):
        profile = str((auth_metadata or {}).get("profile") or "default")
        transition = await transition_ai_provider_auth(
            db,
            owner_user_id=auth.user_id,
            provider=provider,
            auth_type=provider_body.auth.type,
            auth_ref=auth_ref,
            auth_metadata=auth_metadata,
            credential=AuthCredentialWrite(
                profile=profile,
                kind="api_key",
                plaintext=body.credential.value.get_secret_value(),
                metadata=auth_metadata,
            ),
        )
        if (
            previous_non_auth_signature != _runtime_manifest_provider_non_auth_signature(provider)
            and not transition.manifest_event_queued
        ):
            await queue_provider_runtime_manifest_changed(
                db,
                auth.user_id,
                provider.provider_id,
            )
        await db.flush()
        await db.refresh(provider)
        provider_response = await _to_response(db, auth, provider)
        if not provider_response.usable:
            raise RuntimeError("API-key AI provider accept is not usable")
        return AiProviderReadyAcceptResponse(
            status="ready",
            provider=provider_response,
        )

    authorization = await _build_oauth_accept_authorization(
        db=db,
        auth=auth,
        provider=provider,
        body=body.credential,
    )
    if (
        previous_non_auth_signature != _runtime_manifest_provider_non_auth_signature(provider)
        or existing is None
    ):
        await queue_provider_runtime_manifest_changed(
            db,
            auth.user_id,
            provider.provider_id,
        )
    await db.flush()
    await db.refresh(provider)
    provider_response = await _to_response(db, auth, provider)
    return AiProviderOAuthPendingAcceptResponse(
        status="pending",
        provider=provider_response,
        authorization=authorization,
    )


def _validate_ai_provider_accept_contract(
    provider: AiProviderUpsert,
    credential: AiProviderApiKeyAcceptCredential | AiProviderOAuthAcceptCredential,
) -> None:
    if isinstance(credential, AiProviderApiKeyAcceptCredential):
        if provider.auth.type != "api_key" or provider.auth.source != "managed":
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "API-key accept requires managed api_key provider auth",
            )
        return

    oauth_provider = _normalize_profile(credential.provider)
    _validate_supported_oauth_provider(oauth_provider)
    _validate_codex_oauth_provider_shape(provider)
    if (
        provider.auth.type != "agent_profile"
        or provider.auth.tool != oauth_provider
        or provider.auth.profile != "default"
    ):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "OAuth accept requires the default Codex agent profile",
        )


def _accept_can_resume(
    provider: AiProvider,
    credential: AiProviderApiKeyAcceptCredential | AiProviderOAuthAcceptCredential,
) -> bool:
    metadata = provider.auth_metadata or {}
    if isinstance(credential, AiProviderApiKeyAcceptCredential):
        return provider.auth_type == "api_key" and metadata.get("source") == "managed"
    return (
        provider.auth_type == "agent_profile"
        and metadata.get("tool") == _normalize_profile(credential.provider)
        and str(metadata.get("profile") or "default") == "default"
    )


async def _build_oauth_accept_authorization(
    *,
    db: AsyncSession,
    auth: AuthContext,
    provider: AiProvider,
    body: AiProviderOAuthAcceptCredential,
) -> AiProviderOAuthDeviceStartResponse:
    oauth_provider = _normalize_profile(body.provider)
    _validate_supported_oauth_provider(oauth_provider)
    return await _build_codex_device_authorization(
        db=db,
        auth=auth,
        provider=provider,
        oauth_provider=oauth_provider,
    )


async def _get_provider_or_404_for_update(
    db: AsyncSession,
    auth: AuthContext,
    provider_id: str,
) -> AiProvider:
    provider_ids = (
        V2_MANAGED_AI_PROVIDER_IDS
        if provider_id in V2_MANAGED_AI_PROVIDER_IDS
        else frozenset({provider_id})
    )
    providers = (
        (
            await db.execute(
                select(AiProvider)
                .where(
                    AiProvider.owner_user_id == auth.user_id,
                    AiProvider.provider_id.in_(provider_ids),
                    AiProvider.archived_at.is_(None),
                )
                .order_by(AiProvider.provider_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        )
        .scalars()
        .all()
    )
    if not providers:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "AI Provider not found")
    priority = {V2_MANAGED_AI_PROVIDER_ID: 0, provider_id: 1}
    provider = min(
        providers,
        key=lambda candidate: priority.get(candidate.provider_id, 2),
    )
    if is_v2_deployment_managed_provider_id(provider.provider_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "AI Provider not found")
    return provider


async def _oauth_payload_from_token_response(
    client: httpx.AsyncClient,
    oauth_provider: str,
    config: dict,
    response: httpx.Response,
    profile: str,
    *,
    source: str = "oauth_pkce",
) -> tuple[str, str, dict]:
    if oauth_provider == CODEX_OAUTH_PROVIDER:
        payload = await _codex_auth_profile_payload(client, config, response, profile)
        return (
            payload,
            "agent_profile",
            {
                "tool": "codex",
                "profile": profile,
                "source": source,
            },
        )
    return (
        response.text,
        "oauth_profile",
        {
            "provider": oauth_provider,
            "profile": profile,
            "source": source,
        },
    )


async def _codex_auth_profile_payload(
    client: httpx.AsyncClient,
    config: dict,
    response: httpx.Response,
    profile: str,
) -> str:
    token_data = _token_response_json(response)
    access_token = _required_token_field(token_data, "access_token")
    refresh_token = _required_token_field(token_data, "refresh_token")
    id_token_value = token_data.get("id_token")
    id_token = id_token_value if isinstance(id_token_value, str) and id_token_value else None
    api_key = await _obtain_codex_api_key(client, config, id_token) if id_token else None
    claims = _jwt_auth_claims(id_token or access_token)
    account_id = claims.get("chatgpt_account_id")
    tokens = {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "account_id": account_id if isinstance(account_id, str) and account_id else None,
    }
    if id_token:
        tokens["id_token"] = id_token
    auth_json = {
        "auth_mode": "chatgpt",
        "tokens": tokens,
        "last_refresh": datetime.now(UTC).isoformat(),
    }
    if api_key:
        auth_json["OPENAI_API_KEY"] = api_key
    content = json.dumps(auth_json, indent=2)
    envelope = {
        "schemaVersion": 1,
        "kind": "local_agent_profile",
        "tool": "codex",
        "profile": profile,
        "importedAt": datetime.now(UTC).isoformat(),
        "files": [
            {
                "logicalName": "auth.json",
                "sourcePath": "codex-oauth",
                "targetStrategy": "adapter_default",
                "sourceKind": "file",
                "content": content,
                "mode": 0o600,
                "size": len(content.encode("utf-8")),
            }
        ],
    }
    return json.dumps(envelope, separators=(",", ":"))


def _token_response_json(response: httpx.Response) -> dict:
    try:
        data = response.json()
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "OAuth token response was not JSON",
        ) from exc
    if not isinstance(data, dict):
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "OAuth token response had invalid shape")
    return data


def _required_token_field(data: dict, field: str) -> str:
    value = data.get(field)
    if not isinstance(value, str) or not value:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            f"OAuth token response missing {field}",
        )
    return value


async def _obtain_codex_api_key(
    client: httpx.AsyncClient,
    config: dict,
    id_token: str,
) -> str | None:
    token_url = _required_oauth_config(config, "token_url", CODEX_OAUTH_PROVIDER)
    client_id = _required_oauth_config(config, "client_id", CODEX_OAUTH_PROVIDER)
    response = await client.post(
        token_url,
        data={
            "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
            "client_id": client_id,
            "requested_token": "openai-api-key",
            "subject_token": id_token,
            "subject_token_type": "urn:ietf:params:oauth:token-type:id_token",
        },
    )
    if response.status_code >= 400:
        return None
    data = _token_response_json(response)
    access_token = data.get("access_token")
    return access_token if isinstance(access_token, str) and access_token else None


def _jwt_auth_claims(jwt: str) -> dict:
    parts = jwt.split(".")
    if len(parts) < 2:
        return {}
    payload = parts[1]
    padding = "=" * (-len(payload) % 4)
    try:
        decoded = base64.urlsafe_b64decode(f"{payload}{padding}".encode())
        claims = json.loads(decoded)
    except (binascii.Error, ValueError, json.JSONDecodeError):
        return {}
    if not isinstance(claims, dict):
        return {}
    auth_claims = claims.get("https://api.openai.com/auth")
    return auth_claims if isinstance(auth_claims, dict) else {}


@router.post("/{provider_id}/auth/resolve", response_model=AiProviderAuthResolveResponse)
async def resolve_ai_provider_auth(
    provider_id: str,
    body: AiProviderAuthResolveRequest,
    auth: AuthContext = Depends(require_user_cli),
    db: AsyncSession = Depends(get_session),
) -> AiProviderAuthResolveResponse:
    provider = await _get_provider_or_404_for_update(db, auth, provider_id)
    metadata = provider.auth_metadata or {}
    if provider.auth_type == "api_key" and metadata.get("source") != "managed":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "AI Provider does not use managed api_key auth",
        )
    profile = _normalize_profile(body.profile)
    active_profile = _active_auth_profile(provider)
    if active_profile is not None and profile != active_profile:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "AI Provider auth payload not found")
    payload = await _find_auth_payload(
        db,
        auth,
        provider.provider_id,
        profile,
        for_update=True,
    )
    if payload is None or payload.archived_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "AI Provider auth payload not found")
    consumer: OAuthCredentialConsumer | None = None
    key_environment_id = auth.api_key.environment_id if auth.api_key is not None else None
    if key_environment_id is not None and body.environment_id is None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Agent-bound auth resolve requires an explicit runtime consumer",
        )
    if body.environment_id is not None and body.consumer_runtime is not None:
        if key_environment_id is not None and key_environment_id != body.environment_id:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Agent API key cannot resolve credentials for another Agent",
            )
        if not await environment_matches_runtime(
            db,
            owner_user_id=auth.user_id,
            environment_id=body.environment_id,
            runtime=body.consumer_runtime,
        ):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "OAuth consumer does not match an owned Agent runtime",
            )
        if key_environment_id is not None and not await environment_binds_provider(
            db,
            owner_user_id=auth.user_id,
            environment_id=body.environment_id,
            runtime=body.consumer_runtime,
            provider_id=provider.provider_id,
        ):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Agent is not bound to this AI Provider",
            )
        consumer = OAuthCredentialConsumer(body.environment_id, body.consumer_runtime)
    if provider.auth_type in {"agent_profile", "oauth_profile"}:
        if consumer is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "OAuth auth resolve requires an explicit Agent runtime consumer",
            )
        try:
            await claim_oauth_payload(db, payload=payload, consumer=consumer)
        except OAuthCredentialClaimConflict as exc:
            raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
        plaintext = decrypt(payload.encrypted_payload, payload.nonce)
        await db.commit()
    else:
        plaintext = decrypt(payload.encrypted_payload, payload.nonce)
    if provider.auth_type == "api_key":
        return AiProviderAuthResolveResponse(
            provider_id=runtime_managed_provider_id(provider.provider_id),
            auth_type="api_key",
            value=plaintext,
            profile=profile,
            credential_revision=payload.credential_revision,
        )
    if provider.auth_type in {"agent_profile", "oauth_profile"}:
        return AiProviderAuthResolveResponse(
            provider_id=runtime_managed_provider_id(provider.provider_id),
            auth_type=provider.auth_type,
            payload=plaintext,
            tool=metadata.get("tool"),
            provider=metadata.get("provider"),
            profile=profile,
            credential_revision=payload.credential_revision,
        )
    raise HTTPException(
        status.HTTP_409_CONFLICT,
        "AI Provider auth has no managed payload",
    )


def _oauth_config_for(oauth_provider: str) -> dict:
    config: dict = dict(BUILTIN_OAUTH_CONFIGS.get(oauth_provider, {}))
    raw = settings.ai_provider_oauth_config_json.strip()
    if raw:
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "AI Provider OAuth config is invalid JSON",
            ) from exc
        if not isinstance(data, dict):
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "AI Provider OAuth config must be an object",
            )
        configured = data.get(oauth_provider)
        if configured is not None and not isinstance(configured, dict):
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                f"AI Provider OAuth config for {oauth_provider} must be an object",
            )
        if isinstance(configured, dict):
            config = _merge_oauth_config(config, configured)
    if not config:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"AI Provider OAuth config not found for {oauth_provider}",
        )
    return config


def _merge_oauth_config(base: dict, override: dict) -> dict:
    merged = {**base, **override}
    base_extra = base.get("extra_authorize_params")
    override_extra = override.get("extra_authorize_params")
    if isinstance(base_extra, dict) or isinstance(override_extra, dict):
        merged["extra_authorize_params"] = {
            **(base_extra if isinstance(base_extra, dict) else {}),
            **(override_extra if isinstance(override_extra, dict) else {}),
        }
    return merged


def _required_oauth_config(config: dict, key: str, oauth_provider: str) -> str:
    value = config.get(key)
    if not isinstance(value, str) or not value.strip():
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            f"AI Provider OAuth config for {oauth_provider} is missing {key}",
        )
    return value.strip()


def _encode_oauth_state(payload: dict[str, object]) -> str:
    ciphertext, nonce = encrypt(json.dumps(payload, separators=(",", ":"), sort_keys=True))
    return f"v1.{_base64url(nonce)}.{_base64url(ciphertext)}"


def _decode_oauth_state(state: str) -> dict:
    try:
        version, nonce, ciphertext = state.split(".", 2)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid OAuth state") from exc
    if version != "v1":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid OAuth state")
    try:
        plaintext = decrypt(_base64url_decode_bytes(ciphertext), _base64url_decode_bytes(nonce))
        decoded = json.loads(plaintext)
    except Exception as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid OAuth state") from exc
    if not isinstance(decoded, dict):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid OAuth state")
    return decoded


def _code_challenge(code_verifier: str) -> str:
    return _base64url(hashlib.sha256(code_verifier.encode()).digest())


def _base64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _base64url_decode_bytes(raw: str) -> bytes:
    padding = "=" * ((4 - len(raw) % 4) % 4)
    return base64.urlsafe_b64decode(f"{raw}{padding}")


def _validate_oauth_url(input: str, label: str) -> None:
    parsed = urlparse(input)
    if parsed.scheme != "https" or not parsed.netloc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"{label} must be an https URL")


def _oauth_authorization_code_redirect_uri(
    *,
    config: dict,
    client_id: str,
    requested: str | None,
    oauth_provider: str,
) -> str:
    if client_id == CODEX_OAUTH_CLIENT_ID:
        if requested is None:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                f"AI Provider OAuth config for {oauth_provider} is missing redirect_uri",
            )
        parsed = urlparse(requested)
        if (
            parsed.scheme != "http"
            or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}
            or parsed.username is not None
            or parsed.password is not None
        ):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "the official Codex OAuth client only supports a loopback http redirect_uri",
            )
        return requested

    registered = _required_oauth_config(config, "redirect_uri", oauth_provider)
    _validate_redirect_uri(registered)
    if requested is not None and not secrets.compare_digest(requested, registered):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "redirect_uri must match the server-registered OAuth callback",
        )
    return registered


def _validate_redirect_uri(input: str) -> None:
    parsed = urlparse(input)
    if parsed.scheme == "https" and parsed.netloc:
        return
    if parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}:
        return
    if (
        settings.environment == "development"
        and parsed.scheme == "http"
        and _url_origin(parsed) in _development_oauth_redirect_origins()
    ):
        return
    raise HTTPException(
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "redirect_uri must be https or loopback http",
    )


def _url_origin(parsed) -> str | None:
    if not parsed.scheme or not parsed.netloc or parsed.username or parsed.password:
        return None
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"


def _development_oauth_redirect_origins() -> set[str]:
    origins = [settings.web_origin, *settings.cors_origins]
    allowed_origins: set[str] = set()
    for origin in origins:
        parsed = urlparse(origin)
        if parsed.scheme == "http":
            parsed_origin = _url_origin(parsed)
            if parsed_origin:
                allowed_origins.add(parsed_origin)
    return allowed_origins


async def _lock_provider_pool(db: AsyncSession, owner_user_id: UUID) -> None:
    """Serialize user-provider mutations across the runtime env-name boundary."""

    await db.execute(select(User.id).where(User.id == owner_user_id).with_for_update())


async def _validate_runtime_env_unique(
    db: AsyncSession,
    auth: AuthContext,
    provider: AiProviderUpsert | AiProviderResponse,
    *,
    exclude_provider_id: str | None = None,
) -> None:
    auth_ref, _metadata = provider.auth.persistence_fields()
    names = (
        {provider.runtime_env_name}
        if provider.runtime_env_name and provider.auth.type in {"api_key", "secret_ref"}
        else set()
    )
    if auth_ref is not None and auth_ref.startswith("env:"):
        names.add(auth_ref.removeprefix("env:"))
    effective_exclude = exclude_provider_id or provider.provider_id
    for runtime_env_name in names:
        await _validate_runtime_env_name_unique(
            db,
            auth,
            runtime_env_name,
            exclude_provider_id=effective_exclude,
        )


async def _validate_runtime_env_name_unique(
    db: AsyncSession,
    auth: AuthContext,
    runtime_env_name: str | None,
    *,
    exclude_provider_id: str,
) -> None:
    if runtime_env_name is None:
        return
    conflicting_provider_id = await db.scalar(
        select(AiProvider.provider_id)
        .where(
            AiProvider.owner_user_id == auth.user_id,
            AiProvider.provider_id != exclude_provider_id,
            AiProvider.managed_by == "user",
            AiProvider.archived_at.is_(None),
            (
                (AiProvider.runtime_env_name == runtime_env_name)
                | (AiProvider.auth_ref == f"env:{runtime_env_name}")
            ),
        )
        .limit(1)
    )
    if conflicting_provider_id is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "runtime_env_name is already used by another AI Provider",
        )


async def _find_provider(
    db: AsyncSession,
    auth: AuthContext,
    provider_id: str,
    *,
    include_archived: bool = False,
) -> AiProvider | None:
    provider_ids = (
        V2_MANAGED_AI_PROVIDER_IDS
        if provider_id in V2_MANAGED_AI_PROVIDER_IDS
        else frozenset({provider_id})
    )
    stmt = select(AiProvider).where(
        AiProvider.owner_user_id == auth.user_id,
        AiProvider.provider_id.in_(provider_ids),
    )
    if not include_archived:
        stmt = stmt.where(AiProvider.archived_at.is_(None))
    providers = (await db.execute(stmt)).scalars().all()
    if not providers:
        return None
    priority = {
        V2_MANAGED_AI_PROVIDER_ID: 0,
        provider_id: 1,
    }
    return min(providers, key=lambda provider: priority.get(provider.provider_id, 2))


async def _get_provider_or_404(db: AsyncSession, auth: AuthContext, provider_id: str) -> AiProvider:
    provider = await _find_provider(db, auth, provider_id)
    if provider is None or is_v2_deployment_managed_provider_id(provider.provider_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "AI Provider not found")
    return provider


def _raise_if_deployment_managed_provider_id(provider_id: str) -> None:
    if is_v2_deployment_managed_provider_id(provider_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "AI Provider not found")


def _apply_provider_body(
    provider: AiProvider,
    body: AiProviderUpsert | AiProviderResponse,
    *,
    apply_auth: bool = True,
) -> None:
    provider.type = body.type
    provider.label = body.label
    provider.base_url = body.base_url
    provider.api_mode = body.api_mode
    provider.capabilities = body.capabilities
    provider.models = _provider_models_payload(body.models)
    provider.managed_by = body.managed_by
    provider.runtime_env_name = body.runtime_env_name
    if apply_auth:
        provider.auth_type = body.auth.type
        provider.auth_ref, provider.auth_metadata = body.auth.persistence_fields()


def _provider_models_payload(models: list[AiProviderModel] | None) -> list[dict] | None:
    if models is None:
        return None
    return [model.model_dump(exclude_none=True) for model in models]


def _to_auth(provider: AiProvider) -> AiProviderAuth:
    try:
        return ai_provider_auth_from_persistence(
            provider.auth_type,
            provider.auth_ref,
            provider.auth_metadata,
        )
    except (ValidationError, ValueError) as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Stored AI provider auth metadata is invalid",
        ) from exc


async def _to_response(
    db: AsyncSession,
    auth: AuthContext,
    provider: AiProvider,
) -> AiProviderResponse:
    return (await _to_responses(db, auth, [provider]))[0]


async def _to_responses(
    db: AsyncSession,
    auth: AuthContext,
    providers: list[AiProvider],
) -> list[AiProviderResponse]:
    payload_provider_ids = {
        provider.provider_id for provider in providers if _active_auth_profile(provider) is not None
    }
    payload_consumers: dict[tuple[str, str, str], AiProviderConsumer | None] = {}
    if payload_provider_ids:
        rows = (
            await db.execute(
                select(
                    AiProviderAuthPayload.provider_id,
                    AiProviderAuthPayload.auth_profile,
                    AiProviderAuthPayload.kind,
                    AiProviderAuthPayload.consumer_environment_id,
                    AiProviderAuthPayload.consumer_runtime,
                ).where(
                    AiProviderAuthPayload.owner_user_id == auth.user_id,
                    AiProviderAuthPayload.provider_id.in_(payload_provider_ids),
                    AiProviderAuthPayload.archived_at.is_(None),
                )
            )
        ).all()
        for row in rows:
            key = (row.provider_id, row.auth_profile, row.kind)
            payload_consumers[key] = (
                AiProviderConsumer(
                    environment_id=row.consumer_environment_id,
                    runtime=row.consumer_runtime,
                )
                if row.consumer_environment_id is not None and row.consumer_runtime is not None
                else None
            )
    payload_keys = set(payload_consumers)
    return [
        _build_response(
            provider,
            credential_material=_provider_credential_material(provider, payload_keys),
            consumer=_provider_consumer(provider, payload_consumers),
        )
        for provider in providers
    ]


def _provider_credential_material(
    provider: AiProvider,
    payload_keys: set[tuple[str, str, str]],
) -> str:
    active_profile = _active_auth_profile(provider)
    if active_profile is not None:
        if (provider.provider_id, active_profile, provider.auth_type) in payload_keys:
            return "available"
        return "missing"
    if provider.auth_type == "none":
        return "not_required"
    if provider.auth_type == "secret_ref":
        return "referenced" if provider.auth_ref else "missing"
    if provider.auth_type == "api_key":
        source = (provider.auth_metadata or {}).get("source")
        if source in {"env", "vault"} and provider.auth_ref:
            return "referenced"
    return "missing"


def _provider_consumer(
    provider: AiProvider,
    payload_consumers: dict[tuple[str, str, str], AiProviderConsumer | None],
) -> AiProviderConsumer | None:
    active_profile = _active_auth_profile(provider)
    if active_profile is None:
        return None
    return payload_consumers.get((provider.provider_id, active_profile, provider.auth_type))


def _build_response(
    provider: AiProvider,
    *,
    credential_material: str,
    consumer: AiProviderConsumer | None = None,
) -> AiProviderResponse:
    readiness = provider_readiness(
        _provider_capability_input(provider),
        credential_material=credential_material,
    )
    return AiProviderResponse(
        id=str(provider.id),
        provider_id=runtime_managed_provider_id(provider.provider_id),
        scope=AI_PROVIDER_SCOPE,
        type=provider.type,
        label=provider.label,
        base_url=provider.base_url,
        api_mode=provider.api_mode,
        auth=_to_auth(provider),
        usable=credential_material != "missing",
        readiness=readiness,
        consumer=consumer,
        managed_by=provider.managed_by,
        runtime_env_name=provider.runtime_env_name,
        capabilities=provider.capabilities,
        models=provider.models,
        created_at=provider.created_at,
        updated_at=provider.updated_at,
    )


def _runtime_manifest_provider_signature(provider: AiProvider | None) -> dict | None:
    if provider is None:
        return None
    return {
        "type": provider.type,
        "base_url": provider.base_url,
        "api_mode": provider.api_mode,
        "models": provider.models,
        "auth_type": provider.auth_type,
        "auth_ref": provider.auth_ref,
        "auth_metadata": provider.auth_metadata,
        "managed_by": provider.managed_by,
        "runtime_env_name": provider.runtime_env_name,
        "archived_at": provider.archived_at,
    }


def _runtime_manifest_provider_non_auth_signature(provider: AiProvider | None) -> dict | None:
    signature = _runtime_manifest_provider_signature(provider)
    if signature is None:
        return None
    return {
        key: value
        for key, value in signature.items()
        if key not in {"auth_type", "auth_ref", "auth_metadata"}
    }


def _provider_capability_input(
    provider: AiProvider | AiProviderUpsert | AiProviderResponse,
    *,
    effective_api_mode: str | None = None,
) -> AiProviderCapabilityInput:
    if isinstance(provider, AiProvider):
        metadata = provider.auth_metadata or {}
        return AiProviderCapabilityInput(
            provider_type=provider.type,
            api_mode=effective_api_mode or provider.api_mode,
            base_url=provider.base_url,
            auth_type=provider.auth_type,
            auth_source=(str(metadata.get("source")) if metadata.get("source") else None),
            auth_tool=str(metadata.get("tool")) if metadata.get("tool") else None,
            auth_ref=provider.auth_ref,
            runtime_env_name=provider.runtime_env_name,
        )
    auth_ref, metadata = provider.auth.persistence_fields()
    return AiProviderCapabilityInput(
        provider_type=provider.type,
        api_mode=effective_api_mode or provider.api_mode,
        base_url=provider.base_url,
        auth_type=provider.auth.type,
        auth_source=(str(metadata.get("source")) if metadata and metadata.get("source") else None),
        auth_tool=(str(metadata.get("tool")) if metadata and metadata.get("tool") else None),
        auth_ref=auth_ref,
        runtime_env_name=provider.runtime_env_name,
    )


def _connection_test_model(
    provider: AiProvider | AiProviderUpsert,
    requested_model: str | None,
) -> tuple[str | None, str | None]:
    models = provider.models or []
    model_id = requested_model.strip() if requested_model is not None else None
    if not model_id:
        model_id = next((_model_id(model) for model in models if _model_id(model)), None)
    if model_id is None:
        return None, None
    model_api_mode = next(
        (
            _model_api_mode(model)
            for model in models
            if _model_id(model) == model_id and _model_api_mode(model) is not None
        ),
        None,
    )
    return model_id, model_api_mode


def _model_id(model: AiProviderModel | dict) -> str:
    value = model.id if isinstance(model, AiProviderModel) else model.get("id")
    return value.strip() if isinstance(value, str) else ""


def _model_api_mode(model: AiProviderModel | dict) -> str | None:
    value = model.api_mode if isinstance(model, AiProviderModel) else model.get("api_mode")
    return value if isinstance(value, str) else None


def _connection_test_failure(
    provider: AiProviderUpsert,
    *,
    credential_material: CredentialMaterialState,
    category: ConnectionErrorCategory,
    code: str,
    message: str,
    retryable: bool,
) -> AiProviderConnectionTestResponse:
    return _connection_test_failure_with_readiness(
        provider_readiness(
            _provider_capability_input(provider),
            credential_material=credential_material,
            endpoint_reachability="not_tested",
            inference_verification="not_tested",
        ),
        category=category,
        code=code,
        message=message,
        retryable=retryable,
    )


def _connection_test_failure_with_readiness(
    readiness: AiProviderReadiness,
    *,
    category: ConnectionErrorCategory,
    code: str,
    message: str,
    retryable: bool,
) -> AiProviderConnectionTestResponse:
    return AiProviderConnectionTestResponse(
        ok=False,
        readiness=readiness,
        error=AiProviderConnectionError(
            category=category,
            code=code,
            message=message,
            retryable=retryable,
        ),
    )


def _validate_provider(body: AiProviderUpsert | AiProviderResponse) -> list[str]:
    errors: list[str] = []
    errors.extend(_validate_base_url(body.base_url, body.auth))
    if body.runtime_env_name is not None and not _is_runtime_env_name(body.runtime_env_name):
        errors.append("runtime_env_name must be an uppercase environment variable name")
    errors.extend(_validate_provider_models(body))
    allowed_modes = ALLOWED_API_MODES[body.type]
    if body.api_mode is not None and body.api_mode not in allowed_modes:
        errors.append(f"type {body.type} is incompatible with api_mode {body.api_mode}")
    if body.type == "custom_openai_compatible" and body.api_mode is None:
        errors.append("custom_openai_compatible requires api_mode")
    errors.extend(_validate_managed_provider_contract(body))
    errors.extend(_validate_auth_business_rules(body.auth))
    auth_ref, _auth_metadata = body.auth.persistence_fields()
    if (
        auth_ref is not None
        and auth_ref.startswith("env:")
        and body.runtime_env_name is not None
        and body.runtime_env_name != auth_ref.removeprefix("env:")
    ):
        errors.append("runtime_env_name must match the env auth ref")
    return errors


def _validate_provider_models(body: AiProviderUpsert | AiProviderResponse) -> list[str]:
    if not body.models:
        return []
    errors: list[str] = []
    seen: set[str] = set()
    for model in body.models:
        model_id = model.id.strip()
        if not model_id:
            errors.append("models must include non-empty model ids")
            continue
        if model_id in seen:
            errors.append(f"duplicate model id: {model_id}")
        seen.add(model_id)
        if model_id.startswith("openai-codex/") and body.provider_id not in MANAGED_AI_PROVIDER_IDS:
            errors.append(
                "model ids must use the OpenAI model id without the legacy openai-codex prefix"
            )
        if model.api_mode is not None and model.api_mode not in ALLOWED_API_MODES[body.type]:
            errors.append(f"model {model_id} api_mode is incompatible with type {body.type}")
    return errors


def _validate_managed_provider_contract(body: AiProviderUpsert | AiProviderResponse) -> list[str]:
    is_managed_contract = body.provider_id in MANAGED_AI_PROVIDER_IDS or body.managed_by == "clawdi"
    if not is_managed_contract:
        return []

    errors: list[str] = []
    expected_api_mode = managed_provider_api_mode(body.provider_id)
    if expected_api_mode is None:
        errors.append(f"managed Clawdi provider must use provider_id {V2_MANAGED_AI_PROVIDER_ID}")
    if body.managed_by != "clawdi":
        errors.append("managed Clawdi provider must be managed_by clawdi")
    if body.type != "custom_openai_compatible":
        errors.append("managed Clawdi provider must use custom_openai_compatible")
    if expected_api_mode is not None and body.api_mode != expected_api_mode:
        errors.append(f"managed Clawdi provider must use api_mode {expected_api_mode}")
    if body.auth.type != "api_key" or body.auth.source != "managed":
        errors.append("managed Clawdi provider must use managed api_key auth")
    if body.runtime_env_name != MANAGED_AI_PROVIDER_RUNTIME_ENV:
        errors.append(
            f"managed Clawdi provider must use runtime_env_name {MANAGED_AI_PROVIDER_RUNTIME_ENV}"
        )
    return errors


def _validate_auth_business_rules(auth: AiProviderAuth) -> list[str]:
    if auth.type == "agent_profile" and auth.tool not in SUPPORTED_AGENT_PROFILE_TOOLS:
        return ["agent_profile auth currently supports codex only"]
    return []


def _validate_supported_agent_profile_tool(tool: str) -> None:
    if tool in SUPPORTED_AGENT_PROFILE_TOOLS:
        return
    raise HTTPException(
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "AI Provider auth profiles currently support Codex only",
    )


def _validate_supported_oauth_provider(oauth_provider: str) -> None:
    if oauth_provider in SUPPORTED_OAUTH_PROVIDERS:
        return
    raise HTTPException(
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "AI Provider OAuth currently supports Codex only",
    )


def _validate_patch_nulls(update: dict) -> list[str]:
    errors: list[str] = []
    for field in ("type", "base_url", "auth", "managed_by"):
        if field in update and update[field] is None:
            errors.append(f"{field} cannot be null")
    return errors


def _validate_base_url(base_url: str, auth: AiProviderAuth) -> list[str]:
    errors: list[str] = []
    from urllib.parse import urlparse

    try:
        parsed = urlparse(base_url)
    except ValueError:
        return ["base_url must be an http(s) URL"]
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ["base_url must be an http(s) URL"]
    if auth.type != "none":
        return errors
    hostname = parsed.hostname or ""
    if _is_loopback_host(hostname):
        return errors
    if _is_private_host(hostname):
        return errors
    errors.append("none auth is only allowed for loopback or private-network base_url")
    return errors


def _is_loopback_host(hostname: str) -> bool:
    return hostname in {"localhost", "127.0.0.1", "::1", "0.0.0.0"}


def _is_private_host(hostname: str) -> bool:
    if hostname.startswith("10.") or hostname.startswith("192.168."):
        return True
    match = re.fullmatch(r"172\.(\d+)\..*", hostname)
    if not match:
        return False
    return 16 <= int(match.group(1)) <= 31


def _compact(data: dict) -> dict | None:
    compacted = {key: value for key, value in data.items() if value is not None}
    return compacted or None


async def _find_auth_payload(
    db: AsyncSession,
    auth: AuthContext,
    provider_id: str,
    profile: str,
    *,
    for_update: bool = False,
) -> AiProviderAuthPayload | None:
    statement = select(AiProviderAuthPayload).where(
        AiProviderAuthPayload.owner_user_id == auth.user_id,
        AiProviderAuthPayload.provider_id == provider_id,
        AiProviderAuthPayload.auth_profile == profile,
    )
    if for_update:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    return (await db.execute(statement)).scalar_one_or_none()


def _active_auth_profile(provider: AiProvider) -> str | None:
    metadata = provider.auth_metadata or {}
    if provider.auth_type == "api_key" and metadata.get("source") == "managed":
        return str(metadata.get("profile") or "default")
    if provider.auth_type in {"agent_profile", "oauth_profile"}:
        return str(metadata.get("profile") or "default")
    return None


def _normalize_profile(input: str) -> str:
    profile = input.strip().lower()
    if not re.fullmatch(r"[a-z][a-z0-9._-]{0,119}", profile):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid profile")
    return profile


def _is_runtime_env_name(input: str) -> bool:
    return re.fullmatch(r"[A-Z][A-Z0-9_]{0,127}", input) is not None
