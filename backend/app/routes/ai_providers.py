import base64
import binascii
import hashlib
import json
import logging
import re
import secrets
from datetime import UTC, datetime, timedelta
from typing import Annotated
from urllib.parse import urlencode, urlparse
from uuid import UUID

import httpx
from cryptography.exceptions import InvalidTag
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
from app.models.ai_provider import AiProvider, AiProviderAuthPayload
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
    AiProviderDeleteResponse,
    AiProviderListResponse,
    AiProviderManagedApiKeyRequest,
    AiProviderModel,
    AiProviderOAuthAcceptCredential,
    AiProviderOAuthAuthorization,
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
    claim_unique_bound_runtime,
    environment_binds_provider,
    environment_matches_runtime,
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
CODEX_OAUTH_PROVIDER = "codex"
CODEX_DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device"
CODEX_DEVICE_USER_CODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode"
CODEX_DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token"
CODEX_DEVICE_CALLBACK_URL = "https://auth.openai.com/deviceauth/callback"
CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token"
CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
CODEX_OPENAI_BASE_URL = "https://api.openai.com/v1"
SUPPORTED_AGENT_PROFILE_TOOLS = {CODEX_OAUTH_PROVIDER}
SUPPORTED_OAUTH_PROVIDERS = {CODEX_OAUTH_PROVIDER}
CODEX_OAUTH_CONFIG = {
    "authorization_url": "https://auth.openai.com/oauth/authorize",
    "token_url": "https://auth.openai.com/oauth/token",
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
_AI_PROVIDER_OAUTH_COMPLETE_OPERATION = "ai_provider.oauth.complete"
_OAUTH_PENDING_SOURCE = "oauth_pending"


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
    previous_signature = _runtime_manifest_provider_signature(existing)
    provider = existing or AiProvider(owner_user_id=auth.user_id, provider_id=body.provider_id)
    _apply_provider_body(provider, body)
    provider.archived_at = None
    db.add(provider)
    if previous_signature != _runtime_manifest_provider_signature(provider):
        await queue_provider_runtime_manifest_changed(db, auth.user_id, provider.provider_id)
    await db.commit()
    await db.refresh(provider)
    return await _to_response(db, auth, provider)


async def _validate_device_oauth_state(
    db: AsyncSession,
    auth: AuthContext,
    provider: AiProvider,
    encoded_state: str,
) -> dict:
    _validate_codex_oauth_provider_shape(provider)
    state_payload = _decode_oauth_state(encoded_state)
    if (
        state_payload.get("flow") != "device_code"
        or state_payload.get("provider_id") != provider.provider_id
        or state_payload.get("owner_user_id") != str(auth.user_id)
    ):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "OAuth state does not match this user")
    expires_at = _parse_state_datetime(str(state_payload.get("expires_at") or ""))
    if expires_at < datetime.now(UTC):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "OAuth state expired")
    oauth_provider = _normalize_profile(str(state_payload.get("oauth_provider") or ""))
    _validate_supported_oauth_provider(oauth_provider)
    profile = _normalize_profile(str(state_payload.get("profile") or "default"))
    payload = await _find_auth_payload(db, auth, provider.provider_id, profile)
    current_revision = (
        payload.credential_revision if payload is not None and payload.archived_at is None else None
    )
    base_revision = state_payload.get("base_credential_revision")
    if base_revision != current_revision:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "AI Provider credentials changed after this sign-in started",
        )
    metadata = provider.auth_metadata or {}
    if metadata.get("source") == _OAUTH_PENDING_SOURCE:
        expected_hash = str(metadata.get("state_sha256") or "")
        actual_hash = hashlib.sha256(encoded_state.encode()).hexdigest()
        if not expected_hash or not secrets.compare_digest(expected_hash, actual_hash):
            raise HTTPException(status.HTTP_409_CONFLICT, "AI Provider OAuth setup is not pending")
    return state_payload


@router.post(
    "/{provider_id}/auth/oauth/device/poll",
    response_model=AiProviderOAuthDevicePollResponse,
    response_model_exclude_none=True,
)
async def poll_ai_provider_oauth_device(
    provider_id: str,
    body: AiProviderOAuthDevicePollRequest,
    auth: AuthContext = Depends(require_user_auth_unbound),
) -> AiProviderOAuthDevicePollResponse:
    async with async_session_factory() as db:
        provider = await _get_provider_or_404(db, auth, provider_id)
        oauth_state = await _validate_device_oauth_state(db, auth, provider, body.state)
        await db.rollback()

    interval_seconds = oauth_state.get("poll_interval_seconds")
    retry_after_seconds = (
        min(max(interval_seconds, 1), 30) if isinstance(interval_seconds, int) else 5
    )
    oauth_provider = _normalize_profile(str(oauth_state.get("oauth_provider") or ""))
    profile = _normalize_profile(str(oauth_state.get("profile") or "default"))
    config = _oauth_config_for(oauth_provider)
    client_id = _required_oauth_config(config, "client_id", oauth_provider)
    if client_id != CODEX_OAUTH_CLIENT_ID:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "ChatGPT device sign-in requires the official Codex OAuth client",
        )
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            poll_response = await client.post(
                CODEX_DEVICE_TOKEN_URL,
                headers=_codex_device_headers("application/json"),
                json={
                    "device_auth_id": str(oauth_state.get("device_auth_id") or ""),
                    "user_code": str(oauth_state.get("user_code") or ""),
                },
            )
            if poll_response.status_code in {
                status.HTTP_403_FORBIDDEN,
                status.HTTP_404_NOT_FOUND,
            }:
                return AiProviderOAuthDevicePendingResponse(
                    status="pending",
                    retry_after_seconds=retry_after_seconds,
                )
            if poll_response.status_code >= 400:
                raise HTTPException(
                    status.HTTP_502_BAD_GATEWAY,
                    "ChatGPT device authorization failed",
                )
            poll_data = _token_response_json(poll_response)
            authorization_code = _required_token_field(poll_data, "authorization_code")
            code_verifier = _required_token_field(poll_data, "code_verifier")
            token_response = await client.post(
                CODEX_OAUTH_TOKEN_URL,
                headers=_codex_device_headers("application/x-www-form-urlencoded"),
                data={
                    "grant_type": "authorization_code",
                    "code": authorization_code,
                    "redirect_uri": CODEX_DEVICE_CALLBACK_URL,
                    "client_id": client_id,
                    "code_verifier": code_verifier,
                },
            )
            if token_response.status_code >= 400:
                raise HTTPException(
                    status.HTTP_502_BAD_GATEWAY,
                    "ChatGPT device token exchange failed",
                )
            payload_text, provider_auth_type, metadata = await _oauth_payload_from_token_response(
                client,
                oauth_provider,
                config,
                token_response,
                profile,
            )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "ChatGPT device sign-in is temporarily unavailable",
        ) from exc

    async with async_session_factory() as db:
        try:
            provider = await _get_provider_or_404_for_update(db, auth, provider_id)
            await _validate_device_oauth_state(db, auth, provider, body.state)
            previous_signature = _runtime_manifest_provider_signature(provider)
            await _store_auth_payload(
                db,
                auth,
                provider.provider_id,
                profile,
                provider_auth_type,
                payload_text,
                metadata,
            )
            provider.auth_type = provider_auth_type
            provider.auth_ref = None
            provider.auth_metadata = metadata
            if previous_signature != _runtime_manifest_provider_signature(provider):
                await queue_provider_runtime_manifest_changed(
                    db,
                    auth.user_id,
                    provider.provider_id,
                )
            await db.commit()
            await db.refresh(provider)
            provider_response = await _to_response(db, auth, provider)
        except Exception:
            await db.rollback()
            await _revoke_oauth_material_best_effort(
                _revocable_oauth_token_from_envelope(payload_text),
                provider_id,
            )
            raise
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
    provider = await _get_provider_or_404(db, auth, provider_id)
    previous_signature = _runtime_manifest_provider_signature(provider)
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
    _apply_provider_body(provider, merged, apply_auth="auth" in body.model_fields_set)
    if previous_signature != _runtime_manifest_provider_signature(provider):
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
    archived_at = datetime.now(UTC)
    provider.archived_at = archived_at
    payloads = (
        (
            await db.execute(
                select(AiProviderAuthPayload)
                .where(
                    AiProviderAuthPayload.owner_user_id == auth.user_id,
                    AiProviderAuthPayload.provider_id == provider.provider_id,
                    AiProviderAuthPayload.archived_at.is_(None),
                )
                .order_by(AiProviderAuthPayload.auth_profile)
                .with_for_update()
            )
        )
        .scalars()
        .all()
    )
    for payload in payloads:
        if payload.kind in {"agent_profile", "oauth_profile"}:
            await _revoke_oauth_payload_best_effort(payload)
        payload.archived_at = archived_at
        payload.consumer_environment_id = None
        payload.consumer_runtime = None
    await queue_provider_runtime_manifest_changed(db, auth.user_id, provider.provider_id)
    await db.commit()
    return AiProviderDeleteResponse(
        status="deleted",
        provider_id=runtime_managed_provider_id(provider.provider_id),
    )


def _revocable_oauth_token_from_envelope(payload_text: str) -> tuple[str, str] | None:
    try:
        envelope = json.loads(payload_text)
        files = envelope.get("files") if isinstance(envelope, dict) else None
        if not isinstance(files, list):
            return None
        auth_file = next(
            (
                item
                for item in files
                if isinstance(item, dict)
                and item.get("logicalName") == "auth.json"
                and isinstance(item.get("content"), str)
            ),
            None,
        )
        if auth_file is None:
            return None
        auth_json = json.loads(auth_file["content"])
        if not isinstance(auth_json, dict) or auth_json.get("auth_mode") != "chatgpt":
            return None
        tokens = auth_json.get("tokens")
        if not isinstance(tokens, dict):
            return None
        refresh_token = tokens.get("refresh_token")
        if isinstance(refresh_token, str) and refresh_token:
            return refresh_token, "refresh_token"
        access_token = tokens.get("access_token")
        if isinstance(access_token, str) and access_token:
            return access_token, "access_token"
    except (TypeError, ValueError):
        return None
    return None


def _revocable_oauth_token(payload: AiProviderAuthPayload) -> tuple[str, str] | None:
    try:
        return _revocable_oauth_token_from_envelope(
            decrypt(payload.encrypted_payload, payload.nonce)
        )
    except (InvalidTag, RuntimeError, TypeError, ValueError):
        return None


async def _revoke_oauth_material_best_effort(
    revocable: tuple[str, str] | None,
    provider_id: str,
) -> None:
    if revocable is None:
        return
    token, token_type = revocable
    config = _oauth_config_for(CODEX_OAUTH_PROVIDER)
    token_url = _required_oauth_config(config, "token_url", CODEX_OAUTH_PROVIDER)
    parsed = urlparse(token_url)
    revoke_url = parsed._replace(path="/oauth/revoke", query="", fragment="").geturl()
    request: dict[str, str] = {"token": token, "token_type_hint": token_type}
    if token_type == "refresh_token":
        request["client_id"] = _required_oauth_config(
            config,
            "client_id",
            CODEX_OAUTH_PROVIDER,
        )
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(revoke_url, json=request)
        if response.status_code >= 400:
            logger.warning(
                "oauth_revoke_failed provider_id=%s status=%s",
                provider_id,
                response.status_code,
            )
    except httpx.HTTPError:
        logger.warning(
            "oauth_revoke_failed provider_id=%s network_error=true",
            provider_id,
        )


async def _revoke_oauth_payload_best_effort(payload: AiProviderAuthPayload) -> None:
    await _revoke_oauth_material_best_effort(
        _revocable_oauth_token(payload),
        payload.provider_id,
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
    await _store_auth_payload(
        db,
        auth,
        provider.provider_id,
        profile,
        "api_key",
        body.value.get_secret_value(),
        _compact({"runtime_env_name": runtime_env_name}),
    )

    provider.auth_type = "api_key"
    provider.auth_ref = None
    provider.auth_metadata = {"source": "managed", "profile": profile}
    if runtime_env_name is not None:
        provider.runtime_env_name = runtime_env_name
    await queue_provider_runtime_manifest_changed(db, auth.user_id, provider.provider_id)
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
    previous_signature = _runtime_manifest_provider_signature(provider)
    auth_import = body.root
    profile = _normalize_profile(auth_import.profile)
    if auth_import.type == "agent_profile":
        tool = _normalize_profile(auth_import.tool)
        _validate_supported_agent_profile_tool(tool)
        metadata = {
            "tool": tool,
            "profile": profile,
        }
        provider.auth_type = "agent_profile"
        provider.auth_ref = None
        provider.auth_metadata = metadata
    elif auth_import.type == "oauth_profile":
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "oauth_profile import is not supported; use Codex OAuth connect",
        )
    await _store_auth_payload(
        db,
        auth,
        provider.provider_id,
        profile,
        auth_import.type,
        auth_import.payload.get_secret_value(),
        provider.auth_metadata,
    )
    if previous_signature != _runtime_manifest_provider_signature(provider):
        await queue_provider_runtime_manifest_changed(db, auth.user_id, provider.provider_id)
    await db.commit()
    await db.refresh(provider)
    return await _to_response(db, auth, provider)


def _codex_device_headers(content_type: str) -> dict[str, str]:
    return {
        "Content-Type": content_type,
        "User-Agent": "clawdi",
        "originator": "clawdi",
    }


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
            response = await client.post(
                CODEX_DEVICE_USER_CODE_URL,
                headers=_codex_device_headers("application/json"),
                json={"client_id": client_id},
            )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "ChatGPT device sign-in is temporarily unavailable",
        ) from exc
    if response.status_code == status.HTTP_404_NOT_FOUND:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "ChatGPT device sign-in is not enabled for this account or workspace",
        )
    if response.status_code >= 400:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "ChatGPT device sign-in could not be started",
        )
    data = _token_response_json(response)
    device_auth_id = _required_token_field(data, "device_auth_id")
    user_code_value = data.get("user_code") or data.get("usercode")
    if not isinstance(user_code_value, str) or not user_code_value:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "ChatGPT device sign-in response was incomplete",
        )
    interval_value = data.get("interval")
    interval_seconds = interval_value if isinstance(interval_value, int) else 5
    interval_seconds = min(max(interval_seconds, 1), 30)
    profile = "default"
    payload = await _find_auth_payload(db, auth, provider.provider_id, profile)
    base_revision = (
        payload.credential_revision if payload is not None and payload.archived_at is None else None
    )
    expires_at = datetime.now(UTC) + timedelta(seconds=OAUTH_DEVICE_STATE_TTL_SECONDS)
    state_value = _encode_oauth_state(
        {
            "flow": "device_code",
            "provider_id": provider.provider_id,
            "owner_user_id": str(auth.user_id),
            "oauth_provider": oauth_provider,
            "profile": profile,
            "device_auth_id": device_auth_id,
            "user_code": user_code_value,
            "poll_interval_seconds": interval_seconds,
            "base_credential_revision": base_revision,
            "expires_at": expires_at.isoformat(),
        }
    )
    return AiProviderOAuthDeviceStartResponse(
        provider_id=runtime_managed_provider_id(provider.provider_id),
        oauth_provider=oauth_provider,
        profile=profile,
        verification_url=CODEX_DEVICE_VERIFICATION_URL,
        user_code=user_code_value,
        state=state_value,
        expires_at=expires_at,
        poll_interval_seconds=interval_seconds,
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
    return await _build_codex_device_authorization(
        db=db,
        auth=auth,
        provider=provider,
        oauth_provider=_normalize_profile(body.provider),
    )


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
    state = _encode_oauth_state(
        {
            "provider_id": provider.provider_id,
            "owner_user_id": str(auth.user_id),
            "oauth_provider": oauth_provider,
            "profile": profile,
            "redirect_uri": redirect_uri,
            "code_verifier": code_verifier,
            "expires_at": expires_at.isoformat(),
        }
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
    return AiProviderOAuthStartResponse(
        provider_id=runtime_managed_provider_id(provider.provider_id),
        oauth_provider=oauth_provider,
        profile=profile,
        auth_url=auth_url,
        state=state,
        redirect_uri=redirect_uri,
        expires_at=expires_at,
    )


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
    provider = await _get_provider_or_404(db, auth, provider_id)
    _validate_codex_oauth_provider_shape(provider)
    state = _decode_oauth_state(body.state)
    if state.get("provider_id") != provider.provider_id or state.get("owner_user_id") != str(
        auth.user_id
    ):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "OAuth state does not match this user")
    expires_at = _parse_state_datetime(str(state.get("expires_at") or ""))
    if expires_at < datetime.now(UTC):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "OAuth state expired")
    oauth_provider = _normalize_profile(str(state.get("oauth_provider") or ""))
    profile = _normalize_profile(str(state.get("profile") or "default"))
    state_redirect_uri = str(state.get("redirect_uri") or "")
    redirect_uri = body.redirect_uri or state_redirect_uri
    _validate_redirect_uri(redirect_uri)
    if redirect_uri != state_redirect_uri:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "OAuth redirect_uri does not match state")
    config = _oauth_config_for(oauth_provider)
    token_url = _required_oauth_config(config, "token_url", oauth_provider)
    client_id = _required_oauth_config(config, "client_id", oauth_provider)
    _validate_oauth_url(token_url, "token_url")

    form = {
        "grant_type": "authorization_code",
        "client_id": client_id,
        "code": body.code,
        "redirect_uri": redirect_uri,
        "code_verifier": str(state.get("code_verifier") or ""),
    }
    client_secret = str(config.get("client_secret") or "")
    if client_secret:
        form["client_secret"] = client_secret
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.post(token_url, data=form)
        if response.status_code >= 400:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, "OAuth token exchange failed")
        payload_text, provider_auth_type, metadata = await _oauth_payload_from_token_response(
            client,
            oauth_provider,
            config,
            response,
            profile,
        )

    # The token exchange deliberately happens without a row lock. Re-lock and
    # revalidate before writing so a concurrent delete or reconnect wins
    # cleanly instead of reviving archived credential state.
    provider = await _get_provider_or_404_for_update(db, auth, provider_id)
    _validate_codex_oauth_provider_shape(provider)
    if state.get("provider_id") != provider.provider_id or state.get("owner_user_id") != str(
        auth.user_id
    ):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "OAuth state does not match this user")
    previous_signature = _runtime_manifest_provider_signature(provider)
    await _store_auth_payload(
        db,
        auth,
        provider.provider_id,
        profile,
        provider_auth_type,
        payload_text,
        metadata,
    )
    provider.auth_type = provider_auth_type
    provider.auth_ref = None
    provider.auth_metadata = metadata
    if previous_signature != _runtime_manifest_provider_signature(provider):
        await queue_provider_runtime_manifest_changed(db, auth.user_id, provider.provider_id)
    await db.commit()
    await db.refresh(provider)
    return await _to_response(db, auth, provider)


@router.post(
    "/{provider_id}/accept",
    response_model=AiProviderReadyAcceptResponse,
    response_model_exclude_none=True,
)
async def complete_ai_provider_accept(
    provider_id: str,
    body: AiProviderOAuthCompleteRequest,
    idempotency_key: IdempotencyKey,
    auth: AuthContext = Depends(_require_ai_provider_accept_auth),
) -> AiProviderReadyAcceptResponse | JSONResponse:
    """Complete an OAuth-pending provider without spanning remote I/O with a DB session."""

    request_hash = _ai_provider_oauth_complete_request_hash(provider_id, body)
    async with async_session_factory() as db:
        replay = await _load_ai_provider_accept_replay(
            db,
            operation=_AI_PROVIDER_OAUTH_COMPLETE_OPERATION,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            owner_user_id=auth.user_id,
        )
        if replay is not None:
            await db.commit()
            return JSONResponse(status_code=replay.status_code, content=replay.body)
        provider = await _get_provider_or_404(db, auth, provider_id)
        oauth_state = _validate_pending_oauth_accept(provider, auth, body)
        await db.rollback()

    payload_text, provider_auth_type, metadata = await _exchange_oauth_code(
        body,
        oauth_state,
    )

    async with async_session_factory() as db:
        try:
            replay = await _load_ai_provider_accept_replay(
                db,
                operation=_AI_PROVIDER_OAUTH_COMPLETE_OPERATION,
                idempotency_key=idempotency_key,
                request_hash=request_hash,
                owner_user_id=auth.user_id,
            )
            if replay is not None:
                await db.commit()
                return JSONResponse(status_code=replay.status_code, content=replay.body)

            provider = await _get_provider_or_404_for_update(db, auth, provider_id)
            _validate_pending_oauth_accept(provider, auth, body)
            previous_signature = _runtime_manifest_provider_signature(provider)
            profile = _normalize_profile(str(oauth_state.get("profile") or "default"))
            await _store_auth_payload(
                db,
                auth,
                provider.provider_id,
                profile,
                provider_auth_type,
                payload_text,
                metadata,
            )
            provider.auth_type = provider_auth_type
            provider.auth_ref = None
            provider.auth_metadata = metadata
            if previous_signature != _runtime_manifest_provider_signature(provider):
                await queue_provider_runtime_manifest_changed(
                    db,
                    auth.user_id,
                    provider.provider_id,
                )
            await db.flush()
            await db.refresh(provider)
            provider_response = await _to_response(db, auth, provider)
            if not provider_response.usable:
                raise RuntimeError("completed AI provider accept is not usable")
            result = AiProviderReadyAcceptResponse(
                status="ready",
                provider=provider_response,
            )
            response_body = result.model_dump(mode="json", exclude_none=True)
            store_platform_response(
                db,
                operation=_AI_PROVIDER_OAUTH_COMPLETE_OPERATION,
                idempotency_key=idempotency_key,
                request_hash=request_hash,
                owner_user_id=auth.user_id,
                resource_type="ai_provider",
                resource_id=provider_response.provider_id,
                response_status=status.HTTP_200_OK,
                response_body=response_body,
            )
            await db.commit()
        except Exception:
            await db.rollback()
            raise
    return result


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


def _ai_provider_oauth_complete_request_hash(
    provider_id: str,
    body: AiProviderOAuthCompleteRequest,
) -> str:
    return platform_request_hash(
        {
            "provider_id": provider_id,
            "state_sha256": hashlib.sha256(body.state.encode()).hexdigest(),
            "code_sha256": hashlib.sha256(body.code.encode()).hexdigest(),
            "redirect_uri": body.redirect_uri,
        }
    )


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

    previous_signature = _runtime_manifest_provider_signature(existing)
    provider = existing or AiProvider(
        owner_user_id=auth.user_id,
        provider_id=provider_body.provider_id,
    )
    _apply_provider_body(provider, provider_body)
    provider.archived_at = None
    db.add(provider)
    # Make the provider row real inside the transaction before the credential
    # write. A later failure must roll this flush back, never expose a half row.
    await db.flush()

    if isinstance(body.credential, AiProviderApiKeyAcceptCredential):
        profile = str(provider.auth_metadata.get("profile") or "default")
        await _store_auth_payload(
            db,
            auth,
            provider.provider_id,
            profile,
            "api_key",
            body.credential.value.get_secret_value(),
            provider.auth_metadata,
        )
        # Credential rotation changes runtime secret material even when every
        # public provider metadata field remains byte-for-byte identical.
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
    provider.auth_metadata = {
        "tool": authorization.oauth_provider,
        "profile": authorization.profile,
        "source": _OAUTH_PENDING_SOURCE,
        "state_sha256": hashlib.sha256(authorization.state.encode()).hexdigest(),
        "redirect_uri": getattr(authorization, "redirect_uri", None),
        "expires_at": authorization.expires_at.isoformat(),
    }
    if previous_signature != _runtime_manifest_provider_signature(provider):
        await queue_provider_runtime_manifest_changed(
            db,
            auth.user_id,
            provider.provider_id,
        )
    await db.flush()
    await db.refresh(provider)
    provider_response = await _to_response(db, auth, provider)
    if provider_response.usable:
        raise RuntimeError("OAuth-pending AI provider accept is already usable")
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
) -> AiProviderOAuthAuthorization:
    oauth_provider = _normalize_profile(body.provider)
    _validate_supported_oauth_provider(oauth_provider)
    if body.flow == "device_code":
        if body.redirect_uri is not None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "device-code sign-in does not accept redirect_uri",
            )
        return await _build_codex_device_authorization(
            db=db,
            auth=auth,
            provider=provider,
            oauth_provider=oauth_provider,
        )
    profile = "default"
    config = _oauth_config_for(oauth_provider)
    authorization_url = _required_oauth_config(
        config,
        "authorization_url",
        oauth_provider,
    )
    client_id = _required_oauth_config(config, "client_id", oauth_provider)
    redirect_uri = body.redirect_uri or _required_oauth_config(
        config,
        "redirect_uri",
        oauth_provider,
    )
    _validate_oauth_url(authorization_url, "authorization_url")
    _validate_redirect_uri(redirect_uri)

    code_verifier = secrets.token_urlsafe(48)
    code_challenge = _code_challenge(code_verifier)
    expires_at = datetime.now(UTC) + timedelta(seconds=OAUTH_STATE_TTL_SECONDS)
    state = _encode_oauth_state(
        {
            "provider_id": provider.provider_id,
            "owner_user_id": str(auth.user_id),
            "oauth_provider": oauth_provider,
            "profile": profile,
            "redirect_uri": redirect_uri,
            "code_verifier": code_verifier,
            "expires_at": expires_at.isoformat(),
        }
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
    return AiProviderOAuthStartResponse(
        provider_id=runtime_managed_provider_id(provider.provider_id),
        oauth_provider=oauth_provider,
        profile=profile,
        auth_url=f"{authorization_url}{separator}{urlencode(params)}",
        state=state,
        redirect_uri=redirect_uri,
        expires_at=expires_at,
    )


def _validate_pending_oauth_accept(
    provider: AiProvider,
    auth: AuthContext,
    body: AiProviderOAuthCompleteRequest,
) -> dict:
    metadata = dict(provider.auth_metadata or {})
    expected_state_hash = str(metadata.get("state_sha256") or "")
    presented_state_hash = hashlib.sha256(body.state.encode()).hexdigest()
    if (
        provider.auth_type != "agent_profile"
        or metadata.get("source") != _OAUTH_PENDING_SOURCE
        or not expected_state_hash
        or not secrets.compare_digest(expected_state_hash, presented_state_hash)
    ):
        raise HTTPException(status.HTTP_409_CONFLICT, "AI Provider OAuth setup is not pending")

    state = _decode_oauth_state(body.state)
    if state.get("provider_id") != provider.provider_id or state.get("owner_user_id") != str(
        auth.user_id
    ):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "OAuth state does not match this user")
    expires_at = _parse_state_datetime(str(state.get("expires_at") or ""))
    if expires_at < datetime.now(UTC):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "OAuth state expired")
    if str(metadata.get("expires_at") or "") != expires_at.isoformat():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "OAuth state does not match this setup")
    oauth_provider = _normalize_profile(str(state.get("oauth_provider") or ""))
    _validate_supported_oauth_provider(oauth_provider)
    if metadata.get("tool") != oauth_provider:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "OAuth state does not match this setup")
    profile = _normalize_profile(str(state.get("profile") or "default"))
    if metadata.get("profile") != profile:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "OAuth state does not match this setup")
    state_redirect_uri = str(state.get("redirect_uri") or "")
    redirect_uri = body.redirect_uri or state_redirect_uri
    _validate_redirect_uri(redirect_uri)
    if redirect_uri != state_redirect_uri or metadata.get("redirect_uri") != state_redirect_uri:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "OAuth redirect_uri does not match state")
    return dict(state)


async def _exchange_oauth_code(
    body: AiProviderOAuthCompleteRequest,
    state: dict,
) -> tuple[str, str, dict]:
    oauth_provider = _normalize_profile(str(state.get("oauth_provider") or ""))
    profile = _normalize_profile(str(state.get("profile") or "default"))
    redirect_uri = body.redirect_uri or str(state.get("redirect_uri") or "")
    config = _oauth_config_for(oauth_provider)
    token_url = _required_oauth_config(config, "token_url", oauth_provider)
    client_id = _required_oauth_config(config, "client_id", oauth_provider)
    _validate_oauth_url(token_url, "token_url")
    form = {
        "grant_type": "authorization_code",
        "client_id": client_id,
        "code": body.code,
        "redirect_uri": redirect_uri,
        "code_verifier": str(state.get("code_verifier") or ""),
    }
    client_secret = str(config.get("client_secret") or "")
    if client_secret:
        form["client_secret"] = client_secret
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(token_url, data=form)
            if response.status_code >= 400:
                raise HTTPException(
                    status.HTTP_502_BAD_GATEWAY,
                    "OAuth token exchange failed",
                )
            return await _oauth_payload_from_token_response(
                client,
                oauth_provider,
                config,
                response,
                profile,
            )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "OAuth token exchange failed",
        ) from exc


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
) -> tuple[str, str, dict]:
    if oauth_provider == CODEX_OAUTH_PROVIDER:
        payload = await _codex_auth_profile_payload(client, config, response, profile)
        return (
            payload,
            "agent_profile",
            {
                "tool": "codex",
                "profile": profile,
                "source": "oauth_pkce",
            },
        )
    return (
        response.text,
        "oauth_profile",
        {
            "provider": oauth_provider,
            "profile": profile,
            "source": "oauth_pkce",
        },
    )


async def _codex_auth_profile_payload(
    client: httpx.AsyncClient,
    config: dict,
    response: httpx.Response,
    profile: str,
) -> str:
    token_data = _token_response_json(response)
    id_token = _required_token_field(token_data, "id_token")
    access_token = _required_token_field(token_data, "access_token")
    refresh_token = _required_token_field(token_data, "refresh_token")
    api_key = await _obtain_codex_api_key(client, config, id_token)
    claims = _jwt_auth_claims(id_token)
    account_id = claims.get("chatgpt_account_id")
    auth_json = {
        "auth_mode": "chatgpt",
        "tokens": {
            "id_token": id_token,
            "access_token": access_token,
            "refresh_token": refresh_token,
            "account_id": account_id if isinstance(account_id, str) and account_id else None,
        },
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


def _parse_state_datetime(input: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(input)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid OAuth state") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


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
    payload_keys: set[tuple[str, str, str]] = set()
    if payload_provider_ids:
        rows = (
            await db.execute(
                select(
                    AiProviderAuthPayload.provider_id,
                    AiProviderAuthPayload.auth_profile,
                    AiProviderAuthPayload.kind,
                ).where(
                    AiProviderAuthPayload.owner_user_id == auth.user_id,
                    AiProviderAuthPayload.provider_id.in_(payload_provider_ids),
                    AiProviderAuthPayload.archived_at.is_(None),
                )
            )
        ).all()
        payload_keys = {(row.provider_id, row.auth_profile, row.kind) for row in rows}
    return [
        _build_response(
            provider,
            credential_material=_provider_credential_material(provider, payload_keys),
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


def _build_response(provider: AiProvider, *, credential_material: str) -> AiProviderResponse:
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


async def _store_auth_payload(
    db: AsyncSession,
    auth: AuthContext,
    provider_id: str,
    profile: str,
    kind: str,
    plaintext: str,
    metadata: dict | None,
) -> None:
    ciphertext, nonce = encrypt(plaintext)
    payload = await _find_auth_payload(db, auth, provider_id, profile, for_update=True)
    if payload is None:
        payload = AiProviderAuthPayload(
            owner_user_id=auth.user_id,
            provider_id=provider_id,
            auth_profile=profile,
            kind=kind,
            source="managed",
            encrypted_payload=ciphertext,
            nonce=nonce,
            payload_metadata=metadata,
            credential_revision=secrets.token_hex(16),
        )
        db.add(payload)
    else:
        payload.kind = kind
        payload.source = "managed"
        payload.encrypted_payload = ciphertext
        payload.nonce = nonce
        payload.payload_metadata = metadata
        payload.credential_revision = secrets.token_hex(16)
        payload.archived_at = None
    if kind not in {"agent_profile", "oauth_profile"}:
        payload.consumer_environment_id = None
        payload.consumer_runtime = None
    else:
        try:
            await claim_unique_bound_runtime(
                db,
                owner_user_id=auth.user_id,
                provider_id=provider_id,
                payload=payload,
            )
        except OAuthCredentialClaimConflict as exc:
            raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    await _archive_other_auth_payloads(db, auth, provider_id, profile)


async def _archive_other_auth_payloads(
    db: AsyncSession,
    auth: AuthContext,
    provider_id: str,
    active_profile: str,
) -> None:
    await db.execute(
        update(AiProviderAuthPayload)
        .where(
            AiProviderAuthPayload.owner_user_id == auth.user_id,
            AiProviderAuthPayload.provider_id == provider_id,
            AiProviderAuthPayload.auth_profile != active_profile,
            AiProviderAuthPayload.archived_at.is_(None),
        )
        .values(
            archived_at=datetime.now(UTC),
            consumer_environment_id=None,
            consumer_runtime=None,
        )
    )


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
