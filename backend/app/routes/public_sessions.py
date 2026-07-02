"""Public routes for reading shared sessions.

Canonical URL: `/v1/public/sessions/{session_id}` (UUID-keyed). Same
model as Google Drive's `drive.google.com/file/d/{file_id}/view` and
Notion's `notion.so/{page_id}` — the resource ID *is* the URL. Always
exists once the session exists; access is checked at request time
against an optional Clerk JWT and the session's permission rows.

Access policy:
  - Session owner (Clerk JWT matches `session.user_id`) → render.
  - Active `kind='link'` permission → render to anyone (including anon).
  - Authed visitor with matching `kind='user'` permission → render.
  - Anon + no link permission → 401 (SSR shows sign-in CTA).
  - Authed but no matching grant → 403.
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, optional_web_auth
from app.core.database import get_session
from app.models.session import AgentEnvironment, Session
from app.models.session_permission import (
    PERMISSION_KIND_LINK,
    PERMISSION_KIND_USER,
    SessionPermission,
)
from app.models.user import User
from app.schemas.session import (
    PublicSessionExportResponse,
    PublicSessionResponse,
    SessionMessageResponse,
    SessionMessagesPage,
)
from app.services.file_store import get_file_store
from app.services.session_content import (
    SessionContentInvalid,
    SessionContentMissing,
    load_session_messages,
)
from app.services.session_export import (
    public_session_base_fields,
    session_to_json,
    session_to_markdown,
)

router = APIRouter(tags=["public-sessions"])
log = logging.getLogger(__name__)

file_store = get_file_store()


async def _resolve_session_for_view(
    db: AsyncSession, session_id: UUID, visitor: AuthContext | None
) -> tuple[Session, str | None, User | None]:
    """Look up the session by UUID and authorize the visitor.

    Returns `(session, agent_type, owner)`. `owner` is the session's
    owner `User` row (surfacing display name + avatar to the share
    page); None if the owner row was deleted under the session somehow
    (FK is `ON DELETE CASCADE` so this is mostly a paranoid fallback).

    Raises:
      - 404 if the session id has no corresponding row.
      - 401 if anon and no `kind='link'` grant exists (SSR shows
        sign-in CTA).
      - 403 if authed but no matching grant exists.
    """
    stmt = (
        select(Session, AgentEnvironment.agent_type, User)
        .outerjoin(AgentEnvironment, Session.environment_id == AgentEnvironment.id)
        .outerjoin(User, Session.user_id == User.id)
        .where(Session.id == session_id)
    )
    row = (await db.execute(stmt)).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    session, agent_type, owner = row

    visitor_id = visitor.user_id if visitor is not None else None
    if visitor_id is not None and visitor_id == session.user_id:
        return session, agent_type, owner

    permissions = (
        (
            await db.execute(
                select(SessionPermission).where(
                    SessionPermission.session_id == session.id,
                    SessionPermission.revoked_at.is_(None),
                )
            )
        )
        .scalars()
        .all()
    )

    if any(p.kind == PERMISSION_KIND_LINK for p in permissions):
        return session, agent_type, owner
    if visitor_id is not None and any(
        p.kind == PERMISSION_KIND_USER and p.user_id == visitor_id for p in permissions
    ):
        return session, agent_type, owner

    if visitor_id is None:
        # Anonymous + no public-link permission. The SSR layer turns
        # this into a "Sign in to view" page rather than auto-redirecting,
        # so the recipient sees context for what they're being asked to
        # sign into.
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sign in to view this session")
    raise HTTPException(status.HTTP_403_FORBIDDEN, "You don't have access to this session")


@router.get("/public/sessions/{session_id}", response_model=PublicSessionResponse)
async def get_shared_session_detail(
    session_id: UUID = Path(...),
    db: AsyncSession = Depends(get_session),
    visitor: AuthContext | None = Depends(optional_web_auth),
) -> PublicSessionResponse:
    """Detail payload for the public HTML share page.

    Server-side rendered by `/s/[id]/page.tsx` so the page works
    without JS (curl, link unfurlers, agents that don't run a browser).
    Field allow-list lives in `public_session_base_fields` — same shape
    the `.json` export serializes, so a new Session column added without
    updating that helper can't silently leak.
    """
    session, agent_type, owner = await _resolve_session_for_view(db, session_id, visitor)
    return PublicSessionResponse.model_validate(
        public_session_base_fields(session, agent_type, owner)
    )


@router.get("/public/sessions/{session_id}/messages")
async def get_shared_session_messages(
    session_id: UUID = Path(...),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    db: AsyncSession = Depends(get_session),
    visitor: AuthContext | None = Depends(optional_web_auth),
) -> SessionMessagesPage:
    """Paginated messages, mirroring the authed `/messages` endpoint.

    Reuses the same `session_content.load_session_messages` cache so a
    popular shared link doesn't re-parse the source JSON per visitor.
    """
    session, _, _ = await _resolve_session_for_view(db, session_id, visitor)

    if not session.file_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session content not uploaded")

    try:
        raw = await load_session_messages(session, file_store)
    except SessionContentMissing:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session content file not found") from None
    except SessionContentInvalid:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "Internal server error"
        ) from None

    total = len(raw)
    sliced = raw[offset : offset + limit]
    return SessionMessagesPage(
        items=[SessionMessageResponse.model_validate(m) for m in sliced],
        total=total,
        offset=offset,
        limit=limit,
    )


@router.get("/public/sessions/{session_id}/export.md")
async def export_shared_session_markdown(
    session_id: UUID = Path(...),
    db: AsyncSession = Depends(get_session),
    visitor: AuthContext | None = Depends(optional_web_auth),
) -> Response:
    """Agent-friendly Markdown export.

    Body opens with a YAML front-matter block declaring source / agent
    / model / project / counts — that's how an LLM ingesting the page
    knows it's reading a Clawdi session and which agent / project it
    came from.

    `Content-Type: text/markdown; charset=utf-8`. NO cache header:
    revoke-immediacy beats CDN saving — the
    `(file_key, content_hash)` cache in `load_session_messages`
    already absorbs the parse cost.
    """
    session, agent_type, _ = await _resolve_session_for_view(db, session_id, visitor)

    if not session.file_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session content not uploaded")

    try:
        messages = await load_session_messages(session, file_store)
    except SessionContentMissing:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session content file not found") from None
    except SessionContentInvalid:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "Internal server error"
        ) from None

    body = session_to_markdown(
        session,
        messages,
        agent_type=agent_type,
        public=True,
    )
    return Response(
        content=body,
        media_type="text/markdown; charset=utf-8",
    )


@router.get(
    "/public/sessions/{session_id}/export.json",
    response_model=PublicSessionExportResponse,
    response_model_exclude_none=True,
)
async def export_shared_session_json(
    session_id: UUID = Path(...),
    db: AsyncSession = Depends(get_session),
    visitor: AuthContext | None = Depends(optional_web_auth),
) -> PublicSessionExportResponse:
    """Structured JSON export — public-stripped variant.

    `include_owner_metadata=False`: drops local_session_id,
    machine_name, and any other field the share link is not meant
    to expose.
    """
    session, agent_type, _ = await _resolve_session_for_view(db, session_id, visitor)

    if not session.file_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session content not uploaded")

    try:
        messages = await load_session_messages(session, file_store)
    except SessionContentMissing:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session content file not found") from None
    except SessionContentInvalid:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "Internal server error"
        ) from None

    return PublicSessionExportResponse.model_validate(
        session_to_json(
            session,
            messages,
            agent_type=agent_type,
            public=True,
            include_owner_metadata=False,
        )
    )
