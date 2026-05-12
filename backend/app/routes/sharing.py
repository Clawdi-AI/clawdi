"""Owner-facing sharing endpoints.

Every route is gated by:
  1. require_user_auth_unbound — Clerk JWT OR fully-unbound CLI api_key.
     Narrowly-scoped api_keys and env-bound deploy keys are rejected
     (the latter wraps PR #77's blast-radius boundary).
  2. _assert_scope_owner — verifies the scope exists AND the caller
     owns it. 404 (not 403) on either condition to avoid leaking
     scope existence to non-owners.

Public anonymous routes (share-link redemption etc.) live in
`share_redeem.py`; that one uses require_share_token instead.

This module covers Plan Phase B tasks B.1–B.8 incrementally. The
MVP commit ships B.1 skeleton + B.2 create-link so the owner
dialog's "Generate link" action goes through end-to-end; list,
revoke, invitations, members, and unshare land in follow-ups.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_user_auth_unbound
from app.core.config import settings
from app.core.database import get_session
from app.models.scope import Scope
from app.models.scope_invitation import ScopeInvitation
from app.models.scope_membership import ScopeMembership
from app.models.scope_share_link import ScopeShareLink
from app.models.user import User
from app.schemas.sharing import (
    InvitationCreate,
    InvitationResponse,
    ShareLinkCreate,
    ShareLinkCreated,
    ShareLinkResponse,
)
from app.services.sharing import (
    generate_share_token,
    hash_share_token,
    resolve_owner_handle,
    safe_owner_display,
    token_prefix,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/scopes", tags=["sharing"])


async def _assert_scope_owner(db: AsyncSession, auth: AuthContext, scope_id: UUID) -> Scope:
    """Resolve scope and verify the caller owns it. 404 if the
    scope doesn't exist OR the caller isn't its owner — refusing
    to distinguish the two keeps scope IDs un-enumerable by
    non-owners."""
    result = await db.execute(select(Scope).where(Scope.id == scope_id))
    scope = result.scalar_one_or_none()
    if scope is None or scope.user_id != auth.user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "scope not found")
    return scope


def _share_url(raw_token: str) -> str:
    """Compose the public share URL from the raw token.

    Hosts the public landing page on the dashboard origin
    (settings.web_origin). Falls back to a sentinel for OSS
    self-hosters who haven't configured a public dashboard URL.
    """
    base = settings.web_origin.rstrip("/") if settings.web_origin else "https://example.invalid"
    return f"{base}/share/{raw_token}"


@router.post("/{scope_id}/share-links", response_model=ShareLinkCreated)
async def create_share_link(
    scope_id: UUID,
    body: ShareLinkCreate,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> ShareLinkCreated:
    """Generate a new share link for a scope.

    Contract:
    - Raw token is returned ONCE in the create response; server
      stores only the SHA-256 hash + prefix.
    - Gate on owner having `users.name` set (spec § 4.5). Falling
      back to email local-part would leak PII to recipients.
    - Resolves + freezes `resolved_owner_handle` on the link row so
      every downstream consumer (preview, redeem, upgrade) reads
      the same value — even if the owner later renames themselves.
    """
    await _assert_scope_owner(db, auth, scope_id)

    if not auth.user.name:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "error": "display_name_required",
                "message": (
                    "Set a display name on your profile before sharing a "
                    "scope. The name is shown to anyone you share with."
                ),
            },
        )
    try:
        owner_handle = resolve_owner_handle(auth.user)
    except ValueError as err:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "error": "display_name_required",
                "message": ("Your display name must contain at least one alphanumeric character."),
            },
        ) from err

    raw = generate_share_token()
    link = ScopeShareLink(
        scope_id=scope_id,
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
        "share_link_created scope_id=%s link_id=%s by=%s handle=%s",
        scope_id,
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


@router.get("/{scope_id}/share-links", response_model=list[ShareLinkResponse])
async def list_share_links(
    scope_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> list[ShareLinkResponse]:
    """List active + revoked share-links for a scope.

    Returns prefix-only data — the raw token was shown ONCE at create
    time and is unrecoverable. Owners refresh the dialog to see
    redeem counts, last-redeemed timestamps, and revoke individual
    links.

    Sorted created_at DESC so the freshest link surfaces first.
    Revoked links remain in the listing (with revoked_at populated)
    so the owner can see a history; the client renders them muted.
    """
    await _assert_scope_owner(db, auth, scope_id)
    result = await db.execute(
        select(ScopeShareLink)
        .where(ScopeShareLink.scope_id == scope_id)
        .order_by(ScopeShareLink.created_at.desc())
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


@router.delete("/{scope_id}/share-links/{link_id}")
async def revoke_share_link(
    scope_id: UUID,
    link_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    """Soft-revoke a share-link by stamping revoked_at.

    Idempotent: revoking an already-revoked link returns 200 with
    the same response, doesn't double-stamp.

    Once revoked, /preview, /redeem, /upgrade all return 410 Gone
    via require_share_token's expiry check. Anonymous tokens already
    accepted on a device stop syncing — the daemon's next reconcile
    sees 410 and prunes the local share-tokens.json entry.

    Pre-existing ScopeMembership rows (created via /upgrade BEFORE
    revoke) are NOT removed — revoking the LINK doesn't remove
    members who already joined via it. Owner must explicitly call
    DELETE /api/scopes/{id}/members/{user_id} (B.7) for that.
    """
    await _assert_scope_owner(db, auth, scope_id)
    result = await db.execute(
        select(ScopeShareLink).where(
            ScopeShareLink.id == link_id,
            ScopeShareLink.scope_id == scope_id,
        )
    )
    link = result.scalar_one_or_none()
    if link is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "share link not found")
    if link.revoked_at is None:
        link.revoked_at = datetime.now(UTC)
        await db.commit()
        logger.info("share_link_revoked link_id=%s by=%s", link_id, auth.user_id)
    return {"status": "revoked"}


def _owner_view(auth: AuthContext) -> tuple[str, str]:
    """Helper: resolve (display, handle) for the authed owner, used
    by invitation response shaping. Raises 409 if the owner can't
    resolve a handle — same display_name_required gate as create."""
    if not auth.user.name:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "error": "display_name_required",
                "message": (
                    "Set a display name on your profile before sharing. Recipients see the name."
                ),
            },
        )
    try:
        handle = resolve_owner_handle(auth.user)
    except ValueError as err:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "error": "display_name_required",
                "message": ("Your display name must contain at least one alphanumeric character."),
            },
        ) from err
    return safe_owner_display(auth.user), handle


@router.post("/{scope_id}/invitations", response_model=InvitationResponse)
async def create_invitation(
    scope_id: UUID,
    body: InvitationCreate,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> InvitationResponse:
    """Send a pending invitation to a registered clawdi user.

    Email lookup is case-insensitive. The invitee MUST already have
    an account — for non-users the response instructs the owner to
    send a share-link instead (which works for any email and creates
    a Clerk account via the sign-in handoff).

    Cases:
      - target == self → 400 already_owner
      - target email not found → 404 user_not_found
      - multiple accounts with that email → 409 ambiguous_email
        (privacy: silently picking one would invite the wrong account)
      - target already a member → 409 already_member
      - target already invited (FK uniqueness) → 409 already_invited
    """
    scope = await _assert_scope_owner(db, auth, scope_id)
    display, handle = _owner_view(auth)
    target_email = body.email.lower()

    if auth.user.email and auth.user.email.lower() == target_email:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            {"error": "already_owner", "message": "You're already the owner."},
        )

    # `users.email` is NOT unique in production (snapshot import
    # permits dupes). Handle 0 / 1 / N explicitly.
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
                "message": (
                    "Multiple accounts match that email — we can't tell which "
                    "to invite. Send them a share link instead."
                ),
            },
        )
    invitee = invitee_rows[0]

    existing_member = (
        await db.execute(
            select(ScopeMembership).where(
                ScopeMembership.scope_id == scope_id,
                ScopeMembership.user_id == invitee.id,
            )
        )
    ).scalar_one_or_none()
    if existing_member is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {"error": "already_member", "message": "Already a member."},
        )

    invitation = ScopeInvitation(
        scope_id=scope_id,
        invitee_user_id=invitee.id,
        invitee_email=target_email,
        invited_by=auth.user_id,
        created_at=datetime.now(UTC),
    )
    db.add(invitation)
    try:
        await db.commit()
    except IntegrityError:
        # uq_scope_invitations_scope_user collision.
        await db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {"error": "already_invited", "message": "Invitation already pending."},
        ) from None
    await db.refresh(invitation)

    logger.info(
        "invitation_created scope_id=%s email=%s by=%s",
        scope_id,
        target_email,
        auth.user_id,
    )
    return InvitationResponse(
        id=str(invitation.id),
        scope_id=str(scope_id),
        scope_name=scope.name,
        scope_kind=scope.kind,
        owner_display=display,
        owner_handle=handle,
        invitee_email=target_email,
        invited_by_user_id=str(auth.user_id),
        invited_by_display=display,
        created_at=invitation.created_at,
    )


@router.get("/{scope_id}/invitations", response_model=list[InvitationResponse])
async def list_invitations(
    scope_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> list[InvitationResponse]:
    """List all pending invitations on this scope, newest first.

    Accepted/declined invitations roll up into ScopeMembership rows
    on accept and get deleted on decline; this listing therefore
    contains only PENDING invitations from the owner's perspective.
    """
    scope = await _assert_scope_owner(db, auth, scope_id)
    display, handle = _owner_view(auth)
    rows = (
        await db.execute(
            select(ScopeInvitation, User)
            .outerjoin(User, User.id == ScopeInvitation.invited_by)
            .where(ScopeInvitation.scope_id == scope_id)
            .order_by(ScopeInvitation.created_at.desc())
        )
    ).all()
    return [
        InvitationResponse(
            id=str(inv.id),
            scope_id=str(inv.scope_id),
            scope_name=scope.name,
            scope_kind=scope.kind,
            owner_display=display,
            owner_handle=handle,
            invitee_email=inv.invitee_email,
            invited_by_user_id=str(inv.invited_by),
            invited_by_display=(by.name or by.email) if by else None,
            created_at=inv.created_at,
        )
        for inv, by in rows
    ]


@router.delete("/{scope_id}/invitations/{invitation_id}")
async def cancel_invitation(
    scope_id: UUID,
    invitation_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    """Hard-delete a pending invitation. The invitee loses the
    pending entry on their dashboard next refresh."""
    await _assert_scope_owner(db, auth, scope_id)
    row = (
        await db.execute(
            select(ScopeInvitation).where(
                ScopeInvitation.id == invitation_id,
                ScopeInvitation.scope_id == scope_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "invitation not found")
    await db.delete(row)
    await db.commit()
    logger.info("invitation_cancelled id=%s by=%s", invitation_id, auth.user_id)
    return {"status": "cancelled"}
