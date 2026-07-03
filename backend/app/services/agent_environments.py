"""Agent environment registration.

`AgentEnvironment.id` is the stable agent identity used by sessions, runtime
state, channel links, and deploy-key scoping. `registration_key` is only an
idempotency key for self-managed clients that do not bring their own agent id.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import PROJECT_KIND_ENVIRONMENT, Project
from app.models.session import AgentEnvironment


class AgentEnvironmentIdConflict(ValueError):
    """Raised when an explicit agent id already belongs to a different user."""


@dataclass(frozen=True)
class AgentEnvironmentRegistration:
    env: AgentEnvironment
    created: bool


def local_machine_registration_key(machine_id: str, agent_type: str) -> str:
    """Idempotency key for legacy/self-managed setup flows."""

    return f"machine:{machine_id}:agent:{agent_type}"


async def register_agent_environment(
    db: AsyncSession,
    *,
    user_id: UUID,
    machine_id: str,
    machine_name: str,
    agent_type: str,
    agent_version: str | None,
    os_name: str,
    sort_order: int,
    environment_id: UUID | None = None,
    registration_key: str | None = None,
) -> AgentEnvironmentRegistration:
    """Create or refresh an agent row.

    Explicit `environment_id` callers own the agent identity and bypass machine
    idempotency. Implicit callers must pass `registration_key`; concurrent
    retries converge through the database unique constraint on
    `(user_id, registration_key)`.
    """

    if environment_id is not None:
        existing = (
            await db.execute(
                select(AgentEnvironment)
                .where(AgentEnvironment.id == environment_id)
                .with_for_update()
            )
        ).scalar_one_or_none()
        if existing is not None:
            if existing.user_id != user_id:
                raise AgentEnvironmentIdConflict(
                    f"environment {environment_id} is owned by another user"
                )
            await _refresh_agent_environment(
                db,
                existing,
                user_id=user_id,
                machine_id=machine_id,
                machine_name=machine_name,
                agent_type=agent_type,
                agent_version=agent_version,
                os_name=os_name,
                registration_key=registration_key,
            )
            await db.commit()
            return AgentEnvironmentRegistration(env=existing, created=False)
    elif registration_key is not None:
        existing = (
            await db.execute(
                select(AgentEnvironment)
                .where(
                    AgentEnvironment.user_id == user_id,
                    AgentEnvironment.registration_key == registration_key,
                )
                .with_for_update()
            )
        ).scalar_one_or_none()
        if existing is not None:
            await _refresh_agent_environment(
                db,
                existing,
                user_id=user_id,
                machine_id=machine_id,
                machine_name=machine_name,
                agent_type=agent_type,
                agent_version=agent_version,
                os_name=os_name,
                registration_key=registration_key,
            )
            await db.commit()
            return AgentEnvironmentRegistration(env=existing, created=False)

    project = Project(
        user_id=user_id,
        name=f"{machine_name} ({agent_type})",
        slug=f"env-{uuid.uuid4().hex[:12]}",
        kind=PROJECT_KIND_ENVIRONMENT,
    )
    db.add(project)
    try:
        await db.flush()
        env = AgentEnvironment(
            id=environment_id or uuid.uuid4(),
            user_id=user_id,
            machine_id=machine_id,
            machine_name=machine_name,
            agent_type=agent_type,
            agent_version=agent_version,
            os=os_name,
            last_seen_at=datetime.now(UTC),
            sort_order=sort_order,
            default_project_id=project.id,
            registration_key=registration_key,
        )
        db.add(env)
        await db.flush()
        project.origin_environment_id = env.id
        await db.commit()
        await db.refresh(env)
        return AgentEnvironmentRegistration(env=env, created=True)
    except IntegrityError:
        await db.rollback()
        if environment_id is not None:
            winner = (
                await db.execute(
                    select(AgentEnvironment).where(AgentEnvironment.id == environment_id)
                )
            ).scalar_one_or_none()
            if winner is None:
                raise AgentEnvironmentIdConflict(
                    f"environment {environment_id} could not be registered"
                ) from None
            if winner.user_id != user_id:
                raise AgentEnvironmentIdConflict(
                    f"environment {environment_id} is owned by another user"
                )
            await _refresh_agent_environment(
                db,
                winner,
                user_id=user_id,
                machine_id=machine_id,
                machine_name=machine_name,
                agent_type=agent_type,
                agent_version=agent_version,
                os_name=os_name,
                registration_key=registration_key,
            )
            await db.commit()
            return AgentEnvironmentRegistration(env=winner, created=False)
        if registration_key is None:
            raise
        winner = (
            await db.execute(
                select(AgentEnvironment).where(
                    AgentEnvironment.user_id == user_id,
                    AgentEnvironment.registration_key == registration_key,
                )
            )
        ).scalar_one_or_none()
        if winner is None:
            raise
        return AgentEnvironmentRegistration(env=winner, created=False)


async def _refresh_agent_environment(
    db: AsyncSession,
    env: AgentEnvironment,
    *,
    user_id: UUID,
    machine_id: str,
    machine_name: str,
    agent_type: str,
    agent_version: str | None,
    os_name: str,
    registration_key: str | None,
) -> None:
    env.machine_id = machine_id
    env.machine_name = machine_name
    env.agent_type = agent_type
    env.agent_version = agent_version
    env.os = os_name
    env.last_seen_at = datetime.now(UTC)
    env.registration_key = registration_key
    if env.default_project_id is None:
        healing_project = Project(
            user_id=user_id,
            name=f"{machine_name} ({agent_type})",
            slug=f"env-{uuid.uuid4().hex[:12]}",
            kind=PROJECT_KIND_ENVIRONMENT,
            origin_environment_id=env.id,
        )
        db.add(healing_project)
        await db.flush()
        env.default_project_id = healing_project.id
