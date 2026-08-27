from __future__ import annotations

import uuid
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, Path, Query, UploadFile, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_scope
from app.core.database import get_session
from app.models.session import (
    Session,
    SessionEventAppendReceipt,
    SessionEventChunk,
    SessionEventGeneration,
)
from app.schemas.session_events import (
    SessionEvent,
    SessionEventAppendResponse,
    SessionEventChunkResponse,
    SessionEventCommitRequest,
    SessionEventGenerationCreate,
    SessionEventGenerationResponse,
    SessionEventHeadResponse,
    SessionEventsResponse,
    SessionUploadCapabilitiesResponse,
)
from app.services.file_store import get_file_store
from app.services.session_events import (
    EMPTY_EVENT_HEAD,
    SessionEventChunkInvalid,
    validate_event_chunk_async,
)

router = APIRouter(tags=["session-events"])
file_store = get_file_store()

_LOCAL_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._\-]{0,199}$"
_EVENT_CHUNK_TARGET_BYTES = 2 * 1024 * 1024
_EVENT_CHUNK_MAX_BYTES = 8 * 1024 * 1024


def _current_head(session: Session) -> str:
    return session.event_head_hash or EMPTY_EVENT_HEAD


def _head_response(session: Session) -> SessionEventHeadResponse:
    return SessionEventHeadResponse(
        protocol=session.content_protocol,
        generation=session.event_generation_id,
        revision=session.event_revision,
        count=session.event_count,
        head_hash=_current_head(session),
    )


async def _owned_session_by_local(
    db: AsyncSession,
    auth: AuthContext,
    local_session_id: str,
    environment_id: UUID,
    *,
    for_update: bool = False,
) -> Session:
    stmt = select(Session).where(
        Session.user_id == auth.user_id,
        Session.local_session_id == local_session_id,
        Session.origin_environment_id == environment_id,
    )
    if auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None:
        if auth.api_key.environment_id != environment_id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "api key bound to another environment")
    if for_update:
        stmt = stmt.with_for_update()
    session = (await db.execute(stmt)).scalar_one_or_none()
    if session is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    return session


async def _read_upload(file: UploadFile) -> bytes:
    data = await file.read(_EVENT_CHUNK_MAX_BYTES + 1)
    if len(data) > _EVENT_CHUNK_MAX_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Event chunk exceeds 8 MiB")
    return data


def _cas_matches(
    session: Session,
    *,
    generation: UUID | None,
    revision: int,
    count: int,
    head_hash: str,
) -> bool:
    return (
        session.event_generation_id == generation
        and session.event_revision == revision
        and session.event_count == count
        and _current_head(session) == head_hash
    )


def _cas_conflict() -> HTTPException:
    return HTTPException(
        status.HTTP_409_CONFLICT,
        detail={"code": "session_event_base_mismatch", "message": "Event head advanced"},
    )


@router.get("/sessions/upload-capabilities")
async def session_upload_capabilities(
    _auth: AuthContext = Depends(require_scope("sessions:write")),
) -> SessionUploadCapabilitiesResponse:
    return SessionUploadCapabilitiesResponse(
        protocols=["snapshot-v1", "events-v1"],
        event_chunk_target_bytes=_EVENT_CHUNK_TARGET_BYTES,
        event_chunk_max_bytes=_EVENT_CHUNK_MAX_BYTES,
    )


@router.get("/sessions/{local_session_id}/events/head")
async def get_session_event_head(
    local_session_id: str = Path(..., pattern=_LOCAL_ID_PATTERN),
    environment_id: UUID = Query(...),
    auth: AuthContext = Depends(require_scope("sessions:write")),
    db: AsyncSession = Depends(get_session),
) -> SessionEventHeadResponse:
    session = await _owned_session_by_local(db, auth, local_session_id, environment_id)
    return _head_response(session)


@router.post("/sessions/{local_session_id}/events/generations")
async def stage_session_event_generation(
    body: SessionEventGenerationCreate,
    local_session_id: str = Path(..., pattern=_LOCAL_ID_PATTERN),
    auth: AuthContext = Depends(require_scope("sessions:write")),
    db: AsyncSession = Depends(get_session),
) -> SessionEventGenerationResponse:
    session = await _owned_session_by_local(
        db, auth, local_session_id, body.environment_id, for_update=True
    )
    existing = await db.get(SessionEventGeneration, body.generation)
    if existing is not None:
        if (
            existing.session_id != session.id
            or existing.append_id != body.append_id
            or existing.base_generation_id != body.base_generation
            or existing.base_revision != body.base_revision
            or existing.base_count != body.base_count
            or existing.base_head_hash != body.base_head_hash
            or existing.final_count != body.final_count
            or existing.final_head_hash != body.final_head_hash
        ):
            raise HTTPException(status.HTTP_409_CONFLICT, "Generation identity conflict")
        return SessionEventGenerationResponse(generation=existing.id, status=existing.status)
    if not _cas_matches(
        session,
        generation=body.base_generation,
        revision=body.base_revision,
        count=body.base_count,
        head_hash=body.base_head_hash,
    ):
        raise _cas_conflict()
    existing_append = (
        await db.execute(
            select(SessionEventGeneration).where(
                SessionEventGeneration.session_id == session.id,
                SessionEventGeneration.append_id == body.append_id,
            )
        )
    ).scalar_one_or_none()
    if existing_append is not None:
        if (
            existing_append.id != body.generation
            or existing_append.base_generation_id != body.base_generation
            or existing_append.base_revision != body.base_revision
            or existing_append.base_count != body.base_count
            or existing_append.base_head_hash != body.base_head_hash
            or existing_append.final_count != body.final_count
            or existing_append.final_head_hash != body.final_head_hash
        ):
            raise HTTPException(status.HTTP_409_CONFLICT, "append_id identity conflict")
        return SessionEventGenerationResponse(
            generation=existing_append.id, status=existing_append.status
        )
    generation = SessionEventGeneration(
        id=body.generation,
        session_id=session.id,
        append_id=body.append_id,
        status="staging",
        base_generation_id=body.base_generation,
        base_revision=body.base_revision,
        base_count=body.base_count,
        base_head_hash=body.base_head_hash,
        final_count=body.final_count,
        final_head_hash=body.final_head_hash,
    )
    db.add(generation)
    await db.commit()
    return SessionEventGenerationResponse(generation=generation.id, status="staging")


@router.put("/sessions/{local_session_id}/events/generations/{generation_id}/chunks/{start_seq}")
async def upload_session_event_generation_chunk(
    local_session_id: str = Path(..., pattern=_LOCAL_ID_PATTERN),
    generation_id: UUID = Path(...),
    start_seq: int = Path(..., ge=0),
    base_head_hash: str = Form(..., pattern=r"^[0-9a-f]{64}$"),
    content_hash: str = Form(..., pattern=r"^[0-9a-f]{64}$"),
    file: UploadFile = File(...),
    auth: AuthContext = Depends(require_scope("sessions:write")),
    db: AsyncSession = Depends(get_session),
) -> SessionEventChunkResponse:
    data = await _read_upload(file)
    try:
        validated = await validate_event_chunk_async(
            data, start_seq=start_seq, base_head_hash=base_head_hash
        )
    except SessionEventChunkInvalid as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    if validated.content_hash != content_hash:
        raise HTTPException(status.HTTP_409_CONFLICT, "Event chunk content hash mismatch")
    generation = (
        await db.execute(
            select(SessionEventGeneration)
            .where(SessionEventGeneration.id == generation_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if generation is None or generation.status != "staging":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Staging generation not found")
    session = await db.get(Session, generation.session_id)
    if (
        session is None
        or session.user_id != auth.user_id
        or session.local_session_id != local_session_id
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Staging generation not found")
    if (
        auth.is_cli
        and auth.api_key is not None
        and auth.api_key.environment_id is not None
        and session.origin_environment_id != auth.api_key.environment_id
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Staging generation not found")
    existing = (
        await db.execute(
            select(SessionEventChunk).where(
                SessionEventChunk.generation_id == generation_id,
                SessionEventChunk.start_seq == start_seq,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        if (
            existing.content_hash != content_hash
            or existing.base_head_hash != base_head_hash
            or existing.result_head_hash != validated.result_head_hash
        ):
            raise HTTPException(status.HTTP_409_CONFLICT, "Event chunk identity conflict")
        return SessionEventChunkResponse(
            generation=generation_id,
            start_seq=existing.start_seq,
            end_seq=existing.end_seq,
            count=existing.event_count,
            content_hash=existing.content_hash,
            result_head_hash=existing.result_head_hash,
        )
    end_seq = start_seq + len(validated.events) - 1
    key = (
        f"session-events/v1/{auth.user_id}/{session.id}/{generation_id}/chunks/"
        f"{start_seq}-{end_seq}-{content_hash}.ndjson"
    )
    await file_store.put(key, data, "application/x-ndjson")
    db.add(
        SessionEventChunk(
            id=uuid.uuid4(),
            session_id=session.id,
            generation_id=generation_id,
            start_seq=start_seq,
            end_seq=end_seq,
            event_count=len(validated.events),
            base_head_hash=base_head_hash,
            result_head_hash=validated.result_head_hash,
            content_hash=content_hash,
            file_key=key,
        )
    )
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Event chunk identity conflict") from exc
    return SessionEventChunkResponse(
        generation=generation_id,
        start_seq=start_seq,
        end_seq=end_seq,
        count=len(validated.events),
        content_hash=content_hash,
        result_head_hash=validated.result_head_hash,
    )


@router.post("/sessions/{local_session_id}/events/generations/{generation_id}/commit")
async def commit_session_event_generation(
    body: SessionEventCommitRequest,
    local_session_id: str = Path(..., pattern=_LOCAL_ID_PATTERN),
    generation_id: UUID = Path(...),
    auth: AuthContext = Depends(require_scope("sessions:write")),
    db: AsyncSession = Depends(get_session),
) -> SessionEventAppendResponse:
    generation = (
        await db.execute(
            select(SessionEventGeneration)
            .where(SessionEventGeneration.id == generation_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if generation is None or generation.append_id != body.append_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Staging generation not found")
    session = (
        await db.execute(
            select(Session)
            .where(
                Session.id == generation.session_id,
                Session.user_id == auth.user_id,
                Session.local_session_id == local_session_id,
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if session is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    if (
        auth.is_cli
        and auth.api_key is not None
        and auth.api_key.environment_id is not None
        and session.origin_environment_id != auth.api_key.environment_id
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    if (
        generation.base_generation_id != body.base_generation
        or generation.base_revision != body.base_revision
        or generation.base_count != body.base_count
        or generation.base_head_hash != body.base_head_hash
        or generation.final_count != body.final_count
        or generation.final_head_hash != body.final_head_hash
    ):
        raise HTTPException(status.HTTP_409_CONFLICT, "Generation commit identity conflict")
    if generation.status == "committed":
        if not _cas_matches(
            session,
            generation=generation_id,
            revision=generation.base_revision + 1,
            count=generation.final_count,
            head_hash=generation.final_head_hash,
        ):
            raise _cas_conflict()
        return SessionEventAppendResponse(
            generation=generation_id,
            revision=generation.base_revision + 1,
            count=generation.final_count,
            head_hash=generation.final_head_hash,
        )
    if not _cas_matches(
        session,
        generation=body.base_generation,
        revision=body.base_revision,
        count=body.base_count,
        head_hash=body.base_head_hash,
    ):
        raise _cas_conflict()
    chunks = list(
        (
            await db.execute(
                select(SessionEventChunk)
                .where(SessionEventChunk.generation_id == generation_id)
                .order_by(SessionEventChunk.start_seq)
            )
        ).scalars()
    )
    next_seq = 0
    head = EMPTY_EVENT_HEAD
    for chunk in chunks:
        if chunk.start_seq != next_seq or chunk.base_head_hash != head:
            raise HTTPException(status.HTTP_409_CONFLICT, "Staging generation has a gap")
        next_seq = chunk.end_seq + 1
        head = chunk.result_head_hash
    if next_seq != body.final_count or head != body.final_head_hash:
        raise HTTPException(status.HTTP_409_CONFLICT, "Staging generation final head mismatch")
    committed_at = datetime.now(UTC)
    previous_generation_id = session.event_generation_id
    if previous_generation_id is not None and previous_generation_id != generation_id:
        previous_generation = await db.get(SessionEventGeneration, previous_generation_id)
        if previous_generation is not None and previous_generation.superseded_at is None:
            previous_generation.superseded_at = committed_at
    session.content_protocol = "events-v1"
    session.content_hash = body.final_head_hash
    session.content_uploaded_at = committed_at
    session.event_generation_id = generation_id
    session.event_revision += 1
    session.event_count = body.final_count
    session.event_head_hash = body.final_head_hash
    generation.status = "committed"
    await db.commit()
    return SessionEventAppendResponse(
        generation=generation_id,
        revision=session.event_revision,
        count=session.event_count,
        head_hash=_current_head(session),
    )


@router.post("/sessions/{local_session_id}/events/append")
async def append_session_events(
    local_session_id: str = Path(..., pattern=_LOCAL_ID_PATTERN),
    environment_id: UUID = Form(...),
    append_id: UUID = Form(...),
    generation: UUID = Form(...),
    base_revision: int = Form(..., ge=0),
    base_count: int = Form(..., ge=0),
    base_head_hash: str = Form(..., pattern=r"^[0-9a-f]{64}$"),
    final_count: int = Form(..., ge=1),
    final_head_hash: str = Form(..., pattern=r"^[0-9a-f]{64}$"),
    content_hash: str = Form(..., pattern=r"^[0-9a-f]{64}$"),
    file: UploadFile = File(...),
    auth: AuthContext = Depends(require_scope("sessions:write")),
    db: AsyncSession = Depends(get_session),
) -> SessionEventAppendResponse:
    data = await _read_upload(file)
    try:
        validated = await validate_event_chunk_async(
            data, start_seq=base_count, base_head_hash=base_head_hash
        )
    except SessionEventChunkInvalid as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    if (
        validated.content_hash != content_hash
        or validated.result_head_hash != final_head_hash
        or base_count + len(validated.events) != final_count
    ):
        raise HTTPException(status.HTTP_409_CONFLICT, "Event append final hash mismatch")
    session = await _owned_session_by_local(
        db, auth, local_session_id, environment_id, for_update=True
    )
    receipt = (
        await db.execute(
            select(SessionEventAppendReceipt).where(
                SessionEventAppendReceipt.session_id == session.id,
                SessionEventAppendReceipt.append_id == append_id,
            )
        )
    ).scalar_one_or_none()
    if receipt is not None:
        if (
            receipt.generation_id != generation
            or receipt.base_revision != base_revision
            or receipt.base_count != base_count
            or receipt.base_head_hash != base_head_hash
            or receipt.content_hash != content_hash
            or receipt.result_count != final_count
            or receipt.result_head_hash != final_head_hash
        ):
            raise HTTPException(status.HTTP_409_CONFLICT, "append_id identity conflict")
        if not _cas_matches(
            session,
            generation=generation,
            revision=receipt.result_revision,
            count=receipt.result_count,
            head_hash=receipt.result_head_hash,
        ):
            raise _cas_conflict()
        return SessionEventAppendResponse(
            generation=generation,
            revision=receipt.result_revision,
            count=receipt.result_count,
            head_hash=receipt.result_head_hash,
        )
    if (
        session.event_generation_id == generation
        and session.event_count == final_count
        and _current_head(session) == final_head_hash
    ):
        return SessionEventAppendResponse(
            generation=generation,
            revision=session.event_revision,
            count=session.event_count,
            head_hash=_current_head(session),
        )
    if not _cas_matches(
        session,
        generation=generation,
        revision=base_revision,
        count=base_count,
        head_hash=base_head_hash,
    ):
        raise _cas_conflict()
    committed_generation = await db.get(SessionEventGeneration, generation)
    if committed_generation is None or committed_generation.status != "committed":
        raise HTTPException(status.HTTP_409_CONFLICT, "Event generation is not committed")
    end_seq = final_count - 1
    key = (
        f"session-events/v1/{auth.user_id}/{session.id}/{generation}/chunks/"
        f"{base_count}-{end_seq}-{content_hash}.ndjson"
    )
    await file_store.put(key, data, "application/x-ndjson")
    result_revision = session.event_revision + 1
    db.add(
        SessionEventChunk(
            id=uuid.uuid4(),
            session_id=session.id,
            generation_id=generation,
            start_seq=base_count,
            end_seq=end_seq,
            event_count=len(validated.events),
            base_head_hash=base_head_hash,
            result_head_hash=final_head_hash,
            content_hash=content_hash,
            file_key=key,
        )
    )
    db.add(
        SessionEventAppendReceipt(
            id=uuid.uuid4(),
            session_id=session.id,
            append_id=append_id,
            generation_id=generation,
            base_revision=base_revision,
            base_count=base_count,
            base_head_hash=base_head_hash,
            content_hash=content_hash,
            result_revision=result_revision,
            result_count=final_count,
            result_head_hash=final_head_hash,
        )
    )
    session.event_revision = result_revision
    session.event_count = final_count
    session.event_head_hash = final_head_hash
    session.content_hash = final_head_hash
    session.content_uploaded_at = datetime.now(UTC)
    await db.commit()
    return SessionEventAppendResponse(
        generation=generation,
        revision=result_revision,
        count=final_count,
        head_hash=final_head_hash,
    )


@router.get("/sessions/{session_id}/events")
async def get_session_events(
    session_id: UUID,
    auth: AuthContext = Depends(require_scope("sessions:read")),
    db: AsyncSession = Depends(get_session),
) -> SessionEventsResponse:
    stmt = select(Session).where(Session.id == session_id, Session.user_id == auth.user_id)
    if auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None:
        stmt = stmt.where(Session.origin_environment_id == auth.api_key.environment_id)
    session = (await db.execute(stmt)).scalar_one_or_none()
    if session is None or session.event_generation_id is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session events not found")
    chunks = list(
        (
            await db.execute(
                select(SessionEventChunk)
                .where(SessionEventChunk.generation_id == session.event_generation_id)
                .order_by(SessionEventChunk.start_seq)
            )
        ).scalars()
    )
    events: list[SessionEvent] = []
    next_seq = 0
    head = EMPTY_EVENT_HEAD
    for chunk in chunks:
        if chunk.start_seq != next_seq or chunk.base_head_hash != head:
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR, "Session event index is invalid"
            )
        data = await file_store.get(chunk.file_key)
        try:
            validated = await validate_event_chunk_async(
                data, start_seq=next_seq, base_head_hash=head
            )
        except SessionEventChunkInvalid as exc:
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR, "Stored session event chunk is invalid"
            ) from exc
        if (
            validated.content_hash != chunk.content_hash
            or validated.result_head_hash != chunk.result_head_hash
        ):
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Session event chunk drift")
        events.extend(validated.events)
        next_seq = chunk.end_seq + 1
        head = chunk.result_head_hash
    if next_seq != session.event_count or head != _current_head(session):
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Session event head is invalid")
    return SessionEventsResponse(
        generation=session.event_generation_id,
        revision=session.event_revision,
        count=session.event_count,
        head_hash=_current_head(session),
        events=events,
    )
