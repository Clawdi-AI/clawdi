from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from pydantic import JsonValue
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai_provider import AiProvider
from app.models.user import User
from app.services.ai_provider_auth_transition import (
    AuthCredentialWrite,
    transition_ai_provider_auth,
)
from app.services.ai_provider_credentials import lock_ai_provider_owner
from app.services.url_security import UnsafePublicHttpsUrlError, validate_public_https_url

CLAWDI_MANAGED_PROVIDER_ID = "clawdi"
V1_MANAGED_AI_PROVIDER_ID = "clawdi-managed"
V1_MANAGED_AI_PROVIDER_API_MODE = "openai_responses"
_V1_MANAGED_AI_PROVIDER_ACCEPTED_API_MODES = (V1_MANAGED_AI_PROVIDER_API_MODE,)
V2_MANAGED_AI_PROVIDER_ID = CLAWDI_MANAGED_PROVIDER_ID
V2_DEPLOYMENT_MANAGED_AI_PROVIDER_PREFIX = "clawdi-v2-deployment-"
V2_MANAGED_AI_PROVIDER_MAX_ID_LENGTH = 63
V2_LEGACY_PUBLIC_MANAGED_AI_PROVIDER_ID = "clawdi-v2"
# TODO(#425): Remove legacy aliases only after the cross-repo rollout is complete
# and persisted clients no longer send either legacy id.
V2_LEGACY_MANAGED_AI_PROVIDER_ID = "clawdi-managed-v2"
V2_MANAGED_AI_PROVIDER_IDS = frozenset(
    {
        V2_MANAGED_AI_PROVIDER_ID,
        V2_LEGACY_PUBLIC_MANAGED_AI_PROVIDER_ID,
        V2_LEGACY_MANAGED_AI_PROVIDER_ID,
    }
)
V2_MANAGED_AI_PROVIDER_API_MODE = "openai_responses"
_V2_MANAGED_AI_PROVIDER_ACCEPTED_API_MODES = (
    V2_MANAGED_AI_PROVIDER_API_MODE,
    "openai_chat",
)

# The admin managed-provider path is owned by hosted v2. V1 writes its provider
# through the user AI Provider endpoint with the v1-specific id/mode above.
MANAGED_AI_PROVIDER_ID = V2_MANAGED_AI_PROVIDER_ID
MANAGED_AI_PROVIDER_API_MODE = V2_MANAGED_AI_PROVIDER_API_MODE
# TODO(#425): Remove legacy v2 members after the compatibility window closes.
MANAGED_AI_PROVIDER_IDS = frozenset({V1_MANAGED_AI_PROVIDER_ID, *V2_MANAGED_AI_PROVIDER_IDS})
MANAGED_AI_PROVIDER_RUNTIME_ENV = "CLAWDI_AI_API_KEY"
MANAGED_AI_PROVIDER_TYPE = "custom_openai_compatible"
MANAGED_AI_PROVIDER_LABEL = "Clawdi managed"
MANAGED_AI_PROVIDER_PROFILE = "default"
MANAGED_AI_PROVIDER_SCOPE = "account_global"
MANAGED_AI_PROVIDER_PROVENANCE_CAPABILITY = "clawdi_provisioning_discovery_key"

_LEGACY_MANAGED_AI_PROVIDER_RUNTIME_ENV = "CLAWDI_MANAGED_OPENAI_API_KEY"
# Keep the exact pairings emitted by released admin upserts, not two independent allowlists.
_SUPPORTED_DEPLOYMENT_MANAGED_PROVIDER_CONTRACTS = frozenset(
    {
        ("openai_chat", _LEGACY_MANAGED_AI_PROVIDER_RUNTIME_ENV),
        ("openai_chat", MANAGED_AI_PROVIDER_RUNTIME_ENV),
        (MANAGED_AI_PROVIDER_API_MODE, MANAGED_AI_PROVIDER_RUNTIME_ENV),
    }
)

_V2_DEPLOYMENT_ID_RE = re.compile(r"^[1-9][0-9]*$")


class DeploymentManagedProviderCleanupMismatchError(ValueError):
    pass


class DeploymentManagedProviderCleanupInvariantError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class DeploymentManagedProviderCleanupResult:
    provider: AiProvider
    status: Literal["archived", "already_archived"]


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


def is_runtime_metadata_managed_provider_id(provider_id: str) -> bool:
    """Return whether admin may read or replace non-auth runtime metadata."""

    return provider_id == V1_MANAGED_AI_PROVIDER_ID or is_v2_deployment_managed_provider_id(
        provider_id
    )


def runtime_managed_provider_id(provider_id: str) -> str:
    """Return the stable agent-facing id for a managed provider binding."""

    return (
        CLAWDI_MANAGED_PROVIDER_ID
        if provider_id == CLAWDI_MANAGED_PROVIDER_ID or is_v2_managed_provider_id(provider_id)
        else provider_id
    )


def managed_provider_api_mode(provider_id: str) -> str | None:
    if provider_id == V1_MANAGED_AI_PROVIDER_ID:
        return V1_MANAGED_AI_PROVIDER_API_MODE
    if is_v2_managed_provider_id(provider_id):
        return V2_MANAGED_AI_PROVIDER_API_MODE
    return None


def managed_provider_accepted_api_modes(provider_id: str) -> tuple[str, ...] | None:
    if provider_id == V1_MANAGED_AI_PROVIDER_ID:
        return _V1_MANAGED_AI_PROVIDER_ACCEPTED_API_MODES
    # TODO(#425): Remove openai_chat after the rollout compatibility window closes.
    if is_v2_managed_provider_id(provider_id):
        return _V2_MANAGED_AI_PROVIDER_ACCEPTED_API_MODES
    return None


def validate_managed_provider_base_url(base_url: str) -> None:
    try:
        validate_public_https_url(base_url, label="base_url")
    except UnsafePublicHttpsUrlError as exc:
        raise ValueError(str(exc)) from exc


def is_supported_managed_provider_runtime_contract(provider: AiProvider) -> bool:
    """Return whether a managed provider is safe for metadata-only admin writes."""

    return (
        is_runtime_metadata_managed_provider_id(provider.provider_id)
        and provider.type == MANAGED_AI_PROVIDER_TYPE
        and (provider.api_mode, provider.runtime_env_name)
        in _SUPPORTED_DEPLOYMENT_MANAGED_PROVIDER_CONTRACTS
        and provider.auth_type == "api_key"
        and provider.auth_ref is None
        and (provider.auth_metadata or {}).get("source") == "managed"
        and provider.managed_by == "clawdi"
    )


async def _lock_managed_provider_mutation(
    db: AsyncSession,
    *,
    owner_user_id: UUID,
    provider_id: str,
) -> None:
    await lock_ai_provider_owner(db, owner_user_id)
    lock_name = f"managed-ai-provider:{owner_user_id}:{provider_id}"
    await db.execute(select(func.pg_advisory_xact_lock(func.hashtextextended(lock_name, 0))))


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
    await _lock_managed_provider_mutation(
        db,
        owner_user_id=owner_user_id,
        provider_id=provider_id,
    )


async def lock_runtime_metadata_managed_provider_mutation(
    db: AsyncSession,
    *,
    owner_user_id: UUID,
    provider_id: str,
) -> None:
    """Serialize a metadata-only mutation for one supported managed provider."""

    if not is_runtime_metadata_managed_provider_id(provider_id):
        raise ValueError("unsupported runtime metadata managed provider id")
    await _lock_managed_provider_mutation(
        db,
        owner_user_id=owner_user_id,
        provider_id=provider_id,
    )


async def upsert_clawdi_managed_provider(
    db: AsyncSession,
    *,
    user: User,
    provider_id: str = MANAGED_AI_PROVIDER_ID,
    base_url: str,
    api_key: str,
    default_model: str | None = None,
    models: list[dict[str, JsonValue]] | None = None,
    label: str | None = None,
    capabilities: dict[str, JsonValue] | None = None,
) -> AiProvider:
    """Upsert a first-party v2 managed AI provider contract for a user."""
    # TODO(#425): Remove legacy v2 upsert acceptance after the compatibility window closes.
    if not is_v2_managed_provider_id(provider_id):
        raise ValueError("unsupported managed provider id")
    await lock_ai_provider_owner(db, user.id)
    validate_managed_provider_base_url(base_url)
    normalized_base_url = base_url.strip()
    if not api_key.strip():
        raise ValueError("api_key cannot be blank")
    existing = (
        await db.execute(
            select(AiProvider)
            .where(
                AiProvider.owner_user_id == user.id,
                AiProvider.provider_id == provider_id,
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    provider = existing or AiProvider(
        owner_user_id=user.id,
        provider_id=provider_id,
        auth_type="api_key",
        auth_ref=None,
        auth_metadata={"source": "managed", "profile": MANAGED_AI_PROVIDER_PROFILE},
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
    provider.managed_by = "clawdi"
    provider.runtime_env_name = MANAGED_AI_PROVIDER_RUNTIME_ENV
    provider.activate()
    db.add(provider)
    await db.flush()
    auth_metadata: dict[str, JsonValue] = {
        "source": "managed",
        "profile": MANAGED_AI_PROVIDER_PROFILE,
    }
    await transition_ai_provider_auth(
        db,
        owner_user_id=user.id,
        provider=provider,
        auth_type="api_key",
        auth_ref=None,
        auth_metadata=auth_metadata,
        credential=AuthCredentialWrite(
            profile=MANAGED_AI_PROVIDER_PROFILE,
            kind="api_key",
            plaintext=api_key,
            metadata={"runtime_env_name": MANAGED_AI_PROVIDER_RUNTIME_ENV},
        ),
    )
    return provider


def replace_managed_provider_runtime_metadata(
    provider: AiProvider,
    *,
    base_url: str,
    models: list[dict[str, JsonValue]] | None,
) -> bool:
    """Replace runtime metadata without touching provider auth state."""

    if not is_runtime_metadata_managed_provider_id(provider.provider_id):
        raise ValueError("unsupported runtime metadata managed provider id")
    validate_managed_provider_base_url(base_url)
    normalized_base_url = base_url.strip()
    if (
        provider.type == MANAGED_AI_PROVIDER_TYPE
        and provider.api_mode == MANAGED_AI_PROVIDER_API_MODE
        and provider.managed_by == "clawdi"
        and provider.runtime_env_name == MANAGED_AI_PROVIDER_RUNTIME_ENV
        and provider.base_url == normalized_base_url
        and provider.models == models
    ):
        return False
    provider.type = MANAGED_AI_PROVIDER_TYPE
    provider.api_mode = MANAGED_AI_PROVIDER_API_MODE
    provider.managed_by = "clawdi"
    provider.runtime_env_name = MANAGED_AI_PROVIDER_RUNTIME_ENV
    provider.base_url = normalized_base_url
    provider.models = models
    return True


async def find_clawdi_managed_provider(
    db: AsyncSession,
    *,
    owner_user_id: UUID,
    provider_id: str,
    include_archived: bool = False,
) -> AiProvider | None:
    """Find one managed provider without crossing its account boundary."""

    if not is_managed_provider_id(provider_id):
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

    await lock_ai_provider_owner(db, owner_user_id)
    provider = (
        await db.execute(
            select(AiProvider)
            .where(
                AiProvider.owner_user_id == owner_user_id,
                AiProvider.provider_id == provider_id,
                AiProvider.archived_at.is_(None),
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if provider is None:
        return None
    await transition_ai_provider_auth(
        db,
        owner_user_id=owner_user_id,
        provider=provider,
        auth_type=provider.auth_type,
        auth_ref=provider.auth_ref,
        auth_metadata=provider.auth_metadata,
        archive_provider=True,
    )
    return provider


async def cleanup_deployment_managed_provider(
    db: AsyncSession,
    *,
    owner_user_id: UUID,
    provider_id: str,
    expected_provider_uuid: UUID,
    provisioning_discovery_key: str,
    authority: Literal["active_owner", "completed_principal_cleanup"],
) -> DeploymentManagedProviderCleanupResult | None:
    """Atomically archive or prove the exact retained managed provider."""

    await lock_deployment_managed_provider_mutation(
        db,
        owner_user_id=owner_user_id,
        provider_id=provider_id,
    )
    provider = (
        await db.execute(
            select(AiProvider)
            .where(
                AiProvider.owner_user_id == owner_user_id,
                AiProvider.provider_id == provider_id,
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if provider is None:
        return None
    if (
        not is_supported_managed_provider_runtime_contract(provider)
        or provider.id != expected_provider_uuid
        or (provider.capabilities or {}).get(MANAGED_AI_PROVIDER_PROVENANCE_CAPABILITY)
        != provisioning_discovery_key
    ):
        raise DeploymentManagedProviderCleanupMismatchError(
            "managed AI provider cleanup identity did not match"
        )
    if provider.archived_at is not None:
        return DeploymentManagedProviderCleanupResult(
            provider=provider,
            status="already_archived",
        )
    if authority == "completed_principal_cleanup":
        raise DeploymentManagedProviderCleanupInvariantError(
            "completed principal cleanup retained an active managed AI provider"
        )
    await transition_ai_provider_auth(
        db,
        owner_user_id=owner_user_id,
        provider=provider,
        auth_type=provider.auth_type,
        auth_ref=provider.auth_ref,
        auth_metadata=provider.auth_metadata,
        archive_provider=True,
    )
    return DeploymentManagedProviderCleanupResult(provider=provider, status="archived")
