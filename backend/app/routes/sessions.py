import asyncio
import hashlib
import json
import logging
import mimetypes
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, cast, overload
from uuid import UUID, uuid4

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Path,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from pydantic import BaseModel, Field, JsonValue, TypeAdapter, ValidationError, field_validator
from sqlalchemy import case, func, or_, select, text, tuple_, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import (
    AuthContext,
    get_auth,
    is_connected_agent_principal,
    require_any_scope,
    require_scope,
    require_web_auth,
)
from app.core.config import settings
from app.core.database import get_session
from app.models.agent_project_binding import AgentProjectBinding
from app.models.api_key import ApiKey
from app.models.hosted_runtime import HostedRuntimeConfigObservation, HostedRuntimeState
from app.models.memory import Memory
from app.models.session import (
    AgentEnvironment,
    Session,
    SessionEventChunk,
    SessionSyncSuppression,
)
from app.models.session_permission import (
    PERMISSION_KIND_LINK,
    PERMISSION_KINDS,
    SessionPermission,
)
from app.schemas.common import Paginated
from app.schemas.runtime import (
    HostedRuntimePlatformMcpServer,
    HostedRuntimeStdioMcpServer,
    PersistedHostedRuntimeBundledSkillEntry,
    PersistedHostedRuntimeMcp,
    PersistedHostedRuntimeSkills,
    validate_hosted_runtime_desired_state,
)
from app.schemas.runtime_observed import (
    HostedRuntimeObserved,
    HostedRuntimeObservedProviderPayload,
    HostedRuntimeObservedV2,
    RuntimeObservedConfigResponse,
    RuntimeObservedConfigSummaryResponse,
)
from app.schemas.session import (
    AgentMcpInventoryResponse,
    AgentReorderRequest,
    AgentResponse,
    AgentRuntimeObservedDesiredResponse,
    AgentRuntimeObservedResponse,
    EnvironmentCreate,
    EnvironmentCreatedResponse,
    EnvironmentReorderRequest,
    EnvironmentResponse,
    EnvironmentUpdate,
    RuntimeManagedSkillSummary,
    RuntimeObservedDesiredResponse,
    RuntimeObservedHealthResponse,
    RuntimeObservedProviderHealthResponse,
    RuntimeObservedResponse,
    RuntimeObservedSummaryCountsResponse,
    RuntimeObservedSummaryItemResponse,
    RuntimeObservedSummaryResponse,
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
    SessionSearchAnchorResponse,
    SessionSearchMatchResponse,
    SessionUploadResponse,
)
from app.services import memory_extraction
from app.services.agent_environments import (
    clear_connected_agent_registration,
    local_machine_registration_key,
    register_agent_environment,
)
from app.services.agent_lifecycle import (
    AgentLifecycleBoundaryError,
    active_agent_filter,
    archive_agent_and_project,
)
from app.services.file_store import get_file_store
from app.services.http_cache import if_none_match_contains, strong_json_etag
from app.services.memory_provider import get_memory_provider
from app.services.runtime_generation import resolve_runtime_apply_generation
from app.services.runtime_source import expected_runtime_bundle_v2_etag
from app.services.runtime_source_revision import (
    persisted_runtime_source_error,
    persisted_runtime_source_revision,
)
from app.services.session_content import (
    SessionContentInvalid,
    SessionContentMissing,
    load_session_message_projection,
    load_session_messages,
    session_has_uploaded_content,
    slice_session_messages,
)
from app.services.session_export import session_to_markdown
from app.services.session_refs import extract_related_refs
from app.services.session_search import (
    SearchableSessionMessage,
    best_session_message_matches,
    current_search_revision,
    replace_snapshot_search_index,
    searchable_snapshot_messages,
)
from app.services.sync_events import queue_environment_runtime_manifest_changed

router = APIRouter(tags=["sessions"])
log = logging.getLogger(__name__)

file_store = get_file_store()
_MAX_RUNTIME_OBSERVED_BYTES = 64 * 1024
_MAX_AGENT_AVATAR_BYTES = 2 * 1024 * 1024
_AGENT_AVATAR_PREFIX = "agent-avatars/"
_AGENT_AVATAR_KEY_RE = re.compile(r"^agent-avatars/[0-9a-f]{32}\.(png|jpg|webp)$")
_SESSION_LOCAL_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._\-]{0,199}$"
_RUNTIME_OBSERVED_STALE_AFTER = timedelta(seconds=settings.runtime_observation_freshness_seconds)
_AGENT_DISCONNECTED_ERROR_CODE = "agent_disconnected"
_RUNTIME_OBSERVED_ADAPTER = TypeAdapter(HostedRuntimeObserved)
_RELATED_REFS_ADAPTER: TypeAdapter[dict[str, list[str]]] = TypeAdapter(dict[str, list[str]])
_SESSION_MESSAGE_VALUES_ADAPTER: TypeAdapter[list[dict[str, JsonValue]]] = TypeAdapter(
    list[dict[str, JsonValue]]
)
_MANUAL_SESSION_SUMMARY_FILTER = text(
    "(sessions.summary IS NULL OR "
    "(sessions.summary NOT LIKE 'Cron:%' AND sessions.summary NOT LIKE '[%'))"
)


@dataclass(frozen=True, slots=True)
class _SessionUploadAnalysis:
    content_hash: str
    related_refs: dict[str, JsonValue] | None
    search_messages: list[SearchableSessionMessage]
    parse_error: Exception | None = None


def _analyze_session_upload_sync(data: bytes) -> _SessionUploadAnalysis:
    content_hash = hashlib.sha256(data).hexdigest()
    try:
        parsed = _SESSION_MESSAGE_VALUES_ADAPTER.validate_json(data)
        related_refs = _related_refs_json(extract_related_refs(parsed)) or None
        search_messages = searchable_snapshot_messages(parsed)
    except (ValidationError, ValueError, TypeError) as exc:
        return _SessionUploadAnalysis(content_hash, None, [], exc)
    return _SessionUploadAnalysis(content_hash, related_refs, search_messages)


async def _analyze_session_upload(data: bytes) -> _SessionUploadAnalysis:
    return await asyncio.to_thread(_analyze_session_upload_sync, data)


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


async def _register_agent_identity(
    body: EnvironmentCreate,
    auth: AuthContext,
    db: AsyncSession,
) -> EnvironmentCreatedResponse:
    registration_key = local_machine_registration_key(body.machine_id, body.agent_type)
    # Bound deploy keys are pinned to a single env. Letting them
    # create *new* envs (and new env-local projects) would let a
    # leaked key expand the account's footprint — beyond the project
    # of the binding. Allow the idempotent re-register of the same
    # registration key so daemons can survive `clawdi setup` re-runs
    # without rotating keys, but reject everything else with 403.
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
        if bound_env is None or bound_env.registration_key != registration_key:
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

    try:
        registered = await register_agent_environment(
            db,
            user_id=auth.user_id,
            machine_id=body.machine_id,
            machine_name=body.machine_name,
            agent_type=body.agent_type,
            agent_version=body.agent_version,
            os_name=body.os,
            sort_order=await _next_environment_sort_order(db, auth.user_id),
            registration_key=registration_key,
            commit=False,
        )
    except IntegrityError:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "concurrent registration race; retry the request",
        ) from None
    connected_registration = False
    if is_connected_agent_principal(auth):
        hosted_state = await db.get(HostedRuntimeState, registered.env.id)
        environment_bound_key_id = await db.scalar(
            select(ApiKey.id).where(ApiKey.environment_id == registered.env.id).limit(1)
        )
        connected_registration = hosted_state is None and environment_bound_key_id is None
    if connected_registration:
        # This durable origin evidence authorizes Connected-only runtime APIs.
        # Existing Hosted V2 state or a Legacy V1 environment-bound key prevents
        # an account-level CLI token from reclassifying that Agent identity.
        registered.env.connected_agent_registered_at = datetime.now(UTC)
        registered.env.adapter_modules = body.adapter_modules
    else:
        # A managed or environment-bound registration is positive evidence
        # against the Connected runtime shape; do not retain its observations.
        clear_connected_agent_registration(registered.env)
    await db.commit()
    return EnvironmentCreatedResponse(id=str(registered.env.id))


@router.post("/agents")
async def register_agent(
    body: EnvironmentCreate,
    # Daemons register themselves on `clawdi setup`; they hold a
    # write-scoped key. Without a write-scope gate, a read-only key
    # could create new agent rows that the rest of the heartbeat /
    # session path then refuses to write — half-registered ghosts
    # in the dashboard.
    auth: AuthContext = Depends(require_any_scope("sessions:write", "skills:write")),
    db: AsyncSession = Depends(get_session),
) -> EnvironmentCreatedResponse:
    return await _register_agent_identity(body, auth, db)


@router.post("/environments", deprecated=True)
async def register_environment(
    body: EnvironmentCreate,
    auth: AuthContext = Depends(require_any_scope("sessions:write", "skills:write")),
    db: AsyncSession = Depends(get_session),
) -> EnvironmentCreatedResponse:
    return await _register_agent_identity(body, auth, db)


@overload
async def _list_agent_identities(
    request: Request,
    response: Response,
    auth: AuthContext,
    db: AsyncSession,
    *,
    agent_response: Literal[True],
    project_id: UUID | None = None,
) -> list[AgentResponse] | Response: ...


@overload
async def _list_agent_identities(
    request: Request,
    response: Response,
    auth: AuthContext,
    db: AsyncSession,
    *,
    agent_response: Literal[False],
    project_id: UUID | None = None,
) -> list[EnvironmentResponse] | Response: ...


async def _list_agent_identities(
    request: Request,
    response: Response,
    auth: AuthContext,
    db: AsyncSession,
    *,
    agent_response: bool,
    project_id: UUID | None = None,
) -> list[AgentResponse] | list[EnvironmentResponse] | Response:
    # Bound api_keys (deploy keys) only see their own env.
    # Returning every env of the user would let a leaked deploy
    # key enumerate sibling machines and their default_project_ids
    # — the whole point of the env binding is to bound the blast
    # radius of a leaked key. The full list stays available to
    # Clerk JWT (dashboard) callers.
    bound_env = _bound_env_id(auth)
    stmt = (
        select(AgentEnvironment)
        .where(AgentEnvironment.user_id == auth.user_id, active_agent_filter())
        .order_by(
            AgentEnvironment.sort_order.asc(),
            AgentEnvironment.created_at.asc(),
            AgentEnvironment.id.asc(),
        )
    )
    if bound_env is not None:
        stmt = stmt.where(AgentEnvironment.id == bound_env)
    if project_id is not None:
        stmt = stmt.join(
            AgentProjectBinding,
            AgentProjectBinding.agent_id == AgentEnvironment.id,
        ).where(AgentProjectBinding.project_id == project_id)
    result = await db.execute(stmt)
    envs = result.scalars().all()
    hosted_deployment_ids: dict[UUID, str] = {}
    env_ids = [env.id for env in envs]
    if not agent_response and env_ids:
        hosted_deployment_ids = await _hosted_deployment_ids(db, env_ids)
    payload = [
        _identity_response(
            e,
            hosted_deployment_ids.get(e.id),
            agent_response=agent_response,
        )
        for e in envs
    ]
    etag = strong_json_etag([item.model_dump(mode="json") for item in payload])
    headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
    if if_none_match_contains(request.headers.get("if-none-match"), etag):
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    response.headers.update(headers)
    return payload


@router.get(
    "/agents",
    response_model=list[AgentResponse],
    responses={status.HTTP_304_NOT_MODIFIED: {"description": "Not Modified"}},
)
async def list_agents(
    request: Request,
    response: Response,
    project_id: UUID | None = Query(
        default=None,
        description="Return only the caller's Agents linked to this exact Project.",
    ),
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> list[AgentResponse] | Response:
    return await _list_agent_identities(
        request,
        response,
        auth,
        db,
        agent_response=True,
        project_id=project_id,
    )


@router.get(
    "/environments",
    response_model=list[EnvironmentResponse],
    responses={status.HTTP_304_NOT_MODIFIED: {"description": "Not Modified"}},
    deprecated=True,
)
async def list_environments(
    request: Request,
    response: Response,
    # Bare get_auth is intentional. Even narrowly-scoped api_keys
    # (e.g. the legacy `sessions:write`-only deploy key) need to
    # discover their own env at boot to find its default_project.
    # Auth is enforced via the user_id filter + the env-binding
    # restriction below — a bound key only sees its own env regardless
    # of API permission list, and an unbound key is just the user
    # themselves.
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> list[EnvironmentResponse] | Response:
    return await _list_agent_identities(request, response, auth, db, agent_response=False)


@overload
async def _get_agent_identity(
    agent_id: UUID,
    request: Request,
    response: Response,
    auth: AuthContext,
    db: AsyncSession,
    *,
    agent_response: Literal[True],
) -> AgentResponse | Response: ...


@overload
async def _get_agent_identity(
    agent_id: UUID,
    request: Request,
    response: Response,
    auth: AuthContext,
    db: AsyncSession,
    *,
    agent_response: Literal[False],
) -> EnvironmentResponse | Response: ...


async def _get_agent_identity(
    agent_id: UUID,
    request: Request,
    response: Response,
    auth: AuthContext,
    db: AsyncSession,
    *,
    agent_response: bool,
) -> AgentResponse | EnvironmentResponse | Response:
    bound_env = _bound_env_id(auth)
    if bound_env is not None and agent_id != bound_env:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent not found")
    row = (
        await db.execute(
            select(AgentEnvironment, HostedRuntimeState.deployment_id)
            .outerjoin(
                HostedRuntimeState,
                HostedRuntimeState.environment_id == AgentEnvironment.id,
            )
            .where(
                AgentEnvironment.id == agent_id,
                AgentEnvironment.user_id == auth.user_id,
            )
        )
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent not found")
    env, hosted_deployment_id = row
    if env.archived_at is not None:
        # The owner may distinguish their retained, disconnected identity from
        # a random id. The user_id predicate above and bound-id fence before the
        # query keep nonexistent, cross-owner, and mismatched bound ids at 404.
        # Released daemons already treat 403 as a no-restart supervisor stop.
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail={
                "code": _AGENT_DISCONNECTED_ERROR_CODE,
                "message": "Agent is disconnected",
            },
        )
    payload = _identity_response(
        env,
        hosted_deployment_id,
        agent_response=agent_response,
    )
    etag = strong_json_etag(payload.model_dump(mode="json"))
    headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
    if if_none_match_contains(request.headers.get("if-none-match"), etag):
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    response.headers.update(headers)
    return payload


@router.get(
    "/environments/runtime-observed",
    response_model=RuntimeObservedSummaryResponse,
    deprecated=True,
)
async def list_environment_runtime_observed(
    limit: int = Query(default=100, ge=1, le=500),
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> RuntimeObservedSummaryResponse:
    bound_env = _bound_env_id(auth)
    filters = [AgentEnvironment.user_id == auth.user_id, active_agent_filter()]
    if bound_env is not None:
        filters.append(AgentEnvironment.id == bound_env)

    envs = (
        (
            await db.execute(
                select(AgentEnvironment)
                .where(*filters)
                .order_by(
                    AgentEnvironment.sort_order.asc(),
                    AgentEnvironment.created_at.asc(),
                    AgentEnvironment.id.asc(),
                )
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    env_ids = [env.id for env in envs]
    states_by_env: dict[UUID, HostedRuntimeState] = {}
    source_revisions: dict[UUID, str] = {}
    source_errors: set[UUID] = set()
    desired_cli_specs: dict[UUID, str] = {}
    observations_by_env: dict[UUID, HostedRuntimeConfigObservation] = {}
    if env_ids:
        states = list(
            (
                await db.execute(
                    select(HostedRuntimeState).where(HostedRuntimeState.environment_id.in_(env_ids))
                )
            ).scalars()
        )
        states_by_env = {state.environment_id: state for state in states}
        for state in states:
            revision = persisted_runtime_source_revision(state)
            desired_cli_specs[state.environment_id] = state.cli_package_spec
            if revision is not None:
                source_revisions[state.environment_id] = revision
            elif persisted_runtime_source_error(state):
                source_errors.add(state.environment_id)
        observations = (
            (
                await db.execute(
                    select(HostedRuntimeConfigObservation).where(
                        HostedRuntimeConfigObservation.environment_id.in_(env_ids)
                    )
                )
            )
            .scalars()
            .all()
        )
        observations_by_env = {
            observation.environment_id: observation for observation in observations
        }
    counts = RuntimeObservedSummaryCountsResponse()
    items: list[RuntimeObservedSummaryItemResponse] = []
    for env in envs:
        state = states_by_env.get(env.id)
        observation = observations_by_env.get(env.id)
        health = _runtime_observed_health(
            env,
            state,
            observation,
            desired_source_revision=source_revisions.get(env.id),
            desired_source_error=env.id in source_errors,
            desired_cli_package_spec=desired_cli_specs.get(env.id),
        )
        setattr(counts, health.status, getattr(counts, health.status) + 1)
        items.append(
            RuntimeObservedSummaryItemResponse(
                environment=_env_to_response(env, state),
                desired=(
                    _runtime_observed_desired(
                        state,
                        source_revision=source_revisions.get(env.id),
                    )
                    if state is not None
                    else None
                ),
                observed=_runtime_observed_summary(observation),
                health=health,
                provider_health=_runtime_observed_provider_health(state, observation),
            )
        )
    return RuntimeObservedSummaryResponse(counts=counts, items=items)


@router.get(
    "/agents/runtime-observed",
    response_model=RuntimeObservedSummaryResponse,
)
async def list_agent_runtime_observed(
    limit: int = Query(default=100, ge=1, le=500),
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> RuntimeObservedSummaryResponse:
    return await list_environment_runtime_observed(limit=limit, auth=auth, db=db)


@overload
async def _reorder_agent_identities(
    requested_ids: list[UUID], auth: AuthContext, db: AsyncSession, *, agent_response: Literal[True]
) -> list[AgentResponse]: ...


@overload
async def _reorder_agent_identities(
    requested_ids: list[UUID],
    auth: AuthContext,
    db: AsyncSession,
    *,
    agent_response: Literal[False],
) -> list[EnvironmentResponse]: ...


async def _reorder_agent_identities(
    requested_ids: list[UUID],
    auth: AuthContext,
    db: AsyncSession,
    *,
    agent_response: bool,
) -> list[AgentResponse] | list[EnvironmentResponse]:
    requested_set = set(requested_ids)
    if len(requested_set) != len(requested_ids):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Duplicate agent ids in order")

    envs = (
        (
            await db.execute(
                select(AgentEnvironment)
                .where(AgentEnvironment.user_id == auth.user_id)
                .where(active_agent_filter())
                .order_by(
                    AgentEnvironment.sort_order.asc(),
                    AgentEnvironment.created_at.asc(),
                    AgentEnvironment.id.asc(),
                )
            )
        )
        .scalars()
        .all()
    )
    env_by_id = {env.id: env for env in envs}
    missing = requested_set.difference(env_by_id)
    if missing:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent not found")

    ordered = [env_by_id[env_id] for env_id in requested_ids]
    ordered.extend(env for env in envs if env.id not in requested_set)
    for position, env in enumerate(ordered):
        env.sort_order = position
    await db.commit()

    env_ids = [env.id for env in ordered]
    hosted_deployment_ids = await _hosted_deployment_ids(db, env_ids) if not agent_response else {}
    return [
        _identity_response(
            env,
            hosted_deployment_ids.get(env.id),
            agent_response=agent_response,
        )
        for env in ordered
    ]


@router.patch("/agents/order", response_model=list[AgentResponse])
async def reorder_agents(
    body: AgentReorderRequest,
    auth: AuthContext = Depends(require_web_auth),
    db: AsyncSession = Depends(get_session),
) -> list[AgentResponse]:
    return await _reorder_agent_identities(body.agent_ids, auth, db, agent_response=True)


@router.patch("/environments/order", response_model=list[EnvironmentResponse], deprecated=True)
async def reorder_environments(
    body: EnvironmentReorderRequest,
    auth: AuthContext = Depends(require_web_auth),
    db: AsyncSession = Depends(get_session),
) -> list[EnvironmentResponse]:
    return await _reorder_agent_identities(
        body.environment_ids,
        auth,
        db,
        agent_response=False,
    )


@router.get(
    "/agents/{agent_id}",
    response_model=AgentResponse,
    responses={status.HTTP_304_NOT_MODIFIED: {"description": "Not Modified"}},
)
async def get_agent(
    agent_id: UUID,
    request: Request,
    response: Response,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> AgentResponse | Response:
    return await _get_agent_identity(
        agent_id,
        request,
        response,
        auth,
        db,
        agent_response=True,
    )


@router.get(
    "/environments/{environment_id}",
    response_model=EnvironmentResponse,
    responses={status.HTTP_304_NOT_MODIFIED: {"description": "Not Modified"}},
    deprecated=True,
)
async def get_environment(
    environment_id: UUID,
    request: Request,
    response: Response,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> EnvironmentResponse | Response:
    return await _get_agent_identity(
        environment_id,
        request,
        response,
        auth,
        db,
        agent_response=False,
    )


@overload
async def _update_agent_identity(
    agent_id: UUID,
    body: EnvironmentUpdate,
    auth: AuthContext,
    db: AsyncSession,
    *,
    agent_response: Literal[True],
) -> AgentResponse: ...


@overload
async def _update_agent_identity(
    agent_id: UUID,
    body: EnvironmentUpdate,
    auth: AuthContext,
    db: AsyncSession,
    *,
    agent_response: Literal[False],
) -> EnvironmentResponse: ...


async def _update_agent_identity(
    agent_id: UUID,
    body: EnvironmentUpdate,
    auth: AuthContext,
    db: AsyncSession,
    *,
    agent_response: bool,
) -> AgentResponse | EnvironmentResponse:
    env = (
        await db.execute(
            select(AgentEnvironment).where(
                AgentEnvironment.id == agent_id,
                AgentEnvironment.user_id == auth.user_id,
                active_agent_filter(),
            )
        )
    ).scalar_one_or_none()
    if env is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent not found")

    if "display_name" in body.model_fields_set:
        env.display_name = body.display_name
    await db.commit()
    await db.refresh(env)

    hosted_deployment_ids = (
        await _hosted_deployment_ids(db, [agent_id]) if not agent_response else {}
    )
    return _identity_response(
        env,
        hosted_deployment_ids.get(agent_id),
        agent_response=agent_response,
    )


@router.patch("/agents/{agent_id}", response_model=AgentResponse)
async def update_agent(
    agent_id: UUID,
    body: EnvironmentUpdate,
    auth: AuthContext = Depends(require_web_auth),
    db: AsyncSession = Depends(get_session),
) -> AgentResponse:
    return await _update_agent_identity(agent_id, body, auth, db, agent_response=True)


@router.patch(
    "/environments/{environment_id}",
    response_model=EnvironmentResponse,
    deprecated=True,
)
async def update_environment(
    environment_id: UUID,
    body: EnvironmentUpdate,
    auth: AuthContext = Depends(require_web_auth),
    db: AsyncSession = Depends(get_session),
) -> EnvironmentResponse:
    return await _update_agent_identity(environment_id, body, auth, db, agent_response=False)


@overload
async def _clear_agent_avatar(
    agent_id: UUID, auth: AuthContext, db: AsyncSession, *, agent_response: Literal[True]
) -> AgentResponse: ...


@overload
async def _clear_agent_avatar(
    agent_id: UUID, auth: AuthContext, db: AsyncSession, *, agent_response: Literal[False]
) -> EnvironmentResponse: ...


async def _clear_agent_avatar(
    agent_id: UUID,
    auth: AuthContext,
    db: AsyncSession,
    *,
    agent_response: bool,
) -> AgentResponse | EnvironmentResponse:
    env = (
        await db.execute(
            select(AgentEnvironment).where(
                AgentEnvironment.id == agent_id,
                AgentEnvironment.user_id == auth.user_id,
                active_agent_filter(),
            )
        )
    ).scalar_one_or_none()
    if env is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent not found")

    old_avatar_key = env.avatar_asset_key
    env.avatar_asset_key = None
    await db.commit()
    await db.refresh(env)
    await _delete_managed_avatar_key_best_effort(old_avatar_key)

    hosted_deployment_ids = (
        await _hosted_deployment_ids(db, [agent_id]) if not agent_response else {}
    )
    return _identity_response(
        env,
        hosted_deployment_ids.get(agent_id),
        agent_response=agent_response,
    )


@router.delete("/agents/{agent_id}/avatar", response_model=AgentResponse)
async def clear_agent_avatar(
    agent_id: UUID,
    auth: AuthContext = Depends(require_web_auth),
    db: AsyncSession = Depends(get_session),
) -> AgentResponse:
    return await _clear_agent_avatar(agent_id, auth, db, agent_response=True)


@router.delete(
    "/environments/{environment_id}/avatar",
    response_model=EnvironmentResponse,
    deprecated=True,
)
async def clear_environment_avatar(
    environment_id: UUID,
    auth: AuthContext = Depends(require_web_auth),
    db: AsyncSession = Depends(get_session),
) -> EnvironmentResponse:
    return await _clear_agent_avatar(environment_id, auth, db, agent_response=False)


@overload
async def _upload_agent_avatar(
    agent_id: UUID,
    file: UploadFile,
    auth: AuthContext,
    db: AsyncSession,
    *,
    agent_response: Literal[True],
) -> AgentResponse: ...


@overload
async def _upload_agent_avatar(
    agent_id: UUID,
    file: UploadFile,
    auth: AuthContext,
    db: AsyncSession,
    *,
    agent_response: Literal[False],
) -> EnvironmentResponse: ...


async def _upload_agent_avatar(
    agent_id: UUID,
    file: UploadFile,
    auth: AuthContext,
    db: AsyncSession,
    *,
    agent_response: bool,
) -> AgentResponse | EnvironmentResponse:
    env = (
        await db.execute(
            select(AgentEnvironment).where(
                AgentEnvironment.id == agent_id,
                AgentEnvironment.user_id == auth.user_id,
                active_agent_filter(),
            )
        )
    ).scalar_one_or_none()
    if env is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent not found")

    data = await file.read(_MAX_AGENT_AVATAR_BYTES + 1)
    await file.close()
    if len(data) > _MAX_AGENT_AVATAR_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Avatar image is too large")
    detected = _detect_avatar_image(data)
    if detected is None:
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "Avatar must be a PNG, JPEG, or WebP image",
        )
    content_type, extension = detected
    key = f"{_AGENT_AVATAR_PREFIX}{uuid4().hex}{extension}"
    old_avatar_key = env.avatar_asset_key
    await file_store.put(key, data, content_type=content_type)
    env.avatar_asset_key = key
    try:
        await db.commit()
    except Exception:
        await _delete_managed_avatar_key_best_effort(key)
        raise
    await db.refresh(env)
    await _delete_managed_avatar_key_best_effort(old_avatar_key)

    hosted_deployment_ids = (
        await _hosted_deployment_ids(db, [agent_id]) if not agent_response else {}
    )
    return _identity_response(
        env,
        hosted_deployment_ids.get(agent_id),
        agent_response=agent_response,
    )


@router.post("/agents/{agent_id}/avatar", response_model=AgentResponse)
async def upload_agent_avatar(
    agent_id: UUID,
    file: UploadFile = File(...),
    auth: AuthContext = Depends(require_web_auth),
    db: AsyncSession = Depends(get_session),
) -> AgentResponse:
    return await _upload_agent_avatar(agent_id, file, auth, db, agent_response=True)


@router.post(
    "/environments/{environment_id}/avatar",
    response_model=EnvironmentResponse,
    deprecated=True,
)
async def upload_environment_avatar(
    environment_id: UUID,
    file: UploadFile = File(...),
    auth: AuthContext = Depends(require_web_auth),
    db: AsyncSession = Depends(get_session),
) -> EnvironmentResponse:
    return await _upload_agent_avatar(environment_id, file, auth, db, agent_response=False)


@router.get(
    "/environments/{environment_id}/runtime-observed",
    response_model=RuntimeObservedResponse,
    deprecated=True,
)
async def get_environment_runtime_observed(
    environment_id: UUID,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> RuntimeObservedResponse:
    bound_env = _bound_env_id(auth)
    if bound_env is not None and environment_id != bound_env:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent not found")

    row = (
        await db.execute(
            select(AgentEnvironment, HostedRuntimeState)
            .outerjoin(
                HostedRuntimeState,
                HostedRuntimeState.environment_id == AgentEnvironment.id,
            )
            .where(
                AgentEnvironment.id == environment_id,
                AgentEnvironment.user_id == auth.user_id,
                active_agent_filter(),
            )
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent not found")
    env, state = row

    source_revision = persisted_runtime_source_revision(state) if state is not None else None
    source_error = state is not None and persisted_runtime_source_error(state)
    desired_cli_package_spec = state.cli_package_spec if state is not None else None
    observation = (
        await db.execute(
            select(HostedRuntimeConfigObservation).where(
                HostedRuntimeConfigObservation.environment_id == environment_id
            )
        )
    ).scalar_one_or_none()
    return RuntimeObservedResponse(
        environment=_env_to_response(env, state),
        desired=(
            _runtime_observed_desired(state, source_revision=source_revision)
            if state is not None
            else None
        ),
        observed=_runtime_observed_response(observation),
        health=_runtime_observed_health(
            env,
            state,
            observation,
            desired_source_revision=source_revision,
            desired_source_error=source_error,
            desired_cli_package_spec=desired_cli_package_spec,
        ),
        provider_health=_runtime_observed_provider_health(state, observation),
    )


@router.get(
    "/agents/{agent_id}/runtime-observed",
    response_model=AgentRuntimeObservedResponse,
)
async def get_agent_runtime_observed(
    agent_id: UUID,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> AgentRuntimeObservedResponse:
    """Canonical Agent-identity route for runtime desired/observed summaries."""
    response = await get_environment_runtime_observed(agent_id, auth, db)
    state = await db.get(HostedRuntimeState, agent_id)
    observation = await db.get(HostedRuntimeConfigObservation, agent_id)
    desired = response.desired
    if desired is None and state is None:
        return AgentRuntimeObservedResponse(
            environment=response.environment,
            desired=None,
            observed=response.observed,
            health=response.health,
            provider_health=response.provider_health,
        )
    if (
        desired is None
        or state is None
        or desired.deployment_id != state.deployment_id
        or desired.instance_id != state.instance_id
        or desired.desired_config_generation != state.generation
    ):
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Runtime desired state changed while it was being read; retry the request.",
        )
    agent_desired = AgentRuntimeObservedDesiredResponse.model_validate(desired.model_dump())
    return AgentRuntimeObservedResponse(
        environment=response.environment,
        desired=agent_desired.model_copy(
            update={"managed_skills": _runtime_managed_skill_summaries(state)}
        ),
        observed=response.observed,
        health=_agent_runtime_observed_health(response.health, state, observation),
        provider_health=response.provider_health,
    )


@router.get(
    "/agents/{agent_id}/mcp",
    response_model=AgentMcpInventoryResponse,
)
async def get_agent_mcp_inventory(
    agent_id: UUID,
    auth: AuthContext = Depends(require_web_auth),
    db: AsyncSession = Depends(get_session),
) -> AgentMcpInventoryResponse:
    """Return only MCP inventory with proven user-declaration provenance."""
    state = (
        await db.execute(
            select(HostedRuntimeState)
            .join(
                AgentEnvironment,
                AgentEnvironment.id == HostedRuntimeState.environment_id,
            )
            .where(
                HostedRuntimeState.environment_id == agent_id,
                AgentEnvironment.user_id == auth.user_id,
                active_agent_filter(),
            )
        )
    ).scalar_one_or_none()
    if state is None:
        return AgentMcpInventoryResponse(
            agent_id=str(agent_id),
            availability="unavailable",
        )

    if state.mcp is None:
        # Legacy producers can persist a canonical null before they support
        # MCP desired-state projection. Only an explicit {"servers": {}}
        # proves that the configured inventory is empty.
        return AgentMcpInventoryResponse(
            agent_id=str(agent_id),
            deployment_id=state.deployment_id,
            availability="unavailable",
        )
    try:
        persisted = PersistedHostedRuntimeMcp.model_validate(state.mcp)
    except ValueError:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Managed MCP inventory is temporarily unavailable.",
        ) from None

    # The current runtime MCP wire does not identify who declared a server or
    # whether the user can manage it. The exact built-in registration is
    # platform-owned, while an empty map proves there is no user inventory.
    # Anything else is valid runtime state but unproven inventory, so fail
    # closed instead of turning arbitrary desired-state rows into user rows.
    if persisted.servers and not _is_platform_only_mcp(persisted):
        return AgentMcpInventoryResponse(
            agent_id=str(agent_id),
            deployment_id=state.deployment_id,
            availability="unavailable",
        )

    return AgentMcpInventoryResponse(
        agent_id=str(agent_id),
        deployment_id=state.deployment_id,
        availability="available",
    )


def _is_platform_only_mcp(persisted: PersistedHostedRuntimeMcp) -> bool:
    """Recognize the complete canonical built-in declaration, not its id alone."""
    if set(persisted.servers) != {"clawdi"}:
        return False
    server = persisted.servers["clawdi"]
    return isinstance(server, HostedRuntimePlatformMcpServer) or (
        isinstance(server, HostedRuntimeStdioMcpServer)
        and server.command == "clawdi"
        and server.args == ["mcp"]
    )


@router.get("/assets/{asset_key:path}", include_in_schema=False)
async def get_public_asset(asset_key: str) -> Response:
    if not _AGENT_AVATAR_KEY_RE.match(asset_key):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Asset not found")
    try:
        data = await file_store.get(asset_key)
    except FileNotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Asset not found") from None
    media_type = mimetypes.guess_type(asset_key)[0] or "application/octet-stream"
    return Response(
        content=data,
        media_type=media_type,
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


def _env_to_response(
    env: AgentEnvironment,
    hosted_state: HostedRuntimeState | None = None,
) -> EnvironmentResponse:
    return _env_to_response_with_deployment_id(
        env,
        hosted_state.deployment_id if hosted_state is not None else None,
    )


def _env_to_response_with_deployment_id(
    env: AgentEnvironment,
    hosted_deployment_id: str | None,
) -> EnvironmentResponse:
    # Deprecated signal: dashboards now classify agents through their control
    # plane's ownership surface. Kept (runtime-state-derived only) for older
    # API consumers until the field is removed from EnvironmentResponse.
    hosted_managed = hosted_deployment_id is not None
    agent = _agent_to_response(env)
    return EnvironmentResponse(
        **agent.model_dump(),
        hosted_managed=hosted_managed,
        hosted_deployment_id=hosted_deployment_id,
    )


async def _hosted_deployment_ids(
    db: AsyncSession,
    environment_ids: list[UUID],
) -> dict[UUID, str]:
    if not environment_ids:
        return {}
    rows = (
        await db.execute(
            select(
                HostedRuntimeState.environment_id,
                HostedRuntimeState.deployment_id,
            ).where(HostedRuntimeState.environment_id.in_(environment_ids))
        )
    ).all()
    return {environment_id: deployment_id for environment_id, deployment_id in rows}


def _agent_to_response(env: AgentEnvironment) -> AgentResponse:
    return AgentResponse(
        id=str(env.id),
        name=_agent_name_from_fields(
            env.display_name, env.default_name, env.machine_name, env.agent_type
        ),
        default_name=env.default_name,
        machine_name=env.machine_name,
        display_name=env.display_name,
        avatar_url=_asset_url(env.avatar_asset_key) if env.avatar_asset_key else None,
        sort_order=env.sort_order,
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
        explicit_identity=env.registration_key is None,
        # NOT NULL per schema; the heal path in register_environment
        # backfills any legacy row missing this column before the
        # response is built, so we always have a value here.
        default_project_id=str(env.default_project_id),
        adapter_modules=env.adapter_modules,
    )


@overload
def _identity_response(
    env: AgentEnvironment, hosted_deployment_id: str | None, *, agent_response: Literal[True]
) -> AgentResponse: ...


@overload
def _identity_response(
    env: AgentEnvironment,
    hosted_deployment_id: str | None,
    *,
    agent_response: Literal[False],
) -> EnvironmentResponse: ...


def _identity_response(
    env: AgentEnvironment,
    hosted_deployment_id: str | None,
    *,
    agent_response: bool,
) -> AgentResponse | EnvironmentResponse:
    if agent_response:
        return _agent_to_response(env)
    return _env_to_response_with_deployment_id(env, hosted_deployment_id)


def _agent_name_from_fields(
    display_name: str | None,
    default_name: str | None,
    machine_name: str | None,
    agent_type: str | None,
) -> str:
    return (
        (display_name or "").strip()
        or (default_name or "").strip()
        or (machine_name or "").strip()
        or agent_type
        or "Unknown"
    )


def _detect_avatar_image(data: bytes) -> tuple[str, str] | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", ".png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", ".jpg"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp", ".webp"
    return None


def _asset_url(key: str) -> str:
    return f"{settings.public_api_url.rstrip('/')}/v1/assets/{key}"


async def _delete_managed_avatar_key_best_effort(key: str | None) -> None:
    if not key or not _AGENT_AVATAR_KEY_RE.match(key):
        return
    try:
        await file_store.delete(key)
    except Exception:
        log.warning("agent_avatar_delete_failed key=%s", key, exc_info=True)


def _session_content_key(session: Session) -> str:
    if session.origin_environment_id is None:
        return f"sessions/{session.user_id}/{session.local_session_id}.json"
    return (
        f"sessions/{session.user_id}/{session.origin_environment_id}/"
        f"{session.local_session_id}.json"
    )


async def _next_environment_sort_order(db: AsyncSession, user_id: UUID) -> int:
    value = (
        await db.execute(
            select(func.coalesce(func.max(AgentEnvironment.sort_order), -1) + 1).where(
                AgentEnvironment.user_id == user_id
            )
        )
    ).scalar_one()
    return int(value)


def _runtime_observed_desired(
    state: HostedRuntimeState,
    *,
    source_revision: str | None = None,
) -> RuntimeObservedDesiredResponse:
    _, provider_ids, primary_provider_id = _runtime_desired_provider_binding(state.runtimes)
    return RuntimeObservedDesiredResponse(
        deployment_id=state.deployment_id,
        instance_id=state.instance_id,
        desired_config_generation=state.generation,
        desired_source_revision=source_revision,
        provider_id=primary_provider_id or (provider_ids[0] if provider_ids else None),
        enabled_runtimes=_enabled_runtime_names(state.runtimes),
        has_mcp=state.mcp is not None,
        has_tools=state.tools is not None,
        updated_at=state.updated_at,
    )


def _runtime_managed_skill_summaries(
    state: HostedRuntimeState,
) -> list[RuntimeManagedSkillSummary]:
    managed_skills: list[RuntimeManagedSkillSummary] = []
    if state.skills is not None:
        try:
            skills = PersistedHostedRuntimeSkills.model_validate(state.skills)
        except ValueError:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "Managed Skill inventory is temporarily unavailable.",
            ) from None
        managed_skills.extend(
            RuntimeManagedSkillSummary(
                id=skill_id,
                enabled=entry.enabled,
                version=(
                    entry.version or 1
                    if isinstance(entry, PersistedHostedRuntimeBundledSkillEntry)
                    else 1
                ),
            )
            for skill_id, entry in sorted(skills.entries.items())
        )
    return managed_skills


def _agent_runtime_observed_health(
    health: RuntimeObservedHealthResponse,
    state: HostedRuntimeState,
    observation: HostedRuntimeConfigObservation | None,
) -> RuntimeObservedHealthResponse:
    """Add v2 identity evidence without changing the frozen v1 health contract."""
    diagnostics = _validated_runtime_observed_diagnostics(observation)
    if diagnostics is None:
        return health

    reasons = list(health.reasons)
    if diagnostics.applied is None:
        reasons.append("runtime_applied_missing")
    elif diagnostics.applied.instance_id != state.instance_id:
        reasons.append("applied_instance_id_mismatch")

    observed_generation = (
        observation.observed_config_generation if observation is not None else None
    )
    if observed_generation is not None:
        generation_matches = observed_generation == resolve_runtime_apply_generation(
            generation=state.generation,
            apply_generation=state.apply_generation,
        )
        if generation_matches:
            reasons = [reason for reason in reasons if reason != "config_generation_mismatch"]
        elif "config_generation_mismatch" not in reasons:
            reasons.append("config_generation_mismatch")
    if reasons == health.reasons:
        return health

    status_value = health.status
    if reasons and status_value == "ok":
        status_value = "unknown"
    elif not reasons and status_value == "unknown" and diagnostics.status == "ok":
        status_value = "ok"
    return health.model_copy(
        update={
            "status": status_value,
            "reasons": reasons,
        }
    )


def _runtime_observed_health(
    env: AgentEnvironment,
    state: HostedRuntimeState | None,
    observation: HostedRuntimeConfigObservation | None,
    *,
    desired_source_revision: str | None = None,
    desired_source_error: bool = False,
    desired_cli_package_spec: str | None = None,
) -> RuntimeObservedHealthResponse:
    if state is None:
        return RuntimeObservedHealthResponse(
            status="not_configured",
            reasons=["hosted_runtime_state_missing"],
        )

    reasons: list[str] = []
    diagnostics = _validated_runtime_observed_diagnostics(observation)
    observed_at = observation.observed_at if observation is not None else None
    now = datetime.now(UTC)

    if desired_source_error:
        reasons.append("desired_source_invalid")

    if env.last_sync_error:
        reasons.append("daemon_error")
    if env.last_sync_at is None:
        reasons.append("daemon_never_heartbeat")
    elif now - _as_utc(env.last_sync_at) > _RUNTIME_OBSERVED_STALE_AFTER:
        reasons.append("daemon_stale")

    observed_status = diagnostics.status if diagnostics is not None else None
    if observation is None:
        reasons.append("runtime_observed_missing")
    elif diagnostics is None:
        reasons.append("runtime_diagnostics_invalid")
    elif observed_status == "error":
        reasons.append("runtime_error")
    elif observed_status not in {"ok", "unknown"}:
        reasons.append("runtime_status_unknown")

    if observation is not None:
        if observation.observed_config_generation is None:
            reasons.append("observed_config_generation_missing")
        elif observation.observed_config_generation != state.generation:
            reasons.append("config_generation_mismatch")
        if not observation.observed_manifest_etag or not observation.observed_manifest_etag.strip():
            reasons.append("observed_manifest_etag_missing")
        if not desired_source_error and observation.observed_source_revision is None:
            reasons.append("observed_source_revision_missing")
        elif not desired_source_error and desired_source_revision is None:
            reasons.append("desired_source_revision_missing")
        elif (
            not desired_source_error
            and observation.observed_source_revision != desired_source_revision
        ):
            reasons.append("source_revision_mismatch")

    if diagnostics is not None and not desired_source_error:
        if desired_source_revision is not None and observation is not None:
            expected_etag = expected_runtime_bundle_v2_etag(desired_source_revision)
            if (
                observation.observed_manifest_etag
                and observation.observed_manifest_etag != expected_etag
            ):
                reasons.append("observed_manifest_etag_mismatch")

        desired_cli_version = _clawdi_cli_version(desired_cli_package_spec or "")
        if desired_cli_version is None:
            reasons.append("desired_cli_version_invalid")
        elif diagnostics.active_cli_version is None:
            reasons.append("active_cli_version_missing")
        elif diagnostics.active_cli_version != desired_cli_version:
            reasons.append("active_cli_version_mismatch")

        provider_mode, desired_provider_ids, _ = _runtime_desired_provider_binding(state.runtimes)
        if provider_mode is None:
            reasons.append("desired_provider_contract_invalid")
        else:
            applied_provider_ids = (
                diagnostics.applied.applied_provider_ids if diagnostics.applied else []
            )
            missing_provider_ids = sorted(set(desired_provider_ids) - set(applied_provider_ids))
            extra_provider_ids = sorted(set(applied_provider_ids) - set(desired_provider_ids))
            if missing_provider_ids:
                reasons.append("applied_provider_ids_missing_desired")
            if extra_provider_ids:
                reasons.append("applied_provider_ids_extra")

    supervisor_status = (
        diagnostics.supervisor.status if diagnostics and diagnostics.supervisor else None
    )
    if supervisor_status == "error":
        reasons.append("supervisor_error")
    elif supervisor_status == "unknown":
        reasons.append("supervisor_status_unknown")
    elif supervisor_status is not None and supervisor_status != "ok":
        reasons.append("supervisor_status_invalid")

    if observation is not None and observed_at is None:
        reasons.append("runtime_observed_at_missing")
    elif observed_at is not None and now - observed_at > _RUNTIME_OBSERVED_STALE_AFTER:
        reasons.append("runtime_observed_stale")

    provider_health = _runtime_observed_provider_health(state, observation)
    if any(provider.status == "error" for provider in provider_health):
        reasons.append("provider_error")
    elif any(provider.status == "unknown" for provider in provider_health):
        reasons.append("provider_status_unknown")

    if "daemon_error" in reasons or "runtime_error" in reasons or "supervisor_error" in reasons:
        status_value = "error"
    elif "provider_error" in reasons:
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
        observed_at=observed_at,
    )


def _runtime_observed_provider_health(
    state: HostedRuntimeState | None,
    observation: HostedRuntimeConfigObservation | None,
) -> list[RuntimeObservedProviderHealthResponse]:
    diagnostics = _validated_runtime_observed_diagnostics(observation)
    if state is None or diagnostics is None:
        return []

    _, provider_ids, primary_provider_id = _runtime_desired_provider_binding(state.runtimes)
    provider_health: list[RuntimeObservedProviderHealthResponse] = []
    observed_providers = diagnostics.providers or {}
    for provider_key in sorted(set(provider_ids) | set(observed_providers)):
        observed_payload = observed_providers.get(provider_key)
        if observed_payload is None:
            provider_health.append(
                RuntimeObservedProviderHealthResponse(
                    provider_id=provider_key,
                    status="unknown",
                    reasons=["provider_observation_missing"],
                    desired={"selected": True, "primary": provider_key == primary_provider_id},
                    observed=None,
                )
            )
            continue
        provider_health.append(
            RuntimeObservedProviderHealthResponse(
                provider_id=provider_key,
                status=_runtime_observed_provider_status(observed_payload),
                reasons=_runtime_observed_provider_reasons(observed_payload),
                desired={
                    "selected": provider_key in provider_ids,
                    "primary": provider_key == primary_provider_id,
                },
                observed=observed_payload,
            )
        )
    return provider_health


def _clawdi_cli_version(package_spec: str) -> str | None:
    prefix = "clawdi@"
    if not package_spec.startswith(prefix) or len(package_spec) == len(prefix):
        return None
    return package_spec[len(prefix) :]


def _runtime_desired_provider_binding(
    runtimes: dict | None,
) -> tuple[str | None, list[str], str | None]:
    if not isinstance(runtimes, dict) or len(runtimes) != 1:
        return None, [], None
    runtime_name, raw_runtime = next(iter(runtimes.items()))
    if runtime_name not in {"hermes", "openclaw"}:
        return None, [], None
    try:
        runtime = validate_hosted_runtime_desired_state(raw_runtime)
    except ValidationError:
        return None, [], None
    primary_model = getattr(runtime, "primary_model", None)
    primary_provider_id = primary_model.provider_id if primary_model is not None else None
    return runtime.providerMode, runtime.provider_ids, primary_provider_id


def _runtime_observed_provider_status(
    observed: HostedRuntimeObservedProviderPayload | None,
) -> Literal["ok", "error", "unknown", "not_configured"]:
    if observed is None:
        return "unknown"
    payload = observed.root
    if payload.get("status") == "not_configured" or payload.get("configured") is False:
        return "not_configured"
    reasons = _runtime_observed_provider_reasons(observed)
    if reasons:
        return "error"
    raw_status = payload.get("status")
    if raw_status == "ok":
        return "ok"
    if raw_status == "unknown":
        return "unknown"
    if raw_status == "not_configured":
        return "not_configured"
    return "unknown"


def _runtime_observed_provider_reasons(
    observed: HostedRuntimeObservedProviderPayload | None,
) -> list[str]:
    if observed is None:
        return ["provider_observed_missing"]

    payload = observed.root
    reasons: list[str] = []
    raw_status = payload.get("status")
    if raw_status == "error":
        raw_reasons = payload.get("reasons")
        if isinstance(raw_reasons, list):
            reasons.extend(str(reason) for reason in raw_reasons if isinstance(reason, str))
        if not reasons:
            reasons.append("provider_error")
    elif raw_status not in {"ok", "unknown", "not_configured"}:
        reasons.append("provider_status_invalid")

    if payload.get("configured") is False:
        reasons.append("provider_not_configured")
    if payload.get("secretAvailable") is False:
        reasons.append("provider_secret_missing")

    return sorted(set(reasons))


def _enabled_runtime_names(runtimes: dict) -> list[str]:
    enabled: list[str] = []
    for name, raw in runtimes.items():
        if isinstance(raw, dict) and raw.get("enabled") is True:
            enabled.append(str(name))
    return sorted(enabled)


def _validated_runtime_observed_diagnostics(
    observation: HostedRuntimeConfigObservation | None,
) -> HostedRuntimeObservedV2 | None:
    if observation is None:
        return None
    try:
        return _RUNTIME_OBSERVED_ADAPTER.validate_python(observation.diagnostics)
    except ValidationError:
        return None


def _runtime_observed_summary(
    observation: HostedRuntimeConfigObservation | None,
) -> RuntimeObservedConfigSummaryResponse | None:
    if observation is None:
        return None
    return RuntimeObservedConfigSummaryResponse(
        observed_at=observation.observed_at,
        observed_config_generation=observation.observed_config_generation,
        observed_manifest_etag=observation.observed_manifest_etag,
        observed_source_revision=observation.observed_source_revision,
    )


def _runtime_observed_response(
    observation: HostedRuntimeConfigObservation | None,
) -> RuntimeObservedConfigResponse | None:
    summary = _runtime_observed_summary(observation)
    if summary is None:
        return None
    return RuntimeObservedConfigResponse(
        **summary.model_dump(),
        diagnostics=_validated_runtime_observed_diagnostics(observation),
    )


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


async def _delete_agent_identity(
    agent_id: UUID,
    auth: AuthContext,
    db: AsyncSession,
) -> None:
    """Archive an Agent and its exclusive Project without breaking identity."""
    result = await db.execute(
        select(AgentEnvironment).where(
            AgentEnvironment.id == agent_id,
            AgentEnvironment.user_id == auth.user_id,
            active_agent_filter(),
        )
    )
    env = result.scalar_one_or_none()
    if not env:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent not found")
    if env.registration_key is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This agent uses an explicit identity and cannot be disconnected here",
        )
    await queue_environment_runtime_manifest_changed(db, auth.user_id, agent_id)
    try:
        await archive_agent_and_project(db, agent=env)
    except AgentLifecycleBoundaryError:
        await db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Agent Project ownership could not be proven; no resources were archived.",
        ) from None
    await db.commit()


@router.delete("/agents/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_agent(
    agent_id: UUID,
    # Dashboard-only: a leaked deploy-key would otherwise be able
    # to delete its own agent (de-registering the machine on the
    # owner's dashboard) or sibling agents under the same user.
    # Mirrors the lockdown applied to /v1/auth/keys in round 6.
    auth: AuthContext = Depends(require_web_auth),
    db: AsyncSession = Depends(get_session),
) -> None:
    await _delete_agent_identity(agent_id, auth, db)


@router.delete(
    "/environments/{environment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    deprecated=True,
)
async def delete_environment(
    environment_id: UUID,
    auth: AuthContext = Depends(require_web_auth),
    db: AsyncSession = Depends(get_session),
) -> None:
    await _delete_agent_identity(environment_id, auth, db)


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
    runtime_observed: HostedRuntimeObserved | None = None

    @field_validator("runtime_observed", mode="before")
    @classmethod
    def bound_runtime_observed(cls, value: object) -> object:
        return _bounded_runtime_observed(value)


def _bounded_runtime_observed(value: object) -> object:
    if value is None:
        return None
    if not isinstance(value, dict):
        return value
    try:
        encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        encoded_size = len(encoded.encode("utf-8"))
    except (TypeError, UnicodeEncodeError, ValueError) as exc:
        raise ValueError("runtime_observed must be valid UTF-8 JSON") from exc
    if encoded_size <= _MAX_RUNTIME_OBSERVED_BYTES:
        return value
    return {
        "schemaVersion": "clawdi.hostedRuntimeObserved.v2",
        "reportedAt": datetime.now(UTC).isoformat(),
        "runtimeMode": "hosted",
        "status": "error",
        "activeCliVersion": None,
        "applied": None,
        "boot": None,
        "cli": None,
        "error": "runtime observed payload exceeded size limit",
        "truncated": True,
    }


def _runtime_observed_comparison_value(
    value: JsonValue,
) -> JsonValue:
    if not isinstance(value, dict):
        return value
    return {key: item for key, item in value.items() if key != "reportedAt"}


def _runtime_observed_diagnostics(
    value: HostedRuntimeObservedV2,
) -> dict[str, Any]:
    return value.model_dump(
        mode="json",
        by_alias=True,
        exclude_unset=True,
    )


def _runtime_observed_columns(
    value: HostedRuntimeObservedV2,
    *,
    observed_at: datetime,
) -> dict[str, Any]:
    applied = value.applied
    return {
        "observed_at": observed_at,
        "observed_config_generation": applied.generation if applied else None,
        "observed_manifest_etag": applied.etag if applied else None,
        "observed_source_revision": applied.source_revision if applied else None,
        "diagnostics": _runtime_observed_diagnostics(value),
    }


def _runtime_observation_changed(
    observation: HostedRuntimeConfigObservation | None,
    values: dict[str, Any],
) -> bool:
    if observation is None:
        return True
    return (
        observation.observed_config_generation != values["observed_config_generation"]
        or observation.observed_manifest_etag != values["observed_manifest_etag"]
        or observation.observed_source_revision != values["observed_source_revision"]
        or _runtime_observed_comparison_value(observation.diagnostics)
        != _runtime_observed_comparison_value(values["diagnostics"])
    )


@router.post("/agents/{agent_id}/sync-heartbeat", status_code=status.HTTP_204_NO_CONTENT)
async def sync_heartbeat(
    agent_id: UUID,
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
                AgentEnvironment.id == agent_id,
                AgentEnvironment.user_id == auth.user_id,
                active_agent_filter(),
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
        and auth.api_key.environment_id != agent_id
    ):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "api key bound to a different environment",
        )

    # Persist each 60 +/- 15s report. The 150s freshness window is at
    # least twice the maximum 75s report interval, so one missed beat
    # does not mark a live daemon stale. last_sync_at is not indexed,
    # keeping the normal AgentEnvironment write eligible for HOT update.
    now = datetime.now(UTC)
    new_error = body.last_sync_error
    new_revision = body.last_revision_seen
    runtime_observed = body.runtime_observed
    hosted_state = None
    observation = None
    runtime_observed_values = None
    observed_changed = False
    if runtime_observed is not None:
        runtime_observed_values = _runtime_observed_columns(
            runtime_observed,
            observed_at=now,
        )
        row = (
            await db.execute(
                select(HostedRuntimeState, HostedRuntimeConfigObservation)
                .outerjoin(
                    HostedRuntimeConfigObservation,
                    HostedRuntimeConfigObservation.environment_id
                    == HostedRuntimeState.environment_id,
                )
                .where(HostedRuntimeState.environment_id == agent_id)
            )
        ).first()
        if row is not None:
            hosted_state, observation = row
            observed_changed = _runtime_observation_changed(observation, runtime_observed_values)
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
    if hosted_state is not None and runtime_observed_values is not None:
        if observed_changed:
            insert_observation = pg_insert(HostedRuntimeConfigObservation).values(
                environment_id=agent_id,
                **runtime_observed_values,
            )
            await db.execute(
                insert_observation.on_conflict_do_update(
                    index_elements=[HostedRuntimeConfigObservation.environment_id],
                    set_={
                        "observed_at": insert_observation.excluded.observed_at,
                        "observed_config_generation": (
                            insert_observation.excluded.observed_config_generation
                        ),
                        "observed_manifest_etag": (
                            insert_observation.excluded.observed_manifest_etag
                        ),
                        "observed_source_revision": (
                            insert_observation.excluded.observed_source_revision
                        ),
                        "diagnostics": insert_observation.excluded.diagnostics,
                        "updated_at": func.now(),
                    },
                )
            )
        else:
            await db.execute(
                update(HostedRuntimeConfigObservation)
                .where(HostedRuntimeConfigObservation.environment_id == agent_id)
                .values(observed_at=now)
            )
    await db.commit()


@router.post("/sessions/batch")
async def batch_create_sessions(
    body: SessionBatchRequest,
    request: Request,
    auth: AuthContext = Depends(require_scope("sessions:write")),
    db: AsyncSession = Depends(get_session),
) -> SessionBatchResponse:
    """Ingest a batch of sessions from a CLI sync.

    Upserts every row by `(user_id, origin_environment_id, local_session_id)`. The response tells
    the client which sessions still need a content upload — either because
    the stored hash differs from the one just sent, or because no content
    has ever been uploaded for that row (`file_key IS NULL`).
    """
    if not body.sessions:
        return SessionBatchResponse(
            created=0,
            updated=0,
            unchanged=0,
            needs_content=[],
            rejected=[],
            suppressed=[],
        )

    clamped_duration_ids = [
        s.local_session_id for s in body.sessions if s.duration_seconds_was_clamped
    ]
    if clamped_duration_ids:
        log.warning(
            "session_batch_duration_clamped user_agent=%r count=%d local_session_ids=%s",
            request.headers.get("user-agent", ""),
            len(clamped_duration_ids),
            clamped_duration_ids[:20],
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
                    active_agent_filter(),
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

    # Pre-fetch existing rows for diffing. The immutable origin is part of
    # session identity, so equal source-local IDs from two Agents remain
    # independent. Legacy rows without an origin are included only to reject
    # ambiguous adoption explicitly.
    # Keep the diff logic in Python where it's testable. Doing it via an upsert CTE
    # would be slightly faster but much harder to read and harder to keep
    # in lockstep with the SessionBatchResponse contract.
    #
    # Lock in deterministic id order so concurrent batches do not deadlock.
    # `with_for_update()` also serializes this read with upload/delete and
    # keeps the pre-upsert snapshot stable for categorization.
    incoming_ids = list(dict.fromkeys(s.local_session_id for s in body.sessions))
    incoming_pairs = list(
        dict.fromkeys((s.environment_id, s.local_session_id) for s in body.sessions)
    )
    existing_rows = (
        await db.execute(
            select(
                Session.local_session_id,
                Session.environment_id,
                Session.origin_environment_id,
                Session.content_hash,
                Session.file_key,
                Session.content_protocol,
            )
            .where(
                Session.user_id == auth.user_id,
                or_(
                    tuple_(Session.origin_environment_id, Session.local_session_id).in_(
                        incoming_pairs
                    ),
                    # Rows whose immutable origin predates this column must
                    # still serialize with delete/suppression. Their identity
                    # cannot be proven, so they are locked and rejected below
                    # instead of being silently adopted by a new Agent.
                    (
                        Session.origin_environment_id.is_(None)
                        & Session.local_session_id.in_(incoming_ids)
                    ),
                ),
            )
            .order_by(Session.local_session_id)
            .with_for_update()
        )
    ).all()
    suppression_rows = (
        await db.execute(
            select(
                SessionSyncSuppression.origin_environment_id,
                SessionSyncSuppression.local_session_id,
            ).where(
                SessionSyncSuppression.user_id == auth.user_id,
                SessionSyncSuppression.local_session_id.in_(incoming_ids),
                or_(
                    SessionSyncSuppression.origin_environment_id.is_(None),
                    tuple_(
                        SessionSyncSuppression.origin_environment_id,
                        SessionSyncSuppression.local_session_id,
                    ).in_(incoming_pairs),
                ),
            )
        )
    ).all()
    legacy_suppressed_ids = {
        row.local_session_id for row in suppression_rows if row.origin_environment_id is None
    }
    exact_suppressed_pairs = {
        (row.origin_environment_id, row.local_session_id)
        for row in suppression_rows
        if row.origin_environment_id is not None
    }

    def is_suppressed(environment_id: UUID | None, local_session_id: str) -> bool:
        return (
            local_session_id in legacy_suppressed_ids
            or (environment_id, local_session_id) in exact_suppressed_pairs
        )

    suppressed = list(
        dict.fromkeys(
            s.local_session_id
            for s in body.sessions
            if is_suppressed(s.environment_id, s.local_session_id)
        )
    )
    active_sessions = [
        s for s in body.sessions if not is_suppressed(s.environment_id, s.local_session_id)
    ]
    active_existing_rows = [
        row
        for row in existing_rows
        if not is_suppressed(row.origin_environment_id, row.local_session_id)
    ]
    if not active_sessions:
        await db.commit()
        return SessionBatchResponse(
            created=0,
            updated=0,
            unchanged=0,
            needs_content=[],
            rejected=[],
            suppressed=suppressed,
        )

    unknown_origin_ids = sorted(
        {row.local_session_id for row in active_existing_rows if row.origin_environment_id is None}
    )
    if unknown_origin_ids:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "session_origin_unknown",
                "message": (
                    "Existing session identity predates immutable Agent origins; "
                    "delete it before uploading a replacement."
                ),
                "offending_local_session_ids": unknown_origin_ids,
            },
        )

    existing_by_pair = {
        (row.origin_environment_id, row.local_session_id): row for row in active_existing_rows
    }

    rows = [
        {
            "user_id": auth.user_id,
            "environment_id": s.environment_id,
            "origin_environment_id": s.environment_id,
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
            # Batch announces an events-v1 intent but never upgrades the row.
            # The generation CAS commit is the only protocol transition.
            "content_protocol": "snapshot-v1",
        }
        for s in active_sessions
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
    event_pairs = [
        (s.environment_id, s.local_session_id)
        for s in active_sessions
        if s.content_protocol == "events-v1"
    ]
    events_requested = tuple_(
        insert_stmt.excluded.origin_environment_id,
        insert_stmt.excluded.local_session_id,
    ).in_(event_pairs)
    events_committed = Session.content_protocol == "events-v1"
    hash_changed = (
        ~events_requested
        & ~events_committed
        & Session.content_hash.is_distinct_from(insert_stmt.excluded.content_hash)
    )
    upsert_stmt = insert_stmt.on_conflict_do_update(
        constraint="uq_sessions_user_origin_local",
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
            # Protocol changes only in the generation commit route. Batch may
            # refresh metadata, but cannot upgrade early or downgrade events.
            "content_protocol": Session.content_protocol,
            "content_hash": case(
                (events_requested | events_committed, Session.content_hash),
                else_=insert_stmt.excluded.content_hash,
            ),
            "file_key": case(
                (events_requested | events_committed, Session.file_key),
                (hash_changed, None),
                else_=Session.file_key,
            ),
            "content_uploaded_at": case(
                (events_requested | events_committed, Session.content_uploaded_at),
                (hash_changed, None),
                else_=Session.content_uploaded_at,
            ),
            "search_index_revision": case(
                (hash_changed, None),
                else_=Session.search_index_revision,
            ),
            # Only bump `updated_at` when the content actually changed.
            # Without this, a re-push of unchanged sessions (e.g. empty
            # client cache, multi-machine sync, manual cache reset) would
            # touch every row and reshuffle the dashboard's "Last activity"
            # sort to "everything happened just now". `IS DISTINCT FROM` is
            # NULL-safe so legacy rows with content_hash IS NULL also
            # behave correctly: they get a real bump on first proper push.
            "updated_at": case((hash_changed, func.now()), else_=Session.updated_at),
        },
    )
    # Concurrent `DELETE /v1/environments/{id}` between the pre-flight
    # SELECT and this UPSERT can still race the FK. PG sqlstate 23503 means
    # FK violation specifically; anything else (we no longer hit unique
    # collisions because of the upsert) bubbles as a plain 500.
    try:
        upserted_id_rows = (
            await db.execute(
                upsert_stmt.returning(Session.origin_environment_id, Session.local_session_id)
            )
        ).all()
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
    upserted_pairs = {(row[0], row[1]) for row in upserted_id_rows}
    for s in active_sessions:
        pair = (s.environment_id, s.local_session_id)
        if pair not in upserted_pairs:
            # Kept for response compatibility and defensive handling of a
            # future conditional upsert. The current origin-fenced upsert
            # writes every active pair.
            rejected.append(s.local_session_id)
            continue
        prev = existing_by_pair.get(pair)
        if prev is None:
            created += 1
            if s.content_protocol == "snapshot-v1":
                needs_content.append(s.local_session_id)
        elif prev.content_protocol == "events-v1":
            # A legacy client still announces snapshot-v1. Metadata may be
            # refreshed, but an already committed event generation is the
            # authoritative content and must never trigger legacy /upload.
            unchanged += 1
        elif prev.file_key is None:
            # Row existed but never had content uploaded (e.g. previous
            # upload failed mid-flight). Treat as updated — metadata may
            # have changed too, and definitely needs content.
            updated += 1
            if s.content_protocol == "snapshot-v1":
                needs_content.append(s.local_session_id)
        elif prev.content_hash is None or prev.content_hash != s.content_hash:
            updated += 1
            if s.content_protocol == "snapshot-v1":
                needs_content.append(s.local_session_id)
        else:
            unchanged += 1

    return SessionBatchResponse(
        created=created,
        updated=updated,
        unchanged=unchanged,
        needs_content=needs_content,
        rejected=rejected,
        suppressed=suppressed,
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


def _message_search_excerpt(content: str, query: str, *, limit: int = 240) -> str:
    compact = " ".join(content.split())
    if len(compact) <= limit:
        return compact
    match_at = compact.casefold().find(query.casefold())
    if match_at < 0:
        return f"{compact[: limit - 3]}..."
    start = max(0, match_at - limit // 3)
    end = min(len(compact), start + limit)
    start = max(0, end - limit)
    return f"{'...' if start else ''}{compact[start:end]}{'...' if end < len(compact) else ''}"


@router.get("/sessions")
async def list_sessions(
    # Deploy keys carry `sessions:write` (they upload sessions from
    # hosted pods) but explicitly NOT `sessions:read` — pods are
    # write-only "tail" producers. Without this gate a leaked pod
    # key could enumerate every session in its env, including
    # summaries and project_paths it had no business reading.
    auth: AuthContext = Depends(require_scope("sessions:read")),
    db: AsyncSession = Depends(get_session),
    q: str | None = Query(
        default=None,
        max_length=500,
        description="Fuzzy search on summary/project/id and visible message text",
    ),
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
    q = q.strip() if q else None
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
    relevance_expr: Any | None
    metadata_relevance_expr: Any | None = None
    message_match: Any | None = None
    message_relevance_expr: Any | None = None
    if q:
        sim_summary = func.similarity(func.coalesce(Session.summary, ""), q)
        sim_project = func.similarity(func.coalesce(Session.project_path, ""), q)
        sim_local = func.similarity(Session.local_session_id, q)
        metadata_relevance_expr = func.greatest(sim_summary, sim_project, sim_local)
        message_match = best_session_message_matches(auth.user_id, q)
        message_relevance_expr = func.coalesce(message_match.c.score, 0.0)
        relevance_expr = func.greatest(metadata_relevance_expr, message_relevance_expr)
    else:
        relevance_expr = None

    base = select(
        Session,
        AgentEnvironment.agent_type,
        AgentEnvironment.display_name,
        AgentEnvironment.default_name,
        AgentEnvironment.machine_name,
        is_shared_subq,
    ).outerjoin(AgentEnvironment, Session.environment_id == AgentEnvironment.id)
    if q:
        assert message_match is not None
        assert message_relevance_expr is not None
        base = base.outerjoin(message_match, message_match.c.session_id == Session.id)
        base = base.add_columns(
            message_relevance_expr,
            message_match.c.content,
            message_match.c.role,
            message_match.c.position,
            message_match.c.content_revision,
        )
    session_filters: list[Any] = [Session.user_id == auth.user_id]
    agent_filter = AgentEnvironment.agent_type == agent if agent else None
    if bound_env is not None:
        session_filters.append(Session.environment_id == bound_env)
    # Filter on `last_activity_at` (not `started_at`) so a long-
    # running session that began before the window but was active
    # inside it still surfaces under "Today" / "Last 7 days".
    if since:
        session_filters.append(Session.last_activity_at >= since)
    if until:
        session_filters.append(Session.last_activity_at < until)
    if environment_id:
        session_filters.append(Session.environment_id == environment_id)

    if model:
        session_filters.append(Session.model.in_(model))
    if tag:
        # AND semantics for tags: every requested tag must be present.
        # `tags @> ARRAY[...]` is the indexable form vs N separate
        # `tags && ARRAY[t]` clauses.
        session_filters.append(Session.tags.op("@>")(tag))
    if min_messages is not None:
        session_filters.append(Session.message_count >= min_messages)
    if min_duration is not None:
        session_filters.append(Session.duration_seconds >= min_duration)
    if has_pr is True:
        # `related_refs ? 'prs'` would also match `{"prs": null}` — we
        # want a non-empty array. The JSONB length check is explicit
        # and matches what `_session_to_response` carries.
        session_filters.extend(
            (
                Session.related_refs.is_not(None),
                func.jsonb_array_length(Session.related_refs.op("->")("prs")) > 0,
            )
        )
    elif has_pr is False:
        # Explicit "no PRs" — NULL `related_refs` (never extracted)
        # counts as "no PR".
        session_filters.append(
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
        if automated:
            summary_text = func.coalesce(Session.summary, "")
            session_filters.append(or_(summary_text.like("Cron:%"), summary_text.like("[%")))
        else:
            session_filters.append(_MANUAL_SESSION_SUMMARY_FILTER)

    if q:
        # pg_trgm `similarity()` for typo / partial-word tolerance.
        # NOT index-accelerated — the function-call form doesn't trigger
        # the `gin_trgm_ops` operator class (only `%` / `<%` / `LIKE`
        # do). Runs as a Seq Scan over the user's session set; fine
        # for the typical few-thousand-rows-per-user. If a power user
        # ever hits real latency here, swap to `WHERE summary % :q`
        # plus a GIN index. Threshold tuned for "type to filter" UX.
        assert relevance_expr is not None
        assert metadata_relevance_expr is not None
        assert message_match is not None
        session_filters.append(
            or_(
                metadata_relevance_expr >= _TRGM_THRESHOLD,
                message_match.c.session_id.is_not(None),
            )
        )

    base = base.where(*session_filters)
    if agent_filter is not None:
        base = base.where(agent_filter)

    # Run the count BEFORE attaching ORDER BY: PG would otherwise
    # plan a sort over the full filtered set just to discard it for
    # COUNT(*). For 50k+ session users this saves a measurable
    # fraction of list-page latency.
    count_base = select(Session.id).where(*session_filters)
    if message_match is not None:
        count_base = count_base.outerjoin(message_match, message_match.c.session_id == Session.id)
    if agent_filter is not None:
        count_base = count_base.outerjoin(
            AgentEnvironment,
            Session.environment_id == AgentEnvironment.id,
        ).where(agent_filter)
    total = (await db.execute(select(func.count()).select_from(count_base.subquery()))).scalar_one()

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

    items: list[SessionListItemResponse] = []
    for row in rows:
        search_match: SessionSearchMatchResponse | None = None
        if q:
            (
                s,
                agent_type,
                display_name,
                default_name,
                machine_name,
                shared,
                message_score,
                message_content,
                message_role,
                message_position,
                message_revision,
            ) = row
            if (
                message_score is not None
                and isinstance(message_content, str)
                and message_role in ("user", "assistant")
                and isinstance(message_position, int)
                and isinstance(message_revision, str)
            ):
                anchor_kind: Literal["snapshot_offset", "event_seq"] = (
                    "event_seq" if s.content_protocol == "events-v1" else "snapshot_offset"
                )
                search_match = SessionSearchMatchResponse(
                    role=message_role,
                    excerpt=_message_search_excerpt(message_content, q),
                    anchor=SessionSearchAnchorResponse(
                        kind=anchor_kind,
                        position=message_position,
                        revision=message_revision,
                    ),
                )
        else:
            s, agent_type, display_name, default_name, machine_name, shared = row
        items.append(
            _session_to_response(
                s,
                agent_type=agent_type,
                agent_display_name=display_name,
                agent_default_name=default_name,
                machine_name=machine_name,
                is_shared=bool(shared),
                search_match=search_match,
            )
        )

    return Paginated[SessionListItemResponse](
        items=items,
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/sessions/{session_id}")
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
            AgentEnvironment.display_name,
            AgentEnvironment.default_name,
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

    session, agent_type, display_name, default_name, machine_name, is_shared = row
    return SessionDetailResponse(
        **_session_to_response(
            session,
            agent_type=agent_type,
            agent_display_name=display_name,
            agent_default_name=default_name,
            machine_name=machine_name,
            is_shared=bool(is_shared),
        ).model_dump(),
        has_content=session_has_uploaded_content(session),
    )


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(
    session_id: UUID,
    auth: AuthContext = Depends(require_web_auth),
    db: AsyncSession = Depends(get_session),
) -> None:
    session = (
        await db.execute(
            select(Session)
            .where(
                Session.id == session_id,
                Session.user_id == auth.user_id,
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if session is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")

    event_file_keys = list(
        (
            await db.execute(
                select(SessionEventChunk.file_key).where(SessionEventChunk.session_id == session.id)
            )
        ).scalars()
    )
    try:
        await file_store.delete(session.file_key or _session_content_key(session))
        for file_key in event_file_keys:
            await file_store.delete(file_key)
    except Exception:
        log.exception("session_content_delete_failed session_id=%s", session.id)
        await db.rollback()
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Session storage is temporarily unavailable. Please retry.",
        ) from None

    try:
        suppression = pg_insert(SessionSyncSuppression).values(
            user_id=auth.user_id,
            origin_environment_id=session.origin_environment_id,
            local_session_id=session.local_session_id,
        )
        await db.execute(suppression.on_conflict_do_nothing())
        await db.execute(
            update(Memory)
            .where(
                Memory.user_id == auth.user_id,
                Memory.source_session_id == session.id,
            )
            .values(source_session_id=None)
        )
        await db.delete(session)
        await db.commit()
    except Exception:
        await db.rollback()
        raise


@router.post("/sessions/{local_session_id}/upload")
async def upload_session_content(
    # Constrained to safe filename chars so the legacy object key remains
    # inside the user's Session prefix.
    local_session_id: str = Path(..., pattern=_SESSION_LOCAL_ID_PATTERN),
    environment_id: UUID | None = Form(default=None),
    expected_content_hash: str | None = Form(default=None, pattern=r"^[0-9a-f]{64}$"),
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
        stmt = stmt.where(Session.origin_environment_id == bound_env)
    elif environment_id is not None:
        stmt = stmt.where(Session.origin_environment_id == environment_id)
    sessions = list((await db.execute(stmt.with_for_update())).scalars())
    if not sessions:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    if len(sessions) != 1:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "session_origin_required",
                "message": (
                    "More than one Agent owns this local_session_id; "
                    "use an environment-bound credential."
                ),
            },
        )
    session = sessions[0]

    if session.content_protocol == "events-v1":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Session has been upgraded to events-v1",
        )

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
    # Hash, JSON validation, and reference extraction are CPU-bound for large
    # snapshots. Keep them together off the event loop so other requests can
    # continue while this upload is analyzed.
    analysis = await _analyze_session_upload(data)
    content_hash = analysis.content_hash

    # New clients submit the hash announced in the preceding batch as a CAS
    # fence. Keeping this field optional preserves deployed clients' original
    # upload behavior while preventing delayed H2 from replacing newer H3.
    if expected_content_hash is not None and (
        expected_content_hash != content_hash or session.content_hash != expected_content_hash
    ):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "session_content_hash_mismatch",
                "expected_content_hash": session.content_hash,
                "received_content_hash": content_hash,
            },
        )

    fk = _session_content_key(session)
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
    session.related_refs = analysis.related_refs
    await replace_snapshot_search_index(
        db,
        session,
        content_hash,
        analysis.search_messages,
    )
    if analysis.parse_error is not None:
        # Preserve the worker-thread traceback for diagnosing malformed
        # snapshots without failing their best-effort upload.
        error = analysis.parse_error
        log.error(
            "refs_extract_failed local_session_id=%s — leaving field NULL",
            local_session_id,
            exc_info=(type(error), error, error.__traceback__),
        )

    await db.commit()

    return SessionUploadResponse(status="uploaded", file_key=fk, content_hash=content_hash)


@router.get("/sessions/{session_id}/content")
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

    if not session_has_uploaded_content(session):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session content not uploaded")
    try:
        raw = await load_session_messages(session, file_store, db)
    except SessionContentMissing:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session content file not found") from None
    except SessionContentInvalid:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "Internal server error"
        ) from None

    return [SessionMessageResponse.model_validate(m) for m in raw]


@router.get("/sessions/{session_id}/messages")
async def get_session_messages(
    session_id: UUID,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    direction: Literal["asc", "desc"] = Query(default="asc"),
    anchor_kind: Literal["snapshot_offset", "event_seq"] | None = Query(default=None),
    anchor_position: int | None = Query(default=None, ge=0),
    anchor_revision: str | None = Query(default=None, min_length=1, max_length=80),
    auth: AuthContext = Depends(require_scope("sessions:read")),
    db: AsyncSession = Depends(get_session),
) -> SessionMessagesPage:
    """Paginated read of a session's messages, for the dashboard.
    The CLI's `clawdi pull` mirror still uses
    `GET /v1/sessions/{id}/content` to grab the full JSON blob;
    this endpoint slices the same blob server-side so the
    dashboard doesn't ship 10+ MB of messages on a long session.

    Pagination is offset-based within the requested direction. `offset=0`
    starts at the oldest visible message for ascending reads and at the newest
    visible message for descending reads. Clients pin pages to the parent
    session's `content_hash`, which changes after snapshot replacement or event
    append. A complete search anchor recenters the first page around its match;
    stale anchors degrade to ordinary offset pagination.
    """
    anchor_values = (anchor_kind, anchor_position, anchor_revision)
    if any(value is not None for value in anchor_values) and not all(
        value is not None for value in anchor_values
    ):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Search anchor requires kind, position, and revision",
        )

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

    if not session_has_uploaded_content(session):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session content not uploaded")

    # Shared loader handles the (file_key, content_hash)-keyed cache,
    # the file_store fetch, JSON parse, and shape validation. Lives in
    # `services/session_content.py` so the public share routes can
    # share the same cache — a popular shared link must not re-parse
    # a 10 MB JSON blob per visitor.
    try:
        projection = await load_session_message_projection(session, file_store, db)
    except SessionContentMissing:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session content file not found") from None
    except SessionContentInvalid:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "Internal server error"
        ) from None

    total = len(projection.messages)
    page_offset = offset
    anchor_offset: int | None = None
    expected_anchor_kind: Literal["snapshot_offset", "event_seq"] = (
        "event_seq" if session.content_protocol == "events-v1" else "snapshot_offset"
    )
    if (
        anchor_kind is not None
        and anchor_position is not None
        and anchor_revision is not None
        and anchor_kind == expected_anchor_kind
        and anchor_revision == current_search_revision(session)
    ):
        try:
            source_index = projection.source_positions.index(anchor_position)
        except ValueError:
            pass
        else:
            anchor_offset = source_index if direction == "asc" else total - source_index - 1
            page_offset = min(
                max(0, anchor_offset - limit // 2),
                max(0, total - limit),
            )

    sliced = slice_session_messages(
        projection.messages,
        offset=page_offset,
        limit=limit,
        direction=direction,
    )
    return SessionMessagesPage(
        items=[SessionMessageResponse.model_validate(m) for m in sliced],
        total=total,
        offset=page_offset,
        limit=limit,
        anchor_offset=anchor_offset,
    )


@router.post("/sessions/{local_session_id}/extract")
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
    if not session_has_uploaded_content(session):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Session content has not been uploaded",
        )

    try:
        messages = await load_session_messages(session, file_store, db)
    except SessionContentMissing:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session content file not found") from None
    except SessionContentInvalid:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "Internal server error"
        ) from None

    client = memory_extraction.create_memory_extraction_client(
        base_url=settings.llm_base_url or None,
        api_key=settings.llm_api_key,
    )
    try:
        extracted = await memory_extraction.extract_memories_from_session(
            messages,
            project_path=session.project_path,
            client=client,
            model=settings.llm_model,
        )
    except memory_extraction.MemoryExtractionUpstreamError as exc:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE if exc.unavailable else status.HTTP_502_BAD_GATEWAY,
            "Memory extraction provider is unavailable"
            if exc.unavailable
            else "Memory extraction provider returned an invalid response",
        ) from exc

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


@router.get("/sessions/{session_id}/export.md")
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

    if not session_has_uploaded_content(session):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session content not uploaded")

    try:
        messages = await load_session_messages(session, file_store, db)
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


@router.get("/sessions/{session_id}/permissions")
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


@router.post("/sessions/{session_id}/permissions")
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
    "/sessions/{session_id}/permissions",
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
    agent_display_name: str | None = None,
    agent_default_name: str | None = None,
    machine_name: str | None = None,
    is_shared: bool = False,
    search_match: SessionSearchMatchResponse | None = None,
) -> SessionListItemResponse:
    agent_name = (
        _agent_name_from_fields(agent_display_name, agent_default_name, machine_name, None)
        if any((agent_display_name, agent_default_name, machine_name))
        else None
    )
    return SessionListItemResponse(
        id=str(s.id),
        local_session_id=s.local_session_id,
        project_path=s.project_path,
        agent_name=agent_name,
        agent_display_name=agent_display_name,
        agent_default_name=agent_default_name,
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
        content_protocol=s.content_protocol,
        event_head_hash=s.event_head_hash,
        is_shared=is_shared,
        search_match=search_match,
        related_refs=_related_refs_response(s.related_refs),
    )


def _related_refs_json(value: dict[str, list[str]]) -> dict[str, JsonValue]:
    result: dict[str, JsonValue] = {}
    for key, refs in value.items():
        json_refs: list[JsonValue] = [ref for ref in refs]
        result[key] = json_refs
    return result


def _related_refs_response(
    value: dict[str, JsonValue] | None,
) -> dict[str, list[str]] | None:
    if value is None:
        return None
    return _RELATED_REFS_ADAPTER.validate_python(value)


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
        kind=cast(Literal["link", "user", "email"], p.kind),
        user_id=str(p.user_id) if p.user_id else None,
        email=p.email,
        role=cast(Literal["viewer"], p.role),
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
