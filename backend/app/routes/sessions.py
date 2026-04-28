import hashlib
import json
import logging
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, Path, Query, UploadFile, status
from sqlalchemy import case, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth
from app.core.config import settings
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
    SessionExtractResponse,
    SessionListItemResponse,
    SessionMessageResponse,
    SessionUploadResponse,
)
from app.services.file_store import get_file_store
from app.services.memory_extraction import extract_memories_from_session
from app.services.memory_provider import get_memory_provider

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


@router.delete("/api/environments/{environment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_environment(
    environment_id: UUID,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> None:
    """Delete an agent environment. Existing sessions remain (orphaned)
    so users don't lose history when removing a machine. The session
    list query uses an outer-join so orphaned rows still render."""
    result = await db.execute(
        select(AgentEnvironment).where(
            AgentEnvironment.id == environment_id,
            AgentEnvironment.user_id == auth.user_id,
        )
    )
    env = result.scalar_one_or_none()
    if not env:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent not found")
    await db.delete(env)
    await db.commit()


@router.post("/api/sessions/batch")
async def batch_create_sessions(
    body: SessionBatchRequest,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> SessionBatchResponse:
    """Ingest a batch of sessions from a CLI sync.

    Upserts every row by `(user_id, local_session_id)`. The response tells
    the client which sessions still need a content upload — either because
    the stored hash differs from the one just sent, or because no content
    has ever been uploaded for that row (`file_key IS NULL`).
    """
    if not body.sessions:
        return SessionBatchResponse(created=0, updated=0, unchanged=0, needs_content=[])

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

    # Pre-fetch the existing rows for diffing. One indexed lookup against
    # `uq_sessions_user_local` per batch — cheap, and keeps the diff logic
    # in Python where it's testable. Doing the diff via a CTE on the upsert
    # would be slightly faster but much harder to read and harder to keep
    # in lockstep with the SessionBatchResponse contract.
    incoming_ids = [s.local_session_id for s in body.sessions]
    existing_rows = (
        await db.execute(
            select(
                Session.local_session_id,
                Session.content_hash,
                Session.file_key,
            ).where(
                Session.user_id == auth.user_id,
                Session.local_session_id.in_(incoming_ids),
            )
        )
    ).all()
    existing_by_id = {row.local_session_id: row for row in existing_rows}

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
            "content_hash": s.content_hash,
        }
        for s in body.sessions
    ]

    insert_stmt = pg_insert(Session).values(rows)
    # Refresh every metadata field on conflict. Identity (`id`, `user_id`,
    # `local_session_id`, `created_at`) is preserved, and `file_key` /
    # `content_uploaded_at` belong to the upload endpoint — don't clobber.
    upsert_stmt = insert_stmt.on_conflict_do_update(
        constraint="uq_sessions_user_local",
        set_={
            "environment_id": insert_stmt.excluded.environment_id,
            "project_path": insert_stmt.excluded.project_path,
            "started_at": insert_stmt.excluded.started_at,
            "ended_at": insert_stmt.excluded.ended_at,
            "duration_seconds": insert_stmt.excluded.duration_seconds,
            "message_count": insert_stmt.excluded.message_count,
            "input_tokens": insert_stmt.excluded.input_tokens,
            "output_tokens": insert_stmt.excluded.output_tokens,
            "cache_read_tokens": insert_stmt.excluded.cache_read_tokens,
            "model": insert_stmt.excluded.model,
            "models_used": insert_stmt.excluded.models_used,
            "summary": insert_stmt.excluded.summary,
            "tags": insert_stmt.excluded.tags,
            "status": insert_stmt.excluded.status,
            "content_hash": insert_stmt.excluded.content_hash,
            # Only bump `updated_at` when the content actually changed.
            # Without this, a re-push of unchanged sessions (e.g. empty
            # client cache, multi-machine sync, manual cache reset) would
            # touch every row and reshuffle the dashboard's "Last activity"
            # sort to "everything happened just now". `IS DISTINCT FROM` is
            # NULL-safe so legacy rows with content_hash IS NULL also
            # behave correctly: they get a real bump on first proper push.
            "updated_at": case(
                (
                    Session.content_hash.is_distinct_from(insert_stmt.excluded.content_hash),
                    func.now(),
                ),
                else_=Session.updated_at,
            ),
        },
    )
    # Concurrent `DELETE /api/environments/{id}` between the pre-flight
    # SELECT and this UPSERT can still race the FK. PG sqlstate 23503 means
    # FK violation specifically; anything else (we no longer hit unique
    # collisions because of the upsert) bubbles as a plain 500.
    try:
        await db.execute(upsert_stmt)
        await db.commit()
    except IntegrityError as e:
        await db.rollback()
        sqlstate = getattr(e.orig, "sqlstate", None) or getattr(e.orig, "pgcode", None)
        if sqlstate != "23503":
            raise
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "unknown_environment",
                "message": (
                    "Environment was removed mid-upload. "
                    "Run `clawdi setup` to re-register this machine, then retry."
                ),
            },
        ) from e

    # Categorize each row by comparing the pre-fetch snapshot against the
    # incoming payload. The pre-fetch sees the row as it was BEFORE this
    # batch, so we get clean created / updated / unchanged buckets without
    # needing a second round-trip or PG's `xmax` trick.
    created = 0
    updated = 0
    unchanged = 0
    needs_content: list[str] = []
    for s in body.sessions:
        prev = existing_by_id.get(s.local_session_id)
        if prev is None:
            created += 1
            needs_content.append(s.local_session_id)
        elif prev.file_key is None:
            # Row existed but never had content uploaded (e.g. previous
            # upload failed mid-flight). Treat as updated — metadata may
            # have changed too, and definitely needs content.
            updated += 1
            needs_content.append(s.local_session_id)
        elif prev.content_hash is None or prev.content_hash != s.content_hash:
            updated += 1
            needs_content.append(s.local_session_id)
        else:
            unchanged += 1

    return SessionBatchResponse(
        created=created,
        updated=updated,
        unchanged=unchanged,
        needs_content=needs_content,
    )


# Allow-list of columns the client can sort by. Hard-coded to avoid SQL
# injection and so we can promise a stable order for pagination.
# Note: `tokens` is a synthetic key — the UI shows total tokens (in + out) so
# sort by the sum expression, not just one column.
_SESSION_SORT_COLUMNS = {
    # `updated_at` is the default — the upsert path bumps it whenever a
    # session's metadata or content_hash changes, so this orders newest-
    # activity-first across both first-push and append-message flows.
    # Sorting by `started_at` would freeze a session in its original spot
    # forever, even after dozens of new messages.
    "updated_at": Session.updated_at,
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
    sort: str = Query(
        default="updated_at",
        pattern=r"^(updated_at|started_at|message_count|tokens)$",
    ),
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
    # Hash the bytes we're about to store so the row's `content_hash`
    # always describes the actual stored object — not whatever the client
    # claimed in the batch payload. This is what closes the historical
    # DB↔file-store drift: even if a multipart proxy mangles bytes, the
    # hash on disk matches the hash in the row.
    content_hash = hashlib.sha256(data).hexdigest()

    fk = f"sessions/{auth.user_id}/{local_session_id}.json"
    await file_store.put(fk, data)

    session.file_key = fk
    session.content_hash = content_hash
    session.content_uploaded_at = datetime.now(UTC)
    await db.commit()

    return SessionUploadResponse(status="uploaded", file_key=fk, content_hash=content_hash)


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


@router.post("/api/sessions/{local_session_id}/extract")
async def extract_session_memories(
    local_session_id: str = Path(..., pattern=r"^[A-Za-z0-9][A-Za-z0-9._\-]{0,199}$"),
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> SessionExtractResponse:
    """Extract memories from a session's content via the configured LLM.

    Uses `local_session_id` for path lookup (mirrors the upload endpoint
    pattern) — `uq_sessions_user_local` makes that a unique index.

    Not idempotent — every call hits the LLM. Onboarding loops over
    each session exactly once; the future dashboard button is a
    user-initiated single click. Tracking "already extracted" state
    on the server would force us to also reason about session updates
    (re-pushed content with new turns), which is more complexity than
    a one-shot $0.001 LLM call is worth.
    """
    if not settings.llm_api_key:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "LLM is not configured on this deployment",
        )

    session = (
        await db.execute(
            select(Session).where(
                Session.user_id == auth.user_id,
                Session.local_session_id == local_session_id,
            )
        )
    ).scalar_one_or_none()
    if not session:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    if not session.file_key:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Session content has not been uploaded",
        )

    try:
        data = await file_store.get(session.file_key)
    except Exception:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session content file not found")

    try:
        messages = json.loads(data)
    except json.JSONDecodeError:
        log.exception("session %s content is not valid JSON", session.id)
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Internal server error")
    if not isinstance(messages, list):
        log.error(
            "session %s content is not a JSON array (got %s)",
            session.id,
            type(messages).__name__,
        )
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Internal server error")

    # Local import keeps the openai SDK off the cold-start critical path
    # for routes that don't need it.
    from openai import AsyncOpenAI

    client = AsyncOpenAI(
        base_url=settings.llm_base_url or None,
        api_key=settings.llm_api_key,
    )
    extracted = await extract_memories_from_session(
        messages,
        project_path=session.project_path,
        client=client,
        model=settings.llm_model,
    )

    provider = await get_memory_provider(str(auth.user_id), db)
    for m in extracted:
        await provider.add(
            user_id=str(auth.user_id),
            content=m.content,
            category=m.category,
            source="session",
            tags=m.tags or None,
            source_session_id=session.id,
        )

    return SessionExtractResponse(memories_created=len(extracted))


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
        updated_at=s.updated_at,
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
        content_hash=s.content_hash,
    )
