from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai_provider import AiProvider, AiProviderAuthPayload
from app.models.hosted_runtime import HostedRuntimeState
from app.models.session import AgentEnvironment
from app.models.user import User
from app.schemas.runtime import validate_hosted_runtime_desired_state
from app.services.url_security import is_public_https_url

OAuthConsumerRuntime = Literal["codex", "hermes", "openclaw"]
OAUTH_CONSUMER_RUNTIMES = frozenset({"codex", "hermes", "openclaw"})


class OAuthCredentialClaimConflict(ValueError):
    pass


@dataclass(frozen=True)
class OAuthCredentialConsumer:
    environment_id: UUID
    runtime: OAuthConsumerRuntime


async def lock_ai_provider_owner(db: AsyncSession, owner_user_id: UUID) -> None:
    """Acquire the common parent lock before provider or runtime-state mutations."""

    await db.execute(select(User.id).where(User.id == owner_user_id).with_for_update())


def selected_runtime_binding(runtimes: object) -> tuple[OAuthConsumerRuntime, str | None] | None:
    if not isinstance(runtimes, dict) or len(runtimes) != 1:
        return None
    runtime_name, raw_runtime = next(iter(runtimes.items()))
    if runtime_name not in OAUTH_CONSUMER_RUNTIMES:
        return None
    try:
        runtime = validate_hosted_runtime_desired_state(raw_runtime)
    except ValidationError:
        return None
    provider_id = runtime.provider_ids[0] if runtime.provider_ids else None
    return runtime_name, provider_id


async def environment_binds_provider(
    db: AsyncSession,
    *,
    owner_user_id: UUID,
    environment_id: UUID,
    runtime: OAuthConsumerRuntime,
    provider_id: str,
) -> bool:
    row = (
        await db.execute(
            select(AgentEnvironment, HostedRuntimeState)
            .outerjoin(
                HostedRuntimeState,
                HostedRuntimeState.environment_id == AgentEnvironment.id,
            )
            .where(
                AgentEnvironment.id == environment_id,
                AgentEnvironment.user_id == owner_user_id,
            )
        )
    ).one_or_none()
    if row is None:
        return False
    environment, state = row
    if environment.agent_type != runtime or state is None:
        return False
    binding = selected_runtime_binding(state.runtimes)
    return binding is not None and binding[0] == runtime and provider_id == binding[1]


async def environment_matches_runtime(
    db: AsyncSession,
    *,
    owner_user_id: UUID,
    environment_id: UUID,
    runtime: OAuthConsumerRuntime,
) -> bool:
    return (
        await db.scalar(
            select(AgentEnvironment.id).where(
                AgentEnvironment.id == environment_id,
                AgentEnvironment.user_id == owner_user_id,
                AgentEnvironment.agent_type == runtime,
            )
        )
    ) is not None


async def claim_oauth_payload(
    db: AsyncSession,
    *,
    payload: AiProviderAuthPayload,
    consumer: OAuthCredentialConsumer,
) -> None:
    if payload.kind not in {"agent_profile", "oauth_profile"}:
        return
    if payload.consumer_environment_id is None:
        payload.consumer_environment_id = consumer.environment_id
        payload.consumer_runtime = consumer.runtime
        return
    if (
        payload.consumer_environment_id != consumer.environment_id
        or payload.consumer_runtime != consumer.runtime
    ):
        raise OAuthCredentialClaimConflict(
            "OAuth credential is already owned by another Agent runtime"
        )


async def claim_unique_bound_runtime(
    db: AsyncSession,
    *,
    owner_user_id: UUID,
    provider_id: str,
    payload: AiProviderAuthPayload,
    prospective_auth_type: str,
) -> None:
    consumers = await validate_prospective_bound_runtime_auth(
        db,
        owner_user_id=owner_user_id,
        provider_id=provider_id,
        prospective_auth_type=prospective_auth_type,
    )
    if consumers:
        await claim_oauth_payload(db, payload=payload, consumer=consumers[0])


async def validate_prospective_bound_runtime_auth(
    db: AsyncSession,
    *,
    owner_user_id: UUID,
    provider_id: str,
    prospective_auth_type: str,
) -> list[OAuthCredentialConsumer]:
    """Validate every runtime containing a provider under its prospective auth type."""

    rows = (
        await db.execute(
            select(AgentEnvironment.id, HostedRuntimeState.runtimes)
            .join(
                HostedRuntimeState,
                HostedRuntimeState.environment_id == AgentEnvironment.id,
            )
            .where(AgentEnvironment.user_id == owner_user_id)
            .order_by(AgentEnvironment.id)
        )
    ).all()
    consumers: list[OAuthCredentialConsumer] = []
    for environment_id, runtimes in rows:
        binding = selected_runtime_binding(runtimes)
        if binding is None or provider_id != binding[1]:
            continue
        consumers.append(OAuthCredentialConsumer(environment_id, binding[0]))
    if prospective_auth_type in {"agent_profile", "oauth_profile"} and len(consumers) > 1:
        raise OAuthCredentialClaimConflict(
            "OAuth credential cannot be bound to multiple Agent runtimes"
        )
    return consumers


async def provider_has_hosted_runtime_consumer(
    db: AsyncSession,
    *,
    owner_user_id: UUID,
    provider_id: str,
) -> bool:
    rows = (
        await db.execute(
            select(HostedRuntimeState.runtimes)
            .join(
                AgentEnvironment,
                AgentEnvironment.id == HostedRuntimeState.environment_id,
            )
            .where(AgentEnvironment.user_id == owner_user_id)
            .order_by(HostedRuntimeState.environment_id)
        )
    ).scalars()
    return any(
        (binding := selected_runtime_binding(runtimes)) is not None and provider_id == binding[1]
        for runtimes in rows
    )


async def _lock_and_validate_runtime_provider(
    db: AsyncSession,
    *,
    owner_user_id: UUID,
    provider_id: str | None,
) -> AiProvider | None:
    if provider_id is None:
        return None
    provider = await db.scalar(
        select(AiProvider)
        .where(
            AiProvider.owner_user_id == owner_user_id,
            AiProvider.provider_id == provider_id,
            AiProvider.archived_at.is_(None),
        )
        .with_for_update()
    )
    if provider is not None and not is_public_https_url(provider.base_url):
        raise OAuthCredentialClaimConflict(
            "Hosted runtime AI Provider base_url must be a public HTTPS URL: "
            + provider.provider_id
        )
    return provider


async def reconcile_runtime_oauth_claims(
    db: AsyncSession,
    *,
    owner_user_id: UUID,
    environment_id: UUID,
    runtimes: object,
) -> None:
    await lock_ai_provider_owner(db, owner_user_id)
    binding = selected_runtime_binding(runtimes)
    desired_runtime, desired_provider_id = binding if binding is not None else (None, None)
    provider = await _lock_and_validate_runtime_provider(
        db,
        owner_user_id=owner_user_id,
        provider_id=desired_provider_id,
    )
    desired_oauth_provider_id = (
        provider.provider_id
        if provider is not None and provider.auth_type in {"agent_profile", "oauth_profile"}
        else None
    )
    payloads = list(
        (
            await db.execute(
                select(AiProviderAuthPayload)
                .where(
                    AiProviderAuthPayload.owner_user_id == owner_user_id,
                    AiProviderAuthPayload.archived_at.is_(None),
                    (AiProviderAuthPayload.consumer_environment_id == environment_id)
                    | (AiProviderAuthPayload.provider_id == desired_oauth_provider_id),
                )
                .order_by(
                    AiProviderAuthPayload.provider_id,
                    AiProviderAuthPayload.auth_profile,
                )
                .with_for_update()
            )
        ).scalars()
    )
    for payload in payloads:
        is_desired = (
            desired_runtime is not None
            and payload.provider_id == desired_oauth_provider_id
            and payload.kind in {"agent_profile", "oauth_profile"}
        )
        if payload.consumer_environment_id == environment_id and not is_desired:
            payload.consumer_environment_id = None
            payload.consumer_runtime = None
        if is_desired:
            if desired_runtime is None:  # pragma: no cover - guarded by is_desired
                raise RuntimeError("desired OAuth runtime is missing")
            await claim_oauth_payload(
                db,
                payload=payload,
                consumer=OAuthCredentialConsumer(environment_id, desired_runtime),
            )


async def release_runtime_oauth_claims(
    db: AsyncSession,
    *,
    owner_user_id: UUID,
    environment_id: UUID,
) -> None:
    await lock_ai_provider_owner(db, owner_user_id)
    payloads = list(
        (
            await db.execute(
                select(AiProviderAuthPayload)
                .where(
                    AiProviderAuthPayload.owner_user_id == owner_user_id,
                    AiProviderAuthPayload.consumer_environment_id == environment_id,
                )
                .order_by(
                    AiProviderAuthPayload.provider_id,
                    AiProviderAuthPayload.auth_profile,
                )
                .with_for_update()
            )
        ).scalars()
    )
    for payload in payloads:
        payload.consumer_environment_id = None
        payload.consumer_runtime = None
