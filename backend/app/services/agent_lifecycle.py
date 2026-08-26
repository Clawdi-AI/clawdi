"""Authoritative active/archive lifecycle predicates and mutations."""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.api_key import ApiKey
from app.models.project import PROJECT_KIND_ENVIRONMENT, Project
from app.models.session import AgentEnvironment
from app.services.sync_events import (
    notify_sync_subscriptions_changed,
    queue_environment_runtime_manifest_changed,
)


class AgentLifecycleBoundaryError(RuntimeError):
    """The exclusive Agent/Project lifecycle relationship is not provable."""


def active_agent_filter():
    return AgentEnvironment.archived_at.is_(None)


def active_project_filter():
    return Project.archived_at.is_(None)


async def archive_agent_and_project(
    db: AsyncSession, *, agent: AgentEnvironment, now: datetime | None = None
) -> tuple[UUID, ...]:
    """Archive identity and its exclusive Agent Project in one transaction.

    Relationships and resource rows are intentionally untouched. Bound keys
    are revoked in the same transaction so an archived identity has no cached
    or persistent operational authority.
    """
    locked_agent = await db.scalar(
        select(AgentEnvironment)
        .where(
            AgentEnvironment.id == agent.id,
            AgentEnvironment.user_id == agent.user_id,
            active_agent_filter(),
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if locked_agent is None:
        raise AgentLifecycleBoundaryError("active Agent identity is not available")

    project = await db.scalar(
        select(Project)
        .where(
            Project.id == locked_agent.default_project_id,
            Project.user_id == locked_agent.user_id,
            Project.kind == PROJECT_KIND_ENVIRONMENT,
            Project.origin_environment_id == locked_agent.id,
        )
        .with_for_update()
    )
    if project is None:
        raise AgentLifecycleBoundaryError("exclusive Agent Project is not provable")

    sibling_ids = tuple(
        (
            await db.scalars(
                select(AgentEnvironment.id)
                .where(AgentEnvironment.default_project_id == project.id)
                .with_for_update()
            )
        ).all()
    )
    if sibling_ids != (locked_agent.id,):
        raise AgentLifecycleBoundaryError("Agent Project is shared by another Agent")

    archived_at = now or datetime.now(UTC)
    locked_agent.archived_at = archived_at
    project.archived_at = archived_at
    key_ids = list(
        (
            await db.scalars(
                select(ApiKey.id).where(
                    ApiKey.environment_id == locked_agent.id,
                    ApiKey.revoked_at.is_(None),
                )
            )
        ).all()
    )
    await db.execute(update(ApiKey).where(ApiKey.id.in_(key_ids)).values(revoked_at=archived_at))
    await notify_sync_subscriptions_changed(db, [locked_agent.user_id])
    return tuple(key_ids)


async def reactivate_agent_and_project(db: AsyncSession, *, agent: AgentEnvironment) -> None:
    """Reactivate the existing identity and exclusive Project atomically."""
    locked_agent = await db.scalar(
        select(AgentEnvironment)
        .where(
            AgentEnvironment.id == agent.id,
            AgentEnvironment.user_id == agent.user_id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if locked_agent is None:
        raise AgentLifecycleBoundaryError("Agent identity is not available")
    project = await db.scalar(
        select(Project)
        .where(
            Project.id == locked_agent.default_project_id,
            Project.user_id == locked_agent.user_id,
            Project.kind == PROJECT_KIND_ENVIRONMENT,
            Project.origin_environment_id == locked_agent.id,
        )
        .with_for_update()
    )
    if project is None:
        raise AgentLifecycleBoundaryError("exclusive Agent Project is not provable")
    sibling_ids = tuple(
        (
            await db.scalars(
                select(AgentEnvironment.id)
                .where(AgentEnvironment.default_project_id == project.id)
                .with_for_update()
            )
        ).all()
    )
    if sibling_ids != (locked_agent.id,):
        raise AgentLifecycleBoundaryError("Agent Project is shared by another Agent")
    locked_agent.archived_at = None
    project.archived_at = None
    await notify_sync_subscriptions_changed(db, [locked_agent.user_id])
    await queue_environment_runtime_manifest_changed(
        db,
        locked_agent.user_id,
        locked_agent.id,
    )


async def active_owned_agent(
    db: AsyncSession, *, user_id: UUID, agent_id: UUID, for_update: bool = False
) -> AgentEnvironment | None:
    stmt = select(AgentEnvironment).where(
        AgentEnvironment.id == agent_id,
        AgentEnvironment.user_id == user_id,
        active_agent_filter(),
    )
    if for_update:
        stmt = stmt.with_for_update()
    return await db.scalar(stmt)
