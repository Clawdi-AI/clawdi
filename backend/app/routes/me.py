"""Recipient-facing `/api/me/...` routes."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete as sql_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.auth import AuthContext, require_user_auth_unbound
from app.core.database import get_session
from app.models.project import Project
from app.models.project_invitation import ProjectInvitation
from app.models.project_membership import ProjectMembership
from app.models.user import User
from app.schemas.sharing import InvitationResponse, UpgradeBody
from app.services.agent_bindings import (
    assert_project_visible_to_user,
    ensure_context_binding,
    get_owned_agent_or_404,
)
from app.services.sharing import safe_owner_display

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/me", tags=["me"])


@router.get("/invitations", response_model=list[InvitationResponse])
async def list_my_invitations(
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> list[InvitationResponse]:
    Inviter = aliased(User)
    Owner = aliased(User)
    rows = (
        await db.execute(
            select(ProjectInvitation, Inviter, Project, Owner)
            .outerjoin(Inviter, Inviter.id == ProjectInvitation.invited_by)
            .join(Project, Project.id == ProjectInvitation.project_id)
            .join(Owner, Owner.id == Project.user_id)
            .where(ProjectInvitation.invitee_user_id == auth.user_id)
            .order_by(ProjectInvitation.created_at.desc())
        )
    ).all()
    out: list[InvitationResponse] = []
    for inv, by, project, owner in rows:
        out.append(
            InvitationResponse(
                id=str(inv.id),
                project_id=str(inv.project_id),
                project_name=project.name,
                project_kind=project.kind,
                owner_display=safe_owner_display(owner),
                owner_handle=inv.resolved_owner_handle,
                invitee_email=inv.invitee_email,
                invited_by_user_id=str(inv.invited_by),
                invited_by_display=(by.name or by.email) if by else None,
                created_at=inv.created_at,
            )
        )
    return out


@router.post("/invitations/{invitation_id}/accept")
async def accept_invitation(
    invitation_id: UUID,
    body: UpgradeBody | None = None,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> dict:
    return await accept_invitation_for_user(
        invitation_id=invitation_id,
        body=body,
        auth=auth,
        db=db,
    )


async def accept_invitation_for_user(
    *,
    invitation_id: UUID,
    body: UpgradeBody | None,
    auth: AuthContext,
    db: AsyncSession,
) -> dict:
    body = body or UpgradeBody()
    inv_pre = (
        await db.execute(select(ProjectInvitation).where(ProjectInvitation.id == invitation_id))
    ).scalar_one_or_none()
    if inv_pre is None or inv_pre.invitee_user_id != auth.user_id:
        raise HTTPException(status.HTTP_410_GONE, "invitation not available")

    project = (
        await db.execute(select(Project).where(Project.id == inv_pre.project_id).with_for_update())
    ).scalar_one_or_none()
    if project is None:
        raise HTTPException(status.HTTP_410_GONE, "project no longer available")
    if project.user_id == auth.user_id:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"error": "already_owner"},
        )

    inv = (
        await db.execute(select(ProjectInvitation).where(ProjectInvitation.id == invitation_id))
    ).scalar_one_or_none()
    if inv is None or inv.invitee_user_id != auth.user_id:
        raise HTTPException(status.HTTP_410_GONE, "invitation not available")

    existing_membership = (
        await db.execute(
            select(ProjectMembership).where(
                ProjectMembership.project_id == inv.project_id,
                ProjectMembership.member_user_id == auth.user_id,
            )
        )
    ).scalar_one_or_none()
    if existing_membership is not None:
        membership = existing_membership
    else:
        membership = ProjectMembership(
            project_id=inv.project_id,
            member_user_id=auth.user_id,
            role="viewer",
            joined_via="invite",
            joined_at=datetime.now(UTC),
            resolved_owner_handle=inv.resolved_owner_handle,
        )
        db.add(membership)
        await db.flush()

    bound_agent_ids: list[str] = []
    if body.agent_ids:
        for raw_agent_id in body.agent_ids:
            try:
                agent_id = UUID(raw_agent_id)
            except ValueError as err:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid agent id") from err
            await get_owned_agent_or_404(db, user_id=auth.user_id, agent_id=agent_id)
            await assert_project_visible_to_user(
                db,
                user_id=auth.user_id,
                project_id=inv.project_id,
            )
            await ensure_context_binding(
                db,
                agent_id=agent_id,
                project_id=inv.project_id,
                created_by_user_id=auth.user_id,
            )
            bound_agent_ids.append(str(agent_id))

    await db.execute(
        sql_delete(ProjectInvitation).where(
            ProjectInvitation.project_id == inv.project_id,
            ProjectInvitation.invitee_user_id == auth.user_id,
        )
    )
    await db.commit()
    logger.info(
        "invitation_accepted invitation_id=%s by=%s project_id=%s bound_agents=%s",
        invitation_id,
        auth.user_id,
        inv.project_id,
        bound_agent_ids,
    )
    return {
        "id": str(membership.id),
        "project_id": str(membership.project_id),
        "role": membership.role,
        "joined_via": membership.joined_via,
        "joined_at": membership.joined_at.isoformat(),
        "resolved_owner_handle": membership.resolved_owner_handle,
        "bound_agent_ids": bound_agent_ids,
    }


@router.post("/invitations/{invitation_id}/decline")
async def decline_invitation(
    invitation_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    inv = (
        await db.execute(select(ProjectInvitation).where(ProjectInvitation.id == invitation_id))
    ).scalar_one_or_none()
    if inv is None or inv.invitee_user_id != auth.user_id:
        raise HTTPException(status.HTTP_410_GONE, "invitation not available")
    await db.delete(inv)
    await db.commit()
    return {"status": "declined"}
