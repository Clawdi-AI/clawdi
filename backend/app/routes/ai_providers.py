import base64
import hashlib
import json
import re
import secrets
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode, urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import (
    AuthContext,
    require_user_auth,
    require_user_auth_unbound,
    require_user_cli,
)
from app.core.config import settings
from app.core.database import get_session
from app.models.ai_provider import AiProvider, AiProviderAuthPayload
from app.schemas.ai_provider import (
    AiProviderAuth,
    AiProviderAuthImportRequest,
    AiProviderAuthResolveRequest,
    AiProviderAuthResolveResponse,
    AiProviderDeleteResponse,
    AiProviderListResponse,
    AiProviderManagedApiKeyRequest,
    AiProviderOAuthCompleteRequest,
    AiProviderOAuthStartRequest,
    AiProviderOAuthStartResponse,
    AiProviderPatch,
    AiProviderResponse,
    AiProviderUpsert,
    AiProviderValidationResponse,
)
from app.services.vault_crypto import decrypt, encrypt

router = APIRouter(prefix="/api/ai-providers", tags=["ai-providers"])

ALLOWED_API_MODES: dict[str, set[str]] = {
    "openai": {"openai_chat", "openai_responses"},
    "anthropic": {"anthropic_messages"},
    "openrouter": {"openai_chat"},
    "gemini": {"google_generate_content"},
    "mistral": {"openai_chat"},
    "custom_openai_compatible": {"openai_chat", "openai_responses"},
}

OAUTH_STATE_TTL_SECONDS = 10 * 60
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
    return AiProviderListResponse(providers=[_to_response(row) for row in rows])


@router.post("", response_model=AiProviderResponse, response_model_exclude_none=True)
async def upsert_ai_provider(
    body: AiProviderUpsert,
    replace: bool = Query(default=False),
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> AiProviderResponse:
    errors = _validate_provider(body)
    if errors:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"errors": errors})
    existing = await _find_provider(db, auth, body.provider_id, include_archived=True)
    if existing is not None and existing.archived_at is None and not replace:
        raise HTTPException(status.HTTP_409_CONFLICT, "AI Provider already exists")
    provider = existing or AiProvider(owner_user_id=auth.user_id, provider_id=body.provider_id)
    _apply_provider_body(provider, body)
    provider.archived_at = None
    db.add(provider)
    await db.commit()
    await db.refresh(provider)
    return _to_response(provider)


@router.get("/{provider_id}", response_model=AiProviderResponse, response_model_exclude_none=True)
async def get_ai_provider(
    provider_id: str,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> AiProviderResponse:
    provider = await _get_provider_or_404(db, auth, provider_id)
    return _to_response(provider)


@router.patch("/{provider_id}", response_model=AiProviderResponse, response_model_exclude_none=True)
async def patch_ai_provider(
    provider_id: str,
    body: AiProviderPatch,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> AiProviderResponse:
    provider = await _get_provider_or_404(db, auth, provider_id)
    merged = _response_to_upsert(provider)
    update = body.model_dump(exclude_unset=True)
    null_errors = _validate_patch_nulls(update)
    if null_errors:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"errors": null_errors})
    for key, value in update.items():
        if key == "auth" and isinstance(value, dict):
            value = AiProviderAuth.model_validate(value)
        setattr(merged, key, value)
    errors = _validate_provider(merged)
    if errors:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"errors": errors})
    _apply_provider_body(provider, merged)
    await db.commit()
    await db.refresh(provider)
    return _to_response(provider)


@router.delete("/{provider_id}", response_model=AiProviderDeleteResponse)
async def delete_ai_provider(
    provider_id: str,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> AiProviderDeleteResponse:
    provider = await _get_provider_or_404(db, auth, provider_id)
    archived_at = datetime.now(UTC)
    provider.archived_at = archived_at
    payloads = (
        (
            await db.execute(
                select(AiProviderAuthPayload).where(
                    AiProviderAuthPayload.owner_user_id == auth.user_id,
                    AiProviderAuthPayload.provider_id == provider_id,
                    AiProviderAuthPayload.archived_at.is_(None),
                )
            )
        )
        .scalars()
        .all()
    )
    for payload in payloads:
        payload.archived_at = archived_at
    await db.commit()
    return AiProviderDeleteResponse(status="deleted", provider_id=provider_id)


@router.post("/{provider_id}/validate", response_model=AiProviderValidationResponse)
async def validate_ai_provider(
    provider_id: str,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> AiProviderValidationResponse:
    provider = await _get_provider_or_404(db, auth, provider_id)
    body = _response_to_upsert(provider)
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
    provider = await _get_provider_or_404(db, auth, provider_id)
    profile = _normalize_profile(body.profile)
    runtime_env_name = body.runtime_env_name
    if runtime_env_name is not None and not _is_runtime_env_name(runtime_env_name):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid runtime_env_name")
    payload_ref = _payload_ref(provider_id, profile)
    ciphertext, nonce = encrypt(body.value.get_secret_value())
    existing = await _find_auth_payload(db, auth, provider_id, profile)
    if existing is None:
        existing = AiProviderAuthPayload(
            owner_user_id=auth.user_id,
            provider_id=provider_id,
            auth_profile=profile,
            kind="api_key",
            source="managed",
            encrypted_payload=ciphertext,
            nonce=nonce,
            payload_metadata=_compact({"runtime_env_name": runtime_env_name}),
        )
        db.add(existing)
    else:
        existing.kind = "api_key"
        existing.source = "managed"
        existing.encrypted_payload = ciphertext
        existing.nonce = nonce
        existing.payload_metadata = _compact({"runtime_env_name": runtime_env_name})
        existing.archived_at = None

    provider.auth_type = "api_key"
    provider.auth_ref = payload_ref
    provider.auth_metadata = {"source": "managed", "payload_ref": payload_ref}
    if runtime_env_name is not None:
        provider.runtime_env_name = runtime_env_name
    await db.commit()
    await db.refresh(provider)
    return _to_response(provider)


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
    provider = await _get_provider_or_404(db, auth, provider_id)
    profile = _normalize_profile(body.profile)
    payload_ref = _payload_ref(provider_id, profile)
    if body.type == "agent_profile":
        if not body.tool:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "agent_profile requires tool")
        provider.auth_type = "agent_profile"
        provider.auth_ref = payload_ref
        provider.auth_metadata = {
            "tool": _normalize_profile(body.tool),
            "profile": profile,
            "payload_ref": payload_ref,
        }
    elif body.type == "oauth_profile":
        if not body.provider:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "oauth_profile requires provider",
            )
        provider.auth_type = "oauth_profile"
        provider.auth_ref = payload_ref
        provider.auth_metadata = {
            "provider": _normalize_profile(body.provider),
            "profile": profile,
            "payload_ref": payload_ref,
        }
    ciphertext, nonce = encrypt(body.payload.get_secret_value())
    existing = await _find_auth_payload(db, auth, provider_id, profile)
    if existing is None:
        existing = AiProviderAuthPayload(
            owner_user_id=auth.user_id,
            provider_id=provider_id,
            auth_profile=profile,
            kind=body.type,
            source="managed",
            encrypted_payload=ciphertext,
            nonce=nonce,
            payload_metadata=provider.auth_metadata,
        )
        db.add(existing)
    else:
        existing.kind = body.type
        existing.source = "managed"
        existing.encrypted_payload = ciphertext
        existing.nonce = nonce
        existing.payload_metadata = provider.auth_metadata
        existing.archived_at = None
    await db.commit()
    await db.refresh(provider)
    return _to_response(provider)


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
    await _get_provider_or_404(db, auth, provider_id)
    oauth_provider = _normalize_profile(body.provider)
    profile = _normalize_profile(body.profile)
    config = _oauth_config_for(oauth_provider)
    authorization_url = _required_oauth_config(config, "authorization_url", oauth_provider)
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
            "provider_id": provider_id,
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
        provider_id=provider_id,
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
    state = _decode_oauth_state(body.state)
    if state.get("provider_id") != provider_id or state.get("owner_user_id") != str(auth.user_id):
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

    payload_ref = _payload_ref(provider_id, profile)
    ciphertext, nonce = encrypt(response.text)
    existing = await _find_auth_payload(db, auth, provider_id, profile)
    metadata = {
        "provider": oauth_provider,
        "profile": profile,
        "payload_ref": payload_ref,
    }
    if existing is None:
        existing = AiProviderAuthPayload(
            owner_user_id=auth.user_id,
            provider_id=provider_id,
            auth_profile=profile,
            kind="oauth_profile",
            source="managed",
            encrypted_payload=ciphertext,
            nonce=nonce,
            payload_metadata=metadata,
        )
        db.add(existing)
    else:
        existing.kind = "oauth_profile"
        existing.source = "managed"
        existing.encrypted_payload = ciphertext
        existing.nonce = nonce
        existing.payload_metadata = metadata
        existing.archived_at = None
    provider.auth_type = "oauth_profile"
    provider.auth_ref = payload_ref
    provider.auth_metadata = metadata
    await db.commit()
    await db.refresh(provider)
    return _to_response(provider)


@router.post("/{provider_id}/auth/resolve", response_model=AiProviderAuthResolveResponse)
async def resolve_ai_provider_auth(
    provider_id: str,
    body: AiProviderAuthResolveRequest,
    auth: AuthContext = Depends(require_user_cli),
    db: AsyncSession = Depends(get_session),
) -> AiProviderAuthResolveResponse:
    provider = await _get_provider_or_404(db, auth, provider_id)
    metadata = provider.auth_metadata or {}
    if provider.auth_type == "api_key" and metadata.get("source") != "managed":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "AI Provider does not use managed api_key auth",
        )
    profile = _normalize_profile(body.profile)
    payload = await _find_auth_payload(db, auth, provider_id, profile)
    if payload is None or payload.archived_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "AI Provider auth payload not found")
    plaintext = decrypt(payload.encrypted_payload, payload.nonce)
    if provider.auth_type == "api_key":
        return AiProviderAuthResolveResponse(
            provider_id=provider_id,
            auth_type="api_key",
            payload_ref=_payload_ref(provider_id, profile),
            value=plaintext,
            profile=profile,
        )
    if provider.auth_type in {"agent_profile", "oauth_profile"}:
        return AiProviderAuthResolveResponse(
            provider_id=provider_id,
            auth_type=provider.auth_type,
            payload_ref=_payload_ref(provider_id, profile),
            payload=plaintext,
            tool=metadata.get("tool"),
            provider=metadata.get("provider"),
            profile=profile,
        )
    raise HTTPException(
        status.HTTP_409_CONFLICT,
        "AI Provider auth has no managed payload",
    )


def _oauth_config_for(oauth_provider: str) -> dict:
    raw = settings.ai_provider_oauth_config_json.strip()
    if not raw:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "AI Provider OAuth is not configured",
        )
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
    config = data.get(oauth_provider)
    if not isinstance(config, dict):
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"AI Provider OAuth config not found for {oauth_provider}",
        )
    return config


def _required_oauth_config(config: dict, key: str, oauth_provider: str) -> str:
    value = config.get(key)
    if not isinstance(value, str) or not value.strip():
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            f"AI Provider OAuth config for {oauth_provider} is missing {key}",
        )
    return value.strip()


def _encode_oauth_state(payload: dict[str, str]) -> str:
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


def _base64url_decode(raw: str) -> str:
    return _base64url_decode_bytes(raw).decode()


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


def _validate_redirect_uri(input: str) -> None:
    parsed = urlparse(input)
    if parsed.scheme == "https" and parsed.netloc:
        return
    if parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}:
        return
    raise HTTPException(
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "redirect_uri must be https or loopback http",
    )


async def _find_provider(
    db: AsyncSession,
    auth: AuthContext,
    provider_id: str,
    *,
    include_archived: bool = False,
) -> AiProvider | None:
    stmt = select(AiProvider).where(
        AiProvider.owner_user_id == auth.user_id,
        AiProvider.provider_id == provider_id,
    )
    if not include_archived:
        stmt = stmt.where(AiProvider.archived_at.is_(None))
    return (await db.execute(stmt)).scalar_one_or_none()


async def _get_provider_or_404(db: AsyncSession, auth: AuthContext, provider_id: str) -> AiProvider:
    provider = await _find_provider(db, auth, provider_id)
    if provider is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "AI Provider not found")
    return provider


def _apply_provider_body(provider: AiProvider, body: AiProviderUpsert) -> None:
    provider.scope = "account_global"
    provider.type = body.type
    provider.label = body.label
    provider.base_url = body.base_url
    provider.default_model = body.default_model
    provider.api_mode = body.api_mode
    provider.capabilities = body.capabilities
    provider.managed_by = body.managed_by
    provider.runtime_env_name = body.runtime_env_name
    provider.auth_type = body.auth.type
    provider.auth_ref, provider.auth_metadata = _split_auth(body.auth)


def _split_auth(auth: AiProviderAuth) -> tuple[str | None, dict | None]:
    if auth.type == "secret_ref":
        return auth.ref, None
    if auth.type == "api_key":
        metadata = {
            "source": auth.source,
            "payload_ref": auth.payload_ref,
        }
        return auth.ref or auth.payload_ref, _compact(metadata)
    if auth.type == "oauth_profile":
        metadata = {
            "provider": auth.provider,
            "profile": auth.profile,
            "payload_ref": auth.payload_ref,
        }
        return auth.payload_ref, _compact(metadata)
    if auth.type == "agent_profile":
        metadata = {
            "tool": auth.tool,
            "profile": auth.profile,
            "payload_ref": auth.payload_ref,
        }
        return auth.payload_ref, _compact(metadata)
    return None, None


def _to_auth(provider: AiProvider) -> AiProviderAuth:
    metadata = provider.auth_metadata or {}
    if provider.auth_type == "secret_ref":
        return AiProviderAuth(type="secret_ref", ref=provider.auth_ref)
    if provider.auth_type == "api_key":
        source = metadata.get("source")
        return AiProviderAuth(
            type="api_key",
            source=source,
            ref=provider.auth_ref if source != "managed" else None,
            payload_ref=metadata.get("payload_ref"),
        )
    if provider.auth_type == "oauth_profile":
        return AiProviderAuth(
            type="oauth_profile",
            provider=metadata.get("provider"),
            profile=metadata.get("profile"),
            payload_ref=metadata.get("payload_ref"),
        )
    if provider.auth_type == "agent_profile":
        return AiProviderAuth(
            type="agent_profile",
            tool=metadata.get("tool"),
            profile=metadata.get("profile"),
            payload_ref=metadata.get("payload_ref"),
        )
    return AiProviderAuth(type="none")


def _to_response(provider: AiProvider) -> AiProviderResponse:
    return AiProviderResponse(
        id=str(provider.id),
        provider_id=provider.provider_id,
        scope=provider.scope,
        type=provider.type,
        label=provider.label,
        base_url=provider.base_url,
        default_model=provider.default_model,
        api_mode=provider.api_mode,
        auth=_to_auth(provider),
        managed_by=provider.managed_by,
        runtime_env_name=provider.runtime_env_name,
        capabilities=provider.capabilities,
        created_at=provider.created_at,
        updated_at=provider.updated_at,
    )


def _response_to_upsert(provider: AiProvider) -> AiProviderUpsert:
    return AiProviderUpsert(
        provider_id=provider.provider_id,
        type=provider.type,
        label=provider.label,
        base_url=provider.base_url,
        default_model=provider.default_model,
        api_mode=provider.api_mode,
        auth=_to_auth(provider),
        managed_by=provider.managed_by,
        runtime_env_name=provider.runtime_env_name,
        capabilities=provider.capabilities,
    )


def _validate_provider(body: AiProviderUpsert) -> list[str]:
    errors: list[str] = []
    errors.extend(_validate_base_url(body.base_url, body.auth))
    if body.runtime_env_name is not None and not _is_runtime_env_name(body.runtime_env_name):
        errors.append("runtime_env_name must be an uppercase environment variable name")
    allowed_modes = ALLOWED_API_MODES[body.type]
    if body.api_mode is not None and body.api_mode not in allowed_modes:
        errors.append(f"type {body.type} is incompatible with api_mode {body.api_mode}")
    if body.type == "custom_openai_compatible" and body.api_mode is None:
        errors.append("custom_openai_compatible requires api_mode")
    errors.extend(_validate_auth(body.provider_id, body.auth))
    return errors


def _validate_auth(provider_id: str, auth: AiProviderAuth) -> list[str]:
    errors: list[str] = []
    if auth.value is not None:
        errors.append("auth must not include plaintext value")
    if auth.type == "secret_ref":
        if not auth.ref or not (_is_env_ref(auth.ref) or auth.ref.startswith("clawdi://")):
            errors.append("secret_ref auth requires env: or clawdi:// ref")
    elif auth.type == "api_key":
        if auth.source not in {"env", "vault", "managed"}:
            errors.append("api_key auth requires source env, vault, or managed")
        if auth.source == "env" and (not auth.ref or not _is_env_ref(auth.ref)):
            errors.append("api_key env auth requires env: ref")
        if auth.source == "vault" and (not auth.ref or not auth.ref.startswith("clawdi://")):
            errors.append("api_key vault auth requires clawdi:// ref")
        if auth.source == "managed" and not auth.payload_ref:
            errors.append("api_key managed auth requires payload_ref")
        if (
            auth.source == "managed"
            and auth.payload_ref
            and not _is_payload_ref(auth.payload_ref, provider_id)
        ):
            errors.append("api_key managed auth has invalid payload_ref")
    elif auth.type == "oauth_profile":
        if not auth.provider or not auth.profile:
            errors.append("oauth_profile auth requires provider and profile")
        elif not _is_profile_id(auth.provider) or not _is_profile_id(auth.profile):
            errors.append("oauth_profile auth has invalid provider or profile")
        if auth.payload_ref and not _is_payload_ref(auth.payload_ref, provider_id):
            errors.append("oauth_profile auth has invalid payload_ref")
    elif auth.type == "agent_profile":
        if not auth.tool or not auth.profile:
            errors.append("agent_profile auth requires tool and profile")
        elif not _is_profile_id(auth.tool) or not _is_profile_id(auth.profile):
            errors.append("agent_profile auth has invalid tool or profile")
        if auth.payload_ref and not _is_payload_ref(auth.payload_ref, provider_id):
            errors.append("agent_profile auth has invalid payload_ref")
    return errors


def _validate_patch_nulls(update: dict) -> list[str]:
    errors: list[str] = []
    for field in ("type", "base_url", "auth", "managed_by"):
        if field in update and update[field] is None:
            errors.append(f"{field} cannot be null")
    return errors


def _validate_base_url(base_url: str, auth: AiProviderAuth) -> list[str]:
    errors: list[str] = []
    from urllib.parse import urlparse

    parsed = urlparse(base_url)
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
    return hostname in {"localhost", "127.0.0.1", "::1"}


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
) -> AiProviderAuthPayload | None:
    return (
        await db.execute(
            select(AiProviderAuthPayload).where(
                AiProviderAuthPayload.owner_user_id == auth.user_id,
                AiProviderAuthPayload.provider_id == provider_id,
                AiProviderAuthPayload.auth_profile == profile,
            )
        )
    ).scalar_one_or_none()


def _payload_ref(provider_id: str, profile: str) -> str:
    return f"ai-provider-auth://{provider_id}/{profile}"


def _normalize_profile(input: str) -> str:
    profile = input.strip().lower()
    if not re.fullmatch(r"[a-z][a-z0-9._-]{0,119}", profile):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid profile")
    return profile


def _is_runtime_env_name(input: str) -> bool:
    return re.fullmatch(r"[A-Z][A-Z0-9_]{0,127}", input) is not None


def _is_env_ref(input: str) -> bool:
    return re.fullmatch(r"env:[A-Z][A-Z0-9_]{0,127}", input) is not None


def _is_profile_id(input: str) -> bool:
    return re.fullmatch(r"[a-z][a-z0-9._-]{0,119}", input) is not None


def _is_payload_ref(input: str, provider_id: str) -> bool:
    return (
        re.fullmatch(
            rf"ai-provider-auth://{re.escape(provider_id)}/[a-z][a-z0-9._-]{{0,119}}",
            input,
        )
        is not None
    )
