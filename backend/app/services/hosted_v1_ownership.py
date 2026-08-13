from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.api_key import ApiKey
from app.models.hosted_runtime import HostedRuntimeState
from app.models.hosted_v1_ownership import HostedV1AgentOwnership
from app.models.session import AgentEnvironment

HOSTED_V1_AGENT_TYPES = frozenset({"hermes", "openclaw"})


class HostedV1OwnershipConflict(ValueError):
    pass


@dataclass(frozen=True)
class HostedV1OwnershipAdoption:
    ownership: HostedV1AgentOwnership
    archived: tuple[HostedV1AgentOwnership, ...]


async def lock_hosted_v1_ownership_mutations(db: AsyncSession) -> None:
    await db.execute(
        select(func.pg_advisory_xact_lock(func.hashtextextended("hosted-v1-agent-ownership", 0)))
    )


async def active_hosted_v1_ownership(
    db: AsyncSession,
    *,
    agent_id: UUID,
) -> HostedV1AgentOwnership | None:
    """Return the durable active claim occupying an Agent identity."""

    return await db.scalar(
        select(HostedV1AgentOwnership)
        .where(
            HostedV1AgentOwnership.environment_id == agent_id,
            HostedV1AgentOwnership.archived_at.is_(None),
        )
        .with_for_update(read=True)
    )


async def authenticated_hosted_v1_ownership(
    db: AsyncSession,
    *,
    agent_id: UUID,
    api_key_id: UUID,
) -> HostedV1AgentOwnership | None:
    """Return the claim only when its exact active key authenticates the Agent."""

    agent = await db.scalar(
        select(AgentEnvironment)
        .outerjoin(
            HostedRuntimeState,
            HostedRuntimeState.environment_id == AgentEnvironment.id,
        )
        .where(
            AgentEnvironment.id == agent_id,
            AgentEnvironment.archived_at.is_(None),
            AgentEnvironment.connected_agent_registered_at.is_(None),
            HostedRuntimeState.environment_id.is_(None),
        )
        .with_for_update(read=True, of=AgentEnvironment)
    )
    if agent is None:
        return None

    return await db.scalar(
        select(HostedV1AgentOwnership)
        .join(ApiKey, ApiKey.id == HostedV1AgentOwnership.api_key_id)
        .where(
            HostedV1AgentOwnership.environment_id == agent_id,
            HostedV1AgentOwnership.archived_at.is_(None),
            HostedV1AgentOwnership.agent_type == agent.agent_type,
            HostedV1AgentOwnership.api_key_id == api_key_id,
            ApiKey.user_id == agent.user_id,
            ApiKey.revoked_at.is_(None),
        )
        .with_for_update(read=True, of=(HostedV1AgentOwnership, ApiKey))
    )


async def assert_no_active_hosted_v1_ownership(
    db: AsyncSession,
    *,
    agent_id: UUID,
) -> None:
    if await db.scalar(
        select(HostedV1AgentOwnership.id)
        .where(
            HostedV1AgentOwnership.environment_id == agent_id,
            HostedV1AgentOwnership.archived_at.is_(None),
        )
        .with_for_update()
    ):
        raise HostedV1OwnershipConflict(
            "Agent has active Hosted V1 ownership; release it before changing runtime ownership"
        )


async def assert_hosted_v1_registration_compatible(
    db: AsyncSession,
    *,
    agent_id: UUID,
    agent_type: str,
) -> None:
    current = await db.scalar(
        select(HostedV1AgentOwnership).where(
            HostedV1AgentOwnership.environment_id == agent_id,
            HostedV1AgentOwnership.archived_at.is_(None),
        )
    )
    if current is not None and current.agent_type != agent_type:
        raise HostedV1OwnershipConflict(
            "Agent type conflicts with active Hosted V1 ownership; release it first"
        )


async def adopt_hosted_v1_ownership(
    db: AsyncSession,
    *,
    agent_id: UUID,
    owner_user_id: UUID,
    api_key_id: UUID,
    deployment_id: str,
    agent_type: str,
    replace_existing: bool,
) -> HostedV1OwnershipAdoption:
    """Create a claim or rotate its key without changing its identity."""

    if agent_type not in HOSTED_V1_AGENT_TYPES:
        raise HostedV1OwnershipConflict("Unsupported Hosted V1 agent type")

    await lock_hosted_v1_ownership_mutations(db)
    agent = await db.scalar(
        select(AgentEnvironment)
        .where(
            AgentEnvironment.id == agent_id,
            AgentEnvironment.user_id == owner_user_id,
            AgentEnvironment.archived_at.is_(None),
        )
        .with_for_update()
    )
    if agent is None:
        raise HostedV1OwnershipConflict("Active Agent is not owned by the target user")
    if agent.agent_type != agent_type:
        raise HostedV1OwnershipConflict("Agent type does not match the Hosted V1 claim")
    if agent.connected_agent_registered_at is not None:
        raise HostedV1OwnershipConflict("Connected Agent ownership is already active")
    if await db.get(HostedRuntimeState, agent_id) is not None:
        raise HostedV1OwnershipConflict("Hosted V2 ownership is already active")

    api_key = await db.scalar(
        select(ApiKey)
        .where(
            ApiKey.id == api_key_id,
            ApiKey.user_id == owner_user_id,
            ApiKey.revoked_at.is_(None),
        )
        .with_for_update()
    )
    if api_key is None:
        raise HostedV1OwnershipConflict("Active API key is not owned by the target user")
    if api_key.environment_id is not None and api_key.environment_id != agent_id:
        raise HostedV1OwnershipConflict("API key is bound to a different Agent")
    if api_key.runtime_deployment_id is not None:
        raise HostedV1OwnershipConflict("Hosted V2 API key cannot prove Hosted V1 ownership")

    conflicts = list(
        (
            await db.execute(
                select(HostedV1AgentOwnership)
                .where(
                    HostedV1AgentOwnership.archived_at.is_(None),
                    or_(
                        HostedV1AgentOwnership.environment_id == agent_id,
                        (HostedV1AgentOwnership.deployment_id == deployment_id)
                        & (HostedV1AgentOwnership.agent_type == agent_type),
                    ),
                )
                .with_for_update()
            )
        ).scalars()
    )
    if len(conflicts) == 1:
        current = conflicts[0]
        same_identity = (
            current.environment_id == agent_id
            and current.deployment_id == deployment_id
            and current.agent_type == agent_type
        )
        if same_identity and current.api_key_id == api_key_id:
            return HostedV1OwnershipAdoption(ownership=current, archived=())
        if not same_identity:
            raise HostedV1OwnershipConflict(
                "Release the active Hosted V1 claim before changing its Agent or deployment"
            )
    if conflicts and (len(conflicts) != 1 or not replace_existing):
        raise HostedV1OwnershipConflict("Hosted V1 ownership is already claimed")

    now = datetime.now(UTC)
    for current in conflicts:
        current.archived_at = now
        current.archive_reason = "replaced"
    ownership = HostedV1AgentOwnership(
        environment_id=agent_id,
        api_key_id=api_key_id,
        deployment_id=deployment_id,
        agent_type=agent_type,
    )
    db.add(ownership)
    await db.flush()
    return HostedV1OwnershipAdoption(ownership=ownership, archived=tuple(conflicts))


async def release_hosted_v1_ownership(
    db: AsyncSession,
    *,
    agent_id: UUID,
    owner_user_id: UUID,
    api_key_id: UUID,
    deployment_id: str,
    agent_type: str,
) -> HostedV1AgentOwnership | None:
    """Release only the exact active claim; an absent claim is idempotent."""

    await lock_hosted_v1_ownership_mutations(db)
    agent = await db.scalar(
        select(AgentEnvironment)
        .where(
            AgentEnvironment.id == agent_id,
            AgentEnvironment.user_id == owner_user_id,
        )
        .with_for_update()
    )
    if agent is None:
        raise HostedV1OwnershipConflict("Agent is not owned by the target user")
    current = await db.scalar(
        select(HostedV1AgentOwnership)
        .where(
            HostedV1AgentOwnership.environment_id == agent_id,
            HostedV1AgentOwnership.archived_at.is_(None),
        )
        .with_for_update()
    )
    if current is None:
        return None
    if (
        current.api_key_id != api_key_id
        or current.deployment_id != deployment_id
        or current.agent_type != agent_type
    ):
        raise HostedV1OwnershipConflict("A different Hosted V1 ownership claim is active")
    current.archived_at = datetime.now(UTC)
    current.archive_reason = "released"
    await db.flush()
    return current
