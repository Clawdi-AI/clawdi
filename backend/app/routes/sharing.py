"""Owner-facing project sharing endpoints."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete as sql_delete
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_user_auth_unbound
from app.core.config import settings
from app.core.database import get_session
from app.models.project import PROJECT_KIND_WORKSPACE, Project
from app.models.project_invitation import ProjectInvitation
from app.models.project_membership import ProjectMembership
from app.models.project_share_link import ProjectShareLink
from app.models.user import User
from app.schemas.sharing import (
    InvitationCancelResponse,
    InvitationCreate,
    InvitationResponse,
    MemberResponse,
    ProjectLeaveResponse,
    ProjectMemberRemoveResponse,
    ShareLinkCreate,
    ShareLinkCreated,
    ShareLinkResponse,
    ShareLinkRevokeResponse,
    UnshareResponse,
)
from app.services.agent_bindings import delete_project_bindings_for_users
from app.services.sharing import (
    generate_share_token,
    hash_share_token,
    resolve_owner_handle,
    safe_owner_display,
    token_prefix,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/projects", tags=["sharing"])


async def _assert_project_owner(
    db: AsyncSession,
    auth: AuthContext,
    project_id: UUID,
    *,
    for_update: bool = False,
) -> Project:
    stmt = select(Project).where(Project.id == project_id)
    if for_update:
        stmt = stmt.with_for_update()
    result = await db.execute(stmt)
    project = result.scalar_one_or_none()
    if project is None or project.user_id != auth.user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")
    return project


def _assert_project_shareable(project: Project) -> None:
    if project.kind != PROJECT_KIND_WORKSPACE:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            {
                "error": "project_not_shareable",
                "message": "Only Custom Projects can be shared.",
            },
        )


async def _assert_shareable_project_owner(
    db: AsyncSession,
    auth: AuthContext,
    project_id: UUID,
    *,
    for_update: bool = False,
) -> Project:
    project = await _assert_project_owner(db, auth, project_id, for_update=for_update)
    _assert_project_shareable(project)
    return project


def _share_url(raw_token: str) -> str:
    base = settings.web_origin.rstrip("/") if settings.web_origin else "https://example.invalid"
    return f"{base}/share/{raw_token}"


@router.post("/{project_id}/share-links", response_model=ShareLinkCreated)
async def create_share_link(
    project_id: UUID,
    body: ShareLinkCreate,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> ShareLinkCreated:
    await _assert_shareable_project_owner(db, auth, project_id)

    try:
        owner_handle = resolve_owner_handle(auth.user)
    except ValueError as err:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "error": "display_name_required",
                "message": (
                    "Set a display name on your profile (at least one alphanumeric "
                    "character) before sharing - recipients see the name."
                ),
            },
        ) from err

    raw = generate_share_token()
    link = ProjectShareLink(
        project_id=project_id,
        token_hash=hash_share_token(raw),
        token_prefix=token_prefix(raw),
        label=body.label,
        created_by=auth.user_id,
        resolved_owner_handle=owner_handle,
        created_at=datetime.now(UTC),
        expires_at=body.expires_at,
    )
    db.add(link)
    await db.commit()
    await db.refresh(link)

    logger.info(
        "project_share_link_created project_id=%s link_id=%s by=%s handle=%s",
        project_id,
        link.id,
        auth.user_id,
        owner_handle,
    )
    return ShareLinkCreated(
        id=str(link.id),
        raw_token=raw,
        url=_share_url(raw),
        prefix=link.token_prefix,
        owner_handle=owner_handle,
        label=link.label,
        created_at=link.created_at,
        expires_at=link.expires_at,
    )


@router.get("/{project_id}/share-links", response_model=list[ShareLinkResponse])
async def list_share_links(
    project_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> list[ShareLinkResponse]:
    await _assert_shareable_project_owner(db, auth, project_id)
    result = await db.execute(
        select(ProjectShareLink)
        .where(ProjectShareLink.project_id == project_id)
        .order_by(ProjectShareLink.created_at.desc())
    )
    return [
        ShareLinkResponse(
            id=str(link.id),
            prefix=link.token_prefix,
            label=link.label,
            created_at=link.created_at,
            expires_at=link.expires_at,
            revoked_at=link.revoked_at,
            redeem_count=link.redeem_count,
            last_redeemed_at=link.last_redeemed_at,
        )
        for link in result.scalars().all()
    ]


@router.delete(
    "/{project_id}/share-links/{link_id}",
    response_model=ShareLinkRevokeResponse,
)
async def revoke_share_link(
    project_id: UUID,
    link_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> ShareLinkRevokeResponse:
    await _assert_shareable_project_owner(db, auth, project_id, for_update=True)
    result = await db.execute(
        select(ProjectShareLink).where(
            ProjectShareLink.id == link_id,
            ProjectShareLink.project_id == project_id,
        )
    )
    link = result.scalar_one_or_none()
    if link is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "share link not found")
    if link.revoked_at is None:
        link.revoked_at = datetime.now(UTC)
        await db.commit()
        logger.info("project_share_link_revoked link_id=%s by=%s", link_id, auth.user_id)
    return ShareLinkRevokeResponse(status="revoked")


def _owner_view(auth: AuthContext) -> tuple[str, str]:
    try:
        handle = resolve_owner_handle(auth.user)
    except ValueError as err:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "error": "display_name_required",
                "message": (
                    "Set a display name on your profile (at least one alphanumeric "
                    "character) before sharing - recipients see the name."
                ),
            },
        ) from err
    return safe_owner_display(auth.user), handle


@router.post("/{project_id}/invitations", response_model=InvitationResponse)
async def create_invitation(
    project_id: UUID,
    body: InvitationCreate,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> InvitationResponse:
    project = await _assert_shareable_project_owner(db, auth, project_id)
    display, handle = _owner_view(auth)
    target_email = body.email

    if auth.user.email and auth.user.email.lower() == target_email:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            {"error": "already_owner", "message": "You're already the owner."},
        )

    invitee_rows = (
        (await db.execute(select(User).where(func.lower(User.email) == target_email)))
        .scalars()
        .all()
    )
    if len(invitee_rows) == 0:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            {
                "error": "user_not_found",
                "message": (
                    "No clawdi account found for that email. Send them a share link instead."
                ),
            },
        )
    if len(invitee_rows) > 1:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "error": "ambiguous_email",
                "message": "Multiple accounts match that email. Send them a share link instead.",
            },
        )
    invitee = invitee_rows[0]

    existing_member = (
        await db.execute(
            select(ProjectMembership).where(
                ProjectMembership.project_id == project_id,
                ProjectMembership.member_user_id == invitee.id,
            )
        )
    ).scalar_one_or_none()
    if existing_member is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {"error": "already_member", "message": "Already a member."},
        )

    invitation = ProjectInvitation(
        project_id=project_id,
        invitee_user_id=invitee.id,
        invitee_email=target_email,
        invited_by=auth.user_id,
        resolved_owner_handle=handle,
        created_at=datetime.now(UTC),
    )
    db.add(invitation)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {"error": "already_invited", "message": "Invitation already pending."},
        ) from None
    await db.refresh(invitation)

    return InvitationResponse(
        id=str(invitation.id),
        project_id=str(project_id),
        project_name=project.name,
        project_kind=project.kind,
        owner_display=display,
        owner_handle=handle,
        invitee_email=target_email,
        invited_by_user_id=str(auth.user_id),
        invited_by_display=display,
        created_at=invitation.created_at,
    )


@router.get("/{project_id}/invitations", response_model=list[InvitationResponse])
async def list_invitations(
    project_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> list[InvitationResponse]:
    project = await _assert_shareable_project_owner(db, auth, project_id)
    display = safe_owner_display(auth.user)
    rows = (
        await db.execute(
            select(ProjectInvitation, User)
            .outerjoin(User, User.id == ProjectInvitation.invited_by)
            .where(ProjectInvitation.project_id == project_id)
            .order_by(ProjectInvitation.created_at.desc())
        )
    ).all()
    return [
        InvitationResponse(
            id=str(inv.id),
            project_id=str(inv.project_id),
            project_name=project.name,
            project_kind=project.kind,
            owner_display=display,
            owner_handle=inv.resolved_owner_handle,
            invitee_email=inv.invitee_email,
            invited_by_user_id=str(inv.invited_by),
            invited_by_display=(by.name or by.email) if by else None,
            created_at=inv.created_at,
        )
        for inv, by in rows
    ]


@router.delete(
    "/{project_id}/invitations/{invitation_id}",
    response_model=InvitationCancelResponse,
)
async def cancel_invitation(
    project_id: UUID,
    invitation_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> InvitationCancelResponse:
    await _assert_shareable_project_owner(db, auth, project_id, for_update=True)
    row = (
        await db.execute(
            select(ProjectInvitation).where(
                ProjectInvitation.id == invitation_id,
                ProjectInvitation.project_id == project_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "invitation not found")
    await db.delete(row)
    await db.commit()
    return InvitationCancelResponse(status="cancelled")


@router.get("/{project_id}/members", response_model=list[MemberResponse])
async def list_members(
    project_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> list[MemberResponse]:
    await _assert_shareable_project_owner(db, auth, project_id)
    rows = (
        await db.execute(
            select(ProjectMembership, User)
            .join(User, User.id == ProjectMembership.member_user_id)
            .where(ProjectMembership.project_id == project_id)
            .order_by(ProjectMembership.joined_at.desc(), ProjectMembership.id.desc())
        )
    ).all()
    return [
        MemberResponse(
            id=str(member.id),
            user_id=str(user.id),
            user_email=user.email,
            user_display=user.name,
            role=member.role,
            joined_via=member.joined_via,
            joined_at=member.joined_at,
            resolved_owner_handle=member.resolved_owner_handle,
        )
        for member, user in rows
    ]


@router.delete(
    "/{project_id}/members/{member_user_id}",
    response_model=ProjectMemberRemoveResponse,
)
async def remove_member(
    project_id: UUID,
    member_user_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> ProjectMemberRemoveResponse:
    project = await _assert_shareable_project_owner(db, auth, project_id)
    if member_user_id == project.user_id:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            {"error": "owner_cannot_be_removed"},
        )
    member = (
        await db.execute(
            select(ProjectMembership).where(
                ProjectMembership.project_id == project_id,
                ProjectMembership.member_user_id == member_user_id,
            )
        )
    ).scalar_one_or_none()
    if member is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "member not found")

    await db.delete(member)
    bindings_removed = await delete_project_bindings_for_users(
        db,
        project_id=project_id,
        user_ids=[member_user_id],
    )
    await db.commit()
    return ProjectMemberRemoveResponse(
        status="removed",
        agent_bindings_removed=bindings_removed,
    )


@router.post("/{project_id}/leave", response_model=ProjectLeaveResponse)
async def leave_project(
    project_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> ProjectLeaveResponse:
    project = (
        await db.execute(select(Project).where(Project.id == project_id))
    ).scalar_one_or_none()
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")
    if project.user_id == auth.user_id:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            {"error": "owner_cannot_leave"},
        )
    member = (
        await db.execute(
            select(ProjectMembership).where(
                ProjectMembership.project_id == project_id,
                ProjectMembership.member_user_id == auth.user_id,
            )
        )
    ).scalar_one_or_none()
    if member is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "membership not found")

    await db.delete(member)
    bindings_removed = await delete_project_bindings_for_users(
        db,
        project_id=project_id,
        user_ids=[auth.user_id],
    )
    await db.commit()
    return ProjectLeaveResponse(
        status="left",
        agent_bindings_removed=bindings_removed,
    )


@router.post("/{project_id}/unshare", response_model=UnshareResponse)
async def unshare_project(
    project_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> UnshareResponse:
    await _assert_shareable_project_owner(db, auth, project_id, for_update=True)
    now = datetime.now(UTC)

    active_links = (
        (
            await db.execute(
                select(ProjectShareLink).where(
                    ProjectShareLink.project_id == project_id,
                    ProjectShareLink.revoked_at.is_(None),
                )
            )
        )
        .scalars()
        .all()
    )
    for link in active_links:
        link.revoked_at = now

    invite_result = await db.execute(
        sql_delete(ProjectInvitation).where(ProjectInvitation.project_id == project_id)
    )
    invitations_cancelled = int(invite_result.rowcount or 0)

    members = (
        (
            await db.execute(
                select(ProjectMembership).where(ProjectMembership.project_id == project_id)
            )
        )
        .scalars()
        .all()
    )
    member_user_ids = [member.member_user_id for member in members]
    agent_bindings_removed = await delete_project_bindings_for_users(
        db,
        project_id=project_id,
        user_ids=member_user_ids,
    )
    for member in members:
        await db.delete(member)

    await db.commit()
    return UnshareResponse(
        links_revoked=len(active_links),
        members_removed=len(members),
        invitations_cancelled=invitations_cancelled,
        agent_bindings_removed=agent_bindings_removed,
    )
