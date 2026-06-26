from __future__ import annotations

from datetime import UTC, datetime
from urllib.parse import urlparse

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai_provider import AiProvider, AiProviderAuthPayload
from app.models.user import User
from app.services.vault_crypto import encrypt

MANAGED_AI_PROVIDER_ID = "clawdi-managed"
MANAGED_AI_PROVIDER_API_MODE = "openai_responses"
MANAGED_AI_PROVIDER_RUNTIME_ENV = "CLAWDI_MANAGED_OPENAI_API_KEY"
MANAGED_AI_PROVIDER_TYPE = "custom_openai_compatible"
MANAGED_AI_PROVIDER_LABEL = "Clawdi managed"
MANAGED_AI_PROVIDER_PROFILE = "default"


def validate_managed_provider_base_url(base_url: str) -> None:
    parsed = urlparse(base_url.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("base_url must be an http(s) URL")


async def upsert_clawdi_managed_provider(
    db: AsyncSession,
    *,
    user: User,
    base_url: str,
    api_key: str,
    default_model: str | None = None,
    label: str | None = None,
    capabilities: dict | None = None,
) -> AiProvider:
    """Upsert the single first-party managed AI provider contract for a user."""
    validate_managed_provider_base_url(base_url)
    normalized_base_url = base_url.strip()
    if not api_key:
        raise ValueError("api_key cannot be blank")
    existing = (
        await db.execute(
            select(AiProvider).where(
                AiProvider.owner_user_id == user.id,
                AiProvider.provider_id == MANAGED_AI_PROVIDER_ID,
            )
        )
    ).scalar_one_or_none()
    provider = existing or AiProvider(
        owner_user_id=user.id,
        provider_id=MANAGED_AI_PROVIDER_ID,
    )
    provider.scope = "account_global"
    provider.type = MANAGED_AI_PROVIDER_TYPE
    provider.label = label or MANAGED_AI_PROVIDER_LABEL
    provider.base_url = normalized_base_url
    provider.default_model = default_model
    provider.api_mode = MANAGED_AI_PROVIDER_API_MODE
    provider.capabilities = capabilities
    provider.auth_type = "api_key"
    provider.auth_ref = None
    provider.auth_metadata = {"source": "managed", "profile": MANAGED_AI_PROVIDER_PROFILE}
    provider.managed_by = "clawdi"
    provider.runtime_env_name = MANAGED_AI_PROVIDER_RUNTIME_ENV
    provider.archived_at = None
    db.add(provider)

    ciphertext, nonce = encrypt(api_key)
    payload = (
        await db.execute(
            select(AiProviderAuthPayload).where(
                AiProviderAuthPayload.owner_user_id == user.id,
                AiProviderAuthPayload.provider_id == MANAGED_AI_PROVIDER_ID,
                AiProviderAuthPayload.auth_profile == MANAGED_AI_PROVIDER_PROFILE,
            )
        )
    ).scalar_one_or_none()
    if payload is None:
        payload = AiProviderAuthPayload(
            owner_user_id=user.id,
            provider_id=MANAGED_AI_PROVIDER_ID,
            auth_profile=MANAGED_AI_PROVIDER_PROFILE,
            kind="api_key",
            source="managed",
            encrypted_payload=ciphertext,
            nonce=nonce,
            payload_metadata={"runtime_env_name": MANAGED_AI_PROVIDER_RUNTIME_ENV},
        )
        db.add(payload)
    else:
        payload.kind = "api_key"
        payload.source = "managed"
        payload.encrypted_payload = ciphertext
        payload.nonce = nonce
        payload.payload_metadata = {"runtime_env_name": MANAGED_AI_PROVIDER_RUNTIME_ENV}
        payload.archived_at = None

    await db.execute(
        update(AiProviderAuthPayload)
        .where(
            AiProviderAuthPayload.owner_user_id == user.id,
            AiProviderAuthPayload.provider_id == MANAGED_AI_PROVIDER_ID,
            AiProviderAuthPayload.auth_profile != MANAGED_AI_PROVIDER_PROFILE,
            AiProviderAuthPayload.archived_at.is_(None),
        )
        .values(archived_at=datetime.now(UTC))
    )
    return provider
