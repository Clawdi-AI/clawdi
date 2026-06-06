"""Admin endpoints — gated by `X-Admin-Key` shared secret.

Used by upstream-SaaS batch tooling and ops-side scripts that don't
have a per-user Clerk JWT available (e.g. catching up legacy
deployments that pre-date live sync, account-deletion webhooks, fleet
revocation). Disabled by default — `settings.admin_api_key` must be
set to a strong secret to enable.

**Trust model:** admin-minted keys carry the same authority as keys
the user mints for themselves via `POST /api/auth/keys` — full
account access by default. The X-Admin-Key is therefore a root
credential: a leak grants an attacker the ability to mint full-power
keys for any user. Protect it like a database password (rotate on
suspicion, restrict to SaaS backend egress IPs at the infra layer,
audit log access).

The product reasoning: a user's hosted pod is the user's agent
running on our infrastructure — it must be able to do everything
the user can do on their own laptop. Capping admin-minted keys
below user-mint power would make hosted strictly weaker than
self-managed (vault reads, memory reads, etc. would silently fail).

Surface kept minimal: just the operations that batch tooling
genuinely can't accomplish via per-user Clerk JWTs. Future admin
endpoints (list users, view any deployment, audit-log query, etc.)
can land in this file under the same auth dep.
"""

import logging
import uuid
from datetime import UTC, datetime, timedelta
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import require_admin_api_key
from app.core.database import get_session
from app.models.api_key import ApiKey
from app.models.project import PROJECT_KIND_ENVIRONMENT, Project
from app.models.session import AgentEnvironment, Session
from app.models.user import User
from app.schemas.admin import AdminApiKeyCreate, AdminEnvironmentCreate
from app.schemas.api_key import ApiKeyCreated, ApiKeyRevokeResponse
from app.schemas.session import EnvironmentCreatedResponse
from app.services.api_key import mint_api_key
from app.services.user_provisioning import lazy_create_user_with_personal_project

logger = logging.getLogger(__name__)

# `include_in_schema=False`: admin endpoints are server-to-server only
# (SaaS batch tooling + ops scripts). Excluding them from /openapi.json
# stops `bun run generate-api` (web/CLI typed-client codegen) from
# emitting bindings for them, so a leaked frontend bundle can't even
# tell admin endpoints exist let alone what header they expect. The
# routes themselves stay live — gating is `require_admin_api_key`.
router = APIRouter(prefix="/api/admin", tags=["admin"], include_in_schema=False)


def _is_automated_session(summary: str | None) -> bool:
    summary_text = summary or ""
    return summary_text.startswith("Cron:") or summary_text.startswith("[")


def _percentile(values: list[int], percentile: float) -> int:
    if not values:
        return 0
    sorted_values = sorted(values)
    index = max(0, min(len(sorted_values) - 1, int((len(sorted_values) - 1) * percentile)))
    return sorted_values[index]


async def _resolve_or_create_user(db: AsyncSession, clerk_id: str) -> User:
    """Resolve a user by clerk_id, lazy-creating the row + Personal
    project if needed.

    The lazy-create exists for the common SaaS-deploy entry path
    where a user clicks Deploy on clawdi.ai before ever signing
    into cloud.clawdi.ai directly. Without it the admin endpoint
    would 404, the SaaS would catch the error, the pod would deploy
    without sync, and the user would have to redeploy after their
    first direct visit.

    Trust model: `clerk_id` here is value the SaaS already
    authenticated against the user's Clerk session — the shared
    `X-Admin-Key` gate trusts first-party server-to-server callers.
    Email/name are unknown (no JWT available); the row starts with
    `email=None` and the JWT path backfills on first direct sign-in.

    Race-loser status is 500 (not 401): admin callers are
    first-party SaaS code, so a vanishing-winner-row situation is
    an operational anomaly worth a loud failure rather than a
    user-flow retry.
    """
    target = (await db.execute(select(User).where(User.clerk_id == clerk_id))).scalar_one_or_none()
    if target is not None:
        return target

    user = await lazy_create_user_with_personal_project(
        db,
        clerk_id=clerk_id,
        email=None,
        name=None,
        race_loser_status=status.HTTP_500_INTERNAL_SERVER_ERROR,
    )
    logger.info("admin_lazy_create_user clerk_id=%s user_id=%s", clerk_id, user.id)
    return user


@router.get("/stats/sessions")
async def admin_session_stats(
    _: None = Depends(require_admin_api_key),
    db: AsyncSession = Depends(get_session),
    since: datetime | None = Query(
        default=None,
        description="Window start; defaults to the current UTC day.",
    ),
    until: datetime | None = Query(
        default=None,
        description="Window end; defaults to the next UTC day after since.",
    ),
) -> dict:
    """Fleet-wide session volume for capacity planning.

    This route intentionally returns aggregate counters only. It is used for
    quota/cost planning and cron-noise analysis; it does not expose session
    summaries, project paths, or message content.
    """

    now = datetime.now(UTC)
    window_start = since or datetime(now.year, now.month, now.day, tzinfo=UTC)
    window_end = until or (window_start + timedelta(days=1))
    if window_end <= window_start:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "until must be after since")

    rows = (
        await db.execute(
            select(
                Session.user_id,
                AgentEnvironment.agent_type,
                Session.summary,
                Session.message_count,
                Session.duration_seconds,
                Session.input_tokens,
                Session.output_tokens,
                Session.cache_read_tokens,
                Session.file_key,
            )
            .outerjoin(AgentEnvironment, Session.environment_id == AgentEnvironment.id)
            .where(Session.last_activity_at >= window_start, Session.last_activity_at < window_end)
        )
    ).all()

    by_user: dict[str, int] = {}
    automated_users: set[str] = set()
    manual_users: set[str] = set()
    agent_counts: dict[str, int] = {}
    totals = {
        "sessions": 0,
        "messages": 0,
        "tokens": 0,
        "sessions_with_content": 0,
        "automated_sessions": 0,
        "automated_messages": 0,
        "manual_sessions": 0,
        "manual_messages": 0,
        "tiny_sessions": 0,
    }

    for row in rows:
        user_id = str(row.user_id)
        message_count = int(row.message_count or 0)
        duration_seconds = int(row.duration_seconds or 0)
        token_count = int(row.input_tokens or 0) + int(row.output_tokens or 0)
        if row.cache_read_tokens:
            token_count += int(row.cache_read_tokens)
        automated = _is_automated_session(row.summary)
        agent_type = row.agent_type or "unknown"

        totals["sessions"] += 1
        totals["messages"] += message_count
        totals["tokens"] += token_count
        if row.file_key:
            totals["sessions_with_content"] += 1
        if message_count <= 3 or duration_seconds <= 120:
            totals["tiny_sessions"] += 1
        by_user[user_id] = by_user.get(user_id, 0) + 1
        agent_counts[agent_type] = agent_counts.get(agent_type, 0) + 1
        if automated:
            totals["automated_sessions"] += 1
            totals["automated_messages"] += message_count
            automated_users.add(user_id)
        else:
            totals["manual_sessions"] += 1
            totals["manual_messages"] += message_count
            manual_users.add(user_id)

    session_counts = list(by_user.values())
    user_count = len(by_user)
    automated_session_share = (
        totals["automated_sessions"] / totals["sessions"] if totals["sessions"] else 0
    )

    return {
        "window": {
            "since": window_start.isoformat(),
            "until": window_end.isoformat(),
        },
        "totals": {
            **totals,
            "active_users": user_count,
            "automated_users": len(automated_users),
            "manual_users": len(manual_users),
            "automated_session_share": automated_session_share,
        },
        "per_user": {
            "p50_sessions": _percentile(session_counts, 0.50),
            "p90_sessions": _percentile(session_counts, 0.90),
            "p95_sessions": _percentile(session_counts, 0.95),
            "max_sessions": max(session_counts) if session_counts else 0,
        },
        "agents": sorted(
            [
                {"agent_type": agent_type, "sessions": count}
                for agent_type, count in agent_counts.items()
            ],
            key=lambda item: item["sessions"],
            reverse=True,
        ),
    }


@router.post("/auth/keys", response_model=ApiKeyCreated)
async def admin_mint_api_key(
    body: AdminApiKeyCreate,
    _: None = Depends(require_admin_api_key),
    db: AsyncSession = Depends(get_session),
) -> ApiKeyCreated:
    """Mint an api_key on behalf of a user identified by Clerk id.

    Used by upstream-SaaS batch tooling: each legacy deployment that
    didn't have live sync wired up needs a fresh api_key bound to a
    fresh env, but the migration script has no per-user Clerk JWT.

    User row is lazy-created if absent — handles the common entry
    path of a user whose first interaction with cloud-api is via
    SaaS-side admin calls. See `_resolve_or_create_user` for the
    safety model.
    """
    target = await _resolve_or_create_user(db, body.target_clerk_id)

    env_uuid: UUID | None = None
    if body.environment_id:
        try:
            env_uuid = UUID(body.environment_id)
        except (TypeError, ValueError) as e:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "environment_id is not a valid UUID"
            ) from e

    # `scopes=None` is full API permission access — same default as
    # user-self-mint via `POST /api/auth/keys`. Callers may pass a
    # narrower permission list to lock the minted key down (e.g. ops
    # tooling that only needs to push sessions); the route doesn't
    # impose a ceiling.
    try:
        minted = await mint_api_key(
            db,
            user_id=target.id,
            label=body.label,
            scopes=body.scopes,
            environment_id=env_uuid,
        )
    except ValueError as e:
        # `mint_api_key` raises ValueError for cross-tenant
        # environment_id (env not owned by target user). Surface
        # as 403 — admin can't bypass the service-layer invariant.
        # Log so an operator debugging "why is the mint failing?"
        # can grep cloud-api logs directly without correlating with
        # the SaaS side.
        logger.warning(
            "admin_mint_rejected reason=cross_tenant_env target_clerk_id=%s env=%s",
            body.target_clerk_id,
            env_uuid,
        )
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(e)) from e

    api_key = minted.api_key
    logger.info(
        "admin_api_key_minted target_clerk_id=%s key_id=%s environment_id=%s",
        body.target_clerk_id,
        api_key.id,
        api_key.environment_id,
    )
    return ApiKeyCreated(
        id=str(api_key.id),
        label=api_key.label,
        key_prefix=api_key.key_prefix,
        created_at=api_key.created_at,
        last_used_at=api_key.last_used_at,
        expires_at=api_key.expires_at,
        revoked_at=api_key.revoked_at,
        raw_key=minted.raw_key,
    )


@router.delete("/auth/keys/{key_id}", response_model=ApiKeyRevokeResponse)
async def admin_revoke_api_key(
    key_id: UUID,
    _: None = Depends(require_admin_api_key),
    db: AsyncSession = Depends(get_session),
) -> ApiKeyRevokeResponse:
    """Revoke any user's api_key. Used by SaaS admin/account-deletion
    paths (which don't have the user's Clerk JWT) to close the
    orphan-key gap from the cross-PR audit."""
    api_key = (await db.execute(select(ApiKey).where(ApiKey.id == key_id))).scalar_one_or_none()
    if api_key is None:
        # 404 = idempotent success for the caller. The migration
        # script can re-run after a partial failure without
        # special-casing already-revoked keys.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "API key not found")

    if api_key.revoked_at is not None:
        # Already revoked — idempotent, return existing state.
        return ApiKeyRevokeResponse(status="revoked")

    api_key.revoked_at = datetime.now(UTC)
    await db.commit()
    logger.info(
        "admin_api_key_revoked target_user_id=%s key_id=%s",
        api_key.user_id,
        api_key.id,
    )
    return ApiKeyRevokeResponse(status="revoked")


@router.post("/environments", response_model=EnvironmentCreatedResponse)
async def admin_register_environment(
    body: AdminEnvironmentCreate,
    _: None = Depends(require_admin_api_key),
    db: AsyncSession = Depends(get_session),
) -> EnvironmentCreatedResponse:
    """Register an AgentEnvironment row on behalf of a target user.

    Migration tooling needs to seed env_id for legacy deployments
    where no per-user Clerk JWT is in project. The user-facing
    `POST /api/environments` requires a Clerk-authed or Agent environment
    api_key request; this admin variant is gated by the shared
    `X-Admin-Key` header instead.

    Idempotent: re-registering (target_clerk_id, machine_id,
    agent_type) returns the existing env id and refreshes
    `machine_name` / `agent_version` / `last_seen_at`. Concurrent
    callers race-safe via `with_for_update` on the lookup, mirror-
    ing the heal logic in `register_environment` for the
    user-facing endpoint.

    User row is lazy-created if absent — see `_resolve_or_create_user`.
    """
    target = await _resolve_or_create_user(db, body.target_clerk_id)

    # FOR UPDATE row-locks the env so concurrent admin-registers
    # for the same (user, machine) serialize through the heal
    # branch — without this both writers would see
    # default_project_id IS NULL and create competing projects.
    existing = (
        await db.execute(
            select(AgentEnvironment)
            .where(
                AgentEnvironment.user_id == target.id,
                AgentEnvironment.machine_id == body.machine_id,
                AgentEnvironment.agent_type == body.agent_type,
            )
            .with_for_update()
        )
    ).scalar_one_or_none()

    if existing is not None:
        existing.machine_name = body.machine_name
        existing.agent_version = body.agent_version
        existing.last_seen_at = datetime.now(UTC)
        # Heal envs missing default_project_id (older rows or
        # interrupted creates) — same logic the user-facing route
        # runs.
        if existing.default_project_id is None:
            healing_project = Project(
                user_id=target.id,
                name=f"{body.machine_name} ({body.agent_type})",
                slug=f"env-{uuid.uuid4().hex[:12]}",
                kind=PROJECT_KIND_ENVIRONMENT,
                origin_environment_id=existing.id,
            )
            db.add(healing_project)
            await db.flush()
            existing.default_project_id = healing_project.id
        await db.commit()
        return EnvironmentCreatedResponse(id=str(existing.id))

    # Create project first (no origin_environment_id yet — env doesn't
    # exist), then env pointing at the project, then back-fill
    # project.origin_environment_id. Mirror of register_environment's
    # mutual-FK insertion order.
    project = Project(
        user_id=target.id,
        name=f"{body.machine_name} ({body.agent_type})",
        slug=f"env-{uuid.uuid4().hex[:12]}",
        kind=PROJECT_KIND_ENVIRONMENT,
    )
    db.add(project)
    try:
        await db.flush()
        env = AgentEnvironment(
            user_id=target.id,
            machine_id=body.machine_id,
            machine_name=body.machine_name,
            agent_type=body.agent_type,
            agent_version=body.agent_version,
            os=body.os_name,
            last_seen_at=datetime.now(UTC),
            default_project_id=project.id,
        )
        db.add(env)
        await db.flush()
        project.origin_environment_id = env.id
        await db.commit()
        await db.refresh(env)
    except IntegrityError:
        # Race: another admin-register won. Re-query.
        await db.rollback()
        env = (
            await db.execute(
                select(AgentEnvironment).where(
                    AgentEnvironment.user_id == target.id,
                    AgentEnvironment.machine_id == body.machine_id,
                    AgentEnvironment.agent_type == body.agent_type,
                )
            )
        ).scalar_one()

    logger.info(
        "admin_environment_registered target_clerk_id=%s env_id=%s machine_id=%s",
        body.target_clerk_id,
        env.id,
        body.machine_id,
    )
    return EnvironmentCreatedResponse(id=str(env.id))
