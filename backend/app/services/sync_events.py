"""Skill revision counter + SSE fan-out for `clawdi serve` daemons.

Single owner of two intertwined concerns:

1. `users.skills_revision` is the collection-ETag counter for
   `GET /api/skills`. Every change that affects what a daemon
   would see — skill insert, content update, soft-delete — bumps
   it. We centralize the bump in one helper so adding new skill
   mutation paths can't accidentally skip the increment. The
   daemon's 60s reconcile loop uses this as its `If-None-Match`
   short-circuit and as the safety-net catchup mechanism when
   SSE events are missed.

2. Each running `clawdi serve` daemon has an open SSE connection
   to `GET /api/sync/events` and is parked in a per-user queue.
   When `bump_skills_revision()` runs, it pushes a
   `{type:"skill_changed"|"skill_deleted", skill_key, scope_id,
   skills_revision}` event to every connection of that user that
   has visibility into the event's `scope_id`. SSE is the primary
   path for instant propagation; 60s reconcile is the safety net.

Server-side scope filter: every subscribe call carries the
caller's `visible_scope_ids` (computed via
`scope.scope_ids_visible_to`). The broker filters events to
match: a bound api_key for env A NEVER receives events for skills
in env B's scope, even with the daemon's client-side filter
removed. Without this server-side gate, a deploy key could
observe `skill_key` and `scope_id` for every change in the user's
account — a metadata leak even if the daemon would never act on
the event. The daemon retains a defense-in-depth client-side
filter on receipt.

Broadcast-after-commit is enforced via SQLAlchemy's
`after_commit` event hook: `bump_skills_revision` registers an
event for delivery, the hook fires only when the surrounding
transaction successfully commits, and rollback drops the queued
event silently. Without this, a route that bumped the counter
then rolled back would have already fanned out a phantom event,
making every daemon do a redundant pull.

Single-process v1 constraint: fan-out lives in this module's
`_subscribers` dict, so a broadcast in one process only reaches
SSE streams attached to the same process. Operators MUST run the
backend with one worker until this is replaced with a cross-
process channel — Postgres LISTEN/NOTIFY (no extra infra, reuses
the existing async SQLAlchemy connection) or Redis pubsub. Two
uvicorn workers behind a round-robin load balancer breaks the
realtime path: a daemon attached to worker A misses events
broadcast by worker B, falling back to the 60s reconcile loop.
Multi-process fan-out is deferred to v1.5.
"""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from sqlalchemy import event, select
from sqlalchemy import update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User

log = logging.getLogger(__name__)


@dataclass
class _Subscriber:
    """A single SSE connection's queue plus the set of scope_ids
    the caller is allowed to receive events for. Bound api_keys
    see exactly one scope; Clerk JWT (dashboard, future) sees all
    of the user's scopes.

    `visible_scope_ids` is mutable — an out-of-band refresh
    task on the SSE channel re-queries `scope_ids_visible_to`
    every 30s and replaces the field, so a runtime env-scope
    reassignment converges within one refresh cycle. Without
    this, a deploy key whose env is reassigned to a different
    scope would keep receiving event metadata for its former
    scope until the connection drops.
    """

    queue: asyncio.Queue[dict[str, Any]] = field(default_factory=lambda: asyncio.Queue(maxsize=64))
    # `None` means "no filter" (admin / future server-internal use).
    # Empty set means "no events at all" — useful for a subscriber
    # whose visible-scope query returned empty (rare).
    visible_scope_ids: frozenset[UUID] | None = None
    # Identity of the api_key (or None for Clerk JWT) that owns
    # this subscription. Used for per-key fan-out caps so a leaked
    # deploy key can't open all `max_per_user` slots and starve
    # legit dashboard tabs.
    api_key_id: UUID | None = None


# Per-user list of subscribers, one per active SSE connection.
_subscribers: dict[UUID, list[_Subscriber]] = defaultdict(list)
# Cap-and-subscribe must be atomic: without a lock, two concurrent
# handshakes both pass the count check, both subscribe, and the
# user is silently above the cap. Race-free via a synchronous
# lock around read+write — these calls don't await between
# count and append.
_subscribe_lock = asyncio.Lock()


async def try_subscribe(
    user_id: UUID,
    visible_scope_ids: frozenset[UUID],
    *,
    max_per_user: int,
    api_key_id: UUID | None = None,
    is_env_bound: bool = False,
    max_per_key: int = 2,
) -> tuple[asyncio.Queue[dict[str, Any]], _Subscriber] | None:
    """Atomic check-and-subscribe. Returns `(queue, subscriber)` on
    success, `None` if EITHER the per-user OR the per-key cap is
    at limit. The subscriber handle is exposed so the SSE route
    can update its `visible_scope_ids` field as the user's scope
    view changes.

    Per-key cap defends against a leaked DEPLOY KEY (env-bound)
    opening all `max_per_user` slots. `max_per_key` defaults to 2
    (one daemon + one debug session). Bypasses:
      - Clerk JWT (api_key_id=None)
      - Unbound personal CLI keys (`is_env_bound=False`) — multi-
        agent setups run `clawdi serve install --all` which spawns
        N daemons, all sharing the user's device-flow auth key
        from `~/.clawdi/auth.json`. Capping that at 2 silently
        broke realtime sync for users with 3+ registered agents
        (a 3-agent install was the supported headline feature).
    Bound deploy keys remain capped — leaked-key blast radius
    stays bounded by the per-user cap only.
    """
    async with _subscribe_lock:
        existing = _subscribers.get(user_id, [])
        if len(existing) >= max_per_user:
            return None
        if api_key_id is not None and is_env_bound:
            existing_for_key = sum(1 for s in existing if s.api_key_id == api_key_id)
            if existing_for_key >= max_per_key:
                return None
        sub = _Subscriber(visible_scope_ids=visible_scope_ids, api_key_id=api_key_id)
        _subscribers[user_id].append(sub)
        return sub.queue, sub


def subscribe(
    user_id: UUID,
    visible_scope_ids: frozenset[UUID],
) -> asyncio.Queue[dict[str, Any]]:
    """Non-atomic subscribe — exposed for tests and callers that
    don't need to enforce a cap. Production SSE callers use
    `try_subscribe` for atomic cap-and-subscribe."""
    sub = _Subscriber(visible_scope_ids=visible_scope_ids)
    _subscribers[user_id].append(sub)
    return sub.queue


def unsubscribe(user_id: UUID, q: asyncio.Queue[dict[str, Any]]) -> None:
    """Remove the subscriber whose queue is `q`. Idempotent."""
    subs = _subscribers.get(user_id)
    if not subs:
        return
    _subscribers[user_id] = [s for s in subs if s.queue is not q]
    if not _subscribers[user_id]:
        _subscribers.pop(user_id, None)


def connection_count(user_id: UUID) -> int:
    """Used for observability + tests; the cap is enforced inside
    `try_subscribe` to avoid TOCTOU between count and append."""
    return len(_subscribers.get(user_id, []))


def _broadcast(user_id: UUID, event_payload: dict[str, Any]) -> None:
    """Push an event to every subscriber for `user_id` whose
    `visible_scope_ids` includes the event's scope. Non-blocking —
    if a queue is full, drop on the floor (the 60s reconcile loop
    catches missed events). Never raises."""
    subs = _subscribers.get(user_id)
    if not subs:
        return
    raw_scope = event_payload.get("scope_id")
    event_scope: UUID | None = None
    if isinstance(raw_scope, UUID):
        event_scope = raw_scope
    elif isinstance(raw_scope, str):
        try:
            event_scope = UUID(raw_scope)
        except ValueError:
            event_scope = None
    for sub in subs:
        if sub.visible_scope_ids is not None:
            if event_scope is None or event_scope not in sub.visible_scope_ids:
                # Subscriber doesn't have visibility into this
                # scope — skip silently. Logging would be noisy
                # since the multi-env case fan-outs N events of
                # which N-1 are filtered.
                continue
        try:
            sub.queue.put_nowait(event_payload)
        except asyncio.QueueFull:
            # Subscriber is too slow / stalled; the 60s reconcile
            # safety net will catch the change anyway. Logging at
            # warning level so a chronically-overloaded daemon
            # shows up in metrics.
            log.warning("sync_events queue full for user %s; event dropped", user_id)


async def bump_skills_revision(
    db: AsyncSession,
    user_id: UUID,
    *,
    skill_key: str,
    scope_id: UUID,
    event_type: str = "skill_changed",
    content_hash: str | None = None,
) -> int:
    """Atomically increment `users.skills_revision` and queue a
    fan-out event for after-commit delivery. Caller is responsible
    for `db.commit()` — we deliberately don't commit here so the
    bump rolls back together with the skill change if the
    surrounding transaction fails. Returns the new revision so
    callers can echo it in their response.

    The SSE event carries `scope_id` so the broker can filter
    events per-subscriber to scopes the caller has visibility into.
    Without server-side filtering, an api_key bound to env A would
    observe skill_changed events for skills in env B's scope as
    metadata leakage — even if the daemon's client-side filter
    refused to act on them.

    `content_hash` is the post-write tree hash. The daemon uses
    it for echo suppression: an event whose hash matches the
    daemon's `lastPushedHash[skill_key]` is the daemon's own
    upload bouncing back through SSE — pulling it would clobber
    a fresher local edit with the bytes we just sent. Optional
    so future event types (deletes) can omit it; daemons treat
    a missing hash as "always pull, can't be sure it's our own".

    The SSE event is NOT broadcast immediately. We queue it on the
    session via SQLAlchemy's `after_commit` hook; rollback discards
    the queued events. This avoids the phantom-event problem where
    a daemon would react to `skill_changed` for a write that the
    route then rolled back.
    """
    # Atomic increment via UPDATE … RETURNING to avoid the
    # read-modify-write race where two concurrent transactions
    # both read N and both write N+1, losing one revision bump.
    # Without atomicity, the collection ETag short-circuit
    # (`If-None-Match` 304) would silently hide the lost change
    # and daemons miss real updates.
    result = await db.execute(
        sa_update(User)
        .where(User.id == user_id)
        .values(skills_revision=User.skills_revision + 1)
        .returning(User.skills_revision)
    )
    new_revision = result.scalar_one()

    payload: dict[str, Any] = {
        "type": event_type,
        "skill_key": skill_key,
        "scope_id": str(scope_id),
        "skills_revision": new_revision,
    }
    if content_hash is not None:
        payload["content_hash"] = content_hash
    _queue_for_commit(db, user_id, payload)
    return new_revision


# Per-session pending event list. Keyed by the underlying
# (sync) `Session` object that SQLAlchemy hands to event hooks —
# `AsyncSession` wraps it, but the hook fires on the inner sync
# session. We attach via `info` dict so each session keeps its
# own queue and tests don't cross-pollinate.
_PENDING_KEY = "_clawdi_pending_sse_events"


def _queue_for_commit(
    db: AsyncSession,
    user_id: UUID,
    event_payload: dict[str, Any],
) -> None:
    """Stash an event on the session, to be delivered on commit."""
    sync_session = db.sync_session
    pending: list[tuple[UUID, dict[str, Any]]] = sync_session.info.setdefault(_PENDING_KEY, [])
    pending.append((user_id, event_payload))
    # Idempotent listener registration — calling listen() twice on
    # the same target is a no-op in SQLAlchemy, so we don't need a
    # registration flag. Each session's sync_session is unique per
    # request because the dependency yields a fresh session.
    if not event.contains(sync_session, "after_commit", _on_session_commit):
        event.listen(sync_session, "after_commit", _on_session_commit)
        event.listen(sync_session, "after_rollback", _on_session_rollback)


def _on_session_commit(sync_session) -> None:
    """SQLAlchemy after_commit hook — flush all queued events.
    Runs on the sync session's thread; `_broadcast` only touches
    in-memory queues so it doesn't need the event loop. The
    daemon SSE consumer poll-loops on its own queue, so a
    cross-thread put_nowait is fine."""
    pending: list[tuple[UUID, dict[str, Any]]] | None = sync_session.info.pop(_PENDING_KEY, None)
    if not pending:
        return
    for user_id, payload in pending:
        _broadcast(user_id, payload)


def _on_session_rollback(sync_session) -> None:
    """Drop queued events — the writes that produced them never
    landed."""
    sync_session.info.pop(_PENDING_KEY, None)


async def get_skills_revision(db: AsyncSession, user_id: UUID) -> int:
    """Read current revision — used by `GET /api/skills` to fill the
    `ETag` response header and check `If-None-Match`."""
    result = (
        await db.execute(select(User.skills_revision).where(User.id == user_id))
    ).scalar_one_or_none()
    return result or 0
