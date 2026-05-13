"""Sharee-facing /api/me/... routes.

Three surfaces used by the invitee dashboard:
  GET  /api/me/invitations               — inbox (pending only)
  POST /api/me/invitations/{id}/accept   — turn pending row into
        ScopeMembership; invitation row deleted
  POST /api/me/invitations/{id}/decline  — delete pending row, no
        membership created

The `auth` dep on accept is `require_user_auth_unbound` — env-bound
deploy keys cannot accept invitations (would expand a hosted-pod's
blast radius into another user's scope). List/decline use
`require_user_auth` (read-only / cleanup are harmless from a
deploy key).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete as sql_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.auth import AuthContext, require_user_auth, require_user_auth_unbound
from app.core.database import get_session
from app.models.scope import Scope
from app.models.scope_invitation import ScopeInvitation
from app.models.scope_membership import ScopeMembership
from app.models.user import User
from app.routes.mounts import ensure_mount, mount_payload
from app.schemas.sharing import InvitationResponse, UpgradeBody
from app.services.sharing import (
    assert_no_vault_conflicts,
    resolve_auto_mount_parent,
    resolve_owner_handle,
    safe_owner_display,
    safe_owner_handle,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/me", tags=["me"])


@router.get("/invitations", response_model=list[InvitationResponse])
async def list_my_invitations(
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> list[InvitationResponse]:
    """Return every pending invitation addressed to the current user.

    Joins the Scope + scope-owner + inviter (often the same user as
    the owner, but not necessarily — a future co-owner might invite
    on the primary's behalf) so the dashboard can render the full
    "X (@x-handle) invited you to 'Scope Y'" string from one query.
    """
    Inviter = aliased(User)
    Owner = aliased(User)
    rows = (
        await db.execute(
            select(ScopeInvitation, Inviter, Scope, Owner)
            .outerjoin(Inviter, Inviter.id == ScopeInvitation.invited_by)
            .join(Scope, Scope.id == ScopeInvitation.scope_id)
            .join(Owner, Owner.id == Scope.user_id)
            .where(ScopeInvitation.invitee_user_id == auth.user_id)
            .order_by(ScopeInvitation.created_at.desc())
        )
    ).all()
    out: list[InvitationResponse] = []
    for inv, by, scope, owner in rows:
        out.append(
            InvitationResponse(
                id=str(inv.id),
                scope_id=str(inv.scope_id),
                scope_name=scope.name,
                scope_kind=scope.kind,
                owner_display=safe_owner_display(owner),
                owner_handle=safe_owner_handle(owner),
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
    """Turn a pending invitation into a permanent ScopeMembership
    AND a ScopeMount in one transaction.

    Body shape (UpgradeBody): optional parent_scope_id for the mount,
    optional alias, no_mount flag. If parent_scope_id is omitted and
    the user has 2+ owned scopes, returns 409 mount_target_ambiguous
    after committing the membership.

    Lock the SCOPE row across the transaction to serialize against
    concurrent unshare / membership-creating endpoints.
    """
    body = body or UpgradeBody()
    # Pre-fetch to know which scope to lock. (We can't lock the
    # invitation row across an unshare race — unshare deletes
    # invitations by scope_id, not via the row we hold here.)
    inv_pre = (
        await db.execute(select(ScopeInvitation).where(ScopeInvitation.id == invitation_id))
    ).scalar_one_or_none()
    if inv_pre is None or inv_pre.invitee_user_id != auth.user_id:
        raise HTTPException(status.HTTP_410_GONE, "invitation not available")

    scope = (
        await db.execute(select(Scope).where(Scope.id == inv_pre.scope_id).with_for_update())
    ).scalar_one_or_none()
    if scope is None:
        raise HTTPException(status.HTTP_410_GONE, "scope no longer available")

    # Re-fetch under the lock.
    inv = (
        await db.execute(select(ScopeInvitation).where(ScopeInvitation.id == invitation_id))
    ).scalar_one_or_none()
    if inv is None or inv.invitee_user_id != auth.user_id:
        raise HTTPException(status.HTTP_410_GONE, "invitation not available")

    owner = (await db.execute(select(User).where(User.id == scope.user_id))).scalar_one_or_none()
    if owner is None:
        raise HTTPException(status.HTTP_410_GONE, "owner account removed")

    try:
        handle = resolve_owner_handle(owner)
    except ValueError as err:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "error": "owner_display_name_required",
                "message": (
                    "The scope owner has no display name set. Ask them to set "
                    "one before you can join."
                ),
            },
        ) from err

    existing_membership = (
        await db.execute(
            select(ScopeMembership).where(
                ScopeMembership.scope_id == inv.scope_id,
                ScopeMembership.user_id == auth.user_id,
            )
        )
    ).scalar_one_or_none()
    if existing_membership is not None:
        membership = existing_membership
    else:
        membership = ScopeMembership(
            scope_id=inv.scope_id,
            user_id=auth.user_id,
            role="viewer",
            joined_via="invite",
            joined_at=datetime.now(UTC),
            resolved_owner_handle=handle,
        )
        db.add(membership)
        await db.flush()

    # --- Auto-mount (MC) ---
    mount_fields: dict = {}
    if not body.no_mount:
        parent_id = await resolve_auto_mount_parent(
            db,
            auth.user_id,
            body.parent_scope_id,
            membership.id,
        )
        await assert_no_vault_conflicts(
            db,
            parent_scope_id=parent_id,
            source_scope_id=inv.scope_id,
            allow=body.allow_vault_conflicts,
        )
        base_alias = body.alias or f"@{handle}/{scope.slug}"
        mount = await ensure_mount(
            db,
            parent_id=parent_id,
            source_id=inv.scope_id,
            base_alias=base_alias,
            created_by=auth.user_id,
        )
        mount_fields = mount_payload(mount)

    # Defensive sweep: clear any other pending invitations to this
    # user for this scope. The unique constraint on
    # (scope_id, invitee_user_id) makes this near-impossible, but a
    # leftover row would surface as a phantom invite forever.
    await db.execute(
        sql_delete(ScopeInvitation).where(
            ScopeInvitation.scope_id == inv.scope_id,
            ScopeInvitation.invitee_user_id == auth.user_id,
        )
    )
    await db.commit()
    logger.info(
        "invitation_accepted invitation_id=%s by=%s scope_id=%s mount=%s",
        invitation_id,
        auth.user_id,
        inv.scope_id,
        mount_fields.get("mount_parent_scope_id"),
    )
    return {
        "id": str(membership.id),
        "scope_id": str(membership.scope_id),
        "role": membership.role,
        "joined_via": membership.joined_via,
        "joined_at": membership.joined_at.isoformat(),
        "resolved_owner_handle": membership.resolved_owner_handle,
        **mount_fields,
    }


@router.post("/invitations/{invitation_id}/decline")
async def decline_invitation(
    invitation_id: UUID,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    """Hard-delete the pending invitation. 410 if it's already gone
    or wasn't addressed to this user — same shape as accept."""
    inv = (
        await db.execute(select(ScopeInvitation).where(ScopeInvitation.id == invitation_id))
    ).scalar_one_or_none()
    if inv is None or inv.invitee_user_id != auth.user_id:
        raise HTTPException(status.HTTP_410_GONE, "invitation not available")
    await db.delete(inv)
    await db.commit()
    logger.info(
        "invitation_declined invitation_id=%s by=%s",
        invitation_id,
        auth.user_id,
    )
    return {"status": "declined"}
