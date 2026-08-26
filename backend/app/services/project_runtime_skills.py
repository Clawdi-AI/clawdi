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
from dataclasses import dataclass
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_project_binding import AgentProjectBinding
from app.models.hosted_runtime import HostedRuntimeState
from app.models.project import PROJECT_KIND_WORKSPACE, Project
from app.models.project_membership import ProjectMembership
from app.models.session import AgentEnvironment
from app.models.skill import SKILL_AUTHORITY_AGENT_SYNC, SKILL_AUTHORITY_CLOUD, Skill
from app.schemas.runtime import PersistedHostedRuntimeSkills
from app.services.sync_events import queue_runtime_manifests_changed

# OpenClaw's native `skills install --as` contract accepts this slug shape.
# Source keys may be namespaced. The SKILL.md name is the local install identity
# and must fit the strictest native runtime contract.
RUNTIME_PROJECT_SKILL_LOCAL_KEY_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
MAX_AGENT_PROJECT_SKILLS = 1000


@dataclass(frozen=True)
class ProjectSkillRuntimeIdentity:
    source_skill_key: str
    local_skill_key: str


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


def assert_project_skill_runtime_identity(identity: ProjectSkillRuntimeIdentity) -> None:
    if RUNTIME_PROJECT_SKILL_LOCAL_KEY_PATTERN.fullmatch(identity.local_skill_key) is not None:
        return
    raise HTTPException(
        status.HTTP_409_CONFLICT,
        detail={
            "code": "project_skill_name_incompatible",
            "message": (
                f'Skill "{identity.source_skill_key}" cannot be linked to an Agent. '
                "Update its SKILL.md name to use lowercase letters, numbers, or inner "
                "hyphens (up to 64 characters)."
            ),
            "skill_key": identity.source_skill_key,
        },
    )


def project_skill_runtime_identity(
    source_skill_key: str,
    declared_name: str,
) -> ProjectSkillRuntimeIdentity:
    """Resolve the runtime identity while preserving legacy flat-key Skills."""
    local_skill_key = declared_name
    if (
        RUNTIME_PROJECT_SKILL_LOCAL_KEY_PATTERN.fullmatch(local_skill_key) is None
        and RUNTIME_PROJECT_SKILL_LOCAL_KEY_PATTERN.fullmatch(source_skill_key) is not None
    ):
        local_skill_key = source_skill_key
    return ProjectSkillRuntimeIdentity(
        source_skill_key=source_skill_key,
        local_skill_key=local_skill_key,
    )


async def _project_skill_identities(
    db: AsyncSession,
    project_id: UUID,
) -> tuple[ProjectSkillRuntimeIdentity, ...]:
    rows = await db.execute(
        select(Skill.skill_key, Skill.name).where(
            Skill.project_id == project_id,
            Skill.authority == SKILL_AUTHORITY_CLOUD,
            Skill.is_active,
        )
    )
    return tuple(project_skill_runtime_identity(skill_key, name) for skill_key, name in rows)


async def _other_project_local_skill_keys(
    db: AsyncSession,
    *,
    agent_id: UUID,
    project_id: UUID,
) -> set[str]:
    rows = await db.execute(
        select(Skill.skill_key, Skill.name)
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
    return {
        project_skill_runtime_identity(skill_key, name).local_skill_key for skill_key, name in rows
    }


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
    skill_identities: Iterable[ProjectSkillRuntimeIdentity],
    allowed_workspace_skill_keys: set[str] | None = None,
) -> None:
    identities = tuple(skill_identities)
    if not identities:
        return
    for identity in sorted(identities, key=lambda value: value.source_skill_key):
        assert_project_skill_runtime_identity(identity)

    local_owners: dict[str, list[str]] = {}
    for identity in identities:
        local_owners.setdefault(identity.local_skill_key, []).append(identity.source_skill_key)
    duplicate_local_keys = {
        local_skill_key
        for local_skill_key, source_skill_keys in local_owners.items()
        if len(source_skill_keys) > 1
    }

    row = (
        await db.execute(
            select(AgentEnvironment, HostedRuntimeState)
            .outerjoin(
                HostedRuntimeState,
                HostedRuntimeState.environment_id == AgentEnvironment.id,
            )
            .where(
                AgentEnvironment.id == agent_id,
                AgentEnvironment.archived_at.is_(None),
            )
        )
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent not found")
    agent, state = row

    workspace_skill_keys = (
        _runtime_state_skill_keys(state)
        if state is not None
        else await _connected_workspace_skill_keys(db, agent=agent)
    )
    local_skill_keys = set(local_owners)
    workspace_conflicts = local_skill_keys & (
        workspace_skill_keys - (allowed_workspace_skill_keys or set())
    )
    project_conflicts = local_skill_keys & await _other_project_local_skill_keys(
        db,
        agent_id=agent_id,
        project_id=project_id,
    )
    conflicts = sorted(duplicate_local_keys | workspace_conflicts | project_conflicts)
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
        skill_identities=await _project_skill_identities(db, project_id),
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
    local_skill_key: str | None = None,
    enforce_total_limit: bool = True,
    source_agent_id: UUID | None = None,
) -> list[UUID]:
    """Lock the graph and prove a Cloud Skill write has one runtime owner."""
    agent_ids = await lock_project_runtime_graph(db, project_id)
    if local_skill_key is not None:
        proposed_identities = tuple(
            identity
            for identity in await _project_skill_identities(db, project_id)
            if identity.source_skill_key != skill_key
        ) + (project_skill_runtime_identity(skill_key, local_skill_key),)
        for agent_id in agent_ids:
            await _assert_agent_accepts_project_skills(
                db,
                agent_id=agent_id,
                project_id=project_id,
                skill_identities=proposed_identities,
                allowed_workspace_skill_keys=(
                    {local_skill_key} if agent_id == source_agent_id else None
                ),
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
) -> None:
    """Reject local names that collide with linked Project Skills."""
    await lock_agent_runtime_graph(db, agent_id)
    if not skill_keys:
        return
    rows = await db.execute(
        select(Skill.skill_key, Skill.name)
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
    project_local_skill_keys = {
        project_skill_runtime_identity(skill_key, name).local_skill_key for skill_key, name in rows
    }
    conflicts = skill_keys & project_local_skill_keys
    if not conflicts:
        return

    # A linked Project may have been explicitly published from an existing
    # Agent Workspace projection. Keep accepting updates to that established
    # source row so a later explicit refresh can converge the Cloud snapshot;
    # a new local copy still has no ownership evidence and remains rejected.
    existing_source_keys = set(
        (
            await db.execute(
                select(Skill.skill_key)
                .join(
                    AgentEnvironment,
                    AgentEnvironment.default_project_id == Skill.project_id,
                )
                .where(
                    AgentEnvironment.id == agent_id,
                    AgentEnvironment.archived_at.is_(None),
                    Skill.authority_agent_id == agent_id,
                    Skill.authority == SKILL_AUTHORITY_AGENT_SYNC,
                    Skill.is_active,
                )
            )
        ).scalars()
    )
    conflicts = sorted(conflicts - existing_source_keys)
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
    targets = [(user_id, agent_id) for user_id, agent_id in rows]
    await queue_runtime_manifests_changed(db, targets)
    return [agent_id for _user_id, agent_id in targets]


def project_skill_file_signature(
    *,
    signing_key: str,
    agent_id: UUID,
    skill_id: UUID,
    content_hash: str,
) -> str:
    payload = f"project-skill-file:v1:{agent_id}:{skill_id}:{content_hash}".encode()
    return hmac.new(signing_key.encode(), payload, hashlib.sha256).hexdigest()
