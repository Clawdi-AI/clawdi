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
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_project_binding import AgentProjectBinding
from app.models.hosted_runtime import HostedRuntimeState
from app.models.project import PROJECT_KIND_WORKSPACE, Project
from app.models.session import AgentEnvironment
from app.models.skill import SKILL_AUTHORITY_CLOUD, Skill
from app.schemas.runtime import PersistedHostedRuntimeSkills
from app.services.sync_events import queue_runtime_manifest_changed

# OpenClaw's native `skills install --as` contract accepts this slug shape.
# Keeping Project-delivered keys inside the strictest native runtime contract
# prevents a desired manifest from succeeding but failing during installation.
RUNTIME_PROJECT_SKILL_KEY_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")


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

    state = await db.get(HostedRuntimeState, agent_id)
    if state is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "project_skills_require_managed_agent",
                "message": (
                    "This Agent cannot install Project Skills automatically. "
                    "Choose a managed Agent or remove the Project Skills before linking."
                ),
            },
        )

    workspace_conflicts = skill_keys & _runtime_state_skill_keys(state)
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


async def assert_project_skill_write_compatible(
    db: AsyncSession,
    *,
    project_id: UUID,
    skill_key: str,
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
    return agent_ids


async def assert_agent_workspace_skill_write_compatible(
    db: AsyncSession,
    *,
    agent_id: UUID,
    skill_keys: set[str],
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
    conflicts = sorted(skill_keys & set(rows.scalars()))
    if not conflicts:
        return
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
            .join(
                HostedRuntimeState,
                HostedRuntimeState.environment_id == AgentEnvironment.id,
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
