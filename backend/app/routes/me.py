"""Recipient-facing `/v1/me/...` routes."""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete as sql_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.auth import AuthContext, require_user_auth_unbound
from app.core.database import get_session
from app.models.project import PROJECT_KIND_WORKSPACE, Project
from app.models.project_invitation import ProjectInvitation
from app.models.user import User
from app.schemas.sharing import (
    InvitationAcceptResponse,
    InvitationDeclineResponse,
    InvitationResponse,
    UpgradeBody,
)
from app.services.agent_bindings import attach_project_to_owned_agents
from app.services.sharing import ensure_viewer_membership, safe_owner_display

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/me", tags=["me"])


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
            .where(
                ProjectInvitation.invitee_user_id == auth.user_id,
                Project.kind == PROJECT_KIND_WORKSPACE,
            )
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


@router.post(
    "/invitations/{invitation_id}/accept",
    response_model=InvitationAcceptResponse,
)
async def accept_invitation(
    invitation_id: UUID,
    body: UpgradeBody | None = None,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> InvitationAcceptResponse:
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
) -> InvitationAcceptResponse:
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
    if project.kind != PROJECT_KIND_WORKSPACE:
        raise HTTPException(status.HTTP_410_GONE, "invitation not available")
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

    membership = await ensure_viewer_membership(
        db,
        project_id=inv.project_id,
        member_user_id=auth.user_id,
        joined_via="invite",
        resolved_owner_handle=inv.resolved_owner_handle,
    )

    bound_agent_ids = await attach_project_to_owned_agents(
        db,
        user_id=auth.user_id,
        project_id=inv.project_id,
        raw_agent_ids=body.agent_ids,
    )

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
    return InvitationAcceptResponse(
        id=str(membership.id),
        project_id=str(membership.project_id),
        role=membership.role,
        joined_via=membership.joined_via,
        joined_at=membership.joined_at,
        resolved_owner_handle=membership.resolved_owner_handle,
        bound_agent_ids=bound_agent_ids,
    )


@router.post(
    "/invitations/{invitation_id}/decline",
    response_model=InvitationDeclineResponse,
)
async def decline_invitation(
    invitation_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> InvitationDeclineResponse:
    inv = (
        await db.execute(select(ProjectInvitation).where(ProjectInvitation.id == invitation_id))
    ).scalar_one_or_none()
    if inv is None or inv.invitee_user_id != auth.user_id:
        raise HTTPException(status.HTTP_410_GONE, "invitation not available")
    await db.delete(inv)
    await db.commit()
    return InvitationDeclineResponse(status="declined")
