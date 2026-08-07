"""Lifecycle cleanup for filesystem-projected Agent Project Skills."""

from __future__ import annotations

import logging
from uuid import UUID

from sqlalchemy import delete, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import PROJECT_KIND_ENVIRONMENT, Project
from app.models.session import AgentEnvironment
from app.models.skill import Skill
from app.services.file_store import get_file_store
from app.services.runtime_manifest_resources import project_skill_advisory_lock_key
from app.services.sync_events import AGENT_SKILL_DELETED_EVENT, bump_skills_revision

log = logging.getLogger(__name__)


class AgentSkillProjectionBoundaryError(RuntimeError):
    """The Agent's Project identity is not strong enough for cleanup."""


async def delete_agent_project_skill_rows(
    db: AsyncSession,
    *,
    agent: AgentEnvironment,
) -> tuple[str, ...]:
    """Delete current Agent Project rows and every exact claim owned by the Agent.

    Historical rows are intentionally backfilled as ``cloud`` because their
    origin cannot be proven. They still belong to the Agent Project resource,
    however, and must not survive deletion as an immutable orphan. The project
    kind, owner, origin, and exclusive default-project binding are all checked
    before any row is removed. Exact ``agent_sync`` claims may also exist in a
    previous Project after reassignment; those are removed observably here
    rather than left to the authority FK cascade.
    """
    locked_agent = (
        await db.execute(
            select(AgentEnvironment)
            .where(
                AgentEnvironment.id == agent.id,
                AgentEnvironment.user_id == agent.user_id,
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if locked_agent is None:
        raise AgentSkillProjectionBoundaryError("Agent identity no longer exists")

    project = (
        await db.execute(
            select(Project).where(Project.id == locked_agent.default_project_id).with_for_update()
        )
    ).scalar_one_or_none()
    if (
        project is None
        or project.user_id != locked_agent.user_id
        or project.kind != PROJECT_KIND_ENVIRONMENT
        or project.origin_environment_id != locked_agent.id
    ):
        raise AgentSkillProjectionBoundaryError("Agent Project ownership could not be proven")

    sibling_count = (
        await db.execute(
            select(func.count())
            .select_from(AgentEnvironment)
            .where(
                AgentEnvironment.default_project_id == project.id,
                AgentEnvironment.id != locked_agent.id,
            )
        )
    ).scalar_one()
    if sibling_count != 0:
        raise AgentSkillProjectionBoundaryError("Agent Project is bound to multiple Agents")

    mutation_keys = (
        await db.execute(
            select(Skill.project_id, Skill.skill_key)
            .where(
                or_(
                    Skill.project_id == project.id,
                    Skill.authority_agent_id == locked_agent.id,
                )
            )
            .distinct()
            .order_by(Skill.project_id, Skill.skill_key)
        )
    ).all()
    for projection_project_id, skill_key in mutation_keys:
        lock_key = project_skill_advisory_lock_key(
            locked_agent.user_id,
            projection_project_id,
            skill_key,
        )
        await db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": lock_key})

    # Re-read only after every per-key mutation lock is held. The Agent row
    # lock prevents a conforming upload/delete from introducing or moving a
    # claim meanwhile. Rows in the current Agent Project include fail-safe
    # legacy Cloud projections; exact claims in an older Project are included
    # so the FK cascade never becomes the normal unobservable cleanup path.
    skills = (
        (
            await db.execute(
                select(Skill)
                .where(
                    or_(
                        Skill.project_id == project.id,
                        Skill.authority_agent_id == locked_agent.id,
                    )
                )
                .order_by(Skill.project_id, Skill.skill_key, Skill.id)
                .with_for_update()
            )
        )
        .scalars()
        .all()
    )
    file_keys = tuple(sorted({skill.file_key for skill in skills if skill.file_key is not None}))
    # The FK cascade is defense-in-depth. Normal deletion advances the
    # collection revision and queues invalidations before the rows disappear,
    # so conditional readers cannot keep a stale 304 representation.
    for skill in skills:
        if not skill.is_active:
            continue
        await bump_skills_revision(
            db,
            locked_agent.user_id,
            skill_key=skill.skill_key,
            project_id=skill.project_id,
            event_type=AGENT_SKILL_DELETED_EVENT,
        )
    await db.execute(
        delete(Skill).where(
            or_(
                Skill.project_id == project.id,
                Skill.authority_agent_id == locked_agent.id,
            )
        )
    )
    return file_keys


async def delete_agent_skill_files_best_effort(
    file_keys: tuple[str, ...],
    *,
    agent_id: UUID,
) -> None:
    """Remove now-unreachable archives after the database commit succeeds."""
    file_store = get_file_store()
    for file_key in file_keys:
        try:
            await file_store.delete(file_key)
        except Exception:
            # DB authority is already gone. Keep deletion observable without
            # making a non-transactional object-store failure resurrect rows.
            log.warning(
                "agent_skill_projection_file_delete_failed agent_id=%s file_key=%s",
                agent_id,
                file_key,
                exc_info=True,
            )
