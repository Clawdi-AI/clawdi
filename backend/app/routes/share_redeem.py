"""Public anonymous share-token endpoints + sign-in upgrade.

`require_share_token` is the sole gate for /preview and /redeem - no
user identity. /upgrade is the sign-in path: it takes a valid Clerk
auth (api_key OR Clerk JWT, both unbound - not env-bound deploy
keys) AND a valid share token, then creates a permanent
ScopeMembership for the requesting user.

Vault item plaintext is NEVER available via this surface (spec §7.4
+ §10) - CLI clients gate vault resolve on Clerk auth.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import (
    AuthContext,
    ShareTokenContext,
    require_share_token,
    require_user_auth_unbound,
)
from app.core.database import get_session
from app.models.scope import Scope
from app.models.scope_membership import ScopeMembership
from app.models.scope_share_link import ScopeShareLink
from app.models.skill import Skill
from app.models.user import User
from app.models.vault import Vault, VaultItem
from app.routes.mounts import ensure_mount
from app.schemas.sharing import ShareRedeemResponse, UpgradeBody
from app.services.sharing import resolve_auto_mount_parent

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/share", tags=["share-redeem"])


async def _resolve_owner_for_link(
    db: AsyncSession, link: ScopeShareLink
) -> tuple[str, str, User, Scope]:
    """Resolve owner display + frozen handle + scope for a share-link.

    The handle was frozen at link-create time and stored on the link
    row - never recompute. The display string IS recomputed each call
    since it's purely presentation. Returns 410 Gone if either the
    scope or its owner has been deleted between token issue and now;
    the cascade has propagated to the link row in most cases, but
    the in-memory `link` object the dep already held points at
    the now-gone scope.
    """
    scope_result = await db.execute(select(Scope).where(Scope.id == link.scope_id))
    scope = scope_result.scalar_one_or_none()
    if scope is None:
        raise HTTPException(
            status.HTTP_410_GONE,
            "share no longer available (scope removed)",
        )
    owner_result = await db.execute(select(User).where(User.id == scope.user_id))
    owner = owner_result.scalar_one_or_none()
    if owner is None:
        raise HTTPException(
            status.HTTP_410_GONE,
            "share no longer available (owner account removed)",
        )
    display = owner.name or owner.email or f"user-{str(owner.id)[:8]}"
    return display, link.resolved_owner_handle, owner, scope


async def _build_redeem_payload(ctx: ShareTokenContext, db: AsyncSession) -> ShareRedeemResponse:
    """Compose ShareRedeemResponse - pure read, no side-effects.
    Shared between /preview and /redeem so refresh, unfurl, and
    actual-accept all return the same shape."""
    link = (
        await db.execute(select(ScopeShareLink).where(ScopeShareLink.id == ctx.link_id))
    ).scalar_one()
    display, handle, _owner, scope = await _resolve_owner_for_link(db, link)

    skill_count = (
        await db.execute(
            select(func.count(Skill.id)).where(
                Skill.scope_id == ctx.scope_id,
                Skill.is_active.is_(True),
            )
        )
    ).scalar_one() or 0
    vault_count = (
        await db.execute(
            select(func.count(VaultItem.id))
            .join(Vault, Vault.id == VaultItem.vault_id)
            .where(Vault.scope_id == ctx.scope_id)
        )
    ).scalar_one() or 0

    return ShareRedeemResponse(
        scope_id=str(scope.id),
        scope_name=scope.name,
        owner_display=display,
        owner_handle=handle,
        skill_count=skill_count,
        vault_count=vault_count,
        vault_locked=True,
    )


@router.get("/{token}/preview", response_model=ShareRedeemResponse)
async def preview(
    ctx: ShareTokenContext = Depends(require_share_token),
    db: AsyncSession = Depends(get_session),
) -> ShareRedeemResponse:
    """Side-effect-free read of scope metadata for a valid token.

    The public landing page calls this on every SSR pass + every
    crawler unfurl. Does NOT increment redeem_count so the stat
    accurately measures "people who clicked Accept," not "people
    who saw the link."
    """
    return await _build_redeem_payload(ctx, db)


@router.post("/{token}/redeem", response_model=ShareRedeemResponse)
async def redeem(
    ctx: ShareTokenContext = Depends(require_share_token),
    db: AsyncSession = Depends(get_session),
) -> ShareRedeemResponse:
    """Anonymous accept - bumps redeem_count + stamps last_redeemed_at.

    Call on explicit user action only (CLI `share accept` from a
    logged-out terminal). The web landing page uses /preview for
    page render and /upgrade for the logged-in accept path; only
    the CLI's anonymous flow hits /redeem.
    """
    await db.execute(
        update(ScopeShareLink)
        .where(ScopeShareLink.id == ctx.link_id)
        .values(
            redeem_count=ScopeShareLink.redeem_count + 1,
            last_redeemed_at=datetime.now(UTC),
        )
    )
    payload = await _build_redeem_payload(ctx, db)
    await db.commit()
    return payload


@router.post("/{token}/upgrade")
async def upgrade(
    body: UpgradeBody | None = None,
    ctx: ShareTokenContext = Depends(require_share_token),
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> dict:
    """Convert a valid share-token + authed user into a permanent
    ScopeMembership AND a ScopeMount in one transaction.

    Idempotent on (user, scope) for membership and (parent, source)
    for mount.

    Mount target resolution:
      - body.parent_scope_id explicit → use it (validated as caller-owned).
      - body.no_mount=True → skip mount, capability only.
      - exactly 1 owned scope → auto-mount silently.
      - 2+ owned scopes → membership commits, mount returns
        409 mount_target_ambiguous with owned_scopes in context.

    409 already_owner if caller IS the source scope's owner.
    Hosted-pod env-bound api_keys rejected by require_user_auth_unbound.
    """
    body = body or UpgradeBody()
    scope = (await db.execute(select(Scope).where(Scope.id == ctx.scope_id))).scalar_one_or_none()
    if scope is None:
        raise HTTPException(status.HTTP_410_GONE, "scope no longer available")
    if scope.user_id == auth.user_id:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"error": "already_owner"},
        )

    link = (
        await db.execute(select(ScopeShareLink).where(ScopeShareLink.id == ctx.link_id))
    ).scalar_one()

    # Membership row (capability) — idempotent insert.
    existing = (
        await db.execute(
            select(ScopeMembership).where(
                ScopeMembership.scope_id == ctx.scope_id,
                ScopeMembership.user_id == auth.user_id,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        membership = existing
    else:
        membership = ScopeMembership(
            scope_id=ctx.scope_id,
            user_id=auth.user_id,
            role="viewer",
            joined_via="link",
            joined_at=datetime.now(UTC),
            resolved_owner_handle=link.resolved_owner_handle,
        )
        db.add(membership)
        await db.flush()

    # Mount target resolution.
    mount_payload: dict = {}
    if body.no_mount:
        await db.commit()
    else:
        parent_id = await resolve_auto_mount_parent(
            db,
            auth.user_id,
            body.parent_scope_id,
            membership.id,
        )
        # We have a target; build the mount.
        base_alias = body.alias or f"@{link.resolved_owner_handle}/{scope.slug}"
        try:
            mount = await ensure_mount(
                db,
                parent_id=parent_id,
                source_id=ctx.scope_id,
                base_alias=base_alias,
                created_by=auth.user_id,
            )
        except HTTPException:
            # ensure_mount commits its own rollback on race; surface
            # the error but membership is already flushed (will commit
            # when this exception escapes — but ensure_mount called
            # rollback, which nuked our membership too).
            # Re-insert membership defensively and commit just it,
            # then re-raise so caller sees the conflict.
            if existing is None:
                redo = ScopeMembership(
                    scope_id=ctx.scope_id,
                    user_id=auth.user_id,
                    role="viewer",
                    joined_via="link",
                    joined_at=datetime.now(UTC),
                    resolved_owner_handle=link.resolved_owner_handle,
                )
                db.add(redo)
                await db.flush()
                await db.commit()
            raise

        await db.commit()
        mount_payload = {
            "mount_id": str(mount.id),
            "mount_alias": mount.alias,
            "mount_parent_scope_id": str(mount.parent_scope_id),
        }

    logger.info(
        "share_link.upgraded",
        extra={
            "scope_id": str(ctx.scope_id),
            "link_id": str(ctx.link_id),
            "user_id": str(auth.user_id),
            "mount_target": mount_payload.get("mount_parent_scope_id"),
        },
    )
    return {
        "scope_id": str(membership.scope_id),
        "resolved_owner_handle": membership.resolved_owner_handle,
        "membership_id": str(membership.id),
        **mount_payload,
    }
