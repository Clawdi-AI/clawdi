"""SSE event channel + sync_events broker tests.

Two layers verified:

1. **Service-layer broker** — `subscribe`, `unsubscribe`,
   `connection_count`, `_broadcast` and the per-subscriber scope
   filter. Direct in-process API; no HTTP round-trip needed.

2. **Atomic revision counter** — `bump_skills_revision` increments
   `users.skills_revision` and queues an event for after-commit
   delivery; rollback drops the queued event.

The HTTP route layer (`/api/sync/events` SSE stream) is exercised
indirectly via the full skill-upload flow elsewhere; here we
focus on broker correctness because that's where scope-leak
regressions would land.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.services import sync_events


@pytest.mark.asyncio
async def test_stream_returns_when_revoked_event_set():
    """`_stream` must exit the SSE generator the next loop tick
    after the periodic refresher signals revocation. Without
    this, an attacker holding a stolen Bearer would keep
    receiving `skill_changed` / `skill_deleted` events (the
    daemon turns the latter into local file deletions) for as
    long as the TCP stream stayed alive — possibly hours past
    the revoke."""
    from unittest.mock import Mock

    from app.routes.sync import _stream

    queue: asyncio.Queue = asyncio.Queue()
    revoked = asyncio.Event()
    request = Mock()

    async def _not_disconnected():
        return False

    request.is_disconnected = _not_disconnected

    # Start the generator. First yield should be the connect
    # comment; second iteration sees `revoked` set and returns.
    gen = _stream(queue, request, revoked)
    first = await gen.__anext__()
    assert first == b": connected\n\n"

    revoked.set()
    with pytest.raises(StopAsyncIteration):
        await gen.__anext__()


@pytest.mark.asyncio
async def test_stream_drops_event_queued_before_revoke():
    """Race: event lands in the queue right before / during the
    25s `wait_for(queue.get())`. The refresher fires `revoked`
    while wait_for is parked. wait_for resolves the event without
    re-checking the flag — pre-fix the daemon got one extra
    `skill_changed` / `skill_deleted` past revocation, and
    `skill_deleted` triggers a local file rm. Verify the second
    `__anext__` returns (closes the generator) instead of
    yielding the event."""
    from unittest.mock import Mock

    from app.routes.sync import _stream

    queue: asyncio.Queue = asyncio.Queue()
    revoked = asyncio.Event()
    request = Mock()

    async def _not_disconnected():
        return False

    request.is_disconnected = _not_disconnected

    gen = _stream(queue, request, revoked)
    first = await gen.__anext__()
    assert first == b": connected\n\n"

    # Queue an event AND fire revocation in the same tick. The
    # generator's next iteration sees the revoked flag (via the
    # post-get re-check) and returns instead of emitting.
    await queue.put(
        {
            "type": "skill_deleted",
            "skill_key": "x",
            "scope_id": "00000000-0000-0000-0000-000000000099",
            "skills_revision": 1,
        }
    )
    revoked.set()
    with pytest.raises(StopAsyncIteration):
        await gen.__anext__()


@pytest.mark.asyncio
async def test_subscribe_unsubscribe_lifecycle():
    user_id = uuid.uuid4()
    assert sync_events.connection_count(user_id) == 0
    queue = sync_events.subscribe(user_id, frozenset())
    assert sync_events.connection_count(user_id) == 1
    sync_events.unsubscribe(user_id, queue)
    assert sync_events.connection_count(user_id) == 0
    # Idempotent — unsubscribing twice doesn't error.
    sync_events.unsubscribe(user_id, queue)
    assert sync_events.connection_count(user_id) == 0


@pytest.mark.asyncio
async def test_broadcast_filters_by_visible_scope():
    """The broker MUST drop events whose `scope_id` falls outside
    the subscriber's `visible_scope_ids` set. Without this, a
    bound api_key for env A could observe events for skills in
    env B's scope as a side-channel — the daemon-side filter is
    defense-in-depth, not the primary boundary."""
    user_id = uuid.uuid4()
    scope_a = uuid.uuid4()
    scope_b = uuid.uuid4()

    # Subscriber sees only scope_a.
    q_a = sync_events.subscribe(user_id, frozenset({scope_a}))
    # Subscriber sees both (analogous to JWT seeing all user scopes).
    q_both = sync_events.subscribe(user_id, frozenset({scope_a, scope_b}))

    try:
        sync_events._broadcast(
            user_id,
            {
                "type": "skill_changed",
                "skill_key": "alpha",
                "scope_id": str(scope_a),
                "skills_revision": 1,
            },
        )
        sync_events._broadcast(
            user_id,
            {
                "type": "skill_changed",
                "skill_key": "beta",
                "scope_id": str(scope_b),
                "skills_revision": 2,
            },
        )

        # `q_a` saw only the scope_a event.
        a_first = q_a.get_nowait()
        assert a_first["skill_key"] == "alpha"
        assert q_a.empty()

        # `q_both` saw both.
        both_first = q_both.get_nowait()
        both_second = q_both.get_nowait()
        keys = {both_first["skill_key"], both_second["skill_key"]}
        assert keys == {"alpha", "beta"}
        assert q_both.empty()
    finally:
        sync_events.unsubscribe(user_id, q_a)
        sync_events.unsubscribe(user_id, q_both)


@pytest.mark.asyncio
async def test_broadcast_drops_event_with_unparseable_scope():
    """Defensive: a malformed scope_id in the event payload
    (shouldn't happen in practice — `bump_skills_revision`
    always stringifies a real UUID) MUST NOT bypass the filter.
    Treat unparseable scope as "not in any subscriber's set"."""
    user_id = uuid.uuid4()
    scope_a = uuid.uuid4()
    q = sync_events.subscribe(user_id, frozenset({scope_a}))
    try:
        sync_events._broadcast(
            user_id,
            {"type": "skill_changed", "skill_key": "x", "scope_id": "not-a-uuid"},
        )
        # Filter rejects unparseable scope.
        await asyncio.sleep(0)
        assert q.empty()
    finally:
        sync_events.unsubscribe(user_id, q)


@pytest.mark.asyncio
async def test_bump_skills_revision_after_commit_broadcasts(
    db_session: AsyncSession, seed_user: User
):
    """End-to-end: bump_skills_revision queues an event; commit
    flushes it; visible-scope subscribers receive it."""
    from app.models.scope import SCOPE_KIND_PERSONAL, Scope

    personal = (
        await db_session.execute(
            select(Scope).where(Scope.user_id == seed_user.id, Scope.kind == SCOPE_KIND_PERSONAL)
        )
    ).scalar_one()

    queue = sync_events.subscribe(seed_user.id, frozenset({personal.id}))
    try:
        new_rev = await sync_events.bump_skills_revision(
            db_session,
            seed_user.id,
            skill_key="hello",
            scope_id=personal.id,
        )
        # Not delivered yet — the after_commit hook runs on commit.
        await asyncio.sleep(0)
        assert queue.empty(), "event must wait for transaction commit"
        await db_session.commit()
        # commit() schedules the broadcast synchronously inside the
        # after_commit hook; give the loop one tick to deliver.
        await asyncio.sleep(0)
        event = queue.get_nowait()
        assert event["type"] == "skill_changed"
        assert event["skill_key"] == "hello"
        assert event["scope_id"] == str(personal.id)
        assert event["skills_revision"] == new_rev
    finally:
        sync_events.unsubscribe(seed_user.id, queue)


@pytest.mark.asyncio
async def test_pending_events_cleared_on_rollback_hook(db_session: AsyncSession):
    """Direct test of the rollback hook: events queued on the
    session's `info` dict must be dropped if the rollback hook
    fires, so a subsequent commit-on-the-same-session can't
    accidentally fan them out. Avoids exercising a real DB
    rollback (which has its own awkward async/sync interactions
    in the test harness) — we call the hook directly with the
    sync_session SQLAlchemy hands the listener."""
    from app.services.sync_events import _on_session_rollback

    sync_session = db_session.sync_session
    sync_session.info["_clawdi_pending_sse_events"] = [
        (uuid.uuid4(), {"type": "skill_changed", "skill_key": "ghost"}),
    ]
    _on_session_rollback(sync_session)
    assert "_clawdi_pending_sse_events" not in sync_session.info


@pytest.mark.asyncio
async def test_try_subscribe_caps_per_user_and_per_key(seed_user: User):
    """Round-r5 P1: verify both subscription caps that the SSE
    route relies on for blast-radius bounds.

    1. Per-user cap: `max_per_user` is the hard ceiling. Once
       reached, `try_subscribe` MUST return None (route turns
       into 429). A regression dropping this cap lets a buggy
       client open unbounded SSE streams against a single user
       and exhaust process memory.

    2. Per-key cap (env-bound deploy keys only): an env-bound
       `api_key_id` may hold at most `max_per_key` simultaneous
       subscribers — a leaked deploy key can't fan out to the
       per-user limit. Unbound keys (multi-agent personal
       install: serve --all spawns N daemons sharing one auth
       key from ~/.clawdi/auth.json) MUST bypass this cap so 3+
       agent installs continue to receive realtime sync.
    """
    user_id = seed_user.id
    bound_key = uuid.uuid4()
    unbound_key = uuid.uuid4()

    # Clean any prior subscribers for this user from earlier
    # tests in the module.
    sync_events._subscribers.pop(user_id, None)

    # 1) per-user cap: fill exactly max_per_user, next must None.
    handles: list = []
    for _ in range(3):
        h = await sync_events.try_subscribe(
            user_id,
            frozenset(),
            max_per_user=3,
            api_key_id=None,
            is_env_bound=False,
        )
        assert h is not None
        handles.append(h)
    over = await sync_events.try_subscribe(
        user_id,
        frozenset(),
        max_per_user=3,
        api_key_id=None,
        is_env_bound=False,
    )
    assert over is None, "per-user cap must reject the (max_per_user+1)-th subscriber"

    # Cleanup so the next phase starts with an empty list.
    for q, _sub in handles:
        sync_events.unsubscribe(user_id, q)
    sync_events._subscribers.pop(user_id, None)

    # 2a) bound deploy key capped at max_per_key.
    bound_handles: list = []
    for _ in range(2):
        h = await sync_events.try_subscribe(
            user_id,
            frozenset(),
            max_per_user=10,
            api_key_id=bound_key,
            is_env_bound=True,
            max_per_key=2,
        )
        assert h is not None
        bound_handles.append(h)
    third = await sync_events.try_subscribe(
        user_id,
        frozenset(),
        max_per_user=10,
        api_key_id=bound_key,
        is_env_bound=True,
        max_per_key=2,
    )
    assert third is None, "bound deploy key must cap at max_per_key"

    # 2b) unbound key (multi-agent personal install) bypasses
    # the per-key cap — `serve --all` runs N daemons that all
    # use ~/.clawdi/auth.json. With 5 daemons all 5 must
    # subscribe successfully.
    unbound_handles: list = []
    for _ in range(5):
        h = await sync_events.try_subscribe(
            user_id,
            frozenset(),
            max_per_user=10,
            api_key_id=unbound_key,
            is_env_bound=False,
            max_per_key=2,
        )
        assert h is not None, "unbound key must bypass max_per_key"
        unbound_handles.append(h)

    for q, _sub in (*bound_handles, *unbound_handles):
        sync_events.unsubscribe(user_id, q)
    sync_events._subscribers.pop(user_id, None)
