"""Authoritative active/archive lifecycle predicates and mutations."""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import invalidate_api_key_auth_cache
from app.models.api_key import ApiKey
from app.models.project import Project
from app.models.session import AgentEnvironment


def active_agent_filter():
    return AgentEnvironment.archived_at.is_(None)


def active_project_filter():
    return Project.archived_at.is_(None)


async def archive_agent_and_project(
    db: AsyncSession, *, agent: AgentEnvironment, now: datetime | None = None
) -> None:
    """Archive identity and its exclusive Agent Project in one transaction.

    Relationships and resource rows are intentionally untouched. Bound keys
    are revoked in the same transaction so an archived identity has no cached
    or persistent operational authority.
    """
    archived_at = now or datetime.now(UTC)
    agent.archived_at = archived_at
    project = await db.scalar(
        select(Project)
        .where(
            Project.id == agent.default_project_id,
            Project.user_id == agent.user_id,
        )
        .with_for_update()
    )
    if project is None:
        raise RuntimeError("Agent Project is missing")
    project.archived_at = archived_at
    key_ids = list(
        (
            await db.scalars(
                select(ApiKey.id).where(
                    ApiKey.environment_id == agent.id,
                    ApiKey.revoked_at.is_(None),
                )
            )
        ).all()
    )
    await db.execute(update(ApiKey).where(ApiKey.id.in_(key_ids)).values(revoked_at=archived_at))
    for key_id in key_ids:
        invalidate_api_key_auth_cache(key_id)


async def reactivate_agent_and_project(db: AsyncSession, *, agent: AgentEnvironment) -> None:
    """Reactivate the existing identity and exclusive Project atomically."""
    agent.archived_at = None
    project = await db.scalar(
        select(Project)
        .where(
            Project.id == agent.default_project_id,
            Project.user_id == agent.user_id,
        )
        .with_for_update()
    )
    if project is None:
        raise RuntimeError("Agent Project is missing")
    project.archived_at = None


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
