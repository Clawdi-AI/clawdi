"""Shared session-content loader.

Wraps the file-store fetch + JSON parse + cache-by-content-hash logic
in one helper. Originally inlined in `routes/sessions.py`; extracted
so the public share routes can reuse it without copying the cache
(which would defeat its purpose — multiple visitors of the same shared
link must hit the same parsed blob).

Cache key: `(file_key, content_hash)`. The content_hash component makes
re-upload invalidate cleanly without explicit cache-busting.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import OrderedDict
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, Protocol
from uuid import UUID

from pydantic import JsonValue, TypeAdapter, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.session import Session, SessionEventChunk, SessionEventGeneration
from app.schemas.session_events import SessionEvent
from app.services.session_events import (
    EMPTY_EVENT_HEAD,
    project_safe_messages,
    project_safe_timeline,
    project_visible_messages,
    validate_event_chunk_async,
)

log = logging.getLogger(__name__)


class _FileStoreLike(Protocol):
    async def get(self, key: str) -> bytes: ...


# Cache sized + TTLed to bound resident memory.
#   16 entries × ~30-50 MB parsed JSON for a fat 10 MB session ≈ 500-800 MB
#   worst case — well inside a typical app server budget.
# TTL exists for hygiene only: the (file_key, content_hash) key already
# invalidates a stale snapshot, so a long-quiet entry is safe; the TTL just
# stops it from pinning memory forever.
_CONTENT_CACHE_MAX = 16
_CONTENT_CACHE_TTL_S = 300.0
type SessionMessageValue = dict[str, JsonValue]
type SessionTimelineValue = dict[str, JsonValue]
type SessionMessageDirection = Literal["asc", "desc"]


@dataclass(frozen=True, slots=True)
class SessionContentProjection:
    messages: list[SessionMessageValue]
    source_positions: tuple[int, ...]
    timeline: list[SessionTimelineValue]
    timeline_source_positions: tuple[int, ...]


_SESSION_MESSAGES_ADAPTER: TypeAdapter[list[SessionMessageValue]] = TypeAdapter(
    list[SessionMessageValue]
)
_content_cache: OrderedDict[tuple[str, str], tuple[float, SessionContentProjection]] = OrderedDict()
_content_cache_lock = threading.Lock()


class SessionContentMissing(Exception):
    """The session has no uploaded content, or its stored object is absent."""


class SessionContentUnavailable(Exception):
    """The backing store could not be reached or returned a provider failure."""


class SessionContentInvalid(Exception):
    """The stored content isn't a JSON array of messages — corrupted upload."""


def session_has_uploaded_content(session: Session) -> bool:
    return bool(
        session.file_key
        or (session.content_protocol == "events-v1" and session.event_generation_id is not None)
    )


def _cache_get(key: tuple[str, str]) -> SessionContentProjection | None:
    now = time.monotonic()
    with _content_cache_lock:
        entry = _content_cache.get(key)
        if entry is None:
            return None
        ts, parsed = entry
        if now - ts > _CONTENT_CACHE_TTL_S:
            _content_cache.pop(key, None)
            return None
        # Touch — bump to end for LRU.
        _content_cache.move_to_end(key)
        return parsed


def _cache_put(key: tuple[str, str], projection: SessionContentProjection) -> None:
    now = time.monotonic()
    with _content_cache_lock:
        _content_cache[key] = (now, projection)
        _content_cache.move_to_end(key)
        while len(_content_cache) > _CONTENT_CACHE_MAX:
            _content_cache.popitem(last=False)


def slice_session_items(
    items: Sequence[SessionMessageValue],
    *,
    offset: int,
    limit: int,
    direction: SessionMessageDirection,
) -> list[SessionMessageValue]:
    """Slice session projection items using an order-relative offset."""
    if direction == "asc":
        return list(items[offset : offset + limit])

    end = max(0, len(items) - offset)
    start = max(0, end - limit)
    return list(reversed(items[start:end]))


async def load_session_messages(
    session: Session,
    file_store: _FileStoreLike,
    db: AsyncSession | None = None,
) -> list[SessionMessageValue]:
    """Fetch and parse the session's messages array.

    Cached by (file_key, content_hash). Returns the raw list of message
    dicts — callers slice for pagination. Raises:

    - `SessionContentMissing`: no file_key, or the file_store can't find it.
      Route layer translates to 404.
    - `SessionContentInvalid`: JSON decode failure or non-list payload.
      Indicates an upload corruption; route layer returns 500.
    """
    projection = await load_session_content_projection(session, file_store, db)
    return projection.messages


async def load_session_content_projection(
    session: Session,
    file_store: _FileStoreLike,
    db: AsyncSession | None = None,
) -> SessionContentProjection:
    """Load cached message and owner-only timeline projections."""
    if session.content_protocol == "events-v1" and session.event_generation_id is not None:
        if db is None:
            raise SessionContentInvalid("events-v1 content requires a database session")
        return await load_event_generation_projection(
            session.event_generation_id,
            file_store,
            db,
            event_count=session.event_count,
            event_head_hash=session.event_head_hash or EMPTY_EVENT_HEAD,
        )

    if not session.file_key:
        raise SessionContentMissing(f"session {session.id} has no uploaded content")

    return await load_snapshot_projection(
        session.file_key,
        session.content_hash or "",
        file_store,
    )


async def load_snapshot_projection(
    file_key: str,
    content_hash: str,
    file_store: _FileStoreLike,
) -> SessionContentProjection:
    """Load one immutable-or-current snapshot by its explicit storage identity."""
    cache_key = (file_key, content_hash)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    try:
        data = await file_store.get(file_key)
    except FileNotFoundError as exc:
        raise SessionContentMissing(f"session content not found in file store: {file_key}") from exc
    except Exception as exc:
        log.exception("session_content_fetch_failed file_key=%s", file_key)
        raise SessionContentUnavailable("session content storage is unavailable") from exc

    try:
        parsed = _SESSION_MESSAGES_ADAPTER.validate_json(data, strict=True)
    except ValidationError as exc:
        log.exception("session snapshot is not a valid JSON message array file_key=%s", file_key)
        raise SessionContentInvalid("session content is not a valid JSON message array") from exc

    projection = SessionContentProjection(
        messages=parsed,
        source_positions=tuple(range(len(parsed))),
        timeline=[
            {"kind": "message", "position": position, **message}
            for position, message in enumerate(parsed)
        ],
        timeline_source_positions=tuple(range(len(parsed))),
    )
    _cache_put(cache_key, projection)
    return projection


async def load_event_generation_projection(
    generation_id: UUID,
    file_store: _FileStoreLike,
    db: AsyncSession,
    *,
    event_count: int,
    event_head_hash: str,
) -> SessionContentProjection:
    """Load the safe projection for one immutable prefix of a committed generation."""
    generation = (
        await db.execute(
            select(SessionEventGeneration).where(SessionEventGeneration.id == generation_id)
        )
    ).scalar_one_or_none()
    if generation is None or generation.status != "committed":
        raise SessionContentMissing("session event generation is unavailable")

    cache_key = (f"events-v1:{generation.id}:{event_count}", event_head_hash)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached
    events = await _load_event_generation_events(
        generation.id,
        final_count=event_count,
        final_head_hash=event_head_hash,
        file_store=file_store,
        db=db,
    )
    visible = project_visible_messages(events)
    timeline = project_safe_timeline(events)
    projection = SessionContentProjection(
        messages=_SESSION_MESSAGES_ADAPTER.validate_python(project_safe_messages(events)),
        source_positions=tuple(message.position for message in visible),
        timeline=[item.value for item in timeline],
        timeline_source_positions=tuple(item.position for item in timeline),
    )
    _cache_put(cache_key, projection)
    return projection


async def load_session_events(
    session: Session,
    file_store: _FileStoreLike,
    db: AsyncSession,
) -> list[SessionEvent]:
    if session.content_protocol != "events-v1" or session.event_generation_id is None:
        raise SessionContentInvalid("session does not have events-v1 content")
    return await _load_event_generation_events(
        session.event_generation_id,
        final_count=session.event_count,
        final_head_hash=session.event_head_hash or EMPTY_EVENT_HEAD,
        file_store=file_store,
        db=db,
    )


async def _load_event_generation_events(
    generation_id: UUID,
    *,
    final_count: int,
    final_head_hash: str,
    file_store: _FileStoreLike,
    db: AsyncSession,
) -> list[SessionEvent]:
    chunks = list(
        (
            await db.execute(
                select(SessionEventChunk)
                .where(
                    SessionEventChunk.generation_id == generation_id,
                    SessionEventChunk.start_seq < final_count,
                )
                .order_by(SessionEventChunk.start_seq)
            )
        ).scalars()
    )
    events: list[SessionEvent] = []
    next_seq = 0
    head = EMPTY_EVENT_HEAD
    for chunk in chunks:
        if (
            chunk.start_seq != next_seq
            or chunk.base_head_hash != head
            or chunk.end_seq >= final_count
        ):
            raise SessionContentInvalid("events-v1 chunk index is not continuous")
        try:
            data = await file_store.get(chunk.file_key)
        except FileNotFoundError as exc:
            raise SessionContentMissing("events-v1 chunk is unavailable") from exc
        except Exception as exc:
            log.exception("session_event_chunk_fetch_failed file_key=%s", chunk.file_key)
            raise SessionContentUnavailable("session content storage is unavailable") from exc
        try:
            validated = await validate_event_chunk_async(
                data, start_seq=next_seq, base_head_hash=head
            )
        except Exception as exc:
            log.exception("session_event_chunk_invalid file_key=%s", chunk.file_key)
            raise SessionContentInvalid("events-v1 chunk is invalid") from exc
        if (
            validated.content_hash != chunk.content_hash
            or validated.result_head_hash != chunk.result_head_hash
        ):
            raise SessionContentInvalid("events-v1 chunk hash drift")
        events.extend(validated.events)
        next_seq = chunk.end_seq + 1
        head = chunk.result_head_hash
    if next_seq != final_count or head != final_head_hash:
        raise SessionContentInvalid("events-v1 head does not match its chunk index")
    return events
