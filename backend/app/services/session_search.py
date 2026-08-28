from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, Protocol
from uuid import UUID

from pydantic import JsonValue
from sqlalchemy import case, delete, func, literal, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.selectable import Subquery

from app.models.session import Session, SessionEventChunk, SessionMessageSearch
from app.schemas.session_events import SessionEvent
from app.services.session_content import load_session_events, load_session_messages
from app.services.session_events import project_visible_messages

type SearchRole = Literal["user", "assistant"]
_MIN_TRGM_QUERY_LENGTH = 3


class SessionSearchFileStore(Protocol):
    async def get(self, key: str) -> bytes: ...


@dataclass(frozen=True, slots=True)
class SearchableSessionMessage:
    position: int
    role: SearchRole
    content: str


def event_document_revision(generation_id: UUID) -> str:
    return f"events:{generation_id}"


def event_search_revision(head_hash: str) -> str:
    return f"events:{head_hash}"


def snapshot_search_revision(content_hash: str) -> str:
    return f"snapshot:{content_hash}"


def current_search_revision(session: Session) -> str | None:
    if session.content_protocol == "events-v1" and session.event_head_hash is not None:
        return event_search_revision(session.event_head_hash)
    if session.content_protocol == "snapshot-v1" and session.content_hash is not None:
        return snapshot_search_revision(session.content_hash)
    return None


def current_document_revision(session: Session) -> str | None:
    if session.content_protocol == "events-v1" and session.event_generation_id is not None:
        return event_document_revision(session.event_generation_id)
    if session.content_protocol == "snapshot-v1" and session.content_hash is not None:
        return snapshot_search_revision(session.content_hash)
    return None


async def event_search_projection_complete(
    db: AsyncSession,
    generation_id: UUID,
) -> bool:
    missing = (
        await db.execute(
            select(SessionEventChunk.id)
            .where(
                SessionEventChunk.generation_id == generation_id,
                SessionEventChunk.search_indexed_at.is_(None),
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    return missing is None


def _escaped_contains_pattern(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _searchable_text(content: str) -> str:
    return content.replace("\x00", "\ufffd")


def best_session_message_matches(user_id: UUID, query: str) -> Subquery:
    """Return the strongest index-backed visible-message match per Session."""
    active_document_revision = case(
        (
            Session.content_protocol == "events-v1",
            func.concat("events:", Session.event_generation_id),
        ),
        else_=func.concat("snapshot:", Session.content_hash),
    )
    active_search_revision = case(
        (
            Session.content_protocol == "events-v1",
            func.concat("events:", Session.event_head_hash),
        ),
        else_=func.concat("snapshot:", Session.content_hash),
    )
    exact_match = SessionMessageSearch.content.ilike(
        _escaped_contains_pattern(query),
        escape="\\",
    )
    candidate_filter = exact_match
    if len(query) >= _MIN_TRGM_QUERY_LENGTH:
        # Official pg_trgm word-search shape: use the GIN-backed operator for
        # candidates, then word_similarity() only to rank that bounded set.
        candidate_filter = or_(
            exact_match,
            literal(query).op("<%")(SessionMessageSearch.content),
        )
    score = case(
        (exact_match, 1.0),
        else_=func.word_similarity(query, SessionMessageSearch.content),
    ).label("score")
    candidates = (
        select(
            SessionMessageSearch.session_id.label("session_id"),
            SessionMessageSearch.content_revision.label("content_revision"),
            SessionMessageSearch.position.label("position"),
            SessionMessageSearch.content.label("content"),
            SessionMessageSearch.role.label("role"),
            score,
        )
        .where(
            SessionMessageSearch.user_id == user_id,
            candidate_filter,
        )
        .cte("session_message_candidates")
        .prefix_with("MATERIALIZED")
    )
    return (
        select(
            candidates.c.session_id,
            candidates.c.content,
            candidates.c.role,
            candidates.c.score,
            candidates.c.position,
            Session.search_index_revision.label("content_revision"),
        )
        .join(Session, Session.id == candidates.c.session_id)
        .where(
            Session.user_id == user_id,
            candidates.c.content_revision == active_document_revision,
            Session.search_index_revision == active_search_revision,
        )
        .distinct(candidates.c.session_id)
        .order_by(
            candidates.c.session_id,
            candidates.c.score.desc(),
            candidates.c.position.asc(),
        )
        .subquery("best_session_message_match")
    )


def searchable_event_messages(events: Sequence[SessionEvent]) -> list[SearchableSessionMessage]:
    return [
        SearchableSessionMessage(
            position=message.position,
            role=message.role,
            content=_searchable_text(message.content),
        )
        for message in project_visible_messages(events)
        if message.role in ("user", "assistant")
    ]


def searchable_snapshot_messages(
    messages: Sequence[dict[str, JsonValue]],
) -> list[SearchableSessionMessage]:
    projected: list[SearchableSessionMessage] = []
    for position, message in enumerate(messages):
        role = message.get("role")
        content = message.get("content")
        if role not in ("user", "assistant") or not isinstance(content, str) or not content:
            continue
        projected.append(
            SearchableSessionMessage(
                position=position,
                role=role,
                content=_searchable_text(content),
            )
        )
    return projected


def _add_documents(
    db: AsyncSession,
    *,
    user_id: UUID,
    session_id: UUID,
    generation_id: UUID | None,
    content_revision: str,
    messages: Sequence[SearchableSessionMessage],
) -> None:
    db.add_all(
        [
            SessionMessageSearch(
                user_id=user_id,
                session_id=session_id,
                generation_id=generation_id,
                content_revision=content_revision,
                position=message.position,
                role=message.role,
                content=message.content,
            )
            for message in messages
        ]
    )


def stage_event_search_messages(
    db: AsyncSession,
    *,
    user_id: UUID,
    session_id: UUID,
    generation_id: UUID,
    events: Sequence[SessionEvent],
) -> None:
    _add_documents(
        db,
        user_id=user_id,
        session_id=session_id,
        generation_id=generation_id,
        content_revision=event_document_revision(generation_id),
        messages=searchable_event_messages(events),
    )


async def finalize_event_search_index(
    db: AsyncSession,
    session: Session,
    generation_id: UUID,
    *,
    projection_complete: bool,
) -> None:
    document_revision = event_document_revision(generation_id)
    await db.execute(
        delete(SessionMessageSearch).where(
            SessionMessageSearch.session_id == session.id,
            SessionMessageSearch.content_revision != document_revision,
        )
    )
    if not projection_complete:
        session.search_index_revision = None
        return
    revision = current_search_revision(session)
    if revision is None:
        raise ValueError("events-v1 search activation requires a committed event head")
    session.search_index_revision = revision


async def replace_snapshot_search_index(
    db: AsyncSession,
    session: Session,
    content_hash: str,
    messages: Sequence[SearchableSessionMessage],
) -> None:
    revision = snapshot_search_revision(content_hash)
    await db.execute(
        delete(SessionMessageSearch).where(SessionMessageSearch.session_id == session.id)
    )
    _add_documents(
        db,
        user_id=session.user_id,
        session_id=session.id,
        generation_id=None,
        content_revision=revision,
        messages=messages,
    )
    session.search_index_revision = revision


async def rebuild_session_search_index(
    db: AsyncSession,
    session: Session,
    file_store: SessionSearchFileStore,
) -> bool:
    """Rebuild one revision without letting stale object reads replace newer data."""
    search_revision = current_search_revision(session)
    if search_revision is None:
        return False
    if session.content_protocol == "events-v1":
        generation_id = session.event_generation_id
        if generation_id is None:
            return False
        events = await load_session_events(session, file_store, db)
        messages = searchable_event_messages(events)
        document_revision = event_document_revision(generation_id)
    else:
        snapshot = await load_session_messages(session, file_store, db)
        messages = searchable_snapshot_messages(snapshot)
        generation_id = None
        document_revision = search_revision

    current = (
        await db.execute(
            select(Session)
            .where(Session.id == session.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if (
        current is None
        or current_search_revision(current) != search_revision
        or current_document_revision(current) != document_revision
    ):
        return False

    await db.execute(
        delete(SessionMessageSearch).where(SessionMessageSearch.session_id == current.id)
    )
    _add_documents(
        db,
        user_id=current.user_id,
        session_id=current.id,
        generation_id=generation_id,
        content_revision=document_revision,
        messages=messages,
    )
    if generation_id is not None:
        await db.execute(
            update(SessionEventChunk)
            .where(SessionEventChunk.generation_id == generation_id)
            .values(
                search_indexed_at=func.coalesce(
                    SessionEventChunk.search_indexed_at,
                    func.now(),
                )
            )
        )
    current.search_index_revision = search_revision
    return True
