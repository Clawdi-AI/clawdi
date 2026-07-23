from __future__ import annotations

import re
from datetime import UTC, datetime
from urllib.parse import urlparse
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai_provider import AiProvider, AiProviderAuthPayload
from app.models.user import User
from app.services.vault_crypto import encrypt

V1_MANAGED_AI_PROVIDER_ID = "clawdi-managed"
V1_MANAGED_AI_PROVIDER_API_MODE = "openai_responses"
V2_MANAGED_AI_PROVIDER_ID = "clawdi-v2"
V2_DEPLOYMENT_MANAGED_AI_PROVIDER_PREFIX = "clawdi-v2-deployment-"
V2_MANAGED_AI_PROVIDER_MAX_ID_LENGTH = 63
# TODO(#425): Remove this legacy alias and transition accept-set after hosted#892
# is deployed everywhere and no dev/self-hosted binding still uses clawdi-managed-v2.
V2_LEGACY_MANAGED_AI_PROVIDER_ID = "clawdi-managed-v2"
V2_MANAGED_AI_PROVIDER_IDS = frozenset(
    {V2_MANAGED_AI_PROVIDER_ID, V2_LEGACY_MANAGED_AI_PROVIDER_ID}
)
V2_MANAGED_AI_PROVIDER_API_MODE = "openai_chat"

# The admin managed-provider path is owned by hosted v2. V1 writes its provider
# through the user AI Provider endpoint with the v1-specific id/mode above.
MANAGED_AI_PROVIDER_ID = V2_MANAGED_AI_PROVIDER_ID
MANAGED_AI_PROVIDER_API_MODE = V2_MANAGED_AI_PROVIDER_API_MODE
# TODO(#425): Remove the legacy v2 member from this aggregate after hosted#892
# is deployed everywhere and no dev/self-hosted binding still uses clawdi-managed-v2.
MANAGED_AI_PROVIDER_IDS = frozenset({V1_MANAGED_AI_PROVIDER_ID, *V2_MANAGED_AI_PROVIDER_IDS})
MANAGED_AI_PROVIDER_RUNTIME_ENV = "CLAWDI_MANAGED_OPENAI_API_KEY"
MANAGED_AI_PROVIDER_TYPE = "custom_openai_compatible"
MANAGED_AI_PROVIDER_LABEL = "Clawdi managed"
MANAGED_AI_PROVIDER_PROFILE = "default"
MANAGED_AI_PROVIDER_SCOPE = "account_global"
MANAGED_AI_PROVIDER_PROVENANCE_CAPABILITY = "clawdi_provisioning_discovery_key"

_V2_DEPLOYMENT_ID_RE = re.compile(r"^[1-9][0-9]*$")


def is_v2_deployment_managed_provider_id(provider_id: str) -> bool:
    if len(provider_id) > V2_MANAGED_AI_PROVIDER_MAX_ID_LENGTH or not provider_id.startswith(
        V2_DEPLOYMENT_MANAGED_AI_PROVIDER_PREFIX
    ):
        return False
    deployment_id = provider_id.removeprefix(V2_DEPLOYMENT_MANAGED_AI_PROVIDER_PREFIX)
    return _V2_DEPLOYMENT_ID_RE.fullmatch(deployment_id) is not None


def v2_deployment_managed_provider_id(deployment_id: str) -> str | None:
    """Return the credential identity for a numeric hosted deployment id."""

    if _V2_DEPLOYMENT_ID_RE.fullmatch(deployment_id) is None:
        return None
    provider_id = f"{V2_DEPLOYMENT_MANAGED_AI_PROVIDER_PREFIX}{deployment_id}"
    return provider_id if len(provider_id) <= V2_MANAGED_AI_PROVIDER_MAX_ID_LENGTH else None


def is_v2_managed_provider_id(provider_id: str) -> bool:
    return provider_id in V2_MANAGED_AI_PROVIDER_IDS or is_v2_deployment_managed_provider_id(
        provider_id
    )


def is_managed_provider_id(provider_id: str) -> bool:
    return provider_id == V1_MANAGED_AI_PROVIDER_ID or is_v2_managed_provider_id(provider_id)


def runtime_managed_provider_id(provider_id: str) -> str:
    """Return the stable agent-facing id for a managed provider binding."""

    return (
        V2_MANAGED_AI_PROVIDER_ID
        if provider_id == V2_MANAGED_AI_PROVIDER_ID
        or is_v2_deployment_managed_provider_id(provider_id)
        else provider_id
    )


def managed_provider_api_mode(provider_id: str) -> str | None:
    if provider_id == V1_MANAGED_AI_PROVIDER_ID:
        return V1_MANAGED_AI_PROVIDER_API_MODE
    # TODO(#425): Remove legacy v2 mode resolution after hosted#892 is deployed
    # everywhere and no dev/self-hosted binding still uses clawdi-managed-v2.
    if provider_id in V2_MANAGED_AI_PROVIDER_IDS:
        return V2_MANAGED_AI_PROVIDER_API_MODE
    return None


def validate_managed_provider_base_url(base_url: str) -> None:
    parsed = urlparse(base_url.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("base_url must be an http(s) URL")


async def lock_deployment_managed_provider_mutation(
    db: AsyncSession,
    *,
    owner_user_id: UUID,
    provider_id: str,
) -> None:
    """Serialize deployment-provider PUT/DELETE for one owner scope.

    The transaction lock identity matches the provider uniqueness boundary and
    remains held through provider/auth writes, audit insertion, and commit.
    """

    if not is_v2_deployment_managed_provider_id(provider_id):
        raise ValueError("unsupported deployment managed provider id")
    lock_name = f"managed-ai-provider:{owner_user_id}:{provider_id}"
    await db.execute(select(func.pg_advisory_xact_lock(func.hashtextextended(lock_name, 0))))


async def upsert_clawdi_managed_provider(
    db: AsyncSession,
    *,
    user: User,
    provider_id: str = MANAGED_AI_PROVIDER_ID,
    base_url: str,
    api_key: str,
    default_model: str | None = None,
    models: list[dict] | None = None,
    label: str | None = None,
    capabilities: dict | None = None,
) -> AiProvider:
    """Upsert a first-party v2 managed AI provider contract for a user."""
    # TODO(#425): Remove legacy v2 upsert acceptance after hosted#892 is deployed
    # everywhere and no dev/self-hosted binding still uses clawdi-managed-v2.
    if not is_v2_managed_provider_id(provider_id):
        raise ValueError("unsupported managed provider id")
    validate_managed_provider_base_url(base_url)
    normalized_base_url = base_url.strip()
    if not api_key:
        raise ValueError("api_key cannot be blank")
    existing = (
        await db.execute(
            select(AiProvider).where(
                AiProvider.owner_user_id == user.id,
                AiProvider.provider_id == provider_id,
            )
        )
    ).scalar_one_or_none()
    provider = existing or AiProvider(
        owner_user_id=user.id,
        provider_id=provider_id,
    )
    provider.type = MANAGED_AI_PROVIDER_TYPE
    provider.label = label or MANAGED_AI_PROVIDER_LABEL
    provider.base_url = normalized_base_url
    provider.api_mode = MANAGED_AI_PROVIDER_API_MODE
    provider.capabilities = capabilities
    if models is not None:
        provider.models = models
    else:
        provider.models = [{"id": default_model}] if default_model else None
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
                AiProviderAuthPayload.provider_id == provider_id,
                AiProviderAuthPayload.auth_profile == MANAGED_AI_PROVIDER_PROFILE,
            )
        )
    ).scalar_one_or_none()
    if payload is None:
        payload = AiProviderAuthPayload(
            owner_user_id=user.id,
            provider_id=provider_id,
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
            AiProviderAuthPayload.provider_id == provider_id,
            AiProviderAuthPayload.auth_profile != MANAGED_AI_PROVIDER_PROFILE,
            AiProviderAuthPayload.archived_at.is_(None),
        )
        .values(archived_at=datetime.now(UTC))
    )
    return provider


async def find_clawdi_managed_provider(
    db: AsyncSession,
    *,
    owner_user_id: UUID,
    provider_id: str,
    include_archived: bool = False,
) -> AiProvider | None:
    """Find one managed provider without crossing its account boundary."""

    if not is_v2_managed_provider_id(provider_id):
        raise ValueError("unsupported managed provider id")
    query = select(AiProvider).where(
        AiProvider.owner_user_id == owner_user_id,
        AiProvider.provider_id == provider_id,
    )
    if not include_archived:
        query = query.where(AiProvider.archived_at.is_(None))
    return (await db.execute(query)).scalar_one_or_none()


async def archive_clawdi_managed_provider(
    db: AsyncSession,
    *,
    owner_user_id: UUID,
    provider_id: str,
) -> AiProvider | None:
    """Archive managed provider metadata and encrypted auth for one owner."""

    provider = await find_clawdi_managed_provider(
        db,
        owner_user_id=owner_user_id,
        provider_id=provider_id,
    )
    if provider is None:
        return None
    archived_at = datetime.now(UTC)
    provider.archived_at = archived_at
    await db.execute(
        update(AiProviderAuthPayload)
        .where(
            AiProviderAuthPayload.owner_user_id == owner_user_id,
            AiProviderAuthPayload.provider_id == provider_id,
            AiProviderAuthPayload.archived_at.is_(None),
        )
        .values(archived_at=archived_at)
    )
    return provider
