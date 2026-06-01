import re
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_user_auth, require_user_cli
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
    auth: AuthContext = Depends(require_user_auth),
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
    auth: AuthContext = Depends(require_user_auth),
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
    auth: AuthContext = Depends(require_user_auth),
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
    auth: AuthContext = Depends(require_user_auth),
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
    auth: AuthContext = Depends(require_user_auth),
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
    profile = input.strip().lower().replace("_", "-")
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
