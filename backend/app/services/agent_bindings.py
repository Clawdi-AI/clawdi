"""Helpers for agent->project binding operations."""

from __future__ import annotations

from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import delete as sql_delete
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_project_binding import AgentProjectBinding
from app.models.project import Project
from app.models.project_membership import ProjectMembership
from app.models.session import AgentEnvironment


async def get_owned_agent_or_404(
    db: AsyncSession,
    *,
    user_id: UUID,
    agent_id: UUID,
) -> AgentEnvironment:
    agent = (
        await db.execute(
            select(AgentEnvironment).where(
                AgentEnvironment.id == agent_id,
                AgentEnvironment.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    if agent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "agent not found")
    return agent


async def assert_project_visible_to_user(
    db: AsyncSession,
    *,
    user_id: UUID,
    project_id: UUID,
) -> Project:
    project = (
        await db.execute(select(Project).where(Project.id == project_id))
    ).scalar_one_or_none()
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")
    if project.user_id == user_id:
        return project

    member = (
        await db.execute(
            select(ProjectMembership.id).where(
                ProjectMembership.project_id == project_id,
                ProjectMembership.member_user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    if member is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "project is not accessible")
    return project


async def assert_project_writable_by_user(
    db: AsyncSession,
    *,
    user_id: UUID,
    project_id: UUID,
) -> Project:
    project = (
        await db.execute(select(Project).where(Project.id == project_id))
    ).scalar_one_or_none()
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")
    if project.user_id != user_id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "primary project must be owned by the caller",
        )
    return project


async def delete_project_bindings_for_users(
    db: AsyncSession,
    *,
    project_id: UUID,
    user_ids: list[UUID],
) -> int:
    """Delete agent bindings that let specific users use a project.

    Membership removal and project unsharing both remove the sharee's
    future access. Agent bindings are derived runtime use, so they must
    disappear with the membership instead of leaving stale context rows on
    the sharee's agents.
    """
    if not user_ids:
        return 0

    agent_ids = select(AgentEnvironment.id).where(AgentEnvironment.user_id.in_(user_ids))
    result = await db.execute(
        sql_delete(AgentProjectBinding).where(
            AgentProjectBinding.project_id == project_id,
            AgentProjectBinding.agent_id.in_(agent_ids),
        )
    )
    return int(result.rowcount or 0)


async def _next_context_priority(db: AsyncSession, *, agent_id: UUID) -> int:
    max_priority = (
        await db.execute(
            select(func.max(AgentProjectBinding.priority)).where(
                AgentProjectBinding.agent_id == agent_id,
                AgentProjectBinding.binding_type == "context",
            )
        )
    ).scalar_one_or_none()
    return int(max_priority or 0) + 1


async def ensure_context_binding(
    db: AsyncSession,
    *,
    agent_id: UUID,
    project_id: UUID,
    created_by_user_id: UUID,
    priority: int | None = None,
) -> AgentProjectBinding:
    existing = (
        await db.execute(
            select(AgentProjectBinding).where(
                AgentProjectBinding.agent_id == agent_id,
                AgentProjectBinding.project_id == project_id,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        if existing.binding_type == "primary":
            return existing
        if priority is not None and priority >= 1:
            existing.priority = priority
        return existing

    if priority is None:
        priority = await _next_context_priority(db, agent_id=agent_id)
    if priority < 1:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "context priority must be >= 1")

    binding = AgentProjectBinding(
        agent_id=agent_id,
        project_id=project_id,
        binding_type="context",
        priority=priority,
        default_write_enabled=False,
        created_by_user_id=created_by_user_id,
    )
    db.add(binding)
    await db.flush()
    return binding


async def ensure_agent_primary_binding(
    db: AsyncSession,
    *,
    agent: AgentEnvironment,
    created_by_user_id: UUID,
) -> AgentProjectBinding:
    """Ensure the primary binding matches the Agent Project.

    An agent's own Project is immutable: `agent.default_project_id` is the
    default write target and the only valid primary binding. Older clients
    could switch primary to another owned Project; when such rows are found,
    preserve them as ordered context bindings and restore the system primary.
    """
    agent_id = agent.id
    project_id = agent.default_project_id

    rows = (
        (
            await db.execute(
                select(AgentProjectBinding).where(AgentProjectBinding.agent_id == agent_id)
            )
        )
        .scalars()
        .all()
    )

    default_binding = next((row for row in rows if row.project_id == project_id), None)
    stale_primaries = [
        row for row in rows if row.binding_type == "primary" and row.project_id != project_id
    ]
    next_priority = await _next_context_priority(db, agent_id=agent_id)
    for offset, stale in enumerate(stale_primaries):
        stale.priority = next_priority + offset
        stale.binding_type = "context"
        stale.default_write_enabled = False
    if stale_primaries:
        await db.flush()

    if default_binding is not None:
        default_binding.binding_type = "primary"
        default_binding.priority = 0
        default_binding.default_write_enabled = True
        return default_binding

    binding = AgentProjectBinding(
        agent_id=agent_id,
        project_id=project_id,
        binding_type="primary",
        priority=0,
        default_write_enabled=True,
        created_by_user_id=created_by_user_id,
    )
    db.add(binding)
    await db.flush()
    return binding


async def set_primary_binding(
    db: AsyncSession,
    *,
    agent_id: UUID,
    project_id: UUID,
    created_by_user_id: UUID,
) -> AgentProjectBinding:
    """Compatibility wrapper for older imports.

    New code should call `ensure_agent_primary_binding` after loading the
    owned agent. The primary Project is fixed to the Agent Project.
    """
    agent = (
        await db.execute(select(AgentEnvironment).where(AgentEnvironment.id == agent_id))
    ).scalar_one_or_none()
    if agent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "agent not found")
    if agent.default_project_id != project_id:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Agent Project is fixed",
        )
    return await ensure_agent_primary_binding(
        db,
        agent=agent,
        created_by_user_id=created_by_user_id,
    )


async def _legacy_set_primary_binding(
    db: AsyncSession,
    *,
    agent_id: UUID,
    project_id: UUID,
    created_by_user_id: UUID,
) -> AgentProjectBinding:
    existing = (
        await db.execute(
            select(AgentProjectBinding).where(
                AgentProjectBinding.agent_id == agent_id,
                AgentProjectBinding.project_id == project_id,
            )
        )
    ).scalar_one_or_none()

    # Demote current primary if switching projects.
    current_primary = (
        await db.execute(
            select(AgentProjectBinding).where(
                AgentProjectBinding.agent_id == agent_id,
                AgentProjectBinding.binding_type == "primary",
            )
        )
    ).scalar_one_or_none()
    if current_primary is not None and current_primary.project_id != project_id:
        current_primary.binding_type = "context"
        current_primary.default_write_enabled = False
        current_primary.priority = await _next_context_priority(db, agent_id=agent_id)

    if existing is not None:
        existing.binding_type = "primary"
        existing.priority = 0
        existing.default_write_enabled = True
        return existing

    binding = AgentProjectBinding(
        agent_id=agent_id,
        project_id=project_id,
        binding_type="primary",
        priority=0,
        default_write_enabled=True,
        created_by_user_id=created_by_user_id,
    )
    db.add(binding)
    await db.flush()
    return binding
