"""Public anonymous share-token endpoints + sign-in upgrade.

`require_share_token` is the sole gate for /preview and /redeem - no
user identity. /upgrade is the sign-in path: it takes a valid Clerk
auth (api_key OR Clerk JWT, both unbound - not env-bound deploy
keys) AND a valid share token, then creates a permanent
ScopeMembership for the requesting user.

Vault item plaintext is NEVER available via this surface - CLI clients
gate vault resolve on Clerk auth.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from threading import Lock

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
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
from app.routes.mounts import ensure_mount, mount_payload
from app.schemas.sharing import ShareRedeemResponse, UpgradeBody
from app.services.sharing import (
    assert_no_vault_conflicts,
    resolve_auto_mount_parent,
    safe_owner_display,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/share", tags=["share-redeem"])

_REDEEM_RATE_WINDOW = timedelta(minutes=1)
_REDEEM_RATE_LIMIT = 30
_REDEEM_RATE_MAX_BUCKETS = 2048
_REDEEM_RATE_PRUNE_INTERVAL = timedelta(minutes=1)
_REDEEM_IDEMPOTENCY_TTL = timedelta(hours=24)
_REDEEM_IDEMPOTENCY_MAX = 2048
_redeem_rate_lock = Lock()
_redeem_rate: dict[str, list[datetime]] = {}
_redeem_rate_last_prune_at: datetime | None = None
_redeem_idempotency_seen: dict[str, datetime] = {}


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",", 1)[0].strip() or "unknown"
    return request.client.host if request.client else "unknown"


def _check_redeem_rate_limit(request: Request, ctx: ShareTokenContext) -> None:
    """Bound anonymous redeem attempts per IP + link.

    Preview remains side-effect free. Redeem is a mutable anonymous
    endpoint, so valid-token holders get a small per-minute budget
    instead of unbounded counter writes and COUNT queries.

    This is a process-local defense layer for app correctness and
    accidental floods. Production deployments should still enforce
    edge/gateway rate limits so the budget is global across workers
    and pods.
    """
    now = datetime.now(UTC)
    cutoff = now - _REDEEM_RATE_WINDOW
    bucket = f"{_client_ip(request)}:{ctx.link_id}"
    global _redeem_rate_last_prune_at
    with _redeem_rate_lock:
        should_prune = (
            _redeem_rate_last_prune_at is None
            or now - _redeem_rate_last_prune_at >= _REDEEM_RATE_PRUNE_INTERVAL
        )
        if should_prune:
            for existing_bucket, existing_timestamps in list(_redeem_rate.items()):
                fresh = [ts for ts in existing_timestamps if ts >= cutoff]
                if fresh:
                    _redeem_rate[existing_bucket] = fresh
                else:
                    _redeem_rate.pop(existing_bucket, None)
            _redeem_rate_last_prune_at = now

        timestamps = [ts for ts in _redeem_rate.get(bucket, []) if ts >= cutoff]
        if len(timestamps) >= _REDEEM_RATE_LIMIT:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "share redeem rate limit exceeded",
                headers={"Retry-After": str(int(_REDEEM_RATE_WINDOW.total_seconds()))},
            )
        if bucket not in _redeem_rate and len(_redeem_rate) >= _REDEEM_RATE_MAX_BUCKETS:
            oldest = min(
                _redeem_rate,
                key=lambda key: (
                    max(_redeem_rate[key])
                    if _redeem_rate[key]
                    else datetime.min.replace(tzinfo=UTC)
                ),
            )
            _redeem_rate.pop(oldest, None)
        timestamps.append(now)
        _redeem_rate[bucket] = timestamps


def _idempotency_seen(ctx: ShareTokenContext, idempotency_key: str | None) -> bool:
    if idempotency_key is None:
        return False
    if len(idempotency_key) > 200:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Idempotency-Key too long")

    now = datetime.now(UTC)
    cutoff = now - _REDEEM_IDEMPOTENCY_TTL
    cache_key = f"{ctx.link_id}:{idempotency_key}"
    with _redeem_rate_lock:
        stale = [key for key, ts in _redeem_idempotency_seen.items() if ts < cutoff]
        for key in stale:
            _redeem_idempotency_seen.pop(key, None)
        if cache_key in _redeem_idempotency_seen:
            _redeem_idempotency_seen[cache_key] = now
            return True
    return False


def _remember_idempotency(ctx: ShareTokenContext, idempotency_key: str | None) -> None:
    if idempotency_key is None:
        return
    now = datetime.now(UTC)
    cache_key = f"{ctx.link_id}:{idempotency_key}"
    with _redeem_rate_lock:
        if len(_redeem_idempotency_seen) >= _REDEEM_IDEMPOTENCY_MAX:
            oldest = min(_redeem_idempotency_seen, key=_redeem_idempotency_seen.__getitem__)
            _redeem_idempotency_seen.pop(oldest, None)
        _redeem_idempotency_seen[cache_key] = now


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
    return safe_owner_display(owner), link.resolved_owner_handle, owner, scope


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
    request: Request,
    ctx: ShareTokenContext = Depends(require_share_token),
    db: AsyncSession = Depends(get_session),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> ShareRedeemResponse:
    """Anonymous accept - bumps redeem_count + stamps last_redeemed_at.

    Call on explicit user action only (CLI `inbox accept <url>` from
    a logged-out terminal). The web landing page uses /preview for
    page render and /upgrade for the logged-in accept path; only
    the CLI's anonymous flow hits /redeem.
    """
    if _idempotency_seen(ctx, idempotency_key):
        return await _build_redeem_payload(ctx, db)
    _check_redeem_rate_limit(request, ctx)
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
    _remember_idempotency(ctx, idempotency_key)
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
    scope = (
        await db.execute(select(Scope).where(Scope.id == ctx.scope_id).with_for_update())
    ).scalar_one_or_none()
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
    # Defense-in-depth after the source Scope row lock above: the auth
    # dependency validates token state before route entry, and this
    # re-check catches a revoke/expire that wins the race before we
    # create durable membership.
    if link.revoked_at is not None:
        raise HTTPException(status.HTTP_410_GONE, "share link has been revoked")
    if link.expires_at is not None and link.expires_at < datetime.now(UTC):
        raise HTTPException(status.HTTP_410_GONE, "share link has expired")

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
    mount_fields: dict = {}
    if body.no_mount:
        await db.commit()
    else:
        parent_id = await resolve_auto_mount_parent(
            db,
            auth.user_id,
            body.parent_scope_id,
            membership.id,
        )
        await assert_no_vault_conflicts(
            db,
            parent_scope_id=parent_id,
            source_scope_id=ctx.scope_id,
            allow=body.allow_vault_conflicts,
        )
        # We have a target; build the mount. ensure_mount uses a
        # SAVEPOINT internally so a race-window IntegrityError doesn't
        # roll back our already-flushed membership row.
        base_alias = body.alias or f"@{link.resolved_owner_handle}/{scope.slug}"
        mount = await ensure_mount(
            db,
            parent_id=parent_id,
            source_id=ctx.scope_id,
            base_alias=base_alias,
            created_by=auth.user_id,
        )
        await db.commit()
        mount_fields = mount_payload(mount)

    logger.info(
        "share_link.upgraded",
        extra={
            "scope_id": str(ctx.scope_id),
            "link_id": str(ctx.link_id),
            "user_id": str(auth.user_id),
            "mount_target": mount_fields.get("mount_parent_scope_id"),
        },
    )
    return {
        "scope_id": str(membership.scope_id),
        "resolved_owner_handle": membership.resolved_owner_handle,
        "membership_id": str(membership.id),
        **mount_fields,
    }
