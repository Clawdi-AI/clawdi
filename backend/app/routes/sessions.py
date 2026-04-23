import uuid
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
from app.models.session import AgentEnvironment, Session
from app.schemas.session import (
    EnvironmentCreate,
    EnvironmentCreatedResponse,
    EnvironmentResponse,
    SessionBatchRequest,
    SessionBatchResponse,
    SessionDetailResponse,
    SessionListItemResponse,
    SessionMessageResponse,
    SessionUploadResponse,
)
from app.services.file_store import get_file_store

router = APIRouter(tags=["sessions"])

file_store = get_file_store()


@router.post("/api/environments")
async def register_environment(
    body: EnvironmentCreate,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> EnvironmentCreatedResponse:
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
        env.last_seen_at = datetime.now(UTC)
        await db.commit()
        return EnvironmentCreatedResponse(id=str(env.id))

    env = AgentEnvironment(
        user_id=auth.user_id,
        machine_id=body.machine_id,
        machine_name=body.machine_name,
        agent_type=body.agent_type,
        agent_version=body.agent_version,
        os=body.os,
        last_seen_at=datetime.now(UTC),
    )
    db.add(env)
    await db.commit()
    await db.refresh(env)
    return EnvironmentCreatedResponse(id=str(env.id))


@router.get("/api/environments")
async def list_environments(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> list[EnvironmentResponse]:
    result = await db.execute(
        select(AgentEnvironment)
        .where(AgentEnvironment.user_id == auth.user_id)
        .order_by(AgentEnvironment.last_seen_at.desc())
    )
    envs = result.scalars().all()
    return [
        EnvironmentResponse(
            id=str(e.id),
            machine_name=e.machine_name,
            agent_type=e.agent_type,
            agent_version=e.agent_version,
            os=e.os,
            last_seen_at=e.last_seen_at,
        )
        for e in envs
    ]


@router.post("/api/sessions/batch")
async def batch_create_sessions(
    body: SessionBatchRequest,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> SessionBatchResponse:
    """Ingest a batch of sessions from a CLI sync.

    Relies on the `uq_sessions_user_local` unique constraint plus Postgres
    `ON CONFLICT DO NOTHING` for idempotency — safe under concurrent
    invocations and a single round-trip to the DB regardless of batch size.
    """
    if not body.sessions:
        return SessionBatchResponse(synced=0)

    rows = [
        {
            "user_id": auth.user_id,
            "environment_id": uuid.UUID(s.environment_id),
            "local_session_id": s.local_session_id,
            "project_path": s.project_path,
            "started_at": s.started_at,
            "ended_at": s.ended_at,
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
        for s in body.sessions
    ]

    stmt = (
        pg_insert(Session)
        .values(rows)
        .on_conflict_do_nothing(constraint="uq_sessions_user_local")
        .returning(Session.id)
    )
    result = await db.execute(stmt)
    inserted = result.scalars().all()
    await db.commit()
    return SessionBatchResponse(synced=len(inserted))


@router.get("/api/sessions")
async def list_sessions(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
    limit: int = Query(default=50, le=200),
    offset: int = Query(default=0),
    since: datetime | None = Query(default=None),
) -> list[SessionListItemResponse]:
    q = (
        select(Session, AgentEnvironment.agent_type)
        .outerjoin(AgentEnvironment, Session.environment_id == AgentEnvironment.id)
        .where(Session.user_id == auth.user_id)
    )
    if since:
        q = q.where(Session.started_at >= since)
    q = q.order_by(Session.started_at.desc()).limit(limit).offset(offset)

    result = await db.execute(q)
    return [_session_to_response(s, agent_type) for s, agent_type in result.all()]


@router.get("/api/sessions/{session_id}")
async def get_session_detail(
    session_id: UUID,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> SessionDetailResponse:
    result = await db.execute(
        select(Session, AgentEnvironment.agent_type)
        .outerjoin(AgentEnvironment, Session.environment_id == AgentEnvironment.id)
        .where(
            Session.user_id == auth.user_id,
            Session.id == session_id,
        )
    )
    row = result.first()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")

    session, agent_type = row
    return SessionDetailResponse(
        **_session_to_response(session, agent_type).model_dump(),
        has_content=bool(session.file_key),
    )


@router.post("/api/sessions/{local_session_id}/upload")
async def upload_session_content(
    local_session_id: str,
    file: UploadFile = File(...),
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> SessionUploadResponse:
    """Upload session messages JSON to FileStore."""
    result = await db.execute(
        select(Session).where(
            Session.user_id == auth.user_id,
            Session.local_session_id == local_session_id,
        )
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")

    data = await file.read()
    fk = f"sessions/{auth.user_id}/{local_session_id}.json"
    await file_store.put(fk, data)

    session.file_key = fk
    await db.commit()

    return SessionUploadResponse(status="uploaded", file_key=fk)


@router.get("/api/sessions/{session_id}/content")
async def get_session_content(
    session_id: UUID,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> list[SessionMessageResponse]:
    """Read session messages from FileStore, typed as SessionMessageResponse[]."""
    import json

    result = await db.execute(
        select(Session).where(
            Session.user_id == auth.user_id,
            Session.id == session_id,
        )
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")

    if not session.file_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session content not uploaded")

    try:
        data = await file_store.get(session.file_key)
    except Exception:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session content file not found")

    try:
        raw = json.loads(data)
    except json.JSONDecodeError:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Malformed session content")

    if not isinstance(raw, list):
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Session content must be a list")

    return [SessionMessageResponse.model_validate(m) for m in raw]


def _session_to_response(s: Session, agent_type: str | None = None) -> SessionListItemResponse:
    return SessionListItemResponse(
        id=str(s.id),
        local_session_id=s.local_session_id,
        project_path=s.project_path,
        agent_type=agent_type,
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
