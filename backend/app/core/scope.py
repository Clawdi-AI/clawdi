"""Default-scope resolver — the compat shim for phase 1 of the
env-scoped-skills milestone.

Every write target (skills, vaults) carries a required `scope_id`
column. Routes that need to resolve the scope from the caller's
auth context (rather than taking a `/api/scopes/{scope_id}/...`
path parameter) use the helpers below:

  * api_key with environment_id binding → that env's
    `default_scope_id`. Always defined; no ambiguity.
  * Clerk JWT, single env owned by user → that env's
    `default_scope_id`. The "I have one machine" common case.
  * Clerk JWT, multiple envs → the most-recently-active env's
    `default_scope_id`. Same heuristic the migration uses to
    backfill so live writes line up with where existing data
    landed (deterministic tiebreak: `last_seen_at DESC NULLS LAST,
    id DESC`).
  * Clerk JWT, no envs registered → the user's Personal scope.
    Pre-daemon accounts can still create entities from the
    dashboard.

For READ paths the dashboard wants to see the user's full
inventory across every scope — different helper
(`scope_ids_visible_to`) returns the list of scopes the caller
can read.

The runtime kill-switch `SCOPE_ROUTING_ENABLED` (env var, default
true) lets ops disable scope-aware behavior without rolling back
the migration: when off, writes go to whichever scope is
convenient (still NOT NULL, but caller doesn't have to wire
through a picker).

See `docs/plans/env-scoped-skills.md` for the full design.
"""

from __future__ import annotations

import logging
import os
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext
from app.models.scope import SCOPE_KIND_PERSONAL, Scope
from app.models.session import AgentEnvironment


def scope_routing_enabled() -> bool:
    """Read the runtime kill switch. Default ON (`true`). When the
    env var is `false` / `0` / `off`, scope resolution falls back
    to the user's Personal scope unconditionally — preserves
    correctness (every row still gets a scope_id) while taking
    the new routing logic out of the hot path.
    """
    raw = os.environ.get("SCOPE_ROUTING_ENABLED", "true").strip().lower()
    return raw not in ("false", "0", "off", "no")


_log = logging.getLogger(__name__)


async def _personal_scope_id(db: AsyncSession, user_id: UUID) -> UUID:
    """Look up the user's Personal scope. Logs+500s if missing —
    the migration creates one for every user, and new user signup
    should as well, so a missing Personal is a real bug worth
    surfacing rather than silently creating one on the fly.
    Internal detail stays in logs; client gets a generic message.
    """
    result = await db.execute(
        select(Scope.id).where(
            Scope.user_id == user_id,
            Scope.kind == SCOPE_KIND_PERSONAL,
        )
    )
    scope_id = result.scalar_one_or_none()
    if scope_id is None:
        _log.error(
            "personal_scope_missing user=%s — migration or signup hook is broken",
            user_id,
        )
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "internal server error",
        )
    return scope_id


async def resolve_default_write_scope(
    db: AsyncSession,
    auth: AuthContext,
) -> UUID:
    """Pick the scope a write from `auth` should land in.

    Order:
      1. Kill switch off → Personal.
      2. api_key bound to an env → that env's default_scope_id.
      3. Clerk JWT or unbound api_key → most-recently-active env's
         default_scope_id, OR Personal if user has no envs.

    Returns a scope_id that the caller can immediately use as the
    `scope_id` column value on insert. Always returns a value
    (never None) — callers can treat the column as required.
    """
    # Env-bound api_key path FIRST, ahead of the kill switch.
    # SCOPE_ROUTING_ENABLED=false is meant to ramp scope routing
    # off for free-tier Clerk JWT users in case of migration
    # issues — it MUST NOT route a deploy key into the Personal
    # scope, because that would let a key bound to env-A read /
    # write user-wide Personal data. The kill switch falls
    # through ONLY for unbound auth contexts below.
    if auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None:
        bound_env_id = auth.api_key.environment_id
        result = await db.execute(
            select(AgentEnvironment.default_scope_id).where(
                AgentEnvironment.id == bound_env_id,
                AgentEnvironment.user_id == auth.user_id,
            )
        )
        scope_id = result.scalar_one_or_none()
        if scope_id is None:
            # Env vanished out from under the key (deleted by the
            # dashboard) — surface as 404 so the daemon can re-auth
            # rather than 500-ing.
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "bound environment not found",
            )
        return scope_id

    if not scope_routing_enabled():
        return await _personal_scope_id(db, auth.user_id)

    # Clerk JWT path (or unbound api_key, rare): pick most-recently-
    # active env's default_scope_id. Same SQL the migration uses for
    # backfill so live writes land in the same scope as existing
    # data.
    result = await db.execute(
        select(AgentEnvironment.default_scope_id)
        .where(AgentEnvironment.user_id == auth.user_id)
        .order_by(
            AgentEnvironment.last_seen_at.desc().nulls_last(),
            AgentEnvironment.id.desc(),
        )
        .limit(1)
    )
    scope_id = result.scalar_one_or_none()
    if scope_id is not None:
        return scope_id

    # Zero envs — pre-daemon account. Personal is the only viable
    # target.
    return await _personal_scope_id(db, auth.user_id)


async def validate_scope_for_caller(
    db: AsyncSession,
    auth: AuthContext,
    scope_id: UUID,
) -> UUID:
    """Validate that the caller may write to the given `scope_id`.

    Used by the phase-2 explicit-scope routes
    (`/api/scopes/{scope_id}/skills/...`) where the scope is part
    of the URL rather than auto-resolved from the caller's auth.

    Rules:
      * The scope must exist and belong to the authenticated user.
      * If the caller is an api_key bound to a specific environment,
        the scope must equal that env's `default_scope_id`. A daemon
        for env A cannot pass `scope_id=B` in the URL and bypass
        the bound-env isolation.
      * Clerk JWT (dashboard) callers may target any of their own
        scopes — same as `scope_ids_visible_to` for reads.

    404 if the scope doesn't belong to the user; 403 if the caller's
    api_key binding doesn't match the scope.
    """
    # Plain ownership check, no row lock. The earlier `.with_for_update()`
    # locked the entire `scopes` row for the whole request, including
    # for read-only paths (GET /skills/{key}, download). A slow file-store
    # download or batch of daemon pulls would block every other operation
    # touching the same scope (uploads, deletes, etc.) — defeating the
    # per-skill advisory lock that's supposed to be the contention
    # boundary. Validation only needs to check ownership; the actual
    # write paths (upload, delete) take a `pg_advisory_xact_lock` keyed
    # on `(user, scope, skill_key)` for serialization.
    scope_owner = await db.execute(
        select(Scope.id).where(
            Scope.user_id == auth.user_id,
            Scope.id == scope_id,
        )
    )
    if scope_owner.scalar_one_or_none() is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "scope not found",
        )

    if auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None:
        bound_env_id = auth.api_key.environment_id
        bound_scope_result = await db.execute(
            select(AgentEnvironment.default_scope_id).where(
                AgentEnvironment.id == bound_env_id,
                AgentEnvironment.user_id == auth.user_id,
            )
        )
        bound_scope = bound_scope_result.scalar_one_or_none()
        if bound_scope != scope_id:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "api key not bound to this scope",
            )

    return scope_id


async def scope_ids_visible_to(
    db: AsyncSession,
    auth: AuthContext,
) -> list[UUID]:
    """Return every scope_id the caller may read.

    Phase-1 policy:
      * Clerk JWT → ALL scopes the user owns (dashboard sees their
        whole inventory). Critical: without this the dashboard
        would query Personal but most data lives in env-local
        scopes after backfill, producing a day-1 empty-list
        regression.
      * api_key bound to env → only the bound env's
        `default_scope_id` (daemons get their own scope's data,
        nothing else). This is the deploy-key blast radius
        boundary — a leaked key from env A must not gain
        visibility into env B's data ever.
      * api_key WITHOUT env binding (the device-flow CLI key from
        `clawdi auth login`) → ALL the user's scopes, same as
        Clerk JWT. The user authenticated as themselves; multi-
        agent setups need `clawdi serve --agent <other>` and
        `clawdi push --all` to operate on any of the user's envs,
        not just whichever was touched last. An earlier "single
        most-recently-active scope" policy broke `serve --agent`
        when its scope wasn't the default, since the daemon's
        explicit `?scope_id=...` listing intersected to empty.
    """
    # Bound api_keys are ALWAYS restricted to their bound scope —
    # check this first, before the kill-switch fallback. The kill
    # switch turns off scope-aware routing, but it must NEVER
    # disable the env-binding boundary on a deploy key.
    if auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None:
        env_scope = await resolve_default_write_scope(db, auth)
        return [env_scope]

    if not scope_routing_enabled():
        # Kill-switch path: all of the user's scopes.
        result = await db.execute(select(Scope.id).where(Scope.user_id == auth.user_id))
        return list(result.scalars().all())

    # Clerk JWT and unbound CLI key: full inventory.
    result = await db.execute(select(Scope.id).where(Scope.user_id == auth.user_id))
    return list(result.scalars().all())
