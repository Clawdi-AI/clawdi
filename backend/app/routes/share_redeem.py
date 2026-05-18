"""Public share-token endpoints + sign-in upgrade."""

from __future__ import annotations

import logging
from collections import deque
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import (
    AuthContext,
    ShareTokenContext,
    require_share_token,
    require_user_auth_unbound,
)
from app.core.config import settings
from app.core.database import get_session
from app.models.project import Project
from app.models.project_share_link import ProjectShareLink
from app.models.share_redeem_attempt import ShareRedeemAttempt
from app.models.skill import Skill
from app.models.user import User
from app.models.vault import Vault, VaultItem
from app.schemas.sharing import ShareRedeemResponse, ShareUpgradeResponse, UpgradeBody
from app.services.agent_bindings import attach_project_to_owned_agents
from app.services.sharing import ensure_viewer_membership, safe_owner_display

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/share", tags=["share-redeem"])

_REDEEM_RATE_WINDOW = timedelta(minutes=1)
_REDEEM_RATE_LIMIT = 30
_REDEEM_IDEMPOTENCY_TTL = timedelta(hours=24)
_PREVIEW_RATE_WINDOW = timedelta(minutes=1)
_PREVIEW_RATE_LIMIT = 120
_PREVIEW_RATE_BUCKETS: dict[str, deque[datetime]] = {}


def _client_ip(request: Request) -> str:
    if settings.trust_forwarded_for:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",", 1)[0].strip() or "unknown"
        cf_connecting_ip = request.headers.get("cf-connecting-ip")
        if cf_connecting_ip:
            return cf_connecting_ip.strip() or "unknown"
    return request.client.host if request.client else "unknown"


def _register_preview_attempt(request: Request) -> None:
    """Throttle preview probes before token validation.

    Redeem attempts are persisted per valid link. Preview also needs a cheap
    guard for invalid-token scans, where no link_id exists yet.
    """
    now = datetime.now(UTC)
    cutoff = now - _PREVIEW_RATE_WINDOW
    client_key = _client_ip(request)[:128]
    bucket = _PREVIEW_RATE_BUCKETS.setdefault(client_key, deque())
    while bucket and bucket[0] < cutoff:
        bucket.popleft()
    if len(bucket) >= _PREVIEW_RATE_LIMIT:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "share preview rate limit exceeded",
            headers={"Retry-After": str(int(_PREVIEW_RATE_WINDOW.total_seconds()))},
        )
    bucket.append(now)
    if len(_PREVIEW_RATE_BUCKETS) > 4096:
        for key, attempts in list(_PREVIEW_RATE_BUCKETS.items()):
            while attempts and attempts[0] < cutoff:
                attempts.popleft()
            if not attempts:
                _PREVIEW_RATE_BUCKETS.pop(key, None)


async def _register_redeem_attempt(
    db: AsyncSession,
    request: Request,
    ctx: ShareTokenContext,
    idempotency_key: str | None,
) -> bool:
    """Record a redeem attempt.

    Returns False when the same Idempotency-Key was already processed. The
    caller should return the normal payload without bumping redeem_count.
    """
    if idempotency_key is not None and len(idempotency_key) > 200:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Idempotency-Key too long")

    now = datetime.now(UTC)
    idempotency_cutoff = now - _REDEEM_IDEMPOTENCY_TTL
    rate_cutoff = now - _REDEEM_RATE_WINDOW
    client_key = _client_ip(request)[:128]

    link = (
        await db.execute(
            select(ProjectShareLink).where(ProjectShareLink.id == ctx.link_id).with_for_update()
        )
    ).scalar_one_or_none()
    if link is None:
        raise HTTPException(status.HTTP_410_GONE, "share link no longer exists")
    if link.revoked_at is not None:
        raise HTTPException(status.HTTP_410_GONE, "share link has been revoked")
    if link.expires_at is not None and link.expires_at < now:
        raise HTTPException(status.HTTP_410_GONE, "share link has expired")

    await db.execute(
        delete(ShareRedeemAttempt).where(ShareRedeemAttempt.created_at < idempotency_cutoff)
    )

    if idempotency_key is not None:
        existing = (
            await db.execute(
                select(ShareRedeemAttempt.id).where(
                    ShareRedeemAttempt.link_id == ctx.link_id,
                    ShareRedeemAttempt.idempotency_key == idempotency_key,
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            return False

    db.add(
        ShareRedeemAttempt(
            link_id=ctx.link_id,
            client_key=client_key,
            idempotency_key=idempotency_key,
        )
    )
    await db.flush()

    recent_count = (
        await db.execute(
            select(func.count(ShareRedeemAttempt.id)).where(
                ShareRedeemAttempt.link_id == ctx.link_id,
                ShareRedeemAttempt.client_key == client_key,
                ShareRedeemAttempt.created_at >= rate_cutoff,
            )
        )
    ).scalar_one()
    if recent_count > _REDEEM_RATE_LIMIT:
        await db.commit()
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "share redeem rate limit exceeded",
            headers={"Retry-After": str(int(_REDEEM_RATE_WINDOW.total_seconds()))},
        )

    return True


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
    token: str,
    request: Request,
    db: AsyncSession = Depends(get_session),
) -> ShareRedeemResponse:
    _register_preview_attempt(request)
    ctx = await require_share_token(token=token, db=db)
    return await _build_redeem_payload(ctx, db)


@router.post("/{token}/redeem", response_model=ShareRedeemResponse)
async def redeem(
    request: Request,
    ctx: ShareTokenContext = Depends(require_share_token),
    db: AsyncSession = Depends(get_session),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> ShareRedeemResponse:
    should_count = await _register_redeem_attempt(db, request, ctx, idempotency_key)
    if not should_count:
        return await _build_redeem_payload(ctx, db)
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
    return payload


@router.post("/{token}/upgrade", response_model=ShareUpgradeResponse)
async def upgrade(
    body: UpgradeBody | None = None,
    ctx: ShareTokenContext = Depends(require_share_token),
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> dict:
    return await upgrade_share_token(ctx=ctx, body=body, auth=auth, db=db)


async def upgrade_share_token(
    *,
    ctx: ShareTokenContext,
    body: UpgradeBody | None,
    auth: AuthContext,
    db: AsyncSession,
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

    membership = await ensure_viewer_membership(
        db,
        project_id=ctx.project_id,
        member_user_id=auth.user_id,
        joined_via="link",
        resolved_owner_handle=link.resolved_owner_handle,
    )

    bound_agent_ids = await attach_project_to_owned_agents(
        db,
        user_id=auth.user_id,
        project_id=ctx.project_id,
        raw_agent_ids=body.agent_ids,
    )

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
