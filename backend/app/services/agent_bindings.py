"""Helpers for agent->project binding operations."""

from __future__ import annotations

from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import delete as sql_delete
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_project_binding import AgentProjectBinding
from app.models.project import PROJECT_KIND_WORKSPACE, Project
from app.models.project_membership import ProjectMembership
from app.models.session import AgentEnvironment
from app.services.agent_lifecycle import active_agent_filter, active_project_filter


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
                active_agent_filter(),
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
        await db.execute(select(Project).where(Project.id == project_id, active_project_filter()))
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
        await db.execute(select(Project).where(Project.id == project_id, active_project_filter()))
    ).scalar_one_or_none()
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")
    if project.user_id != user_id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Only the Project owner can make this change",
        )
    return project


async def assert_project_linkable_to_agent(
    db: AsyncSession,
    *,
    user_id: UUID,
    agent: AgentEnvironment,
    project_id: UUID,
) -> Project:
    project = await assert_project_visible_to_user(
        db,
        user_id=user_id,
        project_id=project_id,
    )
    if project_id == agent.default_project_id:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "This Project is already the Agent Workspace",
        )
    if project.kind != PROJECT_KIND_WORKSPACE:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Only Projects you create or that are shared with you can be linked",
        )
    return project


async def delete_project_bindings_for_users(
    db: AsyncSession,
    *,
    project_id: UUID,
    user_ids: list[UUID],
) -> int:
    """Delete Agent attachments that let specific users use a Project.

    Membership removal and project unsharing both remove the recipient's
    future access. Agent attachments are derived runtime use, so they must
    disappear with the membership instead of leaving stale context rows on
    the recipient's agents.
    """
    if not user_ids:
        return 0

    # Membership changes are also Project unlink operations. Serialize them
    # with Project Skill writes and explicit Link/Unlink requests, then notify
    # every managed Agent whose desired bundle changed in the same transaction.
    from app.services.project_runtime_skills import lock_project_runtime_graph
    from app.services.sync_events import queue_environment_runtime_manifest_changed

    await lock_project_runtime_graph(db, project_id)
    bound_agents = (
        await db.execute(
            select(AgentEnvironment.user_id, AgentProjectBinding.agent_id)
            .join(
                AgentEnvironment,
                AgentEnvironment.id == AgentProjectBinding.agent_id,
            )
            .where(
                AgentProjectBinding.project_id == project_id,
                AgentProjectBinding.binding_type == "context",
                AgentEnvironment.user_id.in_(user_ids),
            )
        )
    ).all()
    target_agent_ids = [agent_id for _user_id, agent_id in bound_agents]
    deleted_binding_ids = (
        (
            await db.execute(
                sql_delete(AgentProjectBinding)
                .where(
                    AgentProjectBinding.project_id == project_id,
                    AgentProjectBinding.binding_type == "context",
                    AgentProjectBinding.agent_id.in_(target_agent_ids),
                )
                .returning(AgentProjectBinding.id)
            )
        )
        .scalars()
        .all()
    )
    for user_id, agent_id in bound_agents:
        await queue_environment_runtime_manifest_changed(db, user_id, agent_id)
    return len(deleted_binding_ids)


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
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Vault resolution priority must be >= 1",
        )

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


async def attach_project_to_owned_agents(
    db: AsyncSession,
    *,
    user_id: UUID,
    project_id: UUID,
    raw_agent_ids: list[str] | None,
) -> list[str]:
    """Attach a visible Project to the caller's Agents for read-time use."""
    from app.services.project_runtime_skills import (
        assert_project_link_compatible,
        lock_project_agent_binding_changes,
    )
    from app.services.sync_events import queue_environment_runtime_manifest_changed

    agent_ids: list[UUID] = []
    for raw_agent_id in raw_agent_ids or []:
        try:
            agent_id = UUID(raw_agent_id)
        except ValueError as err:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid agent id") from err
        await get_owned_agent_or_404(db, user_id=user_id, agent_id=agent_id)
        if agent_id not in agent_ids:
            agent_ids.append(agent_id)

    if not agent_ids:
        return []
    project = await assert_project_visible_to_user(db, user_id=user_id, project_id=project_id)
    if project.kind != PROJECT_KIND_WORKSPACE:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Only Projects you create or that are shared with you can be linked",
        )
    await lock_project_agent_binding_changes(
        db,
        project_id=project_id,
        agent_ids=agent_ids,
    )
    # Re-check access after acquiring the Project graph lock so archive,
    # unshare, and explicit Link cannot cross at the write boundary.
    project = await assert_project_visible_to_user(db, user_id=user_id, project_id=project_id)
    if project.kind != PROJECT_KIND_WORKSPACE:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Only Projects you create or that are shared with you can be linked",
        )
    for agent_id in sorted(agent_ids, key=str):
        await assert_project_link_compatible(
            db,
            agent_id=agent_id,
            project_id=project_id,
        )

    bound_agent_ids: list[str] = []
    for agent_id in agent_ids:
        await ensure_context_binding(
            db,
            agent_id=agent_id,
            project_id=project_id,
            created_by_user_id=user_id,
        )
        await queue_environment_runtime_manifest_changed(db, user_id, agent_id)
        bound_agent_ids.append(str(agent_id))
    return bound_agent_ids


async def attach_projects_to_owned_agent(
    db: AsyncSession,
    *,
    user_id: UUID,
    agent_id: UUID,
    raw_project_ids: list[str] | None,
) -> list[str]:
    """Attach visible Projects to one owned Agent in a single transaction."""
    from app.services.project_runtime_skills import (
        assert_project_link_compatible,
        lock_project_binding_set_change,
    )
    from app.services.sync_events import queue_environment_runtime_manifest_changed

    agent = await get_owned_agent_or_404(db, user_id=user_id, agent_id=agent_id)
    project_ids: list[UUID] = []
    for raw_project_id in raw_project_ids or []:
        try:
            project_id = UUID(raw_project_id)
        except ValueError as err:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid project id") from err
        if project_id not in project_ids:
            project_ids.append(project_id)

    if not project_ids:
        return []
    for project_id in project_ids:
        await assert_project_linkable_to_agent(
            db,
            user_id=user_id,
            agent=agent,
            project_id=project_id,
        )

    await lock_project_binding_set_change(
        db,
        project_ids=project_ids,
        agent_id=agent_id,
    )
    # Re-check the full selection after locking so archive or unshare cannot
    # leave a partially applied batch.
    for project_id in project_ids:
        await assert_project_linkable_to_agent(
            db,
            user_id=user_id,
            agent=agent,
            project_id=project_id,
        )

    await ensure_agent_primary_binding(
        db,
        agent=agent,
        created_by_user_id=user_id,
    )
    existing_project_ids = set(
        (
            await db.execute(
                select(AgentProjectBinding.project_id).where(
                    AgentProjectBinding.agent_id == agent_id,
                )
            )
        ).scalars()
    )

    changed = False
    for project_id in project_ids:
        if project_id in existing_project_ids:
            continue
        # Each inserted binding is flushed before the next compatibility
        # check, so conflicts within the submitted batch also fail atomically.
        await assert_project_link_compatible(
            db,
            agent_id=agent_id,
            project_id=project_id,
        )
        await ensure_context_binding(
            db,
            agent_id=agent_id,
            project_id=project_id,
            created_by_user_id=user_id,
        )
        existing_project_ids.add(project_id)
        changed = True

    if changed:
        await queue_environment_runtime_manifest_changed(db, user_id, agent_id)
    return [str(project_id) for project_id in project_ids]


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
