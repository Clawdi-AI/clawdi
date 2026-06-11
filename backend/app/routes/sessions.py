import hashlib
import json
import logging
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Path,
    Query,
    Response,
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
from app.models.hosted_runtime import HostedRuntimeState
from app.models.project import PROJECT_KIND_ENVIRONMENT, Project
from app.models.session import AgentEnvironment, Session
from app.models.session_permission import (
    PERMISSION_KIND_LINK,
    PERMISSION_KINDS,
    SessionPermission,
)
from app.schemas.common import Paginated
from app.schemas.session import (
    EnvironmentCreate,
    EnvironmentCreatedResponse,
    EnvironmentResponse,
    RuntimeObservedDesiredResponse,
    RuntimeObservedHealthResponse,
    RuntimeObservedResponse,
    SessionBatchRequest,
    SessionBatchResponse,
    SessionDetailResponse,
    SessionExtractResponse,
    SessionListItemResponse,
    SessionMessageResponse,
    SessionMessagesPage,
    SessionPermissionCreate,
    SessionPermissionResponse,
    SessionPermissionsResponse,
    SessionUploadResponse,
)
from app.services.file_store import get_file_store
from app.services.memory_extraction import extract_memories_from_session
from app.services.memory_provider import get_memory_provider
from app.services.session_content import (
    SessionContentInvalid,
    SessionContentMissing,
    load_session_messages,
)
from app.services.session_export import session_to_markdown
from app.services.session_refs import extract_related_refs

router = APIRouter(tags=["sessions"])
log = logging.getLogger(__name__)

file_store = get_file_store()
_MAX_RUNTIME_OBSERVED_BYTES = 64 * 1024
_RUNTIME_OBSERVED_STALE_AFTER = timedelta(seconds=90)


def _bound_env_id(auth: AuthContext) -> UUID | None:
    """Return the env_id this caller is bound to, or None for
    Clerk JWT (multi-env) callers. Bound api_keys carry an
    `environment_id` on their key row; that's the blast-radius
    boundary every session read/write must respect."""
    if auth.is_cli and auth.api_key is not None:
        return auth.api_key.environment_id
    return None


# Clock-skew window for client-supplied `last_activity_at`. Anything
# more than this far in the future is treated as a sign of broken
# client clocks (laptop NTP off, container with wrong timezone) or a
# malicious daemon trying to game the dashboard's "Last activity"
# sort. We clamp rather than reject so the rest of the upsert still
# lands — losing the bogus timestamp is always better than failing
# the whole batch.
_LAST_ACTIVITY_FUTURE_SLACK = timedelta(minutes=5)


def _clamp_last_activity(
    client_supplied: datetime | None,
    started_at: datetime,
    ended_at: datetime | None,
) -> datetime:
    """Resolve a session's `last_activity_at`, falling back through
    progressively-less-trusted sources and clamping to a sane
    range.

    Priority:
      1. `client_supplied` (= max of message timestamps from the
         JSONL, computed by the adapter). Most accurate when sane.
      2. `ended_at` (adapter-defined; sometimes null).
      3. `started_at` (always present; lower bound).

    Bounds:
      - Lower: never before `started_at` — a session can't have
        activity before it started.
      - Upper: never more than 5 minutes in the future relative to
        the server clock. Adapters should not be sending timestamps
        from beyond now; if they do, the most likely cause is a
        skewed client clock and we treat the value as unreliable.
    """
    now = datetime.now(UTC)
    upper = now + _LAST_ACTIVITY_FUTURE_SLACK
    # Clamp the fallback inputs to [.., now] before they feed into
    # `candidate`. A payload that pushes BOTH `last_activity_at`
    # AND `started_at`/`ended_at` into the future would otherwise
    # bypass the upper bound: `max(started, ended or now, now)`
    # returns the future value unchanged. Pydantic doesn't reject
    # future started_at/ended_at, so the only defense is here.
    safe_started = min(started_at, now)
    safe_ended = min(ended_at, now) if ended_at is not None else None
    candidate = client_supplied or ended_at or started_at
    # Clamp to [safe_started, now + slack].
    if candidate < safe_started:
        candidate = safe_started
    if candidate > upper:
        candidate = max(safe_started, safe_ended or now, now)
    return candidate


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
    # create *new* envs (and new env-local projects) would let a
    # leaked key expand the account's footprint — beyond the project
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
    # read default_project_id IS NULL, both would INSERT a new
    # project, and the second writer would overwrite env's
    # default_project_id with its own project, orphaning the first.
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
        # Heal envs that somehow ended up without a default_project_id —
        # this row predates the project migration, was created via a
        # path that bypassed the new-env branch below, or had its
        # project dropped by an earlier broken cleanup. The daemon's
        # boot path requires a project to upload anything; without
        # this backfill, re-running `clawdi setup` against an old
        # env still leaves the daemon dead at startup with the
        # opaque "environment X has no default_project_id" fatal.
        # Concurrent calls are serialized by the FOR UPDATE row
        # lock above — the second writer sees default_project_id
        # already set and skips this branch.
        if env.default_project_id is None:
            import uuid as _uuid

            healing_slug = f"env-{_uuid.uuid4().hex[:12]}"
            healing_project = Project(
                user_id=auth.user_id,
                name=f"{body.machine_name} ({body.agent_type})",
                slug=healing_slug,
                kind=PROJECT_KIND_ENVIRONMENT,
                origin_environment_id=env.id,
            )
            db.add(healing_project)
            await db.flush()
            env.default_project_id = healing_project.id
        await db.commit()
        return EnvironmentCreatedResponse(id=str(env.id))

    # Mutual FK between env.default_project_id (NOT NULL → project) and
    # project.origin_environment_id (NULLABLE → env). Insert order:
    #   1. project without origin_environment_id (slug pre-computed
    #      from a fresh UUID so it's stable across the two writes)
    #   2. env with default_project_id = project.id
    #   3. update project.origin_environment_id = env.id
    #
    # Concurrent `clawdi setup` runs for the same (user, machine,
    # agent) race here. The new
    # `uq_agent_envs_user_machine_agent` constraint at the model
    # layer means the second writer's commit raises IntegrityError;
    # we catch it, rollback, and re-query for the winner's row.
    import uuid as _uuid

    from sqlalchemy.exc import IntegrityError

    pending_slug = f"env-{_uuid.uuid4().hex[:12]}"
    project = Project(
        user_id=auth.user_id,
        name=f"{body.machine_name} ({body.agent_type})",
        slug=pending_slug,
        kind=PROJECT_KIND_ENVIRONMENT,
    )
    db.add(project)
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
            default_project_id=project.id,
        )
        db.add(env)
        await db.flush()

        project.origin_environment_id = env.id
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
    # discover their own env at boot to find its default_project.
    # Auth is enforced via the user_id filter + the env-binding
    # restriction below — a bound key only sees its own env regardless
    # of API permission list, and an unbound key is just the user
    # themselves.
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> list[EnvironmentResponse]:
    # Bound api_keys (deploy keys) only see their own env.
    # Returning every env of the user would let a leaked deploy
    # key enumerate sibling machines and their default_project_ids
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
    # `default_project_id` — the same boundary that list_environments
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


@router.get("/api/environments/{environment_id}/runtime-observed")
async def get_environment_runtime_observed(
    environment_id: UUID,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> RuntimeObservedResponse:
    bound_env = _bound_env_id(auth)
    if bound_env is not None and environment_id != bound_env:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent not found")

    env = (
        await db.execute(
            select(AgentEnvironment).where(
                AgentEnvironment.id == environment_id,
                AgentEnvironment.user_id == auth.user_id,
            )
        )
    ).scalar_one_or_none()
    if env is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent not found")

    state = (
        await db.execute(
            select(HostedRuntimeState).where(HostedRuntimeState.environment_id == environment_id)
        )
    ).scalar_one_or_none()
    return RuntimeObservedResponse(
        environment=_env_to_response(env),
        desired=_runtime_observed_desired(state) if state is not None else None,
        observed=state.observed if state is not None else None,
        health=_runtime_observed_health(env, state),
    )


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
        default_project_id=str(env.default_project_id),
    )


def _runtime_observed_desired(
    state: HostedRuntimeState,
) -> RuntimeObservedDesiredResponse:
    return RuntimeObservedDesiredResponse(
        deployment_id=state.deployment_id,
        instance_id=state.instance_id,
        generation=state.generation,
        provider_id=state.provider_id,
        enabled_runtimes=_enabled_runtime_names(state.runtimes),
        has_mcp=state.mcp is not None,
        has_tools=state.tools is not None,
        updated_at=state.updated_at,
    )


def _runtime_observed_health(
    env: AgentEnvironment,
    state: HostedRuntimeState | None,
) -> RuntimeObservedHealthResponse:
    if state is None:
        return RuntimeObservedHealthResponse(
            status="not_configured",
            reasons=["hosted_runtime_state_missing"],
        )

    reasons: list[str] = []
    observed = state.observed if isinstance(state.observed, dict) else None
    reported_at = _observed_reported_at(observed)
    now = datetime.now(UTC)

    if env.last_sync_error:
        reasons.append("daemon_error")
    if env.last_sync_at is None:
        reasons.append("daemon_never_heartbeat")
    elif now - _as_utc(env.last_sync_at) > _RUNTIME_OBSERVED_STALE_AFTER:
        reasons.append("daemon_stale")

    observed_status = observed.get("status") if observed is not None else None
    if observed is None:
        reasons.append("runtime_observed_missing")
    elif observed_status == "error":
        reasons.append("runtime_error")
    elif observed_status not in {"ok", "unknown"}:
        reasons.append("runtime_status_unknown")

    supervisor = observed.get("supervisor") if observed is not None else None
    supervisor_status = supervisor.get("status") if isinstance(supervisor, dict) else None
    if supervisor_status == "error":
        reasons.append("supervisor_error")
    elif supervisor_status == "unknown":
        reasons.append("supervisor_status_unknown")
    elif supervisor_status is not None and supervisor_status != "ok":
        reasons.append("supervisor_status_invalid")

    if observed is not None and reported_at is None:
        reasons.append("runtime_reported_at_missing")
    elif reported_at is not None and now - reported_at > _RUNTIME_OBSERVED_STALE_AFTER:
        reasons.append("runtime_observed_stale")

    if "daemon_error" in reasons or "runtime_error" in reasons or "supervisor_error" in reasons:
        status_value = "error"
    elif "daemon_stale" in reasons or "runtime_observed_stale" in reasons:
        status_value = "stale"
    elif observed_status == "ok" and not reasons:
        status_value = "ok"
    else:
        status_value = "unknown"

    return RuntimeObservedHealthResponse(
        status=status_value,
        reasons=reasons,
        reported_at=reported_at,
    )


def _enabled_runtime_names(runtimes: dict) -> list[str]:
    enabled: list[str] = []
    for name, raw in runtimes.items():
        if isinstance(raw, dict) and raw.get("enabled") is True:
            enabled.append(str(name))
    return sorted(enabled)


def _observed_reported_at(observed: dict[str, Any] | None) -> datetime | None:
    if observed is None:
        return None
    value = observed.get("reportedAt")
    if not isinstance(value, str):
        return None
    try:
        return _as_utc(datetime.fromisoformat(value.replace("Z", "+00:00")))
    except ValueError:
        return None


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


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
    """Daemon-emitted observability snapshot for `clawdi daemon`.

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
    runtime_observed: dict[str, Any] | None = None


def _bounded_runtime_observed(value: dict[str, Any] | None) -> dict[str, Any] | None:
    if value is None:
        return None
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    if len(encoded.encode("utf-8")) <= _MAX_RUNTIME_OBSERVED_BYTES:
        return value
    return {
        "schemaVersion": "clawdi.hostedRuntimeObserved.v1",
        "reportedAt": datetime.now(UTC).isoformat(),
        "status": "error",
        "error": "runtime observed payload exceeded size limit",
        "truncated": True,
    }


@router.post("/api/agents/{environment_id}/sync-heartbeat", status_code=status.HTTP_204_NO_CONTENT)
async def sync_heartbeat(
    environment_id: UUID,
    body: SyncHeartbeatRequest,
    # Heartbeat is the daemon's write path for liveness fields. A
    # read-only key would otherwise be able to write `last_sync_error
    # = None` and mask a real outage. `skills:write` is the daemon's
    # canonical write project (it always pushes skills), so reuse it.
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
    # for any other env. Resource-level project alone wasn't enough
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
    runtime_observed = _bounded_runtime_observed(body.runtime_observed)
    hosted_state = None
    observed_changed = False
    if runtime_observed is not None:
        hosted_state = (
            await db.execute(
                select(HostedRuntimeState).where(
                    HostedRuntimeState.environment_id == environment_id
                )
            )
        ).scalar_one_or_none()
        observed_changed = hosted_state is not None and hosted_state.observed != runtime_observed
    has_state_change = (
        env.last_sync_error != new_error
        or (new_revision is not None and env.last_revision_seen != new_revision)
        or (
            body.queue_depth is not None
            and body.queue_depth > env.queue_depth_high_water_since_start
        )
        or bool(body.dropped_count_delta)
        or not env.sync_enabled
        or observed_changed
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
    # A heartbeat IS the user opting in: they ran `clawdi daemon` (or
    # installed the launchd / systemd unit) and the daemon is
    # successfully posting liveness. The `sync_enabled` flag was a
    # canary toggle so existing envs wouldn't auto-pick-up sync at
    # rollout — it has done its job once an actual heartbeat arrives.
    if not env.sync_enabled:
        env.sync_enabled = True
    if hosted_state is not None and runtime_observed is not None:
        hosted_state.observed = runtime_observed
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

    # Agent API keys must NOT be able to write sessions
    # under a different env_id, even one the same user owns. The
    # whole point of the Agent boundary is to bound the blast radius
    # of a leaked deploy-key — without this check, a key from
    # Agent A could land sessions on Agent B's environment and the
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
            "last_activity_at": _clamp_last_activity(s.last_activity_at, s.started_at, s.ended_at),
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
            # `last_activity_at` is monotonically non-decreasing —
            # take the GREATER of the existing value and the new
            # one. Without `greatest()`, an out-of-order push (e.g.
            # daemon B pushes an older snapshot after daemon A
            # pushed a newer one) would clobber the dashboard's
            # "Last activity" with a stale timestamp.
            "last_activity_at": func.greatest(
                Session.last_activity_at, insert_stmt.excluded.last_activity_at
            ),
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
        # row already exists, but two Agent API keys racing on a
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
        #       before project_id existed. A new env adopting the
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
    # `last_activity_at` (derived from the JSONL's last message
    # timestamp) is the default — distinct from `updated_at`
    # (server-clock at upsert), which conflates "user used it" with
    # "daemon pushed it". See migration d2f9e1a0c4b3.
    "last_activity_at": Session.last_activity_at,
    # `updated_at` stays exposed for cache layers / incremental-fetch
    # consumers that want row-last-touched semantics.
    "updated_at": Session.updated_at,
    "started_at": Session.started_at,
    "message_count": Session.message_count,
    "tokens": Session.input_tokens + Session.output_tokens,
    # `relevance` is special-cased in the route: it's only valid when
    # `q` is non-empty (else it's silently ignored and we fall back
    # to `last_activity_at` so the empty-search default still works).
    # The actual ranking expression is built inline below from
    # `similarity(col, :q)` and isn't a static column.
}


# pg_trgm similarity threshold. Default `pg_trgm.similarity_threshold`
# is 0.3 which is fairly strict — close to "all the trigrams match".
# For typo tolerance ("athentication" still surfacing "authentication")
# we want something lower. 0.15 is the sweet spot from the memories
# search benchmark — captures typos and partial-word matches without
# drowning the results in distant relatives.
_TRGM_THRESHOLD = 0.15


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
    # Faceted filters. Multi-valued where the dashboard wants chip
    # multi-select (model, tag); scalar where the chip is single-pick
    # (min_messages, has_pr). All optional — list page renders the
    # full corpus with no filters as the default.
    model: list[str] | None = Query(default=None, description="Filter by model (multi)"),
    tag: list[str] | None = Query(
        default=None,
        description="Filter by tag (multi, AND semantics — every requested tag must be present)",
    ),
    min_messages: int | None = Query(
        default=None, ge=0, description="Only sessions with at least N messages"
    ),
    min_duration: int | None = Query(
        default=None, ge=0, description="Only sessions with duration_seconds >= N"
    ),
    has_pr: bool | None = Query(
        default=None,
        description="Filter to sessions that referenced a GitHub PR",
    ),
    automated: bool | None = Query(
        default=None,
        description=(
            "Filter cron/heartbeat sessions. Automated = summary starts with "
            "'Cron:' or '[' — the same heuristic the dashboard feed uses to "
            "mute them visually."
        ),
    ),
    sort: str = Query(
        default="last_activity_at",
        pattern=r"^(last_activity_at|updated_at|started_at|message_count|tokens|relevance)$",
    ),
    order: str = Query(default="desc", pattern=r"^(asc|desc)$"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=200),
    # Date-range filters operate on the same column the page sorted
    # by — `last_activity_at` for the default sort, so the filter
    # matches the dashboard's "show me sessions active in this
    # range" mental model. `since`/`until` are inclusive of `since`
    # and exclusive of `until` (half-open interval is what every
    # SQL date-range query convention uses; lets the frontend pick
    # "today" as `[start_of_today, start_of_tomorrow)` cleanly).
    since: datetime | None = Query(default=None, description="Filter to last_activity_at >= since"),
    until: datetime | None = Query(default=None, description="Filter to last_activity_at < until"),
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

    # `is_shared` is a correlated EXISTS — true when an active (non-revoked)
    # `kind='link'` row in `session_permissions` exists for this session.
    # Computing inline avoids a denormalized `sessions.visibility` column
    # (which would require app-code discipline to keep in sync on every
    # toggle). The partial unique index on
    # `session_permissions(session_id, kind, COALESCE(...)) WHERE revoked_at
    # IS NULL` makes this lookup index-only.
    is_shared_subq = _link_is_shared_subq()

    # Build the trigram relevance expression once — used both for
    # filtering (similarity > threshold) and for `sort=relevance`
    # (ORDER BY similarity DESC). Greatest-of-three so a match in
    # ANY of summary / project / id wins, and the strongest match
    # drives the rank. NULL-safe via COALESCE — sessions with NULL
    # summary still match if their project_path or id does.
    if q:
        sim_summary = func.similarity(func.coalesce(Session.summary, ""), q)
        sim_project = func.similarity(func.coalesce(Session.project_path, ""), q)
        sim_local = func.similarity(Session.local_session_id, q)
        relevance_expr = func.greatest(sim_summary, sim_project, sim_local)
    else:
        relevance_expr = None  # type: ignore[assignment]

    base = (
        select(
            Session,
            AgentEnvironment.agent_type,
            AgentEnvironment.machine_name,
            is_shared_subq,
        )
        .outerjoin(AgentEnvironment, Session.environment_id == AgentEnvironment.id)
        .where(Session.user_id == auth.user_id)
    )
    if bound_env is not None:
        base = base.where(Session.environment_id == bound_env)
    # Filter on `last_activity_at` (not `started_at`) so a long-
    # running session that began before the window but was active
    # inside it still surfaces under "Today" / "Last 7 days".
    if since:
        base = base.where(Session.last_activity_at >= since)
    if until:
        base = base.where(Session.last_activity_at < until)
    if agent:
        base = base.where(AgentEnvironment.agent_type == agent)
    if environment_id:
        base = base.where(Session.environment_id == environment_id)

    if model:
        base = base.where(Session.model.in_(model))
    if tag:
        # AND semantics for tags: every requested tag must be present.
        # `tags @> ARRAY[...]` is the indexable form vs N separate
        # `tags && ARRAY[t]` clauses.
        base = base.where(Session.tags.op("@>")(tag))
    if min_messages is not None:
        base = base.where(Session.message_count >= min_messages)
    if min_duration is not None:
        base = base.where(Session.duration_seconds >= min_duration)
    if has_pr is True:
        # `related_refs ? 'prs'` would also match `{"prs": null}` — we
        # want a non-empty array. The JSONB length check is explicit
        # and matches what `_session_to_response` carries.
        base = base.where(
            Session.related_refs.is_not(None),
            func.jsonb_array_length(Session.related_refs.op("->")("prs")) > 0,
        )
    elif has_pr is False:
        # Explicit "no PRs" — NULL `related_refs` (never extracted)
        # counts as "no PR".
        base = base.where(
            or_(
                Session.related_refs.is_(None),
                func.coalesce(
                    func.jsonb_array_length(Session.related_refs.op("->")("prs")),
                    0,
                )
                == 0,
            )
        )

    if automated is not None:
        # Heuristic, mirrored from the dashboard feed's muting regex
        # (^(Cron:|\[)). Most fleets are dominated by cron/heartbeat
        # sessions; "Manual only" is how users find their own work.
        # COALESCE so NULL summaries count as manual, not as neither.
        summary_text = func.coalesce(Session.summary, "")
        is_automated = or_(summary_text.like("Cron:%"), summary_text.like("[%"))
        base = base.where(is_automated if automated else ~is_automated)

    if q:
        # pg_trgm `similarity()` for typo / partial-word tolerance.
        # NOT index-accelerated — the function-call form doesn't trigger
        # the `gin_trgm_ops` operator class (only `%` / `<->` / `LIKE`
        # do). Runs as a Seq Scan over the user's session set; fine
        # for the typical few-thousand-rows-per-user. If a power user
        # ever hits real latency here, swap to `WHERE summary % :q`
        # plus a GIN index. Threshold tuned for "type to filter" UX.
        base = base.where(relevance_expr >= _TRGM_THRESHOLD)

    # Run the count BEFORE attaching ORDER BY: PG would otherwise
    # plan a sort over the full filtered set just to discard it for
    # COUNT(*). For 50k+ session users this saves a measurable
    # fraction of list-page latency.
    total = (await db.execute(select(func.count()).select_from(base.subquery()))).scalar_one()

    # Resolve sort column. `relevance` is special — only valid when
    # `q` is present (else fall back to the date default so the empty-
    # search experience doesn't break). The trgm-relevance expression
    # was built up above; reuse it here so the sort matches the
    # similarity used for filtering.
    if sort == "relevance":
        if relevance_expr is None:
            sort_col = _SESSION_SORT_COLUMNS["last_activity_at"]
        else:
            sort_col = relevance_expr
    else:
        sort_col = _SESSION_SORT_COLUMNS[sort]
    # Tiebreaker on `id` for deterministic offset-pagination order.
    # Without this, two rows with identical `last_activity_at`
    # values (same `func.greatest()` clamp output, same
    # `func.now()` from a backfill) can swap positions across
    # page boundaries — UUIDs are unique so this tiebreaker is total.
    ordered = base.order_by(
        sort_col.asc() if order == "asc" else sort_col.desc(),
        Session.id.asc(),
    )

    rows = (await db.execute(ordered.limit(page_size).offset((page - 1) * page_size))).all()

    return Paginated[SessionListItemResponse](
        items=[
            _session_to_response(s, at, mn, is_shared=bool(shared)) for s, at, mn, shared in rows
        ],
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
    is_shared_subq = _link_is_shared_subq()
    stmt = (
        select(
            Session,
            AgentEnvironment.agent_type,
            AgentEnvironment.machine_name,
            is_shared_subq,
        )
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

    session, agent_type, machine_name, is_shared = row
    return SessionDetailResponse(
        **_session_to_response(
            session, agent_type, machine_name, is_shared=bool(is_shared)
        ).model_dump(),
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

    # Extract `related_refs` server-side from the just-uploaded
    # messages for sidebar chips. Best-effort — a parse
    # failure here MUST NOT fail the upload (the bytes are already in
    # the file store and the row's content_hash is the source of truth;
    # we'd rather have a session with NULL related_refs than a
    # half-committed upload).
    try:
        parsed = json.loads(data)
        if isinstance(parsed, list):
            session.related_refs = extract_related_refs(parsed) or None
    except (json.JSONDecodeError, ValueError, TypeError):
        # log.exception (not warning) so the traceback lands in logs —
        # without it, debugging "why did this session land NULL refs"
        # means re-uploading and watching events live.
        log.exception(
            "refs_extract_failed local_session_id=%s — leaving field NULL",
            local_session_id,
        )

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

    # Shared loader handles the (file_key, content_hash)-keyed cache,
    # the file_store fetch, JSON parse, and shape validation. Lives in
    # `services/session_content.py` so the public share routes can
    # share the same cache — a popular shared link must not re-parse
    # a 10 MB JSON blob per visitor.
    try:
        raw = await load_session_messages(session, file_store)
    except SessionContentMissing:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session content file not found") from None
    except SessionContentInvalid:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "Internal server error"
        ) from None

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


# --- Owner-side export + Share-link routes ---------------------------------
#
# The `/export.md` route below is OWNER-readable via `require_scope("sessions:read")`
# — it serves both the dashboard and the MCP `session_read` tool's UUID
# branch (which authenticates as the CLI api-key user).
#
# The `/permissions` routes use `require_web_auth`, rejecting bound
# deploy keys outright: a leaked write-scoped daemon key has no
# legitimate business minting / revoking visibility grants on
# arbitrary sessions, so the gate stays on Clerk JWT.


@router.get("/api/sessions/{session_id}/export.md")
async def export_owned_session_markdown(
    session_id: UUID,
    auth: AuthContext = Depends(require_scope("sessions:read")),
    db: AsyncSession = Depends(get_session),
) -> Response:
    """Owner-side Markdown export — mirror of the public route.

    Feeds the MCP `session_read` tool's UUID branch: when the agent
    passes a session UUID (not a share token), the tool authenticates
    as the owner and hits this route. The body is byte-for-byte the
    same shape the public `.md` export returns — same `session_export.py`
    serializer — so an agent gets identical context whether the user
    referenced one of their own sessions or a shared link.

    Owner-only path → `public=False`: no `url:` line in the front-matter
    and `source` is `clawdi-session` instead of `clawdi-shared-session`
    so the LLM can tell the two apart if it cares.
    """
    bound_env = _bound_env_id(auth)
    stmt = (
        select(Session, AgentEnvironment.agent_type)
        .outerjoin(AgentEnvironment, Session.environment_id == AgentEnvironment.id)
        .where(
            Session.user_id == auth.user_id,
            Session.id == session_id,
        )
    )
    if bound_env is not None:
        stmt = stmt.where(Session.environment_id == bound_env)
    row = (await db.execute(stmt)).first()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    session, agent_type = row

    if not session.file_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session content not uploaded")

    try:
        messages = await load_session_messages(session, file_store)
    except SessionContentMissing:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session content file not found") from None
    except SessionContentInvalid:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "Internal server error"
        ) from None

    body = session_to_markdown(session, messages, agent_type=agent_type)
    return Response(
        content=body,
        media_type="text/markdown; charset=utf-8",
        # No public cache header here — the owner can re-upload at any
        # time and expects the next fetch to reflect it. The (file_key,
        # content_hash) cache in load_session_messages is the only layer
        # we actually want serving stale-but-correct bytes.
    )


@router.get("/api/sessions/{session_id}/permissions")
async def list_session_permissions(
    session_id: UUID,
    auth: AuthContext = Depends(require_web_auth),
    db: AsyncSession = Depends(get_session),
) -> SessionPermissionsResponse:
    """List active permissions for a session — drives the Share popover.

    Returns rows in newest-first order. Today the popover only renders
    the `kind='link'` row (if any); when invite-by-people lands, the
    same response shape powers the "people with access" list.
    """
    await _load_session_for_owner(db, auth, session_id)

    rows = (
        (
            await db.execute(
                select(SessionPermission)
                .where(
                    SessionPermission.session_id == session_id,
                    SessionPermission.revoked_at.is_(None),
                )
                .order_by(SessionPermission.created_at.desc())
            )
        )
        .scalars()
        .all()
    )
    return SessionPermissionsResponse(permissions=[_permission_to_response(p) for p in rows])


@router.post("/api/sessions/{session_id}/permissions")
async def create_session_permission(
    session_id: UUID,
    body: SessionPermissionCreate,
    auth: AuthContext = Depends(require_web_auth),
    db: AsyncSession = Depends(get_session),
) -> SessionPermissionResponse:
    """Idempotent permission grant.

    For today's "Public access" toggle the body is just
    `{"kind": "link"}`. The handler:
      - normalises the body (lowercases email, validates kind matches the
        identifier columns),
      - returns the existing active row if one already matches the
        composite key (so toggling on twice is a no-op),
      - inserts a new row otherwise. The
        `uq_active_permission_per_principal` partial unique index closes
        the race between concurrent callers — the loser's INSERT raises
        IntegrityError and we re-read.
    """
    await _load_session_for_owner(db, auth, session_id)
    kind, user_id, email = _validate_permission_create(body)

    # Fast path: active row already matches.
    existing = await _find_active_permission(db, session_id, kind, user_id, email)
    if existing is not None:
        return _permission_to_response(existing)

    new_perm = SessionPermission(
        session_id=session_id,
        kind=kind,
        user_id=user_id,
        email=email,
        role=body.role or "viewer",
        invited_by=auth.user_id,
        accepted_at=datetime.now(UTC) if kind != "email" else None,
    )
    db.add(new_perm)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        winner = await _find_active_permission(db, session_id, kind, user_id, email)
        if winner is None:
            # Index conflict but no row found — shouldn't happen with the
            # partial unique index. Surface as 500 so it can be debugged.
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "Permission insert raced and the winning row could not be located",
            )
        return _permission_to_response(winner)

    await db.refresh(new_perm)
    return _permission_to_response(new_perm)


@router.delete(
    "/api/sessions/{session_id}/permissions",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def revoke_session_permission(
    session_id: UUID,
    kind: str,
    user_id: UUID | None = None,
    email: str | None = None,
    auth: AuthContext = Depends(require_web_auth),
    db: AsyncSession = Depends(get_session),
) -> None:
    """Revoke the active permission matching the composite key.

    Toggle-off path: `DELETE …/permissions?kind=link`. Soft-delete
    (`revoked_at = now()`) preserves the row for future audit.
    """
    await _load_session_for_owner(db, auth, session_id)

    if kind not in PERMISSION_KINDS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown permission kind: {kind}")
    normalized_email = email.strip().lower() if email else None

    active = await _find_active_permission(db, session_id, kind, user_id, normalized_email)
    if active is not None:
        active.revoked_at = datetime.now(UTC)
        await db.commit()


def _validate_permission_create(
    body: SessionPermissionCreate,
) -> tuple[str, UUID | None, str | None]:
    """Validate the request body's kind/identifier consistency and
    normalise the email column. Returns (kind, user_id, email).

    Pydantic's Literal types already reject unknown `kind` / `role`
    values before this runs (422); we only enforce the cross-field
    invariants that Pydantic can't express declaratively.
    """
    kind = body.kind
    user_id = UUID(body.user_id) if body.user_id else None
    email = body.email.strip().lower() if body.email else None

    if kind == "link":
        if user_id is not None or email is not None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "kind=link must not carry a user_id or email",
            )
    elif kind == "user":
        if user_id is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "kind=user requires user_id")
        if email is not None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "kind=user must not carry an email",
            )
    elif kind == "email":
        if email is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "kind=email requires email")
        if user_id is not None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "kind=email must not carry a user_id",
            )
    return kind, user_id, email


async def _find_active_permission(
    db: AsyncSession,
    session_id: UUID,
    kind: str,
    user_id: UUID | None,
    email: str | None,
) -> SessionPermission | None:
    """Locate the single active row matching the composite key, or None."""
    stmt = select(SessionPermission).where(
        SessionPermission.session_id == session_id,
        SessionPermission.kind == kind,
        SessionPermission.revoked_at.is_(None),
    )
    if user_id is None:
        stmt = stmt.where(SessionPermission.user_id.is_(None))
    else:
        stmt = stmt.where(SessionPermission.user_id == user_id)
    if email is None:
        stmt = stmt.where(SessionPermission.email.is_(None))
    else:
        stmt = stmt.where(SessionPermission.email == email)
    return (await db.execute(stmt)).scalar_one_or_none()


def _session_to_response(
    s: Session,
    agent_type: str | None = None,
    machine_name: str | None = None,
    is_shared: bool = False,
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
        last_activity_at=s.last_activity_at,
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
        is_shared=is_shared,
        related_refs=s.related_refs,
    )


# --- Permission helpers ----------------------------------------------------


def _link_is_shared_subq():
    """Correlated EXISTS used in list/detail queries to compute
    `Session.is_shared`. True when an active `kind='link'` permission
    row exists for the session. Index-only via the partial unique
    index on `session_permissions(session_id, kind, COALESCE(...))
    WHERE revoked_at IS NULL`.
    """
    return (
        select(1)
        .where(
            SessionPermission.session_id == Session.id,
            SessionPermission.kind == PERMISSION_KIND_LINK,
            SessionPermission.revoked_at.is_(None),
        )
        .correlate(Session)
        .exists()
        .label("is_shared")
    )


def _permission_to_response(p: SessionPermission) -> SessionPermissionResponse:
    return SessionPermissionResponse(
        id=str(p.id),
        kind=p.kind,
        user_id=str(p.user_id) if p.user_id else None,
        email=p.email,
        role=p.role,
        invited_by=str(p.invited_by) if p.invited_by else None,
        accepted_at=p.accepted_at,
        expires_at=p.expires_at,
        created_at=p.created_at,
    )


async def _load_session_for_owner(
    db: AsyncSession,
    auth: AuthContext,
    session_id: UUID,
) -> Session:
    """Fetch a session the current caller is allowed to mutate.

    404s rather than 403s on visibility violations (env-binding mismatch)
    to avoid leaking which session-ids exist outside the caller's project.
    """
    bound_env = _bound_env_id(auth)
    stmt = select(Session).where(
        Session.user_id == auth.user_id,
        Session.id == session_id,
    )
    if bound_env is not None:
        stmt = stmt.where(Session.environment_id == bound_env)
    row = (await db.execute(stmt)).scalar_one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    return row
