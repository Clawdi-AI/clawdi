"""Public share-token endpoints + sign-in upgrade."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from threading import Lock
from uuid import UUID

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
from app.models.project import Project
from app.models.project_membership import ProjectMembership
from app.models.project_share_link import ProjectShareLink
from app.models.skill import Skill
from app.models.user import User
from app.models.vault import Vault, VaultItem
from app.schemas.sharing import ShareRedeemResponse, UpgradeBody
from app.services.agent_bindings import (
    assert_project_visible_to_user,
    assert_project_writable_by_user,
    ensure_context_binding,
    get_owned_agent_or_404,
    set_primary_binding,
)
from app.services.sharing import safe_owner_display

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
    db: AsyncSession, link: ProjectShareLink
) -> tuple[str, str, User, Project]:
    project_result = await db.execute(select(Project).where(Project.id == link.project_id))
    project = project_result.scalar_one_or_none()
    if project is None:
        raise HTTPException(
            status.HTTP_410_GONE,
            "share no longer available (project removed)",
        )
    owner_result = await db.execute(select(User).where(User.id == project.user_id))
    owner = owner_result.scalar_one_or_none()
    if owner is None:
        raise HTTPException(
            status.HTTP_410_GONE,
            "share no longer available (owner account removed)",
        )
    return safe_owner_display(owner), link.resolved_owner_handle, owner, project


async def _build_redeem_payload(ctx: ShareTokenContext, db: AsyncSession) -> ShareRedeemResponse:
    link = (
        await db.execute(select(ProjectShareLink).where(ProjectShareLink.id == ctx.link_id))
    ).scalar_one()
    display, handle, _owner, project = await _resolve_owner_for_link(db, link)

    skill_count = (
        await db.execute(
            select(func.count(Skill.id)).where(
                Skill.project_id == ctx.project_id,
                Skill.is_active.is_(True),
            )
        )
    ).scalar_one() or 0
    vault_count = (
        await db.execute(
            select(func.count(VaultItem.id))
            .join(Vault, Vault.id == VaultItem.vault_id)
            .where(Vault.project_id == ctx.project_id)
        )
    ).scalar_one() or 0

    return ShareRedeemResponse(
        project_id=str(project.id),
        project_name=project.name,
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
    return await _build_redeem_payload(ctx, db)


@router.post("/{token}/redeem", response_model=ShareRedeemResponse)
async def redeem(
    request: Request,
    ctx: ShareTokenContext = Depends(require_share_token),
    db: AsyncSession = Depends(get_session),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> ShareRedeemResponse:
    if _idempotency_seen(ctx, idempotency_key):
        return await _build_redeem_payload(ctx, db)
    _check_redeem_rate_limit(request, ctx)
    await db.execute(
        update(ProjectShareLink)
        .where(ProjectShareLink.id == ctx.link_id)
        .values(
            redeem_count=ProjectShareLink.redeem_count + 1,
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
    body = body or UpgradeBody()
    project = (
        await db.execute(select(Project).where(Project.id == ctx.project_id).with_for_update())
    ).scalar_one_or_none()
    if project is None:
        raise HTTPException(status.HTTP_410_GONE, "project no longer available")
    if project.user_id == auth.user_id:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"error": "already_owner"},
        )

    link = (
        await db.execute(select(ProjectShareLink).where(ProjectShareLink.id == ctx.link_id))
    ).scalar_one()
    if link.revoked_at is not None:
        raise HTTPException(status.HTTP_410_GONE, "share link has been revoked")
    if link.expires_at is not None and link.expires_at < datetime.now(UTC):
        raise HTTPException(status.HTTP_410_GONE, "share link has expired")

    existing = (
        await db.execute(
            select(ProjectMembership).where(
                ProjectMembership.project_id == ctx.project_id,
                ProjectMembership.member_user_id == auth.user_id,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        membership = existing
    else:
        membership = ProjectMembership(
            project_id=ctx.project_id,
            member_user_id=auth.user_id,
            role="viewer",
            joined_via="link",
            joined_at=datetime.now(UTC),
            resolved_owner_handle=link.resolved_owner_handle,
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
            if body.bind_as == "primary":
                await assert_project_writable_by_user(
                    db,
                    user_id=auth.user_id,
                    project_id=ctx.project_id,
                )
                await set_primary_binding(
                    db,
                    agent_id=agent_id,
                    project_id=ctx.project_id,
                    created_by_user_id=auth.user_id,
                )
            else:
                await assert_project_visible_to_user(
                    db,
                    user_id=auth.user_id,
                    project_id=ctx.project_id,
                )
                await ensure_context_binding(
                    db,
                    agent_id=agent_id,
                    project_id=ctx.project_id,
                    created_by_user_id=auth.user_id,
                )
            bound_agent_ids.append(str(agent_id))

    await db.commit()
    logger.info(
        "share_upgraded link_id=%s user_id=%s project_id=%s bound_agents=%s",
        ctx.link_id,
        auth.user_id,
        ctx.project_id,
        bound_agent_ids,
    )
    return {
        "membership_id": str(membership.id),
        "project_id": str(membership.project_id),
        "role": membership.role,
        "joined_via": membership.joined_via,
        "joined_at": membership.joined_at.isoformat(),
        "resolved_owner_handle": membership.resolved_owner_handle,
        "bound_agent_ids": bound_agent_ids,
    }
