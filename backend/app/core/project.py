"""Project resolution helpers.

Every write target (skills, vaults) carries a required `project_id`
column. Routes that need to resolve the project from the caller's
auth context (rather than taking a `/api/projects/{project_id}/...`
path parameter) use the helpers below:

  * api_key with environment_id → that Agent Project id. Always
    defined; no ambiguity.
  * Clerk JWT, single env owned by user → that env's
    `default_project_id`. The "I have one machine" common case.
  * Clerk JWT, multiple envs → the most-recently-active env's
    `default_project_id`. Same heuristic the migration uses to
    backfill so live writes line up with where existing data
    landed (deterministic tiebreak: `last_seen_at DESC NULLS LAST,
    id DESC`).
  * Clerk JWT, no envs registered → the user's Personal project.
    Pre-daemon accounts can still create entities from the
    dashboard.

For READ paths the dashboard wants to see the user's full
inventory across every project — different helper
(`project_ids_visible_to`) returns the list of projects the caller
can read.

"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext
from app.models.project import PROJECT_KIND_PERSONAL, Project
from app.models.session import AgentEnvironment

_log = logging.getLogger(__name__)


async def _personal_project_id(db: AsyncSession, user_id: UUID) -> UUID:
    """Look up the user's Personal project. Logs+500s if missing —
    the migration creates one for every user, and new user signup
    should as well, so a missing Personal is a real bug worth
    surfacing rather than silently creating one on the fly.
    Internal detail stays in logs; client gets a generic message.
    """
    result = await db.execute(
        select(Project.id).where(
            Project.user_id == user_id,
            Project.kind == PROJECT_KIND_PERSONAL,
        )
    )
    project_id = result.scalar_one_or_none()
    if project_id is None:
        _log.error(
            "personal_project_missing user=%s — migration or signup hook is broken",
            user_id,
        )
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "internal server error",
        )
    return project_id


async def resolve_default_write_project(
    db: AsyncSession,
    auth: AuthContext,
) -> UUID:
    """Pick the project a write from `auth` should land in.

    Order:
      1. api_key bound to an Agent environment → that Agent Project id.
      2. Clerk JWT or unbound api_key → most-recently-active env's
         default_project_id, OR Personal if user has no envs.

    Returns a project_id that the caller can immediately use as the
    `project_id` column value on insert. Always returns a value
    (never None) — callers can treat the column as required.
    """
    if auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None:
        bound_env_id = auth.api_key.environment_id
        result = await db.execute(
            select(AgentEnvironment.default_project_id).where(
                AgentEnvironment.id == bound_env_id,
                AgentEnvironment.user_id == auth.user_id,
            )
        )
        project_id = result.scalar_one_or_none()
        if project_id is None:
            # Env vanished out from under the key (deleted by the
            # dashboard) — surface as 404 so the daemon can re-auth
            # rather than 500-ing.
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "bound environment not found",
            )
        return project_id

    # Clerk JWT path (or unbound api_key, rare): pick most-recently-
    # active env's default_project_id. Same SQL the migration uses for
    # backfill so live writes land in the same project as existing
    # data.
    result = await db.execute(
        select(AgentEnvironment.default_project_id)
        .where(AgentEnvironment.user_id == auth.user_id)
        .order_by(
            AgentEnvironment.last_seen_at.desc().nulls_last(),
            AgentEnvironment.id.desc(),
        )
        .limit(1)
    )
    project_id = result.scalar_one_or_none()
    if project_id is not None:
        return project_id

    # Zero envs — pre-daemon account. Personal is the only viable
    # target.
    return await _personal_project_id(db, auth.user_id)


async def validate_project_for_caller(
    db: AsyncSession,
    auth: AuthContext,
    project_id: UUID,
) -> UUID:
    """Validate that the caller may write to the given `project_id`.

    Used by the phase-2 explicit-project routes
    (`/api/projects/{project_id}/skills/...`) where the project is part
    of the URL rather than auto-resolved from the caller's auth.

    Rules:
      * The project must exist and belong to the authenticated user.
      * If the caller is an api_key bound to a specific Agent environment,
        the project must equal that Agent Project id. A daemon for Agent A
        cannot pass `project_id=B` in the URL and bypass isolation.
      * Clerk JWT (dashboard) callers may target any of their own
        projects — same as `project_ids_visible_to` for reads.

    404 if the project doesn't belong to the user; 403 if the caller's
    api_key binding doesn't match the project.
    """
    # Plain ownership check, no row lock. The earlier `.with_for_update()`
    # locked the entire project row for the whole request, including
    # for read-only paths (GET /skills/{key}, download). A slow file-store
    # download or batch of daemon pulls would block every other operation
    # touching the same project (uploads, deletes, etc.) — defeating the
    # per-skill advisory lock that's supposed to be the contention
    # boundary. Validation only needs to check ownership; the actual
    # write paths (upload, delete) take a `pg_advisory_xact_lock` keyed
    # on `(user, project, skill_key)` for serialization.
    project_owner = await db.execute(
        select(Project.id).where(
            Project.user_id == auth.user_id,
            Project.id == project_id,
        )
    )
    if project_owner.scalar_one_or_none() is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "project not found",
        )

    if auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None:
        bound_env_id = auth.api_key.environment_id
        bound_project_result = await db.execute(
            select(AgentEnvironment.default_project_id).where(
                AgentEnvironment.id == bound_env_id,
                AgentEnvironment.user_id == auth.user_id,
            )
        )
        bound_project = bound_project_result.scalar_one_or_none()
        if bound_project != project_id:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "api key not bound to this project",
            )

    return project_id


async def resolve_for_parent(
    db: AsyncSession,
    auth: AuthContext,
    parent_project_id: UUID,
) -> set[UUID]:
    """Resolve a caller-selected project read set.

    Composition is enforced at the agent boundary via
    `agent_project_bindings`, not via project-to-project edges.
    For project-filtered reads this helper therefore resolves to an
    exact one-project set when visible.
    """

    visible = set(await project_ids_visible_to(db, auth))
    if parent_project_id not in visible:
        return set()

    return {parent_project_id}


async def validate_project_read_for_caller(
    db: AsyncSession,
    auth: AuthContext,
    project_id: UUID,
) -> UUID:
    """Validate that the caller may READ the given `project_id`.

    Sister of `validate_project_for_caller` (write-side, owner-only).
    This one accepts viewer memberships — a recipient with a
    ProjectMembership row passes here but would be rejected by the
    write validator. Used by read routes that need to serve shared
    content (skill download, etc.) without granting write access.

    Rules:
      * project_id must appear in `project_ids_visible_to(auth)`.
      * Agent API keys still only see their Agent Project
        (enforced inside project_ids_visible_to itself).

    404 if not in the visible set — same "don't leak existence"
    posture as the owner-only validator.
    """
    visible = await project_ids_visible_to(db, auth)
    if project_id not in visible:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "project not found",
        )
    return project_id


async def project_ids_readable_by_user(
    db: AsyncSession,
    user_id: UUID,
) -> list[UUID]:
    """Return owned + shared Project ids for a user.

    This is the account-level read set. `project_ids_visible_to`
    wraps it with auth-token blast-radius constraints for env-bound
    Agent keys.
    """
    from app.models.project_membership import ProjectMembership

    owned_ids = list(
        (await db.execute(select(Project.id).where(Project.user_id == user_id))).scalars().all()
    )
    shared_ids = list(
        (
            await db.execute(
                select(ProjectMembership.project_id).where(
                    ProjectMembership.member_user_id == user_id
                )
            )
        )
        .scalars()
        .all()
    )
    # Owned ordering preserved; shared appended deterministically.
    # Membership rows could in theory dupe an owned project (e.g. if
    # a stale row survived an ownership transfer); de-dup defensively.
    seen = set(owned_ids)
    result_ids = list(owned_ids)
    for sid in shared_ids:
        if sid not in seen:
            result_ids.append(sid)
            seen.add(sid)
    return result_ids


async def project_ids_visible_to(
    db: AsyncSession,
    auth: AuthContext,
) -> list[UUID]:
    """Return every project_id the caller may read.

    Phase-1 policy:
      * Clerk JWT → ALL projects the user owns (dashboard sees their
        whole inventory). Critical: without this the dashboard
        would query Personal but most data lives in env-local
        projects after backfill, producing a day-1 empty-list
        regression.
      * api_key bound to an Agent environment → only that Agent Project
        (daemons get their own Project's data,
        nothing else). This is the deploy-key blast radius
        boundary — a leaked key from env A must not gain
        visibility into env B's data ever.
      * api_key WITHOUT env binding (the device-flow CLI key from
        `clawdi auth login`) → ALL the user's projects, same as
        Clerk JWT. The user authenticated as themselves; multi-
        agent setups need `clawdi serve --agent <other>` and
        `clawdi push --all` to operate on any of the user's envs,
        not just whichever was touched last. An earlier "single
        most-recently-active project" policy broke `serve --agent`
        when its project wasn't the default, since the daemon's
        explicit `?project_id=...` listing intersected to empty.
    """
    # Bound api_keys are ALWAYS restricted to their bound project.
    #
    # Agent API keys ALSO never see shared Projects via membership:
    # the Agent boundary is the blast-radius boundary (PR #77). A leaked
    # hosted-pod key must not gain visibility into projects the user
    # later joined as a recipient.
    if auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None:
        env_project = await resolve_default_write_project(db, auth)
        return [env_project]

    # Clerk JWT and unbound CLI key: owned projects UNION projects the
    # user joined as a member.
    return await project_ids_readable_by_user(db, auth.user_id)
