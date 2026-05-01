"""SSE event channel for `clawdi serve` daemons.

Daemon opens a long-lived `GET /api/sync/events` connection authed
with the same Bearer token it uses for any other API call; server
pushes
`{"type":"skill_changed"|"skill_deleted","skill_key":"…","scope_id":"…","skills_revision":N}`
events as the user's skills change. Daemon immediately pulls the
affected skill — sub-second propagation rather than waiting for
the 60s reconcile safety net.

Outbound-only: daemon doesn't open an inbound HTTP server. Auth
is the Bearer token at handshake; `401` mid-stream (key revoked)
closes the connection from the server side.

Heartbeat: server emits `: ping` comment line every 25s. Daemon
considers the connection stale if no message arrives for 60s and
reconnects with exponential backoff (1→60s, ±20% jitter).

Connection cap: per-user max concurrent SSE connections (v1
default 10) — excess gets 429 with `Retry-After`. Stops a
misbehaving daemon from opening hundreds of streams.

Server-side scope filter: each subscriber registers with the set
of `scope_ids` it's allowed to see (`scope_ids_visible_to`). The
broker filters per-event so a bound api_key for env A never
receives `skill_changed` for skills in env B's scope — not even
as metadata. The daemon keeps a client-side filter as
defense-in-depth.

Single-replica v1: in-process fan-out via `app.services.sync_events`.
Multi-replica needs Redis pubsub or equivalent — explicit v1.5
work, deliberately not in this PR.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse

from app.core.auth import AuthContext, require_scope_short_session
from app.core.database import async_session_factory
from app.core.scope import scope_ids_visible_to
from app.services import sync_events

router = APIRouter(prefix="/api/sync", tags=["sync"])
log = logging.getLogger(__name__)


# Per-user open-connection cap. 10 is generous for a single user
# running daemons across laptop + a few pods; stops a misbehaving
# daemon from reconnecting in a tight loop and starving the pool.
PER_USER_CONNECTION_CAP = 10

# Heartbeat cadence. SSE comments (`: ping\n\n`) are ignored by
# clients but keep intermediary proxies (k8s ingress, Cloudflare)
# from idle-closing the connection. 25s sits comfortably under the
# typical 60s default. Daemon treats 60s of silence as "stale,
# reconnect."
HEARTBEAT_INTERVAL_S = 25.0


async def _stream(
    queue: asyncio.Queue[dict],
    request: Request,
    revoked: asyncio.Event,
) -> AsyncIterator[bytes]:
    """SSE event source. Drains `queue` (events from
    `bump_skills_revision`, already broker-filtered to the
    subscriber's visible scopes) and emits heartbeats so proxies
    don't nuke the connection during quiet periods. Returns when
    the client disconnects, when `revoked` fires (api_key
    revocation noticed by the periodic refresher), or whichever
    happens first."""
    yield b": connected\n\n"
    while True:
        if await request.is_disconnected() or revoked.is_set():
            return
        try:
            event_payload = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_INTERVAL_S)
        except TimeoutError:
            # No event in 25s; emit heartbeat comment and loop.
            yield b": ping\n\n"
            continue
        # Re-check revocation BEFORE emitting. The refresher can
        # set `revoked` while `wait_for` is parked on `queue.get()`;
        # an event landing in the queue right after revocation
        # would otherwise be emitted (one final `skill_changed`
        # / `skill_deleted` slipping past). The daemon turns
        # `skill_deleted` into a local file rm, so this is not
        # cosmetic — without the re-check, a freshly-revoked
        # token could still trigger a write on the client.
        if revoked.is_set():
            return
        # Real event: write SSE record.
        payload = json.dumps(event_payload)
        yield f"event: {event_payload['type']}\ndata: {payload}\n\n".encode()


# Cadence at which the SSE channel re-queries the caller's
# `scope_ids_visible_to` to catch runtime scope reassignment.
# Without this, a deploy key whose env's default_scope_id changed
# mid-stream would keep receiving events for the old scope until
# disconnection. Aligned with the daemon's own
# `refreshDefaultScopeIdLoop` (HEARTBEAT_INTERVAL_MS) so client
# and server converge on the new scope at the same cadence.
SCOPE_REFRESH_INTERVAL_S = 30.0


@router.get("/events")
async def events(
    request: Request,
    # `require_scope_short_session` opens/closes its own DB session
    # for auth lookup instead of holding a request-scoped one for the
    # life of the stream. FastAPI's yield-dependency contract
    # finalises `get_session` only when the StreamingResponse ends —
    # for SSE that means hours, and a few hundred daemons would
    # exhaust the connection pool. The refresh loop below opens
    # short-lived sessions on its own cadence.
    auth: AuthContext = Depends(require_scope_short_session("skills:read")),
):
    """SSE event channel. Daemons subscribe here and pull any
    skill referenced in incoming `skill_changed` events. Server-
    side scope filter applied at broker level: subscribers only
    receive events for scopes they have read access to.

    No request-scoped DB session: SSE streams live for hours,
    and `Depends(get_session)` would pin one connection from
    the pool for the whole duration. Each query inside this
    handler opens a short-lived session via
    `async_session_factory()` and closes it as soon as the
    query returns. With many connected daemons this keeps the
    pool free for normal request traffic.
    """
    user_id = auth.user_id

    # Resolve the caller's initial visible-scope set, then atomic
    # cap-and-subscribe. The cap check + register pair is wrapped
    # in a lock inside `try_subscribe` so concurrent handshakes
    # can't both pass a stale count read and exceed the cap.
    async with async_session_factory() as initial_db:
        initial_visible = frozenset(await scope_ids_visible_to(initial_db, auth))
    subscription = await sync_events.try_subscribe(
        user_id,
        initial_visible,
        max_per_user=PER_USER_CONNECTION_CAP,
        api_key_id=auth.api_key.id if auth.api_key is not None else None,
        # Per-key cap only applies to env-bound deploy keys. Unbound
        # CLI keys are user-level (one key shared across N daemons
        # via `clawdi serve install --all`), so the per-key cap of 2
        # would silently 429 the third local agent on a multi-agent
        # machine.
        is_env_bound=(auth.api_key is not None and auth.api_key.environment_id is not None),
    )
    if subscription is None:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            detail="too many concurrent sync subscriptions for this user",
            headers={"Retry-After": "30"},
        )
    queue, subscriber = subscription

    log.info(
        "sync events: subscribed user=%s visible_scopes=%d connection_count=%s",
        user_id,
        len(initial_visible),
        sync_events.connection_count(user_id),
    )

    # Set when the periodic refresher notices the caller's api_key
    # was revoked. Closes the auth-after-handshake window where a
    # subscriber kept receiving `skill_changed` / `skill_deleted`
    # events — which the daemon turns into local file mutations —
    # for as long as the TCP stream happened to stay alive.
    revoked = asyncio.Event()

    async def refresh_visibility() -> None:
        """Periodically re-query the caller's visible scope set
        and re-check api_key revocation. Closes both the cross-
        scope leak window when an env's default_scope_id changes
        mid-stream AND the post-revocation auth window.

        Opens its own short-lived `async_session_factory()` per
        refresh so a connection isn't held between cycles.
        Without this, every connected daemon held one open DB
        session for the lifetime of its stream — a few hundred
        daemons would exhaust the pool.
        """
        from sqlalchemy import select

        from app.models.api_key import ApiKey

        while True:
            await asyncio.sleep(SCOPE_REFRESH_INTERVAL_S)
            try:
                async with async_session_factory() as refresh_db:
                    # Revocation check first — if the key is dead, the
                    # scope set is moot. The handshake-time AuthContext
                    # is stale; re-read the row to see `revoked_at` AND
                    # whether the row still exists. Env delete cascades
                    # `api_keys.environment_id` so a deleted env can
                    # take its deploy key with it; we treat row-gone
                    # the same as revoked. Without this, `scalar_one_
                    # or_none()` returning None would be silently
                    # interpreted as "still valid".
                    if auth.api_key is not None:
                        result = await refresh_db.execute(
                            select(ApiKey.id, ApiKey.revoked_at).where(ApiKey.id == auth.api_key.id)
                        )
                        row = result.first()
                        if row is None:
                            log.info(
                                "sync events: api_key row deleted mid-stream user=%s key=%s",
                                user_id,
                                auth.api_key.id,
                            )
                            revoked.set()
                            return
                        if row.revoked_at is not None:
                            log.info(
                                "sync events: api_key revoked mid-stream user=%s key=%s",
                                user_id,
                                auth.api_key.id,
                            )
                            revoked.set()
                            return
                    fresh = frozenset(await scope_ids_visible_to(refresh_db, auth))
            except Exception as e:  # noqa: BLE001 — keep stream alive
                log.warning("sync events: scope refresh failed user=%s: %s", user_id, e)
                continue
            if fresh != subscriber.visible_scope_ids:
                log.info(
                    "sync events: scope filter updated user=%s old=%d new=%d",
                    user_id,
                    len(subscriber.visible_scope_ids or set()),
                    len(fresh),
                )
                subscriber.visible_scope_ids = fresh

    async def gen() -> AsyncIterator[bytes]:
        refresh_task = asyncio.create_task(refresh_visibility())
        try:
            async for chunk in _stream(queue, request, revoked):
                yield chunk
        finally:
            refresh_task.cancel()
            try:
                await refresh_task
            except (asyncio.CancelledError, Exception):
                pass
            sync_events.unsubscribe(user_id, queue)
            log.info(
                "sync events: unsubscribed user=%s remaining=%s",
                user_id,
                sync_events.connection_count(user_id),
            )

    # `text/event-stream` is the SSE content type. `X-Accel-Buffering:
    # no` disables nginx response buffering on the off chance an
    # operator runs us behind one — without it the bytes pile up in
    # nginx's buffer and the daemon never sees the heartbeat.
    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
