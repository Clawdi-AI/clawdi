import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
from app.models.session import AgentEnvironment, Session
from app.schemas.session import EnvironmentCreate, SessionBatchRequest

router = APIRouter(tags=["sessions"])


@router.post("/api/environments")
async def register_environment(
    body: EnvironmentCreate,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
):
    # Check if environment already exists for this user + machine
    result = await db.execute(
        select(AgentEnvironment).where(
            AgentEnvironment.user_id == auth.user_id,
            AgentEnvironment.machine_id == body.machine_id,
            AgentEnvironment.agent_type == body.agent_type,
        )
    )
    env = result.scalar_one_or_none()

    if env:
        env.machine_name = body.machine_name
        env.agent_version = body.agent_version
        env.last_seen_at = datetime.now(timezone.utc)
        await db.commit()
        return {"id": str(env.id)}

    env = AgentEnvironment(
        user_id=auth.user_id,
        machine_id=body.machine_id,
        machine_name=body.machine_name,
        agent_type=body.agent_type,
        agent_version=body.agent_version,
        os=body.os,
        last_seen_at=datetime.now(timezone.utc),
    )
    db.add(env)
    await db.commit()
    await db.refresh(env)
    return {"id": str(env.id)}


@router.get("/api/environments")
async def list_environments(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
):
    result = await db.execute(
        select(AgentEnvironment)
        .where(AgentEnvironment.user_id == auth.user_id)
        .order_by(AgentEnvironment.last_seen_at.desc())
    )
    envs = result.scalars().all()
    return [
        {
            "id": str(e.id),
            "machine_name": e.machine_name,
            "agent_type": e.agent_type,
            "agent_version": e.agent_version,
            "os": e.os,
            "last_seen_at": e.last_seen_at.isoformat() if e.last_seen_at else None,
        }
        for e in envs
    ]


@router.post("/api/sessions/batch")
async def batch_create_sessions(
    body: SessionBatchRequest,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
):
    synced = 0
    for s in body.sessions:
        # Skip duplicates by local_session_id
        result = await db.execute(
            select(Session).where(
                Session.user_id == auth.user_id,
                Session.local_session_id == s.local_session_id,
            )
        )
        if result.scalar_one_or_none():
            continue

        session = Session(
            user_id=auth.user_id,
            environment_id=uuid.UUID(s.environment_id),
            local_session_id=s.local_session_id,
            project_path=s.project_path,
            started_at=s.started_at,
            ended_at=s.ended_at,
            duration_seconds=s.duration_seconds,
            message_count=s.message_count,
            input_tokens=s.input_tokens,
            output_tokens=s.output_tokens,
            cache_read_tokens=s.cache_read_tokens,
            model=s.model,
            models_used=s.models_used,
            summary=s.summary,
            tags=s.tags,
            status=s.status,
        )
        db.add(session)
        synced += 1

    await db.commit()
    return {"synced": synced}


@router.get("/api/sessions")
async def list_sessions(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
    limit: int = Query(default=50, le=200),
    offset: int = Query(default=0),
    since: datetime | None = Query(default=None),
):
    q = select(Session).where(Session.user_id == auth.user_id)
    if since:
        q = q.where(Session.started_at >= since)
    q = q.order_by(Session.started_at.desc()).limit(limit).offset(offset)

    result = await db.execute(q)
    sessions = result.scalars().all()
    return [
        {
            "id": str(s.id),
            "local_session_id": s.local_session_id,
            "project_path": s.project_path,
            "started_at": s.started_at.isoformat(),
            "ended_at": s.ended_at.isoformat() if s.ended_at else None,
            "duration_seconds": s.duration_seconds,
            "message_count": s.message_count,
            "input_tokens": s.input_tokens,
            "output_tokens": s.output_tokens,
            "cache_read_tokens": s.cache_read_tokens,
            "model": s.model,
            "models_used": s.models_used,
            "summary": s.summary,
            "tags": s.tags,
            "status": s.status,
        }
        for s in sessions
    ]
