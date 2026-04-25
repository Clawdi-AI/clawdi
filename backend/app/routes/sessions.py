import json
import logging
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, Path, Query, UploadFile, status
from sqlalchemy import func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
from app.core.query_utils import like_needle
from app.models.session import AgentEnvironment, Session
from app.schemas.common import Paginated
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
log = logging.getLogger(__name__)

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


@router.get("/api/environments/{environment_id}")
async def get_environment(
    environment_id: UUID,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> EnvironmentResponse:
    result = await db.execute(
        select(AgentEnvironment).where(
            AgentEnvironment.id == environment_id,
            AgentEnvironment.user_id == auth.user_id,
        )
    )
    env = result.scalar_one_or_none()
    if not env:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent not found")
    return EnvironmentResponse(
        id=str(env.id),
        machine_name=env.machine_name,
        agent_type=env.agent_type,
        agent_version=env.agent_version,
        os=env.os,
        last_seen_at=env.last_seen_at,
    )


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

    # Reject any environment_id the caller doesn't own. Without this check the
    # CLI's local cache (a stale env id from a previous account / a deleted
    # env) lands in the DB and turns up as "Unknown" agent in the dashboard
    # because the outerjoin in list_sessions returns nulls. Refuse the whole
    # batch — partial accept would silently drop the user's sessions and
    # they'd never know.
    requested_env_ids = {s.environment_id for s in body.sessions}
    valid_env_ids = set(
        (
            await db.execute(
                select(AgentEnvironment.id).where(
                    AgentEnvironment.id.in_(requested_env_ids),
                    AgentEnvironment.user_id == auth.user_id,
                )
            )
        )
        .scalars()
        .all()
    )
    missing = requested_env_ids - valid_env_ids
    if missing:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "unknown_environment",
                "message": (
                    "Environment id is no longer registered for this account. "
                    "Run `clawdi setup` to re-register this machine, then retry."
                ),
                "environment_ids": [str(e) for e in missing],
            },
        )

    rows = [
        {
            "user_id": auth.user_id,
            "environment_id": s.environment_id,
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


# Allow-list of columns the client can sort by. Hard-coded to avoid SQL
# injection and so we can promise a stable order for pagination.
# Note: `tokens` is a synthetic key — the UI shows total tokens (in + out) so
# sort by the sum expression, not just one column.
_SESSION_SORT_COLUMNS = {
    "started_at": Session.started_at,
    "message_count": Session.message_count,
    "tokens": Session.input_tokens + Session.output_tokens,
}


@router.get("/api/sessions")
async def list_sessions(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
    q: str | None = Query(default=None, description="Fuzzy search on summary/project/id"),
    agent: str | None = Query(default=None, description="Filter by agent_type"),
    environment_id: UUID | None = Query(default=None, description="Filter by agent environment"),
    sort: str = Query(default="started_at", pattern=r"^(started_at|message_count|tokens)$"),
    order: str = Query(default="desc", pattern=r"^(asc|desc)$"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=200),
    since: datetime | None = Query(default=None),
) -> Paginated[SessionListItemResponse]:
    base = (
        select(Session, AgentEnvironment.agent_type, AgentEnvironment.machine_name)
        .outerjoin(AgentEnvironment, Session.environment_id == AgentEnvironment.id)
        .where(Session.user_id == auth.user_id)
    )
    if since:
        base = base.where(Session.started_at >= since)
    if agent:
        base = base.where(AgentEnvironment.agent_type == agent)
    if environment_id:
        base = base.where(Session.environment_id == environment_id)
    if q:
        # ILIKE on three columns — kept simple; pg_trgm GIN index on these
        # columns is on the to-do list for when session volume grows.
        needle = like_needle(q)
        base = base.where(
            or_(
                Session.summary.ilike(needle, escape="\\"),
                Session.project_path.ilike(needle, escape="\\"),
                Session.local_session_id.ilike(needle, escape="\\"),
            )
        )

    sort_col = _SESSION_SORT_COLUMNS[sort]
    base = base.order_by(sort_col.asc() if order == "asc" else sort_col.desc())

    total = (await db.execute(select(func.count()).select_from(base.subquery()))).scalar_one()

    rows = (await db.execute(base.limit(page_size).offset((page - 1) * page_size))).all()

    return Paginated[SessionListItemResponse](
        items=[_session_to_response(s, at, mn) for s, at, mn in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/api/sessions/{session_id}")
async def get_session_detail(
    session_id: UUID,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> SessionDetailResponse:
    result = await db.execute(
        select(Session, AgentEnvironment.agent_type, AgentEnvironment.machine_name)
        .outerjoin(AgentEnvironment, Session.environment_id == AgentEnvironment.id)
        .where(
            Session.user_id == auth.user_id,
            Session.id == session_id,
        )
    )
    row = result.first()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")

    session, agent_type, machine_name = row
    return SessionDetailResponse(
        **_session_to_response(session, agent_type, machine_name).model_dump(),
        has_content=bool(session.file_key),
    )


@router.post("/api/sessions/{local_session_id}/upload")
async def upload_session_content(
    # Constrained to safe filename chars so it cannot escape the
    # `sessions/{user_id}/` prefix in the file-store key below.
    local_session_id: str = Path(..., pattern=r"^[A-Za-z0-9][A-Za-z0-9._\-]{0,199}$"),
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

    # Session content was written by the CLI; if it's not valid JSON or not
    # the expected shape, something went wrong on upload — surface a generic
    # server error to the client and log the detail server-side so we don't
    # leak stored-data shape assumptions.
    try:
        raw = json.loads(data)
    except json.JSONDecodeError:
        log.exception("session %s content is not valid JSON", session_id)
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Internal server error")

    if not isinstance(raw, list):
        log.error("session %s content is not a JSON array (got %s)", session_id, type(raw).__name__)
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Internal server error")

    return [SessionMessageResponse.model_validate(m) for m in raw]


def _session_to_response(
    s: Session,
    agent_type: str | None = None,
    machine_name: str | None = None,
) -> SessionListItemResponse:
    return SessionListItemResponse(
        id=str(s.id),
        local_session_id=s.local_session_id,
        project_path=s.project_path,
        agent_type=agent_type,
        machine_name=machine_name,
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
