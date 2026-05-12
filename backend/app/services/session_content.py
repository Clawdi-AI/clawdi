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

import json
import logging
import threading
import time
from collections import OrderedDict
from typing import Protocol

from app.models.session import Session

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
_messages_cache: OrderedDict[tuple[str, str], tuple[float, list]] = OrderedDict()
_messages_cache_lock = threading.Lock()


class SessionContentMissing(Exception):
    """The session has no uploaded content, or the file store can't find it."""


class SessionContentInvalid(Exception):
    """The stored content isn't a JSON array of messages — corrupted upload."""


def _cache_get(key: tuple[str, str]) -> list | None:
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


def _cache_put(key: tuple[str, str], parsed: list) -> None:
    now = time.monotonic()
    with _messages_cache_lock:
        _messages_cache[key] = (now, parsed)
        _messages_cache.move_to_end(key)
        while len(_messages_cache) > _MESSAGES_CACHE_MAX:
            _messages_cache.popitem(last=False)


async def load_session_messages(
    session: Session,
    file_store: _FileStoreLike,
) -> list:
    """Fetch and parse the session's messages array.

    Cached by (file_key, content_hash). Returns the raw list of message
    dicts — callers slice for pagination. Raises:

    - `SessionContentMissing`: no file_key, or the file_store can't find it.
      Route layer translates to 404.
    - `SessionContentInvalid`: JSON decode failure or non-list payload.
      Indicates an upload corruption; route layer returns 500.
    """
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
        parsed = json.loads(data)
    except json.JSONDecodeError as e:
        log.exception("session %s content is not valid JSON", session.id)
        raise SessionContentInvalid(
            f"session {session.id} content is not valid JSON"
        ) from e

    if not isinstance(parsed, list):
        log.error(
            "session %s content is not a JSON array (got %s)",
            session.id,
            type(parsed).__name__,
        )
        raise SessionContentInvalid(
            f"session {session.id} content is not a JSON array"
        )

    _cache_put(cache_key, parsed)
    return parsed
