"""Project Skill delivery across Agent Project bindings.

User Projects own Cloud Skill bytes. A managed Agent consumes those bytes only
through its desired runtime manifest; Agent-sync rows remain observations of an
Agent Workspace and never enter this graph.
"""

from __future__ import annotations

import hashlib
import hmac
import re
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import exists, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.agent_project_binding import AgentProjectBinding
from app.models.api_key import ApiKey
from app.models.hosted_runtime import HostedRuntimeConfigObservation, HostedRuntimeState
from app.models.project import PROJECT_KIND_WORKSPACE, Project
from app.models.project_membership import ProjectMembership
from app.models.session import AgentEnvironment
from app.models.skill import SKILL_AUTHORITY_AGENT_SYNC, SKILL_AUTHORITY_CLOUD, Skill
from app.schemas.runtime import PersistedHostedRuntimeSkills
from app.schemas.runtime_observed import HostedRuntimeObservedV2
from app.services.hosted_v1_ownership import authenticated_hosted_v1_ownership
from app.services.runtime_generation import resolve_runtime_apply_generation
from app.services.sync_events import queue_runtime_manifest_changed

# OpenClaw's native `skills install --as` contract accepts this slug shape.
# Keeping Project-delivered keys inside the strictest native runtime contract
# prevents a desired manifest from succeeding but failing during installation.
RUNTIME_PROJECT_SKILL_KEY_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
PROJECT_SKILL_RECONCILE_VERSION = 1
# The Connected daemon renews every four to six minutes. Ten minutes provides
# normal retry margin while still closing stale or downgraded Agents promptly.
CONNECTED_PROJECT_SKILL_CAPABILITY_TTL = timedelta(minutes=10)
MAX_AGENT_PROJECT_SKILLS = 1000
_CONNECTED_PROJECT_SKILL_AGENT_TYPES = frozenset({"claude_code", "codex", "hermes", "openclaw"})


def _advisory_key(namespace: str, value: UUID) -> int:
    digest = hashlib.sha256(f"{namespace}:{value}".encode()).digest()
    unsigned = int.from_bytes(digest[:8], "big", signed=False)
    return unsigned - (1 << 64) if unsigned >= 1 << 63 else unsigned


async def _lock(db: AsyncSession, namespace: str, values: Iterable[UUID]) -> None:
    for value in sorted(set(values), key=str):
        await db.execute(
            text("SELECT pg_advisory_xact_lock(:key)"),
            {"key": _advisory_key(namespace, value)},
        )


async def lock_project_runtime_graph(db: AsyncSession, project_id: UUID) -> list[UUID]:
    """Freeze one Project's binding set, then its affected Agent graphs."""
    return await lock_project_runtime_graphs(db, [project_id])


async def lock_project_runtime_graphs(
    db: AsyncSession,
    project_ids: Iterable[UUID],
) -> list[UUID]:
    """Freeze several Projects before taking any of their Agent locks."""
    locked_project_ids = sorted(set(project_ids), key=str)
    if not locked_project_ids:
        return []
    await _lock(db, "project-runtime-skills", locked_project_ids)
    agent_ids = list(
        (
            await db.execute(
                select(AgentProjectBinding.agent_id).where(
                    AgentProjectBinding.project_id.in_(locked_project_ids),
                    AgentProjectBinding.binding_type == "context",
                )
            )
        ).scalars()
    )
    await _lock(db, "agent-runtime-skills", agent_ids)
    return sorted(set(agent_ids), key=str)


async def lock_project_change(db: AsyncSession, project_id: UUID) -> None:
    """Serialize Project lifecycle/access changes before taking Agent locks."""
    await _lock(db, "project-runtime-skills", [project_id])


async def lock_project_binding_change(
    db: AsyncSession,
    *,
    project_id: UUID,
    agent_id: UUID,
) -> None:
    """Serialize Link/Unlink with Project Skill writes and sibling links."""
    await _lock(db, "project-runtime-skills", [project_id])
    await _lock(db, "agent-runtime-skills", [agent_id])


async def lock_project_agent_binding_changes(
    db: AsyncSession,
    *,
    project_id: UUID,
    agent_ids: Iterable[UUID],
) -> None:
    """Serialize one Project Link request targeting several Agents."""
    await _lock(db, "project-runtime-skills", [project_id])
    await _lock(db, "agent-runtime-skills", agent_ids)


async def lock_project_binding_set_change(
    db: AsyncSession,
    *,
    project_ids: Iterable[UUID],
    agent_id: UUID,
) -> None:
    """Serialize cleanup of several links without changing lock order."""
    await _lock(db, "project-runtime-skills", project_ids)
    await _lock(db, "agent-runtime-skills", [agent_id])


async def lock_agent_runtime_graph(db: AsyncSession, agent_id: UUID) -> None:
    """Serialize Agent Workspace intent with linked Project graph changes."""
    await _lock(db, "agent-runtime-skills", [agent_id])


def _runtime_state_skill_keys(state: HostedRuntimeState) -> set[str]:
    if state.skills is None:
        return set()
    try:
        desired = PersistedHostedRuntimeSkills.model_validate(state.skills)
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "agent_workspace_skills_unavailable",
                "message": (
                    "This Agent's Workspace Skills could not be checked. "
                    "Retry before changing Project access."
                ),
            },
        ) from exc
    return set(desired.entries)


async def _connected_workspace_skill_keys(
    db: AsyncSession,
    *,
    agent: AgentEnvironment,
) -> set[str]:
    """Read the Agent-owned Cloud projection without claiming filesystem authority."""
    rows = await db.execute(
        select(Skill.skill_key).where(
            Skill.project_id == agent.default_project_id,
            Skill.authority == SKILL_AUTHORITY_AGENT_SYNC,
            Skill.is_active,
        )
    )
    return set(rows.scalars())


def _assert_runtime_skill_key(skill_key: str) -> None:
    if RUNTIME_PROJECT_SKILL_KEY_PATTERN.fullmatch(skill_key) is not None:
        return
    raise HTTPException(
        status.HTTP_409_CONFLICT,
        detail={
            "code": "project_skill_name_incompatible",
            "message": (
                f'Skill "{skill_key}" cannot be linked to an Agent. Rename it using '
                "lowercase letters, numbers, or inner hyphens (up to 64 characters)."
            ),
            "skill_key": skill_key,
        },
    )


async def _project_skill_keys(db: AsyncSession, project_id: UUID) -> set[str]:
    rows = await db.execute(
        select(Skill.skill_key).where(
            Skill.project_id == project_id,
            Skill.authority == SKILL_AUTHORITY_CLOUD,
            Skill.is_active,
        )
    )
    return set(rows.scalars())


async def _other_project_skill_keys(
    db: AsyncSession,
    *,
    agent_id: UUID,
    project_id: UUID,
) -> set[str]:
    rows = await db.execute(
        select(Skill.skill_key)
        .join(
            AgentProjectBinding,
            AgentProjectBinding.project_id == Skill.project_id,
        )
        .join(Project, Project.id == Skill.project_id)
        .where(
            AgentProjectBinding.agent_id == agent_id,
            AgentProjectBinding.binding_type == "context",
            AgentProjectBinding.project_id != project_id,
            Project.kind == PROJECT_KIND_WORKSPACE,
            Project.archived_at.is_(None),
            Skill.authority == SKILL_AUTHORITY_CLOUD,
            Skill.is_active,
        )
    )
    return set(rows.scalars())


async def _linked_project_skill_count(db: AsyncSession, *, agent_id: UUID) -> int:
    """Count active Cloud Skills this Agent can actually receive."""
    membership = ProjectMembership.__table__.alias("project_skill_capacity_membership")
    count = await db.scalar(
        select(func.count(Skill.id))
        .select_from(Skill)
        .join(Project, Project.id == Skill.project_id)
        .join(
            AgentProjectBinding,
            (AgentProjectBinding.project_id == Project.id)
            & (AgentProjectBinding.agent_id == agent_id),
        )
        .join(AgentEnvironment, AgentEnvironment.id == AgentProjectBinding.agent_id)
        .outerjoin(
            membership,
            (membership.c.project_id == Project.id)
            & (membership.c.member_user_id == AgentEnvironment.user_id),
        )
        .where(
            AgentEnvironment.id == agent_id,
            AgentEnvironment.archived_at.is_(None),
            AgentProjectBinding.binding_type == "context",
            Project.kind == PROJECT_KIND_WORKSPACE,
            Project.archived_at.is_(None),
            (Project.user_id == AgentEnvironment.user_id) | membership.c.id.is_not(None),
            Skill.authority == SKILL_AUTHORITY_CLOUD,
            Skill.is_active,
        )
    )
    return int(count or 0)


def assert_agent_project_skill_total(total: int) -> None:
    if total <= MAX_AGENT_PROJECT_SKILLS:
        return
    raise HTTPException(
        status.HTTP_409_CONFLICT,
        detail={
            "code": "agent_project_skill_limit_exceeded",
            "message": (
                "This Agent has too many Project Skills. Remove a Skill or unlink a Project, "
                "then try again."
            ),
        },
    )


async def _assert_project_link_skill_capacity(
    db: AsyncSession,
    *,
    agent_id: UUID,
    project_id: UUID,
) -> None:
    current_count = await _linked_project_skill_count(db, agent_id=agent_id)
    already_linked = await db.scalar(
        select(func.count(AgentProjectBinding.id)).where(
            AgentProjectBinding.agent_id == agent_id,
            AgentProjectBinding.project_id == project_id,
            AgentProjectBinding.binding_type == "context",
        )
    )
    if already_linked:
        assert_agent_project_skill_total(current_count)
        return
    added_count = await db.scalar(
        select(func.count(Skill.id)).where(
            Skill.project_id == project_id,
            Skill.authority == SKILL_AUTHORITY_CLOUD,
            Skill.is_active,
        )
    )
    assert_agent_project_skill_total(current_count + int(added_count or 0))


async def _assert_project_skill_write_capacity(
    db: AsyncSession,
    *,
    agent_ids: Iterable[UUID],
    project_id: UUID,
    skill_key: str,
) -> None:
    already_exists = bool(
        await db.scalar(
            select(func.count(Skill.id)).where(
                Skill.project_id == project_id,
                Skill.skill_key == skill_key,
                Skill.authority == SKILL_AUTHORITY_CLOUD,
                Skill.is_active,
            )
        )
    )
    increment = 0 if already_exists else 1
    for agent_id in agent_ids:
        current_count = await _linked_project_skill_count(db, agent_id=agent_id)
        assert_agent_project_skill_total(current_count + increment)


async def _assert_agent_accepts_project_skills(
    db: AsyncSession,
    *,
    agent_id: UUID,
    project_id: UUID,
    skill_keys: set[str],
) -> None:
    if not skill_keys:
        return
    for skill_key in sorted(skill_keys):
        _assert_runtime_skill_key(skill_key)

    agent, state, observation, has_environment_bound_key = await _agent_runtime_delivery_evidence(
        db, agent_id=agent_id
    )
    _assert_agent_supports_project_skills(
        agent,
        state,
        observation,
        has_environment_bound_key=has_environment_bound_key,
    )

    workspace_skill_keys = (
        _runtime_state_skill_keys(state)
        if state is not None
        else await _connected_workspace_skill_keys(db, agent=agent)
    )
    workspace_conflicts = skill_keys & workspace_skill_keys
    project_conflicts = skill_keys & await _other_project_skill_keys(
        db,
        agent_id=agent_id,
        project_id=project_id,
    )
    conflicts = sorted(workspace_conflicts | project_conflicts)
    if not conflicts:
        return
    skill_key = conflicts[0]
    raise HTTPException(
        status.HTTP_409_CONFLICT,
        detail={
            "code": "project_skill_name_conflict",
            "message": (
                f'Skill "{skill_key}" already exists in this Agent\'s Workspace or another '
                "linked Project. Remove or rename one copy, then try again."
            ),
            "skill_key": skill_key,
        },
    )


async def _agent_runtime_delivery_evidence(
    db: AsyncSession,
    *,
    agent_id: UUID,
) -> tuple[
    AgentEnvironment,
    HostedRuntimeState | None,
    HostedRuntimeConfigObservation | None,
    bool,
]:
    has_environment_bound_key = exists().where(
        ApiKey.environment_id == AgentEnvironment.id,
    )
    row = (
        await db.execute(
            select(
                AgentEnvironment,
                HostedRuntimeState,
                HostedRuntimeConfigObservation,
                has_environment_bound_key,
            )
            .outerjoin(
                HostedRuntimeState,
                HostedRuntimeState.environment_id == AgentEnvironment.id,
            )
            .outerjoin(
                HostedRuntimeConfigObservation,
                HostedRuntimeConfigObservation.environment_id == AgentEnvironment.id,
            )
            .where(
                AgentEnvironment.id == agent_id,
                AgentEnvironment.archived_at.is_(None),
            )
        )
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent not found")
    return row[0], row[1], row[2], row[3]


def _assert_agent_supports_project_skills(
    agent: AgentEnvironment,
    state: HostedRuntimeState | None,
    observation: HostedRuntimeConfigObservation | None,
    *,
    has_environment_bound_key: bool,
) -> None:
    if not agent_supports_project_skills(
        agent,
        state,
        observation,
        has_environment_bound_key=has_environment_bound_key,
    ):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "project_skill_delivery_update_required",
                "message": "Update this Agent, then try again.",
            },
        )


def agent_supports_project_skills(
    agent: AgentEnvironment,
    state: HostedRuntimeState | None,
    observation: HostedRuntimeConfigObservation | None,
    *,
    has_environment_bound_key: bool,
) -> bool:
    """Require evidence from exactly one authoritative Agent runtime shape."""
    if state is not None:
        if state.cli_package_spec not in settings.project_skill_hosted_cli_package_specs:
            return False
        if observation is None or observation.observed_at is None:
            return False
        now = datetime.now(UTC)
        observed_at = observation.observed_at
        if observed_at.tzinfo is None:
            observed_at = observed_at.replace(tzinfo=UTC)
        if now - observed_at > timedelta(seconds=settings.runtime_observation_freshness_seconds):
            return False
        if agent.last_sync_at is None or agent.last_sync_error:
            return False
        last_sync_at = agent.last_sync_at
        if last_sync_at.tzinfo is None:
            last_sync_at = last_sync_at.replace(tzinfo=UTC)
        if now - last_sync_at > timedelta(seconds=settings.runtime_observation_freshness_seconds):
            return False
        try:
            diagnostics = HostedRuntimeObservedV2.model_validate(observation.diagnostics)
        except ValueError:
            return False
        expected_version = state.cli_package_spec.removeprefix("clawdi@")
        expected_generation = resolve_runtime_apply_generation(
            generation=state.generation,
            apply_generation=state.apply_generation,
        )
        return bool(
            diagnostics.status == "ok"
            and diagnostics.converge_error is None
            and diagnostics.active_cli_version == expected_version
            and diagnostics.applied is not None
            and diagnostics.applied.instance_id == state.instance_id
            and diagnostics.applied.generation == expected_generation
            and observation.observed_config_generation == expected_generation
            and observation.observed_manifest_etag == diagnostics.applied.etag
            and observation.observed_source_revision == diagnostics.applied.source_revision
        )

    # Explicit hosted identities without Hosted V2 state are Legacy V1
    # deployments (or incomplete provisioning), never Connected fallbacks.
    if agent.registration_key is None:
        return False

    # registration_key is necessary but not sufficient: historical Admin
    # registration without an explicit id created the same key for Legacy V1
    # Hosted deployments. Only a fresh current self-managed registration writes
    # this positive Connected origin marker; ambiguous historical rows remain
    # NULL and fail closed even if old environment-bound keys are later removed.
    if agent.connected_agent_registered_at is None:
        return False

    # A persisted environment-bound workload key is independent positive
    # evidence against the Connected path. Its absence is never used as proof.
    if has_environment_bound_key:
        return False

    observed_at = agent.project_skill_reconcile_observed_at
    if observed_at is None:
        return False
    if observed_at.tzinfo is None:
        observed_at = observed_at.replace(tzinfo=UTC)
    age = datetime.now(UTC) - observed_at
    return (
        agent.agent_type in _CONNECTED_PROJECT_SKILL_AGENT_TYPES
        and agent.project_skill_reconcile_version == PROJECT_SKILL_RECONCILE_VERSION
        and timedelta(0) <= age <= CONNECTED_PROJECT_SKILL_CAPABILITY_TTL
    )


async def assert_project_link_compatible(
    db: AsyncSession,
    *,
    agent_id: UUID,
    project_id: UUID,
) -> None:
    """Fail before Link Project would create an ambiguous Skill graph."""
    await _assert_agent_accepts_project_skills(
        db,
        agent_id=agent_id,
        project_id=project_id,
        skill_keys=await _project_skill_keys(db, project_id),
    )
    await _assert_project_link_skill_capacity(
        db,
        agent_id=agent_id,
        project_id=project_id,
    )


async def assert_project_skill_write_compatible(
    db: AsyncSession,
    *,
    project_id: UUID,
    skill_key: str,
    enforce_total_limit: bool = True,
) -> list[UUID]:
    """Lock the graph and prove a Cloud Skill write has one runtime owner."""
    agent_ids = await lock_project_runtime_graph(db, project_id)
    for agent_id in agent_ids:
        await _assert_agent_accepts_project_skills(
            db,
            agent_id=agent_id,
            project_id=project_id,
            skill_keys={skill_key},
        )
    if enforce_total_limit:
        await _assert_project_skill_write_capacity(
            db,
            agent_ids=agent_ids,
            project_id=project_id,
            skill_key=skill_key,
        )
    return agent_ids


async def assert_agent_workspace_skill_write_compatible(
    db: AsyncSession,
    *,
    agent_id: UUID,
    skill_keys: set[str],
    hosted_v1_api_key_id: UUID | None = None,
) -> None:
    """Fail before Agent Workspace intent would duplicate a linked Project Skill."""
    await lock_agent_runtime_graph(db, agent_id)
    if not skill_keys:
        return
    rows = await db.execute(
        select(Skill.skill_key)
        .join(
            AgentProjectBinding,
            AgentProjectBinding.project_id == Skill.project_id,
        )
        .join(Project, Project.id == Skill.project_id)
        .where(
            AgentProjectBinding.agent_id == agent_id,
            AgentProjectBinding.binding_type == "context",
            Project.kind == PROJECT_KIND_WORKSPACE,
            Project.archived_at.is_(None),
            Skill.authority == SKILL_AUTHORITY_CLOUD,
            Skill.is_active,
        )
    )
    project_skill_keys = set(rows.scalars())
    conflicts = sorted(skill_keys & project_skill_keys)
    if conflicts:
        skill_key = conflicts[0]
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "agent_workspace_project_skill_name_conflict",
                "message": (
                    f'Skill "{skill_key}" already comes from a linked Project. '
                    "Remove or rename one copy, then try again."
                ),
                "skill_key": skill_key,
            },
        )
    if project_skill_keys:
        if hosted_v1_api_key_id is not None and await authenticated_hosted_v1_ownership(
            db,
            agent_id=agent_id,
            api_key_id=hosted_v1_api_key_id,
        ):
            return
        (
            agent,
            state,
            observation,
            has_environment_bound_key,
        ) = await _agent_runtime_delivery_evidence(
            db,
            agent_id=agent_id,
        )
        _assert_agent_supports_project_skills(
            agent,
            state,
            observation,
            has_environment_bound_key=has_environment_bound_key,
        )


async def queue_project_runtime_manifest_changed(
    db: AsyncSession,
    *,
    project_id: UUID,
) -> list[UUID]:
    rows = (
        await db.execute(
            select(AgentEnvironment.user_id, AgentProjectBinding.agent_id)
            .join(
                AgentProjectBinding,
                AgentProjectBinding.agent_id == AgentEnvironment.id,
            )
            .where(
                AgentProjectBinding.project_id == project_id,
                AgentProjectBinding.binding_type == "context",
                AgentEnvironment.archived_at.is_(None),
            )
        )
    ).all()
    affected: list[UUID] = []
    for user_id, agent_id in rows:
        queue_runtime_manifest_changed(db, user_id, agent_id)
        affected.append(agent_id)
    return affected


def project_skill_file_signature(
    *,
    signing_key: str,
    agent_id: UUID,
    skill_id: UUID,
    content_hash: str,
) -> str:
    payload = f"project-skill-file:v1:{agent_id}:{skill_id}:{content_hash}".encode()
    return hmac.new(signing_key.encode(), payload, hashlib.sha256).hexdigest()
