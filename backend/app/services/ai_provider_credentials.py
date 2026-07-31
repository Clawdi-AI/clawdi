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
from app.schemas.runtime import validate_hosted_runtime_desired_state

OAuthConsumerRuntime = Literal["codex", "hermes", "openclaw"]
OAUTH_CONSUMER_RUNTIMES = frozenset({"codex", "hermes", "openclaw"})


class OAuthCredentialClaimConflict(ValueError):
    pass


@dataclass(frozen=True)
class OAuthCredentialConsumer:
    environment_id: UUID
    runtime: OAuthConsumerRuntime


def selected_runtime_binding(runtimes: object) -> tuple[OAuthConsumerRuntime, set[str]] | None:
    if not isinstance(runtimes, dict) or len(runtimes) != 1:
        return None
    runtime_name, raw_runtime = next(iter(runtimes.items()))
    if runtime_name not in OAUTH_CONSUMER_RUNTIMES:
        return None
    try:
        runtime = validate_hosted_runtime_desired_state(raw_runtime)
    except ValidationError:
        return None
    return runtime_name, set(runtime.provider_ids)


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
    return binding is not None and binding[0] == runtime and provider_id in binding[1]


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
) -> None:
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
        if binding is None or provider_id not in binding[1]:
            continue
        consumers.append(OAuthCredentialConsumer(environment_id, binding[0]))
    if len(consumers) > 1:
        raise OAuthCredentialClaimConflict(
            "OAuth credential cannot be bound to multiple Agent runtimes"
        )
    if consumers:
        await claim_oauth_payload(db, payload=payload, consumer=consumers[0])


async def reconcile_runtime_oauth_claims(
    db: AsyncSession,
    *,
    owner_user_id: UUID,
    environment_id: UUID,
    runtimes: object,
) -> None:
    binding = selected_runtime_binding(runtimes)
    desired_runtime, desired_provider_ids = binding if binding is not None else (None, set())
    providers = list(
        (
            await db.execute(
                select(AiProvider)
                .where(
                    AiProvider.owner_user_id == owner_user_id,
                    AiProvider.provider_id.in_(sorted(desired_provider_ids)),
                    AiProvider.archived_at.is_(None),
                )
                .order_by(AiProvider.provider_id)
                .with_for_update()
            )
        ).scalars()
    )
    oauth_provider_ids = {
        provider.provider_id
        for provider in providers
        if provider.auth_type in {"agent_profile", "oauth_profile"}
    }
    payloads = list(
        (
            await db.execute(
                select(AiProviderAuthPayload)
                .where(
                    AiProviderAuthPayload.owner_user_id == owner_user_id,
                    AiProviderAuthPayload.archived_at.is_(None),
                    (AiProviderAuthPayload.consumer_environment_id == environment_id)
                    | (AiProviderAuthPayload.provider_id.in_(sorted(oauth_provider_ids))),
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
            and payload.provider_id in oauth_provider_ids
            and payload.kind in {"agent_profile", "oauth_profile"}
        )
        if payload.consumer_environment_id == environment_id and not is_desired:
            payload.consumer_environment_id = None
            payload.consumer_runtime = None
        if is_desired:
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
