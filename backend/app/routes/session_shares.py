from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_web_auth
from app.core.database import get_session
from app.models.session import AgentEnvironment, Session
from app.models.session_share import SessionShare
from app.schemas.session import (
    PublicSessionShareExportResponse,
    PublicSessionShareResponse,
    SessionMessageResponse,
    SessionMessagesPage,
    SessionShareCreate,
    SessionShareResponse,
    SessionSharesResponse,
)
from app.services.file_store import get_file_store
from app.services.session_content import (
    SessionContentInvalid,
    SessionContentMissing,
    SessionContentUnavailable,
    session_has_uploaded_content,
    slice_session_items,
)
from app.services.session_export import session_share_to_markdown
from app.services.session_shares import (
    SessionShareConflict,
    SessionShareView,
    create_session_share,
    load_session_share_view,
    session_share_metadata,
    session_share_url,
)

router = APIRouter(tags=["session-shares"])
file_store = get_file_store()
NO_STORE = "no-store"
NO_STORE_HEADERS = {"Cache-Control": NO_STORE}


async def _owned_session(
    db: AsyncSession,
    auth: AuthContext,
    session_id: UUID,
) -> tuple[Session, str | None]:
    row = (
        await db.execute(
            select(Session, AgentEnvironment.agent_type)
            .outerjoin(AgentEnvironment, Session.environment_id == AgentEnvironment.id)
            .where(Session.id == session_id, Session.user_id == auth.user_id)
        )
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    session, agent_type = row
    return session, agent_type


def _share_response(share: SessionShare) -> SessionShareResponse:
    _, _, _, _, message_count = session_share_metadata(share)
    return SessionShareResponse(
        id=str(share.id),
        session_id=str(share.session_id),
        scope=share.scope,
        start_position=share.start_position,
        end_position=share.end_position,
        message_count=message_count,
        share_url=session_share_url(share.id),
        created_at=share.created_at,
    )


@router.get("/sessions/{session_id}/shares")
async def list_session_shares(
    session_id: UUID,
    auth: AuthContext = Depends(require_web_auth),
    db: AsyncSession = Depends(get_session),
) -> SessionSharesResponse:
    await _owned_session(db, auth, session_id)
    shares = list(
        (
            await db.execute(
                select(SessionShare)
                .where(
                    SessionShare.session_id == session_id,
                    SessionShare.revoked_at.is_(None),
                )
                .order_by(SessionShare.created_at.desc(), SessionShare.id.desc())
            )
        ).scalars()
    )
    return SessionSharesResponse(shares=[_share_response(share) for share in shares])


@router.post("/sessions/{session_id}/shares", status_code=status.HTTP_201_CREATED)
async def create_share(
    body: SessionShareCreate,
    session_id: UUID,
    auth: AuthContext = Depends(require_web_auth),
    db: AsyncSession = Depends(get_session),
) -> SessionShareResponse:
    session, agent_type = await _owned_session(db, auth, session_id)
    if not session_has_uploaded_content(session):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session content not uploaded")
    try:
        share = await create_session_share(
            db,
            file_store,
            session,
            created_by=auth.user_id,
            agent_type=agent_type,
            scope=body.scope,
            position=body.position,
        )
    except SessionShareConflict as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from None
    except SessionContentMissing:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session content not found") from None
    except SessionContentUnavailable:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Session storage is temporarily unavailable. Please retry.",
        ) from None
    except SessionContentInvalid:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "Internal server error"
        ) from None
    return _share_response(share)


@router.delete("/session-shares/{share_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_share(
    share_id: UUID,
    auth: AuthContext = Depends(require_web_auth),
    db: AsyncSession = Depends(get_session),
) -> None:
    share = (
        await db.execute(
            select(SessionShare)
            .join(Session, Session.id == SessionShare.session_id)
            .where(SessionShare.id == share_id, Session.user_id == auth.user_id)
            .with_for_update(of=SessionShare)
        )
    ).scalar_one_or_none()
    if share is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session share not found")
    if share.revoked_at is None:
        share.revoked_at = datetime.now(UTC)
        await db.commit()


async def _public_share(db: AsyncSession, share_id: UUID) -> SessionShare:
    share = (
        await db.execute(select(SessionShare).where(SessionShare.id == share_id))
    ).scalar_one_or_none()
    if share is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "Session share not found",
            headers=NO_STORE_HEADERS,
        )
    if share.revoked_at is not None:
        raise HTTPException(
            status.HTTP_410_GONE,
            "Session share has been revoked",
            headers=NO_STORE_HEADERS,
        )
    return share


async def _public_share_view(
    db: AsyncSession,
    share: SessionShare,
) -> SessionShareView:
    try:
        return await load_session_share_view(db, file_store, share)
    except SessionContentMissing:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "Session share content not found",
            headers=NO_STORE_HEADERS,
        ) from None
    except SessionContentUnavailable:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Session storage is temporarily unavailable. Please retry.",
            headers=NO_STORE_HEADERS,
        ) from None
    except SessionContentInvalid:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "Internal server error",
            headers=NO_STORE_HEADERS,
        ) from None


def _public_response(share: SessionShare) -> PublicSessionShareResponse:
    title, agent_type, model, started_at, message_count = session_share_metadata(share)
    return PublicSessionShareResponse(
        id=str(share.id),
        title=title,
        agent_type=agent_type,
        model=model,
        started_at=started_at,
        created_at=share.created_at,
        message_count=message_count,
        scope=share.scope,
    )


@router.get("/public/session-shares/{share_id}")
async def get_public_share(
    response: Response,
    share_id: UUID = Path(...),
    db: AsyncSession = Depends(get_session),
) -> PublicSessionShareResponse:
    response.headers["Cache-Control"] = NO_STORE
    return _public_response(await _public_share(db, share_id))


@router.get("/public/session-shares/{share_id}/messages")
async def get_public_share_messages(
    response: Response,
    share_id: UUID = Path(...),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    db: AsyncSession = Depends(get_session),
) -> SessionMessagesPage:
    response.headers["Cache-Control"] = NO_STORE
    share = await _public_share(db, share_id)
    view = await _public_share_view(db, share)
    items = slice_session_items(view.messages, offset=offset, limit=limit, direction="asc")
    return SessionMessagesPage(
        items=[SessionMessageResponse.model_validate(item) for item in items],
        total=len(view.messages),
        offset=offset,
        limit=limit,
    )


@router.get("/public/session-shares/{share_id}/export.md")
async def export_public_share_markdown(
    share_id: UUID = Path(...),
    db: AsyncSession = Depends(get_session),
) -> Response:
    share = await _public_share(db, share_id)
    view = await _public_share_view(db, share)
    title, agent_type, model, started_at, message_count = session_share_metadata(share)
    return Response(
        content=session_share_to_markdown(
            share_id=share.id,
            title=title,
            agent_type=agent_type,
            model=model,
            started_at=started_at.isoformat(),
            message_count=message_count,
            messages=view.messages,
        ),
        media_type="text/markdown; charset=utf-8",
        headers={"Cache-Control": NO_STORE},
    )


@router.get(
    "/public/session-shares/{share_id}/export.json",
    response_model=PublicSessionShareExportResponse,
)
async def export_public_share_json(
    response: Response,
    share_id: UUID = Path(...),
    db: AsyncSession = Depends(get_session),
) -> PublicSessionShareExportResponse:
    response.headers["Cache-Control"] = NO_STORE
    share = await _public_share(db, share_id)
    view = await _public_share_view(db, share)
    detail = _public_response(share)
    return PublicSessionShareExportResponse(
        **detail.model_dump(),
        messages=[SessionMessageResponse.model_validate(item) for item in view.messages],
        share_url=session_share_url(share.id),
    )
