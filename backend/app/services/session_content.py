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

from pydantic import JsonValue, TypeAdapter, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.session import Session, SessionEventChunk
from app.schemas.session_events import SessionEvent
from app.services.session_events import (
    EMPTY_EVENT_HEAD,
    project_safe_messages,
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
_MESSAGES_CACHE_MAX = 16
_MESSAGES_CACHE_TTL_S = 300.0
type SessionMessageValue = dict[str, JsonValue]
type SessionMessageDirection = Literal["asc", "desc"]


@dataclass(frozen=True, slots=True)
class SessionMessageProjection:
    messages: list[SessionMessageValue]
    source_positions: tuple[int, ...]


_SESSION_MESSAGES_ADAPTER: TypeAdapter[list[SessionMessageValue]] = TypeAdapter(
    list[SessionMessageValue]
)
_messages_cache: OrderedDict[tuple[str, str], tuple[float, SessionMessageProjection]] = (
    OrderedDict()
)
_messages_cache_lock = threading.Lock()


class SessionContentMissing(Exception):
    """The session has no uploaded content, or the file store can't find it."""


class SessionContentInvalid(Exception):
    """The stored content isn't a JSON array of messages — corrupted upload."""


def session_has_uploaded_content(session: Session) -> bool:
    return bool(
        session.file_key
        or (session.content_protocol == "events-v1" and session.event_generation_id is not None)
    )


def _cache_get(key: tuple[str, str]) -> SessionMessageProjection | None:
    now = time.monotonic()
    with _messages_cache_lock:
        entry = _messages_cache.get(key)
        if entry is None:
            return None
        ts, parsed = entry
        if now - ts > _MESSAGES_CACHE_TTL_S:
            _messages_cache.pop(key, None)
            return None
        # Touch — bump to end for LRU.
        _messages_cache.move_to_end(key)
        return parsed


def _cache_put(key: tuple[str, str], projection: SessionMessageProjection) -> None:
    now = time.monotonic()
    with _messages_cache_lock:
        _messages_cache[key] = (now, projection)
        _messages_cache.move_to_end(key)
        while len(_messages_cache) > _MESSAGES_CACHE_MAX:
            _messages_cache.popitem(last=False)


def slice_session_messages(
    messages: Sequence[SessionMessageValue],
    *,
    offset: int,
    limit: int,
    direction: SessionMessageDirection,
) -> list[SessionMessageValue]:
    """Slice messages in the requested order using an order-relative offset."""
    if direction == "asc":
        return list(messages[offset : offset + limit])

    end = max(0, len(messages) - offset)
    start = max(0, end - limit)
    return list(reversed(messages[start:end]))


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
    projection = await load_session_message_projection(session, file_store, db)
    return projection.messages


async def load_session_message_projection(
    session: Session,
    file_store: _FileStoreLike,
    db: AsyncSession | None = None,
) -> SessionMessageProjection:
    """Load visible messages with their canonical source positions."""
    if session.content_protocol == "events-v1" and session.event_generation_id is not None:
        if db is None:
            raise SessionContentInvalid("events-v1 content requires a database session")
        cache_key = (
            f"events-v1:{session.event_generation_id}",
            session.event_head_hash or EMPTY_EVENT_HEAD,
        )
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached
        events = await load_session_events(session, file_store, db)
        visible = project_visible_messages(events)
        projection = SessionMessageProjection(
            messages=_SESSION_MESSAGES_ADAPTER.validate_python(project_safe_messages(events)),
            source_positions=tuple(message.position for message in visible),
        )
        _cache_put(cache_key, projection)
        return projection

    if not session.file_key:
        raise SessionContentMissing(f"session {session.id} has no uploaded content")

    cache_key = (session.file_key, session.content_hash or "")
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    try:
        data = await file_store.get(session.file_key)
    except Exception as e:
        # Log the underlying error — storage failures (S3 timeout, perms,
        # missing key) must be visible in server logs instead of being
        # permanently swallowed behind a generic 404 to the client.
        log.exception("session_content_fetch_failed file_key=%s", session.file_key)
        raise SessionContentMissing(
            f"session content not found in file store: {session.file_key}"
        ) from e

    try:
        parsed = _SESSION_MESSAGES_ADAPTER.validate_json(data, strict=True)
    except ValidationError as exc:
        log.exception("session %s content is not a valid JSON message array", session.id)
        raise SessionContentInvalid(
            f"session {session.id} content is not a valid JSON message array"
        ) from exc

    projection = SessionMessageProjection(
        messages=parsed,
        source_positions=tuple(range(len(parsed))),
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
            raise SessionContentInvalid("events-v1 chunk index is not continuous")
        try:
            data = await file_store.get(chunk.file_key)
            validated = await validate_event_chunk_async(
                data, start_seq=next_seq, base_head_hash=head
            )
        except Exception as exc:
            log.exception("session_event_chunk_fetch_failed file_key=%s", chunk.file_key)
            raise SessionContentInvalid("events-v1 chunk is unavailable or invalid") from exc
        if (
            validated.content_hash != chunk.content_hash
            or validated.result_head_hash != chunk.result_head_hash
        ):
            raise SessionContentInvalid("events-v1 chunk hash drift")
        events.extend(validated.events)
        next_seq = chunk.end_seq + 1
        head = chunk.result_head_hash
    if next_seq != session.event_count or head != (session.event_head_hash or EMPTY_EVENT_HEAD):
        raise SessionContentInvalid("events-v1 head does not match its chunk index")
    return events
