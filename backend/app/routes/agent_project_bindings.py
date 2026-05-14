"""Agent -> project binding routes."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_user_auth_unbound
from app.core.database import get_session
from app.models.agent_project_binding import AgentProjectBinding
from app.schemas.sharing import (
    AgentProjectBindingResponse,
    BindingCreate,
    BindingReorderBody,
)
from app.services.agent_bindings import (
    assert_project_visible_to_user,
    assert_project_writable_by_user,
    ensure_context_binding,
    get_owned_agent_or_404,
    set_primary_binding,
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
    await get_owned_agent_or_404(db, user_id=auth.user_id, agent_id=agent_id)
    rows = (
        await db.execute(
            select(AgentProjectBinding)
            .where(AgentProjectBinding.agent_id == agent_id)
            .order_by(
                AgentProjectBinding.binding_type.asc(),
                AgentProjectBinding.priority.asc(),
                AgentProjectBinding.created_at.asc(),
            )
        )
    ).scalars().all()
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
    try:
        project_id = UUID(body.project_id)
    except ValueError as err:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid project_id") from err

    await assert_project_writable_by_user(db, user_id=auth.user_id, project_id=project_id)
    binding = await set_primary_binding(
        db,
        agent_id=agent_id,
        project_id=project_id,
        created_by_user_id=auth.user_id,
    )
    await db.commit()
    await db.refresh(binding)
    return _to_response(binding)


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
    await get_owned_agent_or_404(db, user_id=auth.user_id, agent_id=agent_id)
    try:
        project_id = UUID(body.project_id)
    except ValueError as err:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid project_id") from err

    await assert_project_visible_to_user(db, user_id=auth.user_id, project_id=project_id)
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
    for item in body.items:
        try:
            binding_id = UUID(item.binding_id)
        except ValueError as err:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid binding_id") from err
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
        if binding.binding_type != "context":
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "only context bindings can be reordered",
            )
        if item.priority < 1:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "context priority must be >= 1")
        binding.priority = item.priority

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

    await db.delete(binding)
    await db.commit()
    return {"status": "deleted"}
