"""Commit-safe, cross-process SSE fan-out for `clawdi daemon`.

Single owner of three intertwined concerns:

1. `users.skills_revision` is the collection-ETag counter for
   `GET /v1/skills`. Every change that affects what a daemon
   would see — skill insert, content update, soft-delete — bumps
   it. We centralize the bump in one helper so adding new skill
   mutation paths can't accidentally skip the increment. The
   daemon's 60s reconcile loop uses this as its `If-None-Match`
   short-circuit and as the safety-net catchup mechanism when
   SSE events are missed.

2. Each running `clawdi daemon` process has an open SSE connection
   to `GET /v1/sync/events` and is parked in a per-user queue.
   When `bump_skills_revision()` runs, it pushes a
   `{type:"skill_changed"|"skill_deleted", skill_key, project_id,
   skills_revision}` event to every connection of that user, and
   every accepted project member, that has visibility into the
   event's `project_id`. SSE is the primary path for instant
   propagation; 60s reconcile is the safety net.

3. Runtime desired-state changes emit a signal-only
   `{type:"runtime_manifest_changed", environment_id}` event. Bound deploy
   keys receive only their environment; unbound user keys may receive any
   user-owned environment event and filter again client-side.

Server-side project filter: every subscribe call carries the
caller's `visible_project_ids` (computed via
`project.project_ids_visible_to`). The broker filters events to
match: a bound api_key for env A NEVER receives events for skills
in env B's project, even with the daemon's client-side filter
removed. Without this server-side gate, a deploy key could
observe `skill_key` and `project_id` for every change in the user's
account — a metadata leak even if the daemon would never act on
the event. Shared-project member fan-out still goes through this
filter, so membership removal stops future events as soon as the
subscriber's refreshed visibility drops the project. The daemon
retains a defense-in-depth client-side filter on receipt.

Broadcast-after-commit is enforced via SQLAlchemy's
`after_commit` event hook: `bump_skills_revision` registers an
event for delivery, the hook fires only when the surrounding
transaction successfully commits, and rollback drops the queued
event silently. Without this, a route that bumped the counter
then rolled back would have already fanned out a phantom event,
making every daemon do a redundant pull.

Cross-process delivery uses PostgreSQL LISTEN/NOTIFY. The notification is
enqueued inside the same database transaction as the desired-state mutation,
so PostgreSQL delivers it only after commit and discards it on rollback. The
committing process also performs a local after-commit broadcast for minimum
latency; its listener ignores the matching process id to prevent duplicates.
Each API worker holds a dedicated listener connection with reconnect handling.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID, uuid4

import asyncpg
from pydantic import ValidationError
from sqlalchemy import event, select, text
from sqlalchemy import update as sa_update
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.hosted_runtime import HostedRuntimeState
from app.models.project_membership import ProjectMembership
from app.models.session import AgentEnvironment
from app.models.user import User
from app.schemas.runtime import HostedRuntimeTools, validate_hosted_runtime_desired_state

log = logging.getLogger(__name__)

_POSTGRES_CHANNEL = "clawdi_sync_events"
_PROCESS_TOKEN = uuid4().hex
_POSTGRES_PAYLOAD_LIMIT_BYTES = 7900


@dataclass
class _Subscriber:
    """A single SSE connection's queue plus the set of project_ids
    the caller is allowed to receive events for. Bound api_keys
    see exactly one project; Clerk JWT (dashboard, future) sees all
    of the user's projects.

    `visible_project_ids` is mutable — an out-of-band refresh
    task on the SSE channel re-queries `project_ids_visible_to`
    every 30s and replaces the field, so a runtime env-project
    reassignment converges within one refresh cycle. Without
    this, a deploy key whose env is reassigned to a different
    project would keep receiving event metadata for its former
    project until the connection drops.
    """

    queue: asyncio.Queue[dict[str, Any]] = field(default_factory=lambda: asyncio.Queue(maxsize=64))
    # `None` means "no filter" (admin / future server-internal use).
    # Empty set means "no events at all" — useful for a subscriber
    # whose visible-project query returned empty (rare).
    visible_project_ids: frozenset[UUID] | None = None
    # Bound deploy keys receive runtime invalidations only for this exact
    # environment. None means user-level auth and may receive any environment
    # owned by the event's user.
    environment_id: UUID | None = None
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
    visible_project_ids: frozenset[UUID],
    *,
    max_per_user: int,
    api_key_id: UUID | None = None,
    is_env_bound: bool = False,
    environment_id: UUID | None = None,
    max_per_key: int = 3,
) -> tuple[asyncio.Queue[dict[str, Any]], _Subscriber] | None:
    """Atomic check-and-subscribe. Returns `(queue, subscriber)` on
    success, `None` if EITHER the per-user OR the per-key cap is
    at limit. The subscriber handle is exposed so the SSE route
    can update its `visible_project_ids` field as the user's project
    view changes.

    Per-key cap defends against a leaked Agent API key
    opening all `max_per_user` slots. `max_per_key` defaults to 3:
    one daemon skill-sync stream, one runtime-watch invalidation
    stream, and one debug/diagnostic stream. Bypasses:
      - Clerk JWT (api_key_id=None)
      - Unbound personal CLI keys (`is_env_bound=False`) — multi-
        agent setups run `clawdi daemon install --all` which spawns
        N daemons, all sharing the user's device-flow auth key
        from `~/.clawdi/auth.json`. A small fixed per-key cap would
        silently break realtime sync once the user registers more
        agents than the cap allows.
    Bound deploy keys remain capped by both limits. The per-user
    cap is still authoritative when aggregate connections across
    keys reach `max_per_user`, even if a key has fewer than three.
    """
    async with _subscribe_lock:
        existing = _subscribers.get(user_id, [])
        if len(existing) >= max_per_user:
            return None
        if api_key_id is not None and is_env_bound:
            existing_for_key = sum(1 for s in existing if s.api_key_id == api_key_id)
            if existing_for_key >= max_per_key:
                return None
        sub = _Subscriber(
            visible_project_ids=visible_project_ids,
            environment_id=environment_id,
            api_key_id=api_key_id,
        )
        _subscribers[user_id].append(sub)
        return sub.queue, sub


def subscribe(
    user_id: UUID,
    visible_project_ids: frozenset[UUID],
    *,
    environment_id: UUID | None = None,
) -> asyncio.Queue[dict[str, Any]]:
    """Non-atomic subscribe — exposed for tests and callers that
    don't need to enforce a cap. Production SSE callers use
    `try_subscribe` for atomic cap-and-subscribe."""
    sub = _Subscriber(
        visible_project_ids=visible_project_ids,
        environment_id=environment_id,
    )
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
    """Push an event to authorized subscribers for `user_id`.

    Skill events use project visibility; runtime events use the exact bound
    environment. Delivery is non-blocking, and polling catches queue drops.
    """
    subs = _subscribers.get(user_id)
    if not subs:
        return
    is_runtime_event = event_payload.get("type") == "runtime_manifest_changed"
    event_environment_id = _payload_uuid(event_payload.get("environment_id"))
    raw_project_id = event_payload.get("project_id")
    event_project_id: UUID | None = None
    if isinstance(raw_project_id, UUID):
        event_project_id = raw_project_id
    elif isinstance(raw_project_id, str):
        try:
            event_project_id = UUID(raw_project_id)
        except ValueError:
            event_project_id = None
    for sub in subs:
        if is_runtime_event:
            if event_environment_id is None:
                continue
            if sub.environment_id is not None and sub.environment_id != event_environment_id:
                continue
        elif sub.visible_project_ids is not None:
            if event_project_id is None or event_project_id not in sub.visible_project_ids:
                # Subscriber doesn't have visibility into this
                # project — skip silently. Logging would be noisy
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


def _payload_uuid(value: object) -> UUID | None:
    if isinstance(value, UUID):
        return value
    if isinstance(value, str):
        try:
            return UUID(value)
        except ValueError:
            return None
    return None


def queue_runtime_manifest_changed(
    db: AsyncSession,
    user_id: UUID,
    environment_id: UUID,
) -> None:
    """Queue a signal-only runtime manifest invalidation for commit."""
    payload = {
        "type": "runtime_manifest_changed",
        "environment_id": str(environment_id),
    }
    _queue_for_commit(db, user_id, payload, deduplicate=True)


async def queue_environment_runtime_manifest_changed(
    db: AsyncSession,
    user_id: UUID,
    environment_id: UUID,
) -> bool:
    """Queue an event when an environment currently has runtime desired state."""
    state = (
        await db.execute(
            select(HostedRuntimeState).where(
                HostedRuntimeState.environment_id == environment_id,
            )
        )
    ).scalar_one_or_none()
    if state is None:
        return False
    queue_runtime_manifest_changed(db, user_id, environment_id)
    return True


async def queue_provider_runtime_manifest_changed(
    db: AsyncSession,
    user_id: UUID,
    provider_id: str,
) -> list[UUID]:
    """Queue invalidations for hosted environments bound to a provider."""
    states = (
        (
            await db.execute(
                select(HostedRuntimeState)
                .join(
                    AgentEnvironment,
                    AgentEnvironment.id == HostedRuntimeState.environment_id,
                )
                .where(AgentEnvironment.user_id == user_id)
            )
        )
        .scalars()
        .all()
    )
    affected: list[UUID] = []
    for state in states:
        if not _runtime_state_may_use_provider(state, provider_id):
            continue
        queue_runtime_manifest_changed(db, user_id, state.environment_id)
        affected.append(state.environment_id)
    return affected


def _runtime_state_may_use_provider(state: HostedRuntimeState, provider_id: str) -> bool:
    runtimes = state.runtimes
    if not isinstance(runtimes, dict) or len(runtimes) != 1:
        return False
    runtime_name, raw_runtime = next(iter(runtimes.items()))
    if runtime_name not in {"hermes", "openclaw"}:
        return False
    try:
        runtime = validate_hosted_runtime_desired_state(raw_runtime)
    except ValidationError:
        return False
    if provider_id in runtime.provider_ids:
        return True
    try:
        tools = HostedRuntimeTools.model_validate(state.tools)
    except ValidationError:
        return False
    return provider_id == tools.codex.provider_id


async def bump_skills_revision(
    db: AsyncSession,
    user_id: UUID,
    *,
    skill_key: str,
    project_id: UUID,
    event_type: str = "skill_changed",
    content_hash: str | None = None,
) -> int:
    """Atomically increment `users.skills_revision` and queue a
    fan-out event for after-commit delivery. Caller is responsible
    for `db.commit()` — we deliberately don't commit here so the
    bump rolls back together with the skill change if the
    surrounding transaction fails. Returns the new revision so
    callers can echo it in their response.

    The SSE event carries `project_id` so the broker can filter
    events per-subscriber to projects the caller has visibility into.
    Without server-side filtering, an api_key bound to env A would
    observe skill_changed events for skills in env B's project as
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
        "project_id": str(project_id),
        "skills_revision": new_revision,
    }
    if content_hash is not None:
        payload["content_hash"] = content_hash
    member_rows = (
        (
            await db.execute(
                select(ProjectMembership.member_user_id).where(
                    ProjectMembership.project_id == project_id
                )
            )
        )
        .scalars()
        .all()
    )
    target_user_ids = {user_id, *member_rows}
    for target_user_id in target_user_ids:
        _queue_for_commit(db, target_user_id, payload)
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
    *,
    deduplicate: bool = False,
) -> None:
    """Stash an event on the session, to be delivered on commit."""
    sync_session = db.sync_session
    pending: list[tuple[UUID, dict[str, Any]]] = sync_session.info.setdefault(_PENDING_KEY, [])
    if deduplicate and (user_id, event_payload) in pending:
        return
    pending.append((user_id, event_payload))
    # Idempotent listener registration — calling listen() twice on
    # the same target is a no-op in SQLAlchemy, so we don't need a
    # registration flag. Each session's sync_session is unique per
    # request because the dependency yields a fresh session.
    if not event.contains(sync_session, "after_commit", _on_session_commit):
        event.listen(sync_session, "before_commit", _on_session_before_commit)
        event.listen(sync_session, "after_commit", _on_session_commit)
        event.listen(sync_session, "after_rollback", _on_session_rollback)


def _on_session_before_commit(sync_session) -> None:
    """Publish pending events transactionally for other API processes."""
    pending: list[tuple[UUID, dict[str, Any]]] | None = sync_session.info.get(_PENDING_KEY)
    if not pending:
        return
    for user_id, payload in pending:
        notification = json.dumps(
            {
                "origin": _process_id(),
                "user_id": str(user_id),
                "event": payload,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
        if len(notification.encode("utf-8")) > _POSTGRES_PAYLOAD_LIMIT_BYTES:
            raise ValueError("sync event exceeds PostgreSQL notification payload limit")
        sync_session.execute(
            text("SELECT pg_notify(:channel, :payload)"),
            {"channel": _POSTGRES_CHANNEL, "payload": notification},
        )


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


_listener_task: asyncio.Task[None] | None = None
_listener_stop: asyncio.Event | None = None


async def start_postgres_listener() -> None:
    """Start the process-local PostgreSQL listener and await first connect."""
    global _listener_stop, _listener_task
    if _listener_task is not None and not _listener_task.done():
        return
    loop = asyncio.get_running_loop()
    ready: asyncio.Future[None] = loop.create_future()
    _listener_stop = asyncio.Event()
    _listener_task = asyncio.create_task(
        _postgres_listener_loop(_listener_stop, ready),
        name="sync-events-postgres-listener",
    )
    try:
        await ready
    except Exception:
        await asyncio.gather(_listener_task, return_exceptions=True)
        _listener_task = None
        _listener_stop = None
        raise


async def stop_postgres_listener() -> None:
    """Stop the process-local PostgreSQL listener. Idempotent."""
    global _listener_stop, _listener_task
    if _listener_task is None:
        return
    if _listener_stop is not None:
        _listener_stop.set()
    await asyncio.gather(_listener_task, return_exceptions=True)
    _listener_task = None
    _listener_stop = None


async def _postgres_listener_loop(
    stop: asyncio.Event,
    ready: asyncio.Future[None],
) -> None:
    reconnect_delay = 1.0
    while not stop.is_set():
        connection: asyncpg.Connection | None = None
        terminated = asyncio.Event()
        try:
            connection = await asyncpg.connect(_asyncpg_dsn(), timeout=10)
            await connection.add_listener(_POSTGRES_CHANNEL, _on_postgres_notification)
            connection.add_termination_listener(lambda _connection: terminated.set())
            if not ready.done():
                ready.set_result(None)
            reconnect_delay = 1.0
            stop_task = asyncio.create_task(stop.wait())
            terminated_task = asyncio.create_task(terminated.wait())
            _, pending = await asyncio.wait(
                {stop_task, terminated_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - listener reconnects after startup
            if not ready.done():
                ready.set_exception(exc)
                return
            log.warning("sync events PostgreSQL listener disconnected: %s", exc)
        finally:
            if connection is not None and not connection.is_closed():
                try:
                    await connection.remove_listener(
                        _POSTGRES_CHANNEL,
                        _on_postgres_notification,
                    )
                except Exception as exc:  # noqa: BLE001 - reconnect loop owns recovery
                    log.warning("sync events listener cleanup failed: %s", exc)
                try:
                    await connection.close(timeout=5)
                except Exception as exc:  # noqa: BLE001 - reconnect loop owns recovery
                    log.warning("sync events listener close failed: %s", exc)
        if stop.is_set():
            return
        try:
            await asyncio.wait_for(stop.wait(), timeout=reconnect_delay)
        except TimeoutError:
            reconnect_delay = min(reconnect_delay * 2, 30.0)


def _asyncpg_dsn() -> str:
    url = make_url(settings.database_url).set(drivername="postgresql")
    return url.render_as_string(hide_password=False)


def _process_id() -> str:
    # PID makes this fork-safe even if an ASGI master preloads the module and
    # workers inherit the same random token.
    return f"{os.getpid()}-{_PROCESS_TOKEN}"


def _on_postgres_notification(
    _connection: asyncpg.Connection,
    _pid: int,
    _channel: str,
    payload: str,
) -> None:
    try:
        envelope = json.loads(payload)
        if envelope.get("origin") == _process_id():
            return
        user_id = UUID(envelope["user_id"])
        event_payload = envelope["event"]
        if not isinstance(event_payload, dict) or not isinstance(event_payload.get("type"), str):
            raise ValueError("invalid event payload")
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        log.warning("ignored invalid PostgreSQL sync event: %s", exc)
        return
    _broadcast(user_id, event_payload)


async def get_skills_revision(db: AsyncSession, user_id: UUID) -> int:
    """Read current revision — used by `GET /v1/skills` to fill the
    `ETag` response header and check `If-None-Match`."""
    result = (
        await db.execute(select(User.skills_revision).where(User.id == user_id))
    ).scalar_one_or_none()
    return result or 0
