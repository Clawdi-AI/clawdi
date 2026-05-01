import hashlib
import json
import logging
import threading
import time
from collections import OrderedDict
from datetime import UTC, datetime
from uuid import UUID

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Path,
    Query,
    UploadFile,
    status,
)
from pydantic import BaseModel, Field
from sqlalchemy import case, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth, require_scope, require_web_auth
from app.core.config import settings
from app.core.database import get_session
from app.core.query_utils import like_needle
from app.models.scope import SCOPE_KIND_ENVIRONMENT, Scope
from app.models.session import AgentEnvironment, Session
from app.schemas.common import Paginated
from app.schemas.session import (
    EnvironmentCreate,
    EnvironmentCreatedResponse,
    EnvironmentResponse,
    SessionBatchRequest,
    SessionBatchResponse,
    SessionDetailResponse,
    SessionExtractResponse,
    SessionListItemResponse,
    SessionMessageResponse,
    SessionMessagesPage,
    SessionUploadResponse,
)
from app.services.file_store import get_file_store
from app.services.memory_extraction import extract_memories_from_session
from app.services.memory_provider import get_memory_provider

router = APIRouter(tags=["sessions"])
log = logging.getLogger(__name__)

file_store = get_file_store()


# In-process cache for parsed `/api/sessions/{id}/messages`
# blobs. Each unique (file_key, content_hash) snapshot is parsed
# once and re-sliced on subsequent paginated requests. Without
# this, a 50-page scroll through a long session re-downloads and
# re-parses the same 10 MB JSON blob 50 times — the pagination
# fix is then load-bearing for bandwidth alone, not latency.
#
# Bounded: at most _MESSAGES_CACHE_MAX entries (LRU-ish — we
# touch by reinserting on hit). Each entry holds the parsed list
# (Python objects), which for a 10 MB JSON blob with ~5k messages
# is roughly 30-50 MB of resident memory. 16 × 50 MB = ~800 MB
# worst case, well within typical app server budget. TTL is
# also set so a long-quiet entry doesn't pin memory; the
# content_hash component of the key already invalidates a
# stale snapshot, so TTL is just memory hygiene.
_MESSAGES_CACHE_MAX = 16
_MESSAGES_CACHE_TTL_S = 300.0
_messages_cache: OrderedDict[tuple[str, str], tuple[float, list]] = OrderedDict()
_messages_cache_lock = threading.Lock()


def _messages_cache_get(key: tuple[str, str]) -> list | None:
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


def _messages_cache_put(key: tuple[str, str], parsed: list) -> None:
    now = time.monotonic()
    with _messages_cache_lock:
        _messages_cache[key] = (now, parsed)
        _messages_cache.move_to_end(key)
        while len(_messages_cache) > _MESSAGES_CACHE_MAX:
            _messages_cache.popitem(last=False)


def _bound_env_id(auth: AuthContext) -> UUID | None:
    """Return the env_id this caller is bound to, or None for
    Clerk JWT (multi-env) callers. Bound api_keys carry an
    `environment_id` on their key row; that's the blast-radius
    boundary every session read/write must respect."""
    if auth.is_cli and auth.api_key is not None:
        return auth.api_key.environment_id
    return None


@router.post("/api/environments")
async def register_environment(
    body: EnvironmentCreate,
    # Daemons register themselves on `clawdi setup`; they hold a
    # write-scoped key. Without `require_scope`, a read-only key
    # could create new env rows that the rest of the heartbeat /
    # session path then refuses to write — half-registered ghosts
    # in the dashboard.
    auth: AuthContext = Depends(require_scope("skills:write")),
    db: AsyncSession = Depends(get_session),
) -> EnvironmentCreatedResponse:
    # Bound deploy keys are pinned to a single env. Letting them
    # create *new* envs (and new env-local scopes) would let a
    # leaked key expand the account's footprint — beyond the scope
    # of the binding. Allow the idempotent re-register of the same
    # env (machine_id / agent_type match the one the key is bound
    # to) so daemons can survive `clawdi setup` re-runs without
    # rotating keys, but reject everything else with 403.
    if auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None:
        bound = auth.api_key.environment_id
        # Defense-in-depth: a key bound to env X must also belong to
        # the calling user. The mint flow already enforces this, but
        # a bug there shouldn't combine with a machine_id collision
        # to let one user's key register an env on someone else's
        # account. Filter by user_id too.
        bound_env = (
            await db.execute(
                select(AgentEnvironment).where(
                    AgentEnvironment.id == bound,
                    AgentEnvironment.user_id == auth.user_id,
                )
            )
        ).scalar_one_or_none()
        if (
            bound_env is None
            or bound_env.machine_id != body.machine_id
            or bound_env.agent_type != body.agent_type
        ):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail={
                    "code": "env_binding_violation",
                    "message": (
                        "Bound API keys cannot register new environments. "
                        "Use a Clerk-authenticated dashboard session or a "
                        "non-bound CLI key."
                    ),
                    "bound_environment_id": str(bound),
                },
            )

    # Check if environment already exists for this user + machine.
    # `with_for_update()` row-locks the env so concurrent
    # `clawdi setup` re-registrations serialize through the
    # heal path below — without the lock both requests would
    # read default_scope_id IS NULL, both would INSERT a new
    # scope, and the second writer would overwrite env's
    # default_scope_id with its own scope, orphaning the first.
    result = await db.execute(
        select(AgentEnvironment)
        .where(
            AgentEnvironment.user_id == auth.user_id,
            AgentEnvironment.machine_id == body.machine_id,
            AgentEnvironment.agent_type == body.agent_type,
        )
        .with_for_update()
    )
    env = result.scalar_one_or_none()

    if env:
        env.machine_name = body.machine_name
        env.agent_version = body.agent_version
        env.last_seen_at = datetime.now(UTC)
        # Heal envs that somehow ended up without a default_scope_id —
        # this row predates the scope migration, was created via a
        # path that bypassed the new-env branch below, or had its
        # scope dropped by an earlier broken cleanup. The daemon's
        # boot path requires a scope to upload anything; without
        # this backfill, re-running `clawdi setup` against an old
        # env still leaves the daemon dead at startup with the
        # opaque "environment X has no default_scope_id" fatal.
        # Concurrent calls are serialized by the FOR UPDATE row
        # lock above — the second writer sees default_scope_id
        # already set and skips this branch.
        if env.default_scope_id is None:
            import uuid as _uuid

            healing_slug = f"env-{_uuid.uuid4().hex[:12]}"
            healing_scope = Scope(
                user_id=auth.user_id,
                name=f"{body.machine_name} ({body.agent_type})",
                slug=healing_slug,
                kind=SCOPE_KIND_ENVIRONMENT,
                origin_environment_id=env.id,
            )
            db.add(healing_scope)
            await db.flush()
            env.default_scope_id = healing_scope.id
        await db.commit()
        return EnvironmentCreatedResponse(id=str(env.id))

    # Mutual FK between env.default_scope_id (NOT NULL → scope) and
    # scope.origin_environment_id (NULLABLE → env). Insert order:
    #   1. scope without origin_environment_id (slug pre-computed
    #      from a fresh UUID so it's stable across the two writes)
    #   2. env with default_scope_id = scope.id
    #   3. update scope.origin_environment_id = env.id
    #
    # Concurrent `clawdi setup` runs for the same (user, machine,
    # agent) race here. The new
    # `uq_agent_envs_user_machine_agent` constraint at the model
    # layer means the second writer's commit raises IntegrityError;
    # we catch it, rollback, and re-query for the winner's row.
    import uuid as _uuid

    from sqlalchemy.exc import IntegrityError

    pending_slug = f"env-{_uuid.uuid4().hex[:12]}"
    scope = Scope(
        user_id=auth.user_id,
        name=f"{body.machine_name} ({body.agent_type})",
        slug=pending_slug,
        kind=SCOPE_KIND_ENVIRONMENT,
    )
    db.add(scope)
    try:
        await db.flush()

        env = AgentEnvironment(
            user_id=auth.user_id,
            machine_id=body.machine_id,
            machine_name=body.machine_name,
            agent_type=body.agent_type,
            agent_version=body.agent_version,
            os=body.os,
            last_seen_at=datetime.now(UTC),
            default_scope_id=scope.id,
        )
        db.add(env)
        await db.flush()

        scope.origin_environment_id = env.id
        await db.commit()
        await db.refresh(env)
        return EnvironmentCreatedResponse(id=str(env.id))
    except IntegrityError:
        await db.rollback()
        # Winner's row is committed; re-fetch and return its id
        # so both clients see the same env.
        result = await db.execute(
            select(AgentEnvironment).where(
                AgentEnvironment.user_id == auth.user_id,
                AgentEnvironment.machine_id == body.machine_id,
                AgentEnvironment.agent_type == body.agent_type,
            )
        )
        winner = result.scalar_one_or_none()
        if winner is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "concurrent registration race; retry the request",
            ) from None
        return EnvironmentCreatedResponse(id=str(winner.id))


@router.get("/api/environments")
async def list_environments(
    # Bare get_auth is intentional. Even narrowly-scoped api_keys
    # (e.g. the legacy `sessions:write`-only deploy key) need to
    # discover their own env at boot to find its default_scope.
    # Auth is enforced via the user_id filter + the env-binding
    # restriction below — a bound key only sees its own env regardless
    # of scope list, and an unscoped key is just the user themselves.
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> list[EnvironmentResponse]:
    # Bound api_keys (deploy keys) only see their own env.
    # Returning every env of the user would let a leaked deploy
    # key enumerate sibling machines and their default_scope_ids
    # — the whole point of the env binding is to bound the blast
    # radius of a leaked key. The full list stays available to
    # Clerk JWT (dashboard) callers.
    bound_env = _bound_env_id(auth)
    stmt = (
        select(AgentEnvironment)
        .where(AgentEnvironment.user_id == auth.user_id)
        .order_by(AgentEnvironment.last_seen_at.desc())
    )
    if bound_env is not None:
        stmt = stmt.where(AgentEnvironment.id == bound_env)
    result = await db.execute(stmt)
    envs = result.scalars().all()
    return [_env_to_response(e) for e in envs]


@router.get("/api/environments/{environment_id}")
async def get_environment(
    environment_id: UUID,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> EnvironmentResponse:
    # Bound api_keys may only fetch their own env. Without this an
    # env-A deploy key could probe sibling envs by id and read their
    # `default_scope_id` — the same boundary that list_environments
    # enforces, applied per-row.
    bound_env = _bound_env_id(auth)
    if bound_env is not None and environment_id != bound_env:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent not found")
    result = await db.execute(
        select(AgentEnvironment).where(
            AgentEnvironment.id == environment_id,
            AgentEnvironment.user_id == auth.user_id,
        )
    )
    env = result.scalar_one_or_none()
    if not env:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent not found")
    return _env_to_response(env)


def _env_to_response(env: AgentEnvironment) -> EnvironmentResponse:
    return EnvironmentResponse(
        id=str(env.id),
        machine_name=env.machine_name,
        agent_type=env.agent_type,
        agent_version=env.agent_version,
        os=env.os,
        last_seen_at=env.last_seen_at,
        last_sync_at=env.last_sync_at,
        last_sync_error=env.last_sync_error,
        last_revision_seen=env.last_revision_seen,
        queue_depth_high_water=env.queue_depth_high_water_since_start,
        dropped_count=env.dropped_count_since_start,
        sync_enabled=env.sync_enabled,
        # NOT NULL per schema; the heal path in register_environment
        # backfills any legacy row missing this column before the
        # response is built, so we always have a value here.
        default_scope_id=str(env.default_scope_id),
    )


@router.delete("/api/environments/{environment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_environment(
    environment_id: UUID,
    # Dashboard-only: a leaked deploy-key would otherwise be able
    # to delete its own env (de-registering the machine on the
    # owner's dashboard) or sibling envs under the same user.
    # Mirrors the lockdown applied to /api/auth/keys in round 6.
    auth: AuthContext = Depends(require_web_auth),
    db: AsyncSession = Depends(get_session),
) -> None:
    """Delete an agent environment. Existing sessions remain (orphaned)
    so users don't lose history when removing a machine. The session
    list query uses an outer-join so orphaned rows still render."""
    result = await db.execute(
        select(AgentEnvironment).where(
            AgentEnvironment.id == environment_id,
            AgentEnvironment.user_id == auth.user_id,
        )
    )
    env = result.scalar_one_or_none()
    if not env:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent not found")
    await db.delete(env)
    await db.commit()


class SyncHeartbeatRequest(BaseModel):
    """Daemon-emitted observability snapshot for `clawdi serve`.

    Sent every ~30s even on quiet cycles so the dashboard's
    "Last synced: X ago" indicator stays fresh and the operator
    can spot a stalled daemon (no heartbeats for >5 min) without
    waiting for an actual sync event.
    """

    last_revision_seen: int | None = Field(default=None, ge=0)
    last_sync_error: str | None = Field(default=None, max_length=2000)
    # Both counters are monotonic non-negative observables. Without
    # `ge=0` a malformed payload with a negative value would
    # silently decrement the running totals on the env row. The
    # daemon's `drainDroppedDelta` always returns >= 0 so this is a
    # boundary defense, not a regression for correct clients.
    queue_depth: int | None = Field(default=None, ge=0)
    dropped_count_delta: int | None = Field(default=None, ge=0)


@router.post("/api/agents/{environment_id}/sync-heartbeat", status_code=status.HTTP_204_NO_CONTENT)
async def sync_heartbeat(
    environment_id: UUID,
    body: SyncHeartbeatRequest,
    # Heartbeat is the daemon's write path for liveness fields. A
    # read-only key would otherwise be able to write `last_sync_error
    # = None` and mask a real outage. `skills:write` is the daemon's
    # canonical write scope (it always pushes skills), so reuse it.
    auth: AuthContext = Depends(require_scope("skills:write")),
    db: AsyncSession = Depends(get_session),
) -> None:
    """Daemon writes its liveness state here every cycle. Extreme-
    light endpoint: validate ownership / env-id binding, update a
    handful of columns, commit. No heavy queries.
    """
    env = (
        await db.execute(
            select(AgentEnvironment).where(
                AgentEnvironment.id == environment_id,
                AgentEnvironment.user_id == auth.user_id,
            )
        )
    ).scalar_one_or_none()
    if env is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "agent environment not found")

    # If the deploy-key is bound to a specific env, refuse calls
    # for any other env. Resource-level scope alone wasn't enough
    # — without this, a key from pod A could heartbeat under
    # pod B's id and corrupt B's observability fields.
    if (
        auth.is_cli
        and auth.api_key is not None
        and auth.api_key.environment_id is not None
        and auth.api_key.environment_id != environment_id
    ):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "api key bound to a different environment",
        )

    # Conditional write: skip the UPDATE entirely when nothing
    # interesting has changed since the prior heartbeat. Daemons
    # heartbeat every 30s; with N daemons per user × M users
    # this was the single highest-write hot path in the backend.
    # Now we only commit when last_sync_error flips, queue HWM
    # advances, dropped delta is non-zero, or sync_enabled needs
    # to flip on — all real state-change signals. last_sync_at
    # advances on every commit (so the dashboard's "live" badge
    # transitions still fire) but we throttle commits to one per
    # 30s of *content change*, not one per heartbeat. The badge
    # logic on the dashboard tolerates last_sync_at being stale
    # by up to ~90s.
    now = datetime.now(UTC)
    new_error = body.last_sync_error
    new_revision = body.last_revision_seen
    has_state_change = (
        env.last_sync_error != new_error
        or (new_revision is not None and env.last_revision_seen != new_revision)
        or (
            body.queue_depth is not None
            and body.queue_depth > env.queue_depth_high_water_since_start
        )
        or bool(body.dropped_count_delta)
        or not env.sync_enabled
    )
    # Even with no state change, refresh last_sync_at if the
    # previous value is older than 30s — the dashboard freshness
    # cutoff is 90s, so a 30s refresh keeps the badge "live"
    # without writing on every single heartbeat.
    last = env.last_sync_at
    needs_freshness_refresh = last is None or (now - last).total_seconds() > 30
    if not has_state_change and not needs_freshness_refresh:
        return
    env.last_sync_at = now
    env.last_sync_error = new_error
    if new_revision is not None:
        env.last_revision_seen = new_revision
    if body.queue_depth is not None and body.queue_depth > env.queue_depth_high_water_since_start:
        env.queue_depth_high_water_since_start = body.queue_depth
    if body.dropped_count_delta:
        env.dropped_count_since_start = (
            env.dropped_count_since_start or 0
        ) + body.dropped_count_delta
    # A heartbeat IS the user opting in: they ran `clawdi serve` (or
    # installed the launchd / systemd unit) and the daemon is
    # successfully posting liveness. The `sync_enabled` flag was a
    # canary toggle so existing envs wouldn't auto-pick-up sync at
    # rollout — it has done its job once an actual heartbeat arrives.
    if not env.sync_enabled:
        env.sync_enabled = True
    await db.commit()


@router.post("/api/sessions/batch")
async def batch_create_sessions(
    body: SessionBatchRequest,
    auth: AuthContext = Depends(require_scope("sessions:write")),
    db: AsyncSession = Depends(get_session),
) -> SessionBatchResponse:
    """Ingest a batch of sessions from a CLI sync.

    Upserts every row by `(user_id, local_session_id)`. The response tells
    the client which sessions still need a content upload — either because
    the stored hash differs from the one just sent, or because no content
    has ever been uploaded for that row (`file_key IS NULL`).
    """
    if not body.sessions:
        return SessionBatchResponse(
            created=0, updated=0, unchanged=0, needs_content=[], rejected=[]
        )

    # Env-bound deploy-keys must NOT be able to write sessions
    # under a different env_id, even one the same user owns. The
    # whole point of the env binding is to bound the blast radius
    # of a leaked deploy-key — without this check, a key from
    # pod A could land sessions on pod B's environment and the
    # dashboard would attribute them to the wrong machine.
    # `sync_heartbeat` already enforces the same invariant; we
    # were inconsistent here.
    if auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None:
        bound = auth.api_key.environment_id
        offending = {s.environment_id for s in body.sessions if s.environment_id != bound}
        if offending:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail={
                    "code": "env_binding_violation",
                    "message": (
                        "API key is bound to a single environment; cannot write "
                        "sessions under a different environment_id."
                    ),
                    "bound_environment_id": str(bound),
                    "offending_environment_ids": [str(e) for e in offending],
                },
            )

    # Reject any environment_id the caller doesn't own. Without this check the
    # CLI's local cache (a stale env id from a previous account / a deleted
    # env) lands in the DB and turns up as "Unknown" agent in the dashboard
    # because the outerjoin in list_sessions returns nulls. Refuse the whole
    # batch — partial accept would silently drop the user's sessions and
    # they'd never know.
    requested_env_ids = {s.environment_id for s in body.sessions}
    valid_env_ids = set(
        (
            await db.execute(
                select(AgentEnvironment.id).where(
                    AgentEnvironment.id.in_(requested_env_ids),
                    AgentEnvironment.user_id == auth.user_id,
                )
            )
        )
        .scalars()
        .all()
    )
    missing = requested_env_ids - valid_env_ids
    if missing:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "unknown_environment",
                "message": (
                    "Environment id is no longer registered for this account. "
                    "Run `clawdi setup` to re-register this machine, then retry."
                ),
                "environment_ids": [str(e) for e in missing],
            },
        )

    # Pre-fetch the existing rows for diffing. One indexed lookup against
    # `uq_sessions_user_local` per batch — cheap, and keeps the diff logic
    # in Python where it's testable. Doing the diff via a CTE on the upsert
    # would be slightly faster but much harder to read and harder to keep
    # in lockstep with the SessionBatchResponse contract.
    #
    # Also includes `environment_id` so the env-binding check below can
    # see what env each row currently lives in. The unique key is
    # `(user_id, local_session_id)` — without that check, a bound env-A
    # api_key could send a payload with `local_session_id` matching an
    # existing env-B row; the payload-side env match passes (it claims
    # env-A), and the upsert's ON CONFLICT path then overwrites
    # environment_id from B to A. Bound key effectively steals the row.
    #
    # `with_for_update()` closes the TOCTOU between the env-binding
    # check below and the upsert that follows. Without the row lock,
    # a concurrent JWT (dashboard) write could rebind environment_id
    # in the gap; the bound-key check would pass on the stale read,
    # then the upsert overwrites again. Locking the rows for the rest
    # of this transaction makes the (read, check, write) sequence
    # atomic from the perspective of any other writer.
    incoming_ids = [s.local_session_id for s in body.sessions]
    existing_rows = (
        await db.execute(
            select(
                Session.local_session_id,
                Session.environment_id,
                Session.content_hash,
                Session.file_key,
            )
            .where(
                Session.user_id == auth.user_id,
                Session.local_session_id.in_(incoming_ids),
            )
            .with_for_update()
        )
    ).all()
    existing_by_id = {row.local_session_id: row for row in existing_rows}

    # Bound-key cross-env steal guard. Reject if any pre-existing row
    # belongs to an env other than the one the caller is bound to.
    if auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None:
        bound = auth.api_key.environment_id
        stolen = [
            row.local_session_id
            for row in existing_rows
            if row.environment_id is not None and row.environment_id != bound
        ]
        if stolen:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail={
                    "code": "env_binding_violation",
                    "message": (
                        "Some local_session_ids in this batch belong to a "
                        "different environment. Bound API keys cannot rebind "
                        "sessions across environments."
                    ),
                    "bound_environment_id": str(bound),
                    "offending_local_session_ids": stolen,
                },
            )

    # Cross-env mismatch guard for ALL callers (bound and unbound).
    # The bound check above only fires when the caller is bound; an
    # UNBOUND CLI key (multi-agent / dashboard JWT) writing
    # `s.environment_id=Y` for a row that already lives in env=X
    # would slip past it. Without this check the upsert WHERE below
    # turns the conflict into a no-op (correctly), but the response
    # is still computed from the pre-upsert snapshot — the caller
    # gets `created`/`needs_content` and then POSTs upload content
    # to `/api/sessions/{local_session_id}/upload`, which resolves
    # the row by `local_session_id` alone and stamps the new bytes
    # onto the OTHER env's row. Cross-env data corruption.
    incoming_env_by_id = {s.local_session_id: s.environment_id for s in body.sessions}
    mismatched = [
        row.local_session_id
        for row in existing_rows
        if (
            row.environment_id is not None
            and incoming_env_by_id.get(row.local_session_id) is not None
            and row.environment_id != incoming_env_by_id[row.local_session_id]
        )
    ]
    if mismatched:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "session_env_mismatch",
                "message": (
                    "Some local_session_ids in this batch already live in a "
                    "different environment. Sessions are pinned to the env "
                    "that first wrote them; either delete the offending "
                    "sessions from the dashboard or push with the correct "
                    "environment_id."
                ),
                "offending_local_session_ids": mismatched,
            },
        )

    rows = [
        {
            "user_id": auth.user_id,
            "environment_id": s.environment_id,
            "local_session_id": s.local_session_id,
            "project_path": s.project_path,
            "started_at": s.started_at,
            "ended_at": s.ended_at,
            "duration_seconds": s.duration_seconds,
            "message_count": s.message_count,
            "input_tokens": s.input_tokens,
            "output_tokens": s.output_tokens,
            "cache_read_tokens": s.cache_read_tokens,
            "model": s.model,
            "models_used": s.models_used,
            "summary": s.summary,
            "tags": s.tags,
            "status": s.status,
            "content_hash": s.content_hash,
        }
        for s in body.sessions
    ]

    insert_stmt = pg_insert(Session).values(rows)
    # Refresh every metadata field on conflict. Identity (`id`, `user_id`,
    # `local_session_id`, `created_at`) is preserved, and `file_key` /
    # `content_uploaded_at` belong to the upload endpoint — don't clobber.
    # When content_hash changes, also null out `file_key` and
    # `content_uploaded_at` so the blob ↔ hash invariant holds. Without
    # this, the silent-data-loss path is:
    #   1. push H1 → upload K1 → DB (H1, K1)                      ✓
    #   2. user edits, push H2 → DB (H2, K1) [old blob, new hash] ✗
    #   3. client uploads H2 content but request fails
    #   4. retry push H2 → server sees prev.content_hash == H2,
    #      not in `needs_content`, client never re-uploads
    #   → DB claims H2 but blob bytes are still H1's.
    # With the case-clear, step 2 lands as (H2, NULL), and step 4's
    # `prev.file_key is None` branch (see needs_content categorization
    # below) re-enqueues the upload. Hash unchanged → file_key kept,
    # so a no-op re-push doesn't churn the blob.
    hash_changed = Session.content_hash.is_distinct_from(insert_stmt.excluded.content_hash)
    upsert_stmt = insert_stmt.on_conflict_do_update(
        constraint="uq_sessions_user_local",
        set_={
            "environment_id": insert_stmt.excluded.environment_id,
            "project_path": insert_stmt.excluded.project_path,
            "started_at": insert_stmt.excluded.started_at,
            "ended_at": insert_stmt.excluded.ended_at,
            "duration_seconds": insert_stmt.excluded.duration_seconds,
            "message_count": insert_stmt.excluded.message_count,
            "input_tokens": insert_stmt.excluded.input_tokens,
            "output_tokens": insert_stmt.excluded.output_tokens,
            "cache_read_tokens": insert_stmt.excluded.cache_read_tokens,
            "model": insert_stmt.excluded.model,
            "models_used": insert_stmt.excluded.models_used,
            "summary": insert_stmt.excluded.summary,
            "tags": insert_stmt.excluded.tags,
            "status": insert_stmt.excluded.status,
            "content_hash": insert_stmt.excluded.content_hash,
            "file_key": case((hash_changed, None), else_=Session.file_key),
            "content_uploaded_at": case((hash_changed, None), else_=Session.content_uploaded_at),
            # Only bump `updated_at` when the content actually changed.
            # Without this, a re-push of unchanged sessions (e.g. empty
            # client cache, multi-machine sync, manual cache reset) would
            # touch every row and reshuffle the dashboard's "Last activity"
            # sort to "everything happened just now". `IS DISTINCT FROM` is
            # NULL-safe so legacy rows with content_hash IS NULL also
            # behave correctly: they get a real bump on first proper push.
            "updated_at": case((hash_changed, func.now()), else_=Session.updated_at),
        },
        # Refuse cross-env rebinds at the conflict step itself. The
        # pre-fetch FOR UPDATE check above guards the case where the
        # row already exists, but two env-bound keys racing on a
        # never-before-seen `local_session_id` BOTH pass the pre-
        # check (no row to lock). The first INSERT wins; the second
        # falls through to ON CONFLICT and would otherwise overwrite
        # `environment_id`. The `WHERE` here makes the upsert a no-op
        # if the existing row's env doesn't match the incoming one,
        # so the second writer's row stays bound to the FIRST writer's
        # env. Combined with the post-upsert categorization below
        # (which still sees the correct `prev.environment_id`), the
        # second writer just gets `unchanged`/`updated` for its own
        # metadata edits without changing the env binding.
        #
        # Two allow-cases:
        #   (a) `environment_id` matches the incoming env (same
        #       writer or legitimate same-env update). NULL=NULL
        #       counts as a match via IS NOT DISTINCT FROM, so a
        #       legacy push with no env_id still updates an
        #       env_id-NULL row.
        #   (b) Existing row has `environment_id IS NULL` —
        #       orphaned by `ON DELETE SET NULL` after its
        #       original env was deleted, OR a legacy row from
        #       before scope_id existed. A new env adopting the
        #       orphan is the right outcome (otherwise the row
        #       stays unreachable forever; the client would
        #       silently drop it from `needs_content` and the
        #       session would never re-upload).
        where=or_(
            Session.environment_id.is_(None),
            Session.environment_id.is_not_distinct_from(insert_stmt.excluded.environment_id),
        ),
    )
    # Concurrent `DELETE /api/environments/{id}` between the pre-flight
    # SELECT and this UPSERT can still race the FK. PG sqlstate 23503 means
    # FK violation specifically; anything else (we no longer hit unique
    # collisions because of the upsert) bubbles as a plain 500.
    # RETURNING the local_session_ids that PG actually wrote. When
    # the conflict-WHERE rejects a row (cross-env race the
    # pre-fetch couldn't catch — see comment on the upsert WHERE),
    # PG omits that row from RETURNING. The set difference vs the
    # incoming ids gives us no-ops, which we must exclude from the
    # response below. Without this, the loser of a two-bound-keys
    # race on a never-before-seen `local_session_id` gets told its
    # row was `created` and that it should upload content; the
    # follow-up POST `/api/sessions/{local_session_id}/upload` then
    # 404s because the row that DID land belongs to the winner's
    # env (not visible to the loser). Worse, an unbound caller in
    # the same race window would bypass the pre-check and stamp
    # bytes onto the winner's row.
    try:
        upserted_id_rows = (await db.execute(upsert_stmt.returning(Session.local_session_id))).all()
        await db.commit()
    except IntegrityError as e:
        await db.rollback()
        sqlstate = getattr(e.orig, "sqlstate", None) or getattr(e.orig, "pgcode", None)
        if sqlstate != "23503":
            raise
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "unknown_environment",
                "message": (
                    "Environment was removed mid-upload. "
                    "Run `clawdi setup` to re-register this machine, then retry."
                ),
            },
        ) from e

    # Categorize each row by comparing the pre-fetch snapshot against the
    # incoming payload. The pre-fetch sees the row as it was BEFORE this
    # batch, so we get clean created / updated / unchanged buckets without
    # needing a second round-trip or PG's `xmax` trick.
    created = 0
    updated = 0
    unchanged = 0
    needs_content: list[str] = []
    rejected: list[str] = []
    upserted_ids = {row[0] for row in upserted_id_rows}
    for s in body.sessions:
        if s.local_session_id not in upserted_ids:
            # Upsert filtered this row out at the conflict-WHERE
            # step (cross-env race window: pre-fetch saw no row,
            # the first writer landed its INSERT, our second
            # writer's ON CONFLICT mismatched env). Surface the
            # id explicitly so the CLI/daemon doesn't write a
            # stale lock entry under the assumption that any
            # 200-without-needs_content id was successfully
            # synced. Loser retries on the next change; the next
            # batch's pre-fetch will see the winner's row and
            # return a clean 409 `session_env_mismatch`.
            rejected.append(s.local_session_id)
            continue
        prev = existing_by_id.get(s.local_session_id)
        if prev is None:
            created += 1
            needs_content.append(s.local_session_id)
        elif prev.file_key is None:
            # Row existed but never had content uploaded (e.g. previous
            # upload failed mid-flight). Treat as updated — metadata may
            # have changed too, and definitely needs content.
            updated += 1
            needs_content.append(s.local_session_id)
        elif prev.content_hash is None or prev.content_hash != s.content_hash:
            updated += 1
            needs_content.append(s.local_session_id)
        else:
            unchanged += 1

    return SessionBatchResponse(
        created=created,
        updated=updated,
        unchanged=unchanged,
        needs_content=needs_content,
        rejected=rejected,
    )


# Allow-list of columns the client can sort by. Hard-coded to avoid SQL
# injection and so we can promise a stable order for pagination.
# Note: `tokens` is a synthetic key — the UI shows total tokens (in + out) so
# sort by the sum expression, not just one column.
_SESSION_SORT_COLUMNS = {
    # `updated_at` is the default — the upsert path bumps it whenever a
    # session's metadata or content_hash changes, so this orders newest-
    # activity-first across both first-push and append-message flows.
    # Sorting by `started_at` would freeze a session in its original spot
    # forever, even after dozens of new messages.
    "updated_at": Session.updated_at,
    "started_at": Session.started_at,
    "message_count": Session.message_count,
    "tokens": Session.input_tokens + Session.output_tokens,
}


@router.get("/api/sessions")
async def list_sessions(
    # Deploy keys carry `sessions:write` (they upload sessions from
    # hosted pods) but explicitly NOT `sessions:read` — pods are
    # write-only "tail" producers. Without this gate a leaked pod
    # key could enumerate every session in its env, including
    # summaries and project_paths it had no business reading.
    auth: AuthContext = Depends(require_scope("sessions:read")),
    db: AsyncSession = Depends(get_session),
    q: str | None = Query(default=None, description="Fuzzy search on summary/project/id"),
    agent: str | None = Query(default=None, description="Filter by agent_type"),
    environment_id: UUID | None = Query(default=None, description="Filter by agent environment"),
    sort: str = Query(
        default="updated_at",
        pattern=r"^(updated_at|started_at|message_count|tokens)$",
    ),
    order: str = Query(default="desc", pattern=r"^(asc|desc)$"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=200),
    since: datetime | None = Query(default=None),
) -> Paginated[SessionListItemResponse]:
    # Env binding: a bound api_key (deploy key) can only see its
    # own env's sessions. Without this, a key for env A would list
    # env B's sessions because user_id alone doesn't fence them.
    # Reject an explicit `environment_id` query that doesn't match
    # the binding rather than silently overriding it — the caller
    # asking for the wrong env is a bug worth surfacing.
    bound_env = _bound_env_id(auth)
    if bound_env is not None and environment_id is not None and environment_id != bound_env:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "api key bound to a different environment",
        )

    base = (
        select(Session, AgentEnvironment.agent_type, AgentEnvironment.machine_name)
        .outerjoin(AgentEnvironment, Session.environment_id == AgentEnvironment.id)
        .where(Session.user_id == auth.user_id)
    )
    if bound_env is not None:
        base = base.where(Session.environment_id == bound_env)
    if since:
        base = base.where(Session.started_at >= since)
    if agent:
        base = base.where(AgentEnvironment.agent_type == agent)
    if environment_id:
        base = base.where(Session.environment_id == environment_id)
    if q:
        # ILIKE on three columns — kept simple; pg_trgm GIN index on these
        # columns is on the to-do list for when session volume grows.
        needle = like_needle(q)
        base = base.where(
            or_(
                Session.summary.ilike(needle, escape="\\"),
                Session.project_path.ilike(needle, escape="\\"),
                Session.local_session_id.ilike(needle, escape="\\"),
            )
        )

    sort_col = _SESSION_SORT_COLUMNS[sort]
    base = base.order_by(sort_col.asc() if order == "asc" else sort_col.desc())

    total = (await db.execute(select(func.count()).select_from(base.subquery()))).scalar_one()

    rows = (await db.execute(base.limit(page_size).offset((page - 1) * page_size))).all()

    return Paginated[SessionListItemResponse](
        items=[_session_to_response(s, at, mn) for s, at, mn in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/api/sessions/{session_id}")
async def get_session_detail(
    session_id: UUID,
    auth: AuthContext = Depends(require_scope("sessions:read")),
    db: AsyncSession = Depends(get_session),
) -> SessionDetailResponse:
    bound_env = _bound_env_id(auth)
    stmt = (
        select(Session, AgentEnvironment.agent_type, AgentEnvironment.machine_name)
        .outerjoin(AgentEnvironment, Session.environment_id == AgentEnvironment.id)
        .where(
            Session.user_id == auth.user_id,
            Session.id == session_id,
        )
    )
    if bound_env is not None:
        # 404 not 403: never leak that a session exists in a
        # different env to a key that can't see it.
        stmt = stmt.where(Session.environment_id == bound_env)
    result = await db.execute(stmt)
    row = result.first()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")

    session, agent_type, machine_name = row
    return SessionDetailResponse(
        **_session_to_response(session, agent_type, machine_name).model_dump(),
        has_content=bool(session.file_key),
    )


@router.post("/api/sessions/{local_session_id}/upload")
async def upload_session_content(
    # Constrained to safe filename chars so it cannot escape the
    # `sessions/{user_id}/` prefix in the file-store key below.
    local_session_id: str = Path(..., pattern=r"^[A-Za-z0-9][A-Za-z0-9._\-]{0,199}$"),
    file: UploadFile = File(...),
    auth: AuthContext = Depends(require_scope("sessions:write")),
    db: AsyncSession = Depends(get_session),
) -> SessionUploadResponse:
    """Upload session messages JSON to FileStore."""
    bound_env = _bound_env_id(auth)
    stmt = select(Session).where(
        Session.user_id == auth.user_id,
        Session.local_session_id == local_session_id,
    )
    if bound_env is not None:
        # Bound api_keys can only write within their env. A NULL
        # `environment_id` (orphan from a since-deleted env) is
        # treated as "not yours" — without this an orphaned
        # session would be a silent shared write target.
        stmt = stmt.where(Session.environment_id == bound_env)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")

    # Stream the upload in bounded chunks, refusing once total
    # bytes cross the cap. The global `BodySizeLimitMiddleware`
    # already rejects oversized declared Content-Length at the
    # ASGI layer; this defense-in-depth path catches chunked /
    # streamed uploads (no Content-Length header) where the
    # middleware can't decide. `await file.read()` without bound
    # would pull arbitrarily large bodies into memory first.
    _MAX_SESSION_CONTENT_BYTES = 50 * 1024 * 1024  # 50 MB
    chunks: list[bytes] = []
    total = 0
    chunk_size = 1024 * 1024  # 1 MB
    while True:
        chunk = await file.read(chunk_size)
        if not chunk:
            break
        total += len(chunk)
        if total > _MAX_SESSION_CONTENT_BYTES:
            raise HTTPException(
                status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                f"Session content exceeds {_MAX_SESSION_CONTENT_BYTES} bytes",
            )
        chunks.append(chunk)
    data = b"".join(chunks)
    # Hash the bytes we're about to store so the row's `content_hash`
    # always describes the actual stored object — not whatever the client
    # claimed in the batch payload. This is what closes the historical
    # DB↔file-store drift: even if a multipart proxy mangles bytes, the
    # hash on disk matches the hash in the row.
    content_hash = hashlib.sha256(data).hexdigest()

    fk = f"sessions/{auth.user_id}/{local_session_id}.json"
    await file_store.put(fk, data)

    session.file_key = fk
    session.content_hash = content_hash
    session.content_uploaded_at = datetime.now(UTC)
    await db.commit()

    return SessionUploadResponse(status="uploaded", file_key=fk, content_hash=content_hash)


@router.get("/api/sessions/{session_id}/content")
async def get_session_content(
    session_id: UUID,
    # Same write-only-deploy-key rationale as list_sessions: pods
    # don't read session content, only push their own. Plaintext
    # message bodies must not be reachable without sessions:read.
    auth: AuthContext = Depends(require_scope("sessions:read")),
    db: AsyncSession = Depends(get_session),
) -> list[SessionMessageResponse]:
    """Read session messages from FileStore, typed as SessionMessageResponse[]."""
    bound_env = _bound_env_id(auth)
    stmt = select(Session).where(
        Session.user_id == auth.user_id,
        Session.id == session_id,
    )
    if bound_env is not None:
        stmt = stmt.where(Session.environment_id == bound_env)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")

    if not session.file_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session content not uploaded")

    try:
        data = await file_store.get(session.file_key)
    except Exception:
        # Logging the underlying error keeps storage failures
        # (S3 timeouts, permission errors, missing keys) visible
        # in server logs instead of being permanently swallowed
        # behind a generic 404. Client still sees a 404 — internal
        # storage detail must not leak in the response.
        log.exception(
            "session_content_fetch_failed file_key=%s",
            session.file_key,
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session content file not found") from None

    # Session content was written by the CLI; if it's not valid JSON or not
    # the expected shape, something went wrong on upload — surface a generic
    # server error to the client and log the detail server-side so we don't
    # leak stored-data shape assumptions.
    try:
        raw = json.loads(data)
    except json.JSONDecodeError:
        log.exception("session %s content is not valid JSON", session_id)
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Internal server error")

    if not isinstance(raw, list):
        log.error("session %s content is not a JSON array (got %s)", session_id, type(raw).__name__)
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Internal server error")

    return [SessionMessageResponse.model_validate(m) for m in raw]


@router.get("/api/sessions/{session_id}/messages")
async def get_session_messages(
    session_id: UUID,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    auth: AuthContext = Depends(require_scope("sessions:read")),
    db: AsyncSession = Depends(get_session),
) -> SessionMessagesPage:
    """Paginated read of a session's messages, for the dashboard.
    The CLI's `clawdi pull` mirror still uses
    `GET /api/sessions/{id}/content` to grab the full JSON blob;
    this endpoint slices the same blob server-side so the
    dashboard doesn't ship 10+ MB of messages on a long session.

    Pagination is offset-based, NOT cursor-based: the underlying
    file-store blob is immutable per upload (each push replaces
    the entire JSON array), so `array[offset:offset+limit]` is
    stable for a given `content_hash`. Clients pin to a snapshot
    by reading `content_hash` from the parent
    `/api/sessions/{id}` response and refusing to mix pages
    from different hashes — a daemon append in between would
    show up as a hash change and trigger a refetch.
    """
    bound_env = _bound_env_id(auth)
    stmt = select(Session).where(
        Session.user_id == auth.user_id,
        Session.id == session_id,
    )
    if bound_env is not None:
        stmt = stmt.where(Session.environment_id == bound_env)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")

    if not session.file_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session content not uploaded")

    # Cache the parsed list keyed on (file_key, content_hash).
    # Both components matter:
    #   - file_key uniquely identifies the blob in object
    #     storage (multiple sessions can hold byte-identical
    #     content; their separate file_keys keep their cache
    #     entries distinct).
    #   - content_hash invalidates the cache when the daemon
    #     re-uploads (common during a live conversation).
    # Without this cache, a 50-page scroll re-downloads +
    # re-parses the same 10 MB blob 50 times — same backend
    # latency as the legacy full-content endpoint, just split
    # across more requests. With it, page 1 pays the parse
    # cost and pages 2..N are pure dict slicing.
    cache_hash = session.content_hash or ""
    cache_key = (session.file_key, cache_hash)
    raw = _messages_cache_get(cache_key)
    if raw is None:
        try:
            data = await file_store.get(session.file_key)
        except Exception:
            log.exception("session_content_fetch_failed file_key=%s", session.file_key)
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, "Session content file not found"
            ) from None

        try:
            raw = json.loads(data)
        except json.JSONDecodeError:
            log.exception("session %s content is not valid JSON", session_id)
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Internal server error")

        if not isinstance(raw, list):
            log.error(
                "session %s content is not a JSON array (got %s)",
                session_id,
                type(raw).__name__,
            )
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Internal server error")
        _messages_cache_put(cache_key, raw)

    total = len(raw)
    sliced = raw[offset : offset + limit]
    return SessionMessagesPage(
        items=[SessionMessageResponse.model_validate(m) for m in sliced],
        total=total,
        offset=offset,
        limit=limit,
    )


@router.post("/api/sessions/{local_session_id}/extract")
async def extract_session_memories(
    local_session_id: str = Path(..., pattern=r"^[A-Za-z0-9][A-Za-z0-9._\-]{0,199}$"),
    auth: AuthContext = Depends(require_scope("memories:write")),
    db: AsyncSession = Depends(get_session),
) -> SessionExtractResponse:
    """Extract memories from a session's content via the configured LLM.

    Uses `local_session_id` for path lookup (mirrors the upload endpoint
    pattern) — `uq_sessions_user_local` makes that a unique index.

    Not idempotent — every call hits the LLM. Onboarding loops over
    each session exactly once; the future dashboard button is a
    user-initiated single click. Tracking "already extracted" state
    on the server would force us to also reason about session updates
    (re-pushed content with new turns), which is more complexity than
    a one-shot $0.001 LLM call is worth.
    """
    if not settings.llm_api_key:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "LLM is not configured on this deployment",
        )

    bound_env = _bound_env_id(auth)
    stmt = select(Session).where(
        Session.user_id == auth.user_id,
        Session.local_session_id == local_session_id,
    )
    if bound_env is not None:
        stmt = stmt.where(Session.environment_id == bound_env)
    session = (await db.execute(stmt)).scalar_one_or_none()
    if not session:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    if not session.file_key:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Session content has not been uploaded",
        )

    try:
        data = await file_store.get(session.file_key)
    except Exception:
        # Logging the underlying error keeps storage failures
        # (S3 timeouts, permission errors, missing keys) visible
        # in server logs instead of being permanently swallowed
        # behind a generic 404. Client still sees a 404 — internal
        # storage detail must not leak in the response.
        log.exception(
            "session_content_fetch_failed file_key=%s",
            session.file_key,
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session content file not found") from None

    try:
        messages = json.loads(data)
    except json.JSONDecodeError:
        log.exception("session %s content is not valid JSON", session.id)
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Internal server error")
    if not isinstance(messages, list):
        log.error(
            "session %s content is not a JSON array (got %s)",
            session.id,
            type(messages).__name__,
        )
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Internal server error")

    # Local import keeps the openai SDK off the cold-start critical path
    # for routes that don't need it.
    from openai import AsyncOpenAI

    client = AsyncOpenAI(
        base_url=settings.llm_base_url or None,
        api_key=settings.llm_api_key,
    )
    extracted = await extract_memories_from_session(
        messages,
        project_path=session.project_path,
        client=client,
        model=settings.llm_model,
    )

    provider = await get_memory_provider(str(auth.user_id), db)
    for m in extracted:
        await provider.add(
            user_id=str(auth.user_id),
            content=m.content,
            category=m.category,
            source="session",
            tags=m.tags or None,
            source_session_id=session.id,
        )

    return SessionExtractResponse(memories_created=len(extracted))


def _session_to_response(
    s: Session,
    agent_type: str | None = None,
    machine_name: str | None = None,
) -> SessionListItemResponse:
    return SessionListItemResponse(
        id=str(s.id),
        local_session_id=s.local_session_id,
        project_path=s.project_path,
        agent_type=agent_type,
        machine_name=machine_name,
        started_at=s.started_at,
        ended_at=s.ended_at,
        updated_at=s.updated_at,
        duration_seconds=s.duration_seconds,
        message_count=s.message_count,
        input_tokens=s.input_tokens,
        output_tokens=s.output_tokens,
        cache_read_tokens=s.cache_read_tokens,
        model=s.model,
        models_used=s.models_used,
        summary=s.summary,
        tags=s.tags,
        status=s.status,
        content_hash=s.content_hash,
    )
