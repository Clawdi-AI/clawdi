"""Agent -> project binding routes."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import case, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_user_auth_unbound
from app.core.database import get_session
from app.core.project import project_ids_visible_to
from app.models.agent_project_binding import AgentProjectBinding
from app.schemas.sharing import (
    AgentProjectBindingResponse,
    BindingCreate,
    BindingReorderBody,
)
from app.services.agent_bindings import (
    assert_project_visible_to_user,
    ensure_agent_primary_binding,
    ensure_context_binding,
    get_owned_agent_or_404,
)

router = APIRouter(prefix="/api/agents", tags=["agent-project-bindings"])


def _to_response(binding: AgentProjectBinding) -> AgentProjectBindingResponse:
    return AgentProjectBindingResponse(
        id=str(binding.id),
        agent_id=str(binding.agent_id),
        project_id=str(binding.project_id),
        binding_type=binding.binding_type,
        priority=binding.priority,
        default_write_enabled=binding.default_write_enabled,
        created_at=binding.created_at,
    )


@router.get("/{agent_id}/project-bindings", response_model=list[AgentProjectBindingResponse])
async def list_project_bindings(
    agent_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> list[AgentProjectBindingResponse]:
    agent = await get_owned_agent_or_404(db, user_id=auth.user_id, agent_id=agent_id)
    rows = (
        (
            await db.execute(
                select(AgentProjectBinding)
                .where(AgentProjectBinding.agent_id == agent_id)
                .order_by(
                    case((AgentProjectBinding.binding_type == "primary", 0), else_=1),
                    AgentProjectBinding.priority.asc(),
                    AgentProjectBinding.created_at.asc(),
                )
            )
        )
        .scalars()
        .all()
    )
    visible_project_ids = set(await project_ids_visible_to(db, auth))
    changed = False
    stale = [row for row in rows if row.project_id not in visible_project_ids]
    if stale:
        for row in stale:
            await db.delete(row)
        changed = True
        rows = [row for row in rows if row.project_id in visible_project_ids]

    if agent.default_project_id in visible_project_ids:
        await ensure_agent_primary_binding(
            db,
            agent=agent,
            created_by_user_id=auth.user_id,
        )
        changed = True

    if changed:
        await db.commit()
        rows = (
            (
                await db.execute(
                    select(AgentProjectBinding)
                    .where(AgentProjectBinding.agent_id == agent_id)
                    .order_by(
                        case((AgentProjectBinding.binding_type == "primary", 0), else_=1),
                        AgentProjectBinding.priority.asc(),
                        AgentProjectBinding.created_at.asc(),
                    )
                )
            )
            .scalars()
            .all()
        )
    return [_to_response(row) for row in rows]


@router.put(
    "/{agent_id}/project-bindings/primary",
    response_model=AgentProjectBindingResponse,
)
async def set_primary_project_binding(
    agent_id: UUID,
    body: BindingCreate,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> AgentProjectBindingResponse:
    await get_owned_agent_or_404(db, user_id=auth.user_id, agent_id=agent_id)
    raise HTTPException(
        status.HTTP_400_BAD_REQUEST,
        "Agent Project is fixed",
    )


@router.post(
    "/{agent_id}/project-bindings/context",
    response_model=AgentProjectBindingResponse,
)
async def add_context_project_binding(
    agent_id: UUID,
    body: BindingCreate,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> AgentProjectBindingResponse:
    agent = await get_owned_agent_or_404(db, user_id=auth.user_id, agent_id=agent_id)
    try:
        project_id = UUID(body.project_id)
    except ValueError as err:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid project_id") from err

    await assert_project_visible_to_user(db, user_id=auth.user_id, project_id=project_id)
    if project_id == agent.default_project_id:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Project is already this Agent Project",
        )
    if body.priority is not None:
        priority_conflict = (
            await db.execute(
                select(AgentProjectBinding.id).where(
                    AgentProjectBinding.agent_id == agent_id,
                    AgentProjectBinding.binding_type == "context",
                    AgentProjectBinding.priority == body.priority,
                    AgentProjectBinding.project_id != project_id,
                )
            )
        ).scalar_one_or_none()
        if priority_conflict is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "context priority is already in use",
            )
    binding = await ensure_context_binding(
        db,
        agent_id=agent_id,
        project_id=project_id,
        created_by_user_id=auth.user_id,
        priority=body.priority,
    )
    await db.commit()
    await db.refresh(binding)
    return _to_response(binding)


@router.patch("/{agent_id}/project-bindings/context/reorder")
async def reorder_context_project_bindings(
    agent_id: UUID,
    body: BindingReorderBody,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    await get_owned_agent_or_404(db, user_id=auth.user_id, agent_id=agent_id)
    if len({item.binding_id for item in body.items}) != len(body.items):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "duplicate binding_id")
    if len({item.priority for item in body.items}) != len(body.items):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "duplicate priority")

    current_context_rows = (
        (
            await db.execute(
                select(AgentProjectBinding).where(
                    AgentProjectBinding.agent_id == agent_id,
                    AgentProjectBinding.binding_type == "context",
                )
            )
        )
        .scalars()
        .all()
    )
    current_by_id = {binding.id: binding for binding in current_context_rows}

    requested: list[tuple[AgentProjectBinding, int]] = []
    for item in body.items:
        try:
            binding_id = UUID(item.binding_id)
        except ValueError as err:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid binding_id") from err
        binding = current_by_id.get(binding_id)
        if binding is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "binding not found")
        if item.priority < 1:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "context priority must be >= 1")
        requested.append((binding, item.priority))

    requested_ids = {binding.id for binding, _priority in requested}
    requested_priorities = {priority for _binding, priority in requested}
    for binding in current_context_rows:
        if binding.id not in requested_ids and binding.priority in requested_priorities:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "context priority is already in use",
            )

    if requested:
        max_priority = max([binding.priority for binding in current_context_rows] + [0])
        temp_base = max_priority + len(requested) + 1000
        for offset, (binding, _priority) in enumerate(requested, start=1):
            binding.priority = temp_base + offset
        await db.flush()

        for binding, priority in requested:
            binding.priority = priority

    await db.commit()
    return {"status": "reordered"}


@router.delete("/{agent_id}/project-bindings/{binding_id}")
async def delete_project_binding(
    agent_id: UUID,
    binding_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    await get_owned_agent_or_404(db, user_id=auth.user_id, agent_id=agent_id)
    binding = (
        await db.execute(
            select(AgentProjectBinding).where(
                AgentProjectBinding.id == binding_id,
                AgentProjectBinding.agent_id == agent_id,
            )
        )
    ).scalar_one_or_none()
    if binding is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "binding not found")
    if binding.binding_type == "primary":
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Agent Project cannot be detached",
        )

    await db.delete(binding)
    await db.commit()
    return {"status": "deleted"}
