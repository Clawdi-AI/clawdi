"""Scope mount management — owner-only composition operations.

A mount is a composition edge on the parent scope, NOT a permission
grant on the source. Creating a mount requires:
  1. Caller owns the parent scope (write-side privilege).
  2. Caller has independent membership (or ownership) of the source
     scope. This re-checks the viewer's read capability so a mount
     can't bypass the membership model.

See docs/scenarios/scope-sharing-demo.md for the user-facing
composition flows.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_user_auth_unbound
from app.core.database import get_session
from app.core.scope import scope_ids_visible_to, validate_scope_for_caller
from app.models.scope import Scope
from app.models.scope_mount import ScopeMount
from app.models.user import User
from app.schemas.sharing import MountCreate, MountResponse
from app.services.sharing import (
    assert_no_vault_conflicts,
    safe_owner_display,
    safe_owner_handle,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/scopes", tags=["mounts"])


async def _build_mount_response(
    db: AsyncSession,
    mount: ScopeMount,
    *,
    src: Scope | None = None,
    owner: User | None = None,
) -> MountResponse:
    """Build the response shape from a mount row.

    `src` and `owner` may be passed in by callers that already
    fetched them (avoids a post-commit re-query in create_mount).
    """
    if src is None:
        src = (
            await db.execute(select(Scope).where(Scope.id == mount.source_scope_id))
        ).scalar_one()
    if owner is None:
        owner = (await db.execute(select(User).where(User.id == src.user_id))).scalar_one()
    return MountResponse(
        id=str(mount.id),
        parent_scope_id=str(mount.parent_scope_id),
        source_scope_id=str(mount.source_scope_id),
        source_scope_name=src.name,
        source_scope_slug=src.slug,
        source_owner_display=safe_owner_display(owner),
        source_owner_handle=safe_owner_handle(owner),
        alias=mount.alias,
        mode=mount.mode,
        created_at=mount.created_at,
    )


def mount_payload(mount: ScopeMount) -> dict[str, str]:
    """The `mount_*` dict spread into every accept-route response.

    Single source for the shape so the share-link upgrade response,
    the invitation accept response, and any future accept-shape route
    can't drift apart. The keys are part of the published API
    contract (web + CLI both unpack them), so don't rename without
    also bumping the OpenAPI schema and the typed-client.
    """
    return {
        "mount_id": str(mount.id),
        "mount_alias": mount.alias,
        "mount_parent_scope_id": str(mount.parent_scope_id),
    }


async def ensure_mount(
    db: AsyncSession,
    *,
    parent_id: UUID,
    source_id: UUID,
    base_alias: str,
    created_by: UUID,
    mode: str = "live",
) -> ScopeMount:
    """Create a mount row, idempotent on (parent, source).

    Natural alias `<base_alias>` is tried first. On `(parent, alias)`
    collision with a DIFFERENT source, the helper suffix-bumps
    `base_alias-2`, ..., `base_alias-9`. After 9 attempts raises
    HTTPException(409 alias_collision_exhausted).

    Pre-checks alias collisions via SELECT rather than catching
    IntegrityError + rollback: the rollback path leaves the
    async session in a state that has hit greenlet boundaries in
    other routes. The race window between SELECT and INSERT is
    real but small; concurrent racers fall back to a single
    IntegrityError that surfaces as 409 alias_collision_exhausted.

    Reused by:
      * POST /api/scopes/{id}/mounts (this module)
      * Auto-mount inside /upgrade and /me/invitations/{id}/accept
        (Phase MC)
    """
    existing = (
        await db.execute(
            select(ScopeMount).where(
                ScopeMount.parent_scope_id == parent_id,
                ScopeMount.source_scope_id == source_id,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing

    # Pre-fetch every taken alias on this parent so suffix selection
    # is single-query rather than per-suffix flush + rollback.
    taken_rows = (
        (await db.execute(select(ScopeMount.alias).where(ScopeMount.parent_scope_id == parent_id)))
        .scalars()
        .all()
    )
    taken = set(taken_rows)

    chosen: str | None = None
    attempts: list[str] = []
    for suffix in (None, 2, 3, 4, 5, 6, 7, 8, 9):
        candidate = base_alias if suffix is None else f"{base_alias}-{suffix}"
        attempts.append(candidate)
        if candidate not in taken:
            chosen = candidate
            break

    if chosen is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "error": "alias_collision_exhausted",
                "message": (
                    "Could not resolve an unused alias for this mount; "
                    "another mount already uses every variant tried."
                ),
                "attempted_aliases": attempts,
            },
        )

    mount = ScopeMount(
        parent_scope_id=parent_id,
        source_scope_id=source_id,
        alias=chosen,
        mode=mode,
        created_by=created_by,
        created_at=datetime.now(UTC),
    )
    # Wrap the INSERT in a SAVEPOINT so a race-window IntegrityError
    # rolls back ONLY this nested transaction, not the outer one. The
    # caller has typically already flushed a ScopeMembership row before
    # calling us (the share-link / invitation upgrade paths); a flat
    # `db.rollback()` here would nuke that flushed membership row too,
    # which previously forced share_redeem.upgrade to defensively
    # re-insert the membership on the conflict path. With the nested
    # rollback that's no longer necessary.
    try:
        async with db.begin_nested():
            db.add(mount)
            await db.flush()
    except IntegrityError as err:
        existing_after_race = (
            await db.execute(
                select(ScopeMount).where(
                    ScopeMount.parent_scope_id == parent_id,
                    ScopeMount.source_scope_id == source_id,
                )
            )
        ).scalar_one_or_none()
        if existing_after_race is not None:
            return existing_after_race
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "error": "alias_collision_exhausted",
                "message": "Alias became taken between check and insert; retry.",
                "attempted_aliases": [chosen],
            },
        ) from err
    return mount


async def _resolve_default_alias(db: AsyncSession, source_id: UUID) -> tuple[str, Scope, User]:
    """Compute the natural-form alias `@<owner-handle>/<source-slug>`."""
    src = (await db.execute(select(Scope).where(Scope.id == source_id))).scalar_one()
    owner = (await db.execute(select(User).where(User.id == src.user_id))).scalar_one()
    return f"@{safe_owner_handle(owner)}/{src.slug}", src, owner


@router.get("/{parent_scope_id}/mounts", response_model=list[MountResponse])
async def list_mounts(
    parent_scope_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> list[MountResponse]:
    """List mounts on a parent scope (owner only)."""
    await validate_scope_for_caller(db, auth, parent_scope_id)
    rows = (
        (
            await db.execute(
                select(ScopeMount)
                .where(ScopeMount.parent_scope_id == parent_scope_id)
                .order_by(ScopeMount.created_at.asc())
            )
        )
        .scalars()
        .all()
    )
    return [await _build_mount_response(db, m) for m in rows]


@router.post("/{parent_scope_id}/mounts", response_model=MountResponse)
async def create_mount(
    parent_scope_id: UUID,
    body: MountCreate,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> MountResponse:
    """Mount a source scope into a parent the caller owns.

    Auth: caller owns parent AND has viewer-or-owner membership in
    source. The capability re-check uses scope_ids_visible_to(auth)
    so the membership graph stays authoritative.
    """
    await validate_scope_for_caller(db, auth, parent_scope_id)
    try:
        source_id = UUID(body.source_scope_id)
    except (ValueError, AttributeError) as err:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            {"error": "invalid_source_scope_id", "message": "Not a UUID."},
        ) from err

    if source_id == parent_scope_id:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            {
                "error": "self_mount",
                "message": "Cannot mount a scope into itself.",
            },
        )

    visible = await scope_ids_visible_to(db, auth)
    if source_id not in visible:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            {
                "error": "source_not_visible",
                "message": (
                    "You must hold membership in the source scope before "
                    "mounting it. Accept the invitation or share link first."
                ),
            },
        )

    if body.mode != "live":
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            {
                "error": "unsupported_mode",
                "message": "Only 'live' mode is supported in this release.",
            },
        )

    await assert_no_vault_conflicts(
        db,
        parent_scope_id=parent_scope_id,
        source_scope_id=source_id,
        allow=body.allow_vault_conflicts,
    )

    # Pre-resolve the source + owner so the response can be built
    # from in-memory data; avoids a post-commit re-query that has
    # tripped greenlet boundaries in similar routes elsewhere.
    src_for_alias, src, owner = await _resolve_default_alias(db, source_id)
    base_alias = body.alias if body.alias else src_for_alias

    mount = await ensure_mount(
        db,
        parent_id=parent_scope_id,
        source_id=source_id,
        base_alias=base_alias,
        created_by=auth.user_id,
        mode=body.mode,
    )
    await db.commit()

    logger.info(
        "scope_mount_created parent=%s source=%s alias=%s by=%s",
        parent_scope_id,
        source_id,
        mount.alias,
        auth.user_id,
    )
    return await _build_mount_response(db, mount, src=src, owner=owner)


@router.delete("/{parent_scope_id}/mounts/{mount_id}")
async def delete_mount(
    parent_scope_id: UUID,
    mount_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    """Drop a mount edge. Does NOT touch the underlying membership;
    sharee can `POST /api/scopes/{source}/leave` to drop membership."""
    await validate_scope_for_caller(db, auth, parent_scope_id)
    row = (
        await db.execute(
            select(ScopeMount).where(
                ScopeMount.id == mount_id,
                ScopeMount.parent_scope_id == parent_scope_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "mount not found")
    await db.delete(row)
    await db.commit()
    logger.info(
        "scope_mount_deleted id=%s parent=%s by=%s",
        mount_id,
        parent_scope_id,
        auth.user_id,
    )
    return {"status": "unmounted"}
