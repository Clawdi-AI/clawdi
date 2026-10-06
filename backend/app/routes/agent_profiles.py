from datetime import UTC, datetime, timedelta
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path
from sqlalchemy import CursorResult, delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_any_scope
from app.core.database import get_session
from app.models.session import AgentEnvironment, AgentProfile, Session, SessionSyncSuppression
from app.schemas.agent_profile import (
    AgentProfileResponse,
    AttributeSessionsRequest,
    ProfileInventoryRequest,
    ProfileRenameRequest,
    ProfileSessionMoveResponse,
)
from app.services.connected_agent_fence import (
    ConnectedAgentFenceHeaders,
    connected_agent_fence_headers,
    require_connected_agent_fence,
)

router = APIRouter(tags=["profiles"])
_KEY_PATTERN = r"^[a-z0-9][a-z0-9_-]{0,63}$"


async def _agent(
    db: AsyncSession, auth: AuthContext, agent_id: UUID, *, lock: bool = False
) -> AgentEnvironment:
    if auth.api_key is not None and auth.api_key.environment_id is not None:
        if auth.api_key.environment_id != agent_id:
            raise HTTPException(403, "api key bound to another environment")
    stmt = select(AgentEnvironment).where(
        AgentEnvironment.id == agent_id,
        AgentEnvironment.user_id == auth.user_id,
        AgentEnvironment.archived_at.is_(None),
    )
    if lock:
        stmt = stmt.with_for_update()
    agent = (await db.execute(stmt)).scalar_one_or_none()
    if agent is None:
        raise HTTPException(404, "Agent not found")
    return agent


async def _write_agent(
    db: AsyncSession, auth: AuthContext, agent_id: UUID, headers: ConnectedAgentFenceHeaders
) -> AgentEnvironment:
    agent = await _agent(db, auth, agent_id, lock=True)
    await require_connected_agent_fence(
        db, auth=auth, agent_ids={agent_id}, headers=headers, lock=True
    )
    return agent


async def _responses(db: AsyncSession, agent: AgentEnvironment) -> list[AgentProfileResponse]:
    counts = (
        select(Session.origin_profile_key, func.count().label("count"))
        .where(
            Session.user_id == agent.user_id,
            Session.origin_environment_id == agent.id,
        )
        .group_by(Session.origin_profile_key)
        .subquery()
    )
    rows = (
        await db.execute(
            select(AgentProfile, func.coalesce(counts.c.count, 0))
            .outerjoin(
                counts,
                counts.c.origin_profile_key == AgentProfile.profile_key,
            )
            .where(AgentProfile.environment_id == agent.id)
            .order_by(
                AgentProfile.is_default.desc(),
                AgentProfile.profile_key,
            )
        )
    ).all()
    online = agent.last_sync_at is not None and agent.last_sync_at > datetime.now(UTC) - timedelta(
        seconds=90
    )
    return [
        AgentProfileResponse(
            id=p.id,
            profile_key=p.profile_key,
            upstream_key=p.upstream_key,
            is_default=p.is_default,
            display_name=p.display_name,
            state=p.state,
            online=online and p.state == "active",
            first_seen_at=p.first_seen_at,
            last_seen_at=p.last_seen_at,
            removed_at=p.removed_at,
            session_count=count,
        )
        for p, count in rows
    ]


@router.get("/agents/{agent_id}/profiles")
async def list_agent_profiles(
    agent_id: UUID,
    auth: AuthContext = Depends(
        require_any_scope("sessions:read", "sessions:write", "skills:read", "skills:write")
    ),
    db: AsyncSession = Depends(get_session),
) -> list[AgentProfileResponse]:
    return await _responses(db, await _agent(db, auth, agent_id))


@router.put("/agents/{agent_id}/profiles")
async def put_agent_profiles(
    agent_id: UUID,
    body: ProfileInventoryRequest,
    auth: AuthContext = Depends(require_any_scope("sessions:write", "skills:write")),
    headers: ConnectedAgentFenceHeaders = Depends(connected_agent_fence_headers),
    db: AsyncSession = Depends(get_session),
) -> list[AgentProfileResponse]:
    agent = await _write_agent(db, auth, agent_id, headers)
    known = {
        p.profile_key: p
        for p in (
            await db.execute(
                select(AgentProfile).where(
                    AgentProfile.environment_id == agent_id,
                )
            )
        ).scalars()
    }
    now = datetime.now(UTC)
    present: set[str] = set()
    for item in body.profiles:
        key = "" if item.is_default else item.upstream_key
        present.add(key)
        p = known.get(key)
        if p is None:
            p = AgentProfile(
                environment_id=agent_id,
                profile_key=key,
                upstream_key=item.upstream_key,
                is_default=item.is_default,
            )
            db.add(p)
        p.upstream_key = item.upstream_key
        p.state = "active"
        p.last_seen_at = now
        p.removed_at = None
    if body.complete:
        for key, p in known.items():
            if key not in present and p.state != "removed":
                p.state = "removed"
                p.removed_at = now
    await db.commit()
    return await _responses(db, agent)


async def _move(
    db: AsyncSession,
    auth: AuthContext,
    agent_id: UUID,
    old: str,
    new: str,
    ids: list[str] | None = None,
) -> ProfileSessionMoveResponse:
    moved: list[int] = []
    try:
        for model in (Session, SessionSyncSuppression):
            stmt = update(model).where(
                model.user_id == auth.user_id,
                model.origin_environment_id == agent_id,
                model.origin_profile_key == old,
            )
            if ids is not None:
                stmt = stmt.where(model.local_session_id.in_(ids))
            result = await db.execute(stmt.values(origin_profile_key=new))
            if not isinstance(result, CursorResult):
                raise RuntimeError("Profile move did not return an update result")
            moved.append(result.rowcount)
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            409,
            detail={
                "code": "profile_conflict",
                "message": "Destination profile already contains a session being moved.",
            },
        ) from exc
    return ProfileSessionMoveResponse(sessions_moved=moved[0], suppressions_moved=moved[1])


@router.post("/agents/{agent_id}/profiles/{profile_key}/attribute-sessions")
async def attribute_sessions(
    agent_id: UUID,
    body: AttributeSessionsRequest,
    profile_key: str = Path(pattern=_KEY_PATTERN),
    auth: AuthContext = Depends(require_any_scope("sessions:write", "skills:write")),
    headers: ConnectedAgentFenceHeaders = Depends(connected_agent_fence_headers),
    db: AsyncSession = Depends(get_session),
) -> ProfileSessionMoveResponse:
    agent = await _write_agent(db, auth, agent_id, headers)
    if agent.agent_type != "openclaw":
        raise HTTPException(400, "Session attribution is only supported for OpenClaw")
    target = (
        await db.execute(
            select(AgentProfile).where(
                AgentProfile.environment_id == agent_id,
                AgentProfile.profile_key == profile_key,
            )
        )
    ).scalar_one_or_none()
    if target is None or target.state != "active":
        raise HTTPException(404, "Active profile not found")
    result = await _move(db, auth, agent_id, "", profile_key, body.local_session_ids)
    await db.commit()
    return result


@router.post("/agents/{agent_id}/profiles/{profile_key}/rename")
async def rename_profile(
    agent_id: UUID,
    body: ProfileRenameRequest,
    profile_key: str = Path(pattern=_KEY_PATTERN),
    auth: AuthContext = Depends(require_any_scope("sessions:write", "skills:write")),
    headers: ConnectedAgentFenceHeaders = Depends(connected_agent_fence_headers),
    db: AsyncSession = Depends(get_session),
) -> ProfileSessionMoveResponse:
    agent = await _write_agent(db, auth, agent_id, headers)
    if agent.agent_type != "hermes":
        raise HTTPException(400, "Profile rename is only supported for Hermes")
    new = body.new_upstream_key
    profiles = {
        p.profile_key: p
        for p in (
            await db.execute(
                select(AgentProfile).where(
                    AgentProfile.environment_id == agent_id,
                )
            )
        ).scalars()
    }
    source = profiles.get(profile_key)
    if source is None:
        # A retried rename after successful commit is a metadata no-op.
        if new in profiles:
            return ProfileSessionMoveResponse(sessions_moved=0, suppressions_moved=0)
        raise HTTPException(404, "Profile not found")
    if source.is_default or new == "default":
        raise HTTPException(400, "The default profile cannot be renamed")
    if new == profile_key:
        return ProfileSessionMoveResponse(sessions_moved=0, suppressions_moved=0)
    target = profiles.get(new)
    if target is not None:
        for model in (Session, SessionSyncSuppression):
            occupied = (
                await db.execute(
                    select(model.id)
                    .where(
                        model.user_id == auth.user_id,
                        model.origin_environment_id == agent_id,
                        model.origin_profile_key == new,
                    )
                    .limit(1)
                )
            ).first()
            if occupied:
                raise HTTPException(
                    409,
                    detail={
                        "code": "profile_conflict",
                        "message": "The destination profile is already in use.",
                    },
                )
        await db.execute(delete(AgentProfile).where(AgentProfile.id == target.id))
        await db.flush()
    result = await _move(db, auth, agent_id, profile_key, new)
    source.profile_key = new
    source.upstream_key = new
    source.state = "active"
    source.removed_at = None
    source.last_seen_at = datetime.now(UTC)
    await db.commit()
    return result
