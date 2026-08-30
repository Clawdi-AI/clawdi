from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, Protocol
from uuid import UUID

from pydantic import JsonValue
from sqlalchemy import (
    String,
    case,
    cast,
    delete,
    func,
    literal,
    literal_column,
    or_,
    select,
    update,
)
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.selectable import Subquery

from app.core.query_utils import (
    lexical_search_filter,
    like_needle,
    search_excerpt,
    text_search_document,
    websearch_query,
)
from app.models.session import (
    SESSION_SEARCH_CHUNK_BODY_CHARACTERS,
    SESSION_SEARCH_CHUNK_MAX_CHARACTERS,
    Session,
    SessionEventChunk,
    SessionMessageSearch,
)
from app.schemas.session import (
    SessionSearchAnchorResponse,
    SessionSearchMatchResponse,
)
from app.schemas.session_events import SessionEvent
from app.services.session_content import load_session_events, load_session_messages
from app.services.session_events import project_visible_messages

type SearchRole = Literal["user", "assistant"]

_UUID_PREFIX_RE = re.compile(r"^[0-9a-f]{8,32}$", re.IGNORECASE)


class SessionSearchFileStore(Protocol):
    async def get(self, key: str) -> bytes: ...


@dataclass(frozen=True, slots=True)
class SearchableSessionMessage:
    position: int
    role: SearchRole
    content: str


@dataclass(frozen=True, slots=True)
class SessionSearchNavigation:
    current_position: int
    index: int
    total: int
    previous_position: int | None
    next_position: int | None


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


def _uuid_prefix_pattern(value: str) -> str | None:
    compact = value.strip().replace("-", "")
    if not _UUID_PREFIX_RE.fullmatch(compact):
        return None
    return f"{compact}%"


def session_search_match_response(
    session: Session,
    query: str,
    *,
    content: object,
    role: object,
    position: object,
    revision: object,
) -> SessionSearchMatchResponse | None:
    """Build the shared API match contract from a ranked search row."""
    if (
        not isinstance(content, str)
        or role not in ("user", "assistant")
        or not isinstance(position, int)
        or not isinstance(revision, str)
    ):
        return None
    return SessionSearchMatchResponse(
        role=role,
        excerpt=search_excerpt(content, query),
        anchor=SessionSearchAnchorResponse(
            kind="event_seq" if session.content_protocol == "events-v1" else "snapshot_offset",
            position=position,
            revision=revision,
        ),
    )


def _searchable_text(content: str) -> str:
    return content.replace("\x00", "\ufffd")


def session_search_chunks(content: str) -> list[str]:
    """Split one message into bounded, overlapping search documents."""
    if len(content) <= SESSION_SEARCH_CHUNK_MAX_CHARACTERS:
        return [content]

    chunks: list[str] = []
    start = 0
    while start + SESSION_SEARCH_CHUNK_MAX_CHARACTERS < len(content):
        chunks.append(content[start : start + SESSION_SEARCH_CHUNK_MAX_CHARACTERS])
        start += SESSION_SEARCH_CHUNK_BODY_CHARACTERS
    chunks.append(content[start:])
    return chunks


def _message_search_document():
    content = SessionMessageSearch.content
    return case(
        (
            func.char_length(content) <= literal_column(str(SESSION_SEARCH_CHUNK_MAX_CHARACTERS)),
            text_search_document((content,)),
        ),
        else_=text_search_document((literal_column("''::text"),)),
    )


def _message_match_expression(query: str):
    return lexical_search_filter(
        query,
        (SessionMessageSearch.content,),
        search_vector=_message_search_document(),
    )


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
    message_match = _message_match_expression(query)
    phrase_match = SessionMessageSearch.content.ilike(like_needle(query), escape="\\")
    lexical_rank = func.ts_rank_cd(
        _message_search_document(),
        websearch_query(query),
    )
    candidates = (
        select(
            SessionMessageSearch.session_id.label("session_id"),
            SessionMessageSearch.content_revision.label("content_revision"),
            SessionMessageSearch.position.label("position"),
            SessionMessageSearch.chunk_index.label("chunk_index"),
            SessionMessageSearch.content.label("content"),
            SessionMessageSearch.role.label("role"),
            case(
                (phrase_match, literal(2.0) + lexical_rank),
                else_=literal(0.75) + lexical_rank,
            ).label("score"),
        )
        .where(
            SessionMessageSearch.user_id == user_id,
            message_match,
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
            candidates.c.chunk_index.asc(),
        )
        .subquery("best_session_message_match")
    )


def session_search_matches(user_id: UUID, query: str) -> Subquery:
    """Return every web-search match with one ranked body hit per Session."""
    pattern = like_needle(query)
    message_match = best_session_message_matches(user_id, query)
    metadata_fields = (
        func.coalesce(Session.summary, ""),
        func.coalesce(Session.project_path, ""),
        Session.local_session_id,
    )
    metadata_match = lexical_search_filter(query, metadata_fields)
    metadata_phrase_match = or_(*(field.ilike(pattern, escape="\\") for field in metadata_fields))
    metadata_scores = [
        func.similarity(func.coalesce(Session.summary, ""), query),
        func.similarity(func.coalesce(Session.project_path, ""), query),
        func.similarity(Session.local_session_id, query),
    ]
    uuid_prefix = _uuid_prefix_pattern(query)
    if uuid_prefix is not None:
        compact_session_id = func.replace(cast(Session.id, String), "-", "")
        metadata_match = or_(metadata_match, compact_session_id.ilike(uuid_prefix))
        metadata_phrase_match = or_(
            metadata_phrase_match,
            compact_session_id.ilike(uuid_prefix),
        )
        metadata_scores.append(func.similarity(compact_session_id, uuid_prefix[:-1]))
    metadata_score = case(
        (
            metadata_phrase_match,
            literal(1.0) + func.greatest(*metadata_scores),
        ),
        else_=literal(0.5),
    )
    message_score = func.coalesce(message_match.c.score, 0.0)
    return (
        select(
            Session.id.label("session_id"),
            func.greatest(metadata_score, message_score).label("score"),
            message_match.c.content,
            message_match.c.role,
            message_match.c.position,
            message_match.c.content_revision,
        )
        .outerjoin(message_match, message_match.c.session_id == Session.id)
        .where(
            Session.user_id == user_id,
            or_(metadata_match, message_match.c.session_id.is_not(None)),
        )
        .subquery("session_search_matches")
    )


async def session_message_search_navigation(
    db: AsyncSession,
    session: Session,
    *,
    query: str,
    position: int | None = None,
    roles: Sequence[SearchRole] | None = None,
) -> SessionSearchNavigation | None:
    """Resolve one active match and its transcript-order neighbours."""
    if roles is not None and not roles:
        return None
    document_revision = current_document_revision(session)
    if document_revision is None or session.search_index_revision != current_search_revision(
        session
    ):
        return None

    message_match = _message_match_expression(query)
    matching_positions_query = select(SessionMessageSearch.position.label("position")).where(
        SessionMessageSearch.user_id == session.user_id,
        SessionMessageSearch.session_id == session.id,
        SessionMessageSearch.content_revision == document_revision,
        message_match,
    )
    if roles is not None:
        matching_positions_query = matching_positions_query.where(
            SessionMessageSearch.role.in_(roles)
        )
    matching_positions = matching_positions_query.group_by(SessionMessageSearch.position).subquery(
        "matching_session_message_positions"
    )
    ordered_matches = select(
        matching_positions.c.position,
        func.row_number().over(order_by=matching_positions.c.position).label("match_index"),
        func.count().over().label("match_total"),
        func.lag(matching_positions.c.position)
        .over(order_by=matching_positions.c.position)
        .label("previous_position"),
        func.lead(matching_positions.c.position)
        .over(order_by=matching_positions.c.position)
        .label("next_position"),
    ).subquery("ordered_session_message_matches")
    navigation_query = select(
        ordered_matches.c.position,
        ordered_matches.c.match_index,
        ordered_matches.c.match_total,
        ordered_matches.c.previous_position,
        ordered_matches.c.next_position,
    )
    if position is None:
        navigation_query = navigation_query.order_by(ordered_matches.c.position).limit(1)
    else:
        navigation_query = navigation_query.where(ordered_matches.c.position == position)
    row = (await db.execute(navigation_query)).one_or_none()
    if row is None:
        return None
    current_position, match_index, match_total, previous_position, next_position = row
    return SessionSearchNavigation(
        current_position=current_position,
        index=match_index,
        total=match_total,
        previous_position=previous_position,
        next_position=next_position,
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
                chunk_index=chunk_index,
                role=message.role,
                content=content,
            )
            for message in messages
            for chunk_index, content in enumerate(session_search_chunks(message.content))
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
