"""Agent Skill intent references and observed inventory; source Projects own bytes."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import JsonValue, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_user_auth_unbound
from app.core.database import get_session
from app.models.hosted_runtime import HostedRuntimeState
from app.models.project import Project
from app.models.runtime_observation import (
    RUNTIME_OBSERVATION_HEAD_ACTIVE,
    V2RuntimeObservationHead,
    V2RuntimeObservationInbox,
)
from app.models.session import AgentEnvironment
from app.models.skill import SKILL_AUTHORITY_CLOUD, AgentSkillReference, Skill
from app.routes.skills import build_skill_detail
from app.schemas.runtime import (
    PersistedHostedRuntimeSkills,
    PersistedHostedRuntimeSourcedSkillEntry,
)
from app.schemas.runtime_observation import HostedRuntimeObservedSkillsV1
from app.schemas.skill import (
    AgentSkillDesiredListResponse,
    AgentSkillDesiredResponse,
    AgentSkillReferenceResponse,
    AgentSkillRemovalFailure,
    SkillDetailResponse,
)
from app.services.agent_bindings import assert_project_visible_to_user, get_owned_agent_or_404
from app.services.audit import record_control_plane_audit
from app.services.project_runtime_skills import (
    agent_project_skill_sources,
    assert_agent_accepts_project_skills,
    assert_agent_project_skill_total,
    lock_project_binding_change,
    project_skill_context_binding,
    project_skill_runtime_identity,
)
from app.services.runtime_source_revision import persisted_runtime_source_revision
from app.services.sync_events import queue_runtime_manifest_changed

router = APIRouter(prefix="/agents/{agent_id}", tags=["agent-skills"])


def skill_source_identity(*parts: str) -> str:
    return hashlib.sha256("\0".join(parts).encode()).hexdigest()


async def _hosted_state(db: AsyncSession, agent_id: UUID) -> HostedRuntimeState:
    state = await db.get(HostedRuntimeState, agent_id)
    if state is None or set(state.runtimes) not in ({"hermes"}, {"openclaw"}):
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "hosted_skill_runtime_required"})
    return state


async def _observed_skills(
    db: AsyncSession,
    state: HostedRuntimeState,
) -> tuple[HostedRuntimeObservedSkillsV1 | None, datetime | None]:
    observed_at = datetime.now(UTC)
    revision = persisted_runtime_source_revision(state)
    if revision is None:
        return None, None
    rows = (
        await db.execute(
            select(V2RuntimeObservationInbox.diagnostics, V2RuntimeObservationHead.captured_at)
            .join(
                V2RuntimeObservationHead,
                V2RuntimeObservationHead.latest_inbox_id == V2RuntimeObservationInbox.id,
            )
            .where(
                V2RuntimeObservationHead.environment_id == state.environment_id,
                V2RuntimeObservationHead.deployment_id == state.deployment_id,
                V2RuntimeObservationHead.generation == (state.apply_generation or state.generation),
                V2RuntimeObservationHead.state == RUNTIME_OBSERVATION_HEAD_ACTIVE,
                V2RuntimeObservationHead.freshness_deadline > observed_at,
                V2RuntimeObservationHead.captured_at <= observed_at,
            )
            .order_by(V2RuntimeObservationHead.latest_stream_position.desc())
            .limit(2)
        )
    ).all()
    if len(rows) != 1:
        return None, None
    diagnostics: JsonValue = rows[0][0]
    captured_at: datetime | None = rows[0][1]
    if not isinstance(diagnostics, dict):
        return None, None
    applied = diagnostics.get("applied")
    if not isinstance(applied, dict) or (
        applied.get("instanceId") != state.instance_id
        or applied.get("sourceRevision") != revision
        or applied.get("generation") != (state.apply_generation or state.generation)
    ):
        return None, None
    try:
        observed = HostedRuntimeObservedSkillsV1.model_validate(diagnostics.get("skills"))
    except ValidationError:
        return None, None
    if any(
        item.source_revision != revision or item.generation != applied["generation"]
        for item in observed.entries
    ):
        return None, None
    return observed, captured_at


@router.get("/skills", response_model=AgentSkillDesiredListResponse)
async def list_agent_skills(
    agent_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> AgentSkillDesiredListResponse:
    await get_owned_agent_or_404(db, user_id=auth.user_id, agent_id=agent_id)
    state = await _hosted_state(db, agent_id)
    observed, captured_at = await _observed_skills(db, state)
    runtime = next(iter(state.runtimes))
    observations = (
        {item.skill_key: item for item in observed.entries if item.runtime == runtime}
        if observed
        else {}
    )
    skills: list[AgentSkillDesiredResponse] = []

    def append(item: AgentSkillDesiredResponse, changed_at: datetime) -> None:
        observation = observations.get(item.skill_key)
        if observation is not None and (
            observation.source_identity == item.source_identity
            and observation.desired_state == "present"
            and captured_at is not None
            and captured_at >= changed_at
        ):
            if observation.status == "installed":
                item.convergence = "installed"
            elif observation.status == "failed":
                item.convergence = "failed"
            item.observation_error_code = observation.error_code
            item.observed_at = captured_at
        skills.append(item)

    if state.skills is not None:
        try:
            workspace = PersistedHostedRuntimeSkills.model_validate(state.skills)
        except ValidationError:
            raise HTTPException(
                status.HTTP_409_CONFLICT, {"code": "agent_workspace_skills_unavailable"}
            ) from None
        for key, entry in workspace.entries.items():
            if not entry.enabled:
                continue
            if isinstance(entry, PersistedHostedRuntimeSourcedSkillEntry):
                source = entry.source
                identity = skill_source_identity(
                    "github", key, source.url, source.path, source.commit
                )
                kind = "github"
            else:
                identity = skill_source_identity("bundled", key, str(entry.version))
                kind = "bundled"
            append(
                AgentSkillDesiredResponse(
                    skill_key=key,
                    name=key,
                    source=kind,
                    authority="hosted",
                    read_only=kind == "bundled",
                    source_identity=identity,
                ),
                state.updated_at,
            )
    rows = await db.execute(
        agent_project_skill_sources()
        .add_columns(
            project_skill_context_binding().label("linked"),
            AgentSkillReference.updated_at.label("reference_updated_at"),
        )
        .outerjoin(
            AgentSkillReference,
            (AgentSkillReference.agent_id == AgentEnvironment.id)
            & (AgentSkillReference.skill_id == Skill.id),
        )
        .where(AgentEnvironment.id == agent_id)
    )
    for _, skill, linked, reference_updated_at in rows:
        key = project_skill_runtime_identity(skill.skill_key, skill.name).local_skill_key
        append(
            AgentSkillDesiredResponse(
                skill_key=key,
                name=skill.name,
                description=skill.description,
                source="project" if linked else "library",
                authority="cloud",
                read_only=linked,
                skill_id=skill.id,
                project_id=skill.project_id,
                content_hash=skill.content_hash,
                source_skill_key=skill.skill_key,
                source_identity=skill_source_identity(
                    "project", key, str(skill.project_id), skill.content_hash
                ),
            ),
            max(skill.updated_at, reference_updated_at or skill.updated_at),
        )
    desired_keys = {item.skill_key for item in skills}
    removal_failures = [
        AgentSkillRemovalFailure(skill_key=key, observation_error_code="reconcile_failed")
        for key, item in sorted(observations.items())
        if item.desired_state == "absent" and item.status == "failed" and key not in desired_keys
    ]
    return AgentSkillDesiredListResponse(
        agent_id=agent_id,
        skills=sorted(skills, key=lambda item: item.skill_key),
        removal_failures=removal_failures,
    )


async def _source_skill(db: AsyncSession, auth: AuthContext, skill_id: UUID) -> Skill:
    skill = await db.scalar(
        select(Skill).where(
            Skill.id == skill_id, Skill.is_active, Skill.authority == SKILL_AUTHORITY_CLOUD
        )
    )
    if skill is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill not found")
    await assert_project_visible_to_user(db, user_id=auth.user_id, project_id=skill.project_id)
    return skill


@router.put(
    "/skill-references/{skill_id}",
    response_model=AgentSkillReferenceResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def put_agent_skill_reference(
    agent_id: UUID,
    skill_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> AgentSkillReferenceResponse:
    await get_owned_agent_or_404(db, user_id=auth.user_id, agent_id=agent_id)
    skill = await _source_skill(db, auth, skill_id)
    await lock_project_binding_change(db, project_id=skill.project_id, agent_id=agent_id)
    await get_owned_agent_or_404(db, user_id=auth.user_id, agent_id=agent_id)
    await _hosted_state(db, agent_id)
    # Agent Project archive/cleanup already locks the source Project row. Recheck
    # access after that lock so an archive cannot race a new reference into existence.
    await db.execute(select(Project.id).where(Project.id == skill.project_id).with_for_update())
    await db.refresh(skill)
    skill = await _source_skill(db, auth, skill_id)
    sources = [
        source
        for _, source in await db.execute(
            agent_project_skill_sources().where(AgentEnvironment.id == agent_id)
        )
    ]
    identities = [
        project_skill_runtime_identity(source.skill_key, source.name)
        for source in sources
        if source.project_id == skill.project_id and source.id != skill.id
    ]
    identities.append(project_skill_runtime_identity(skill.skill_key, skill.name))
    if identities[-1].local_skill_key == "clawdi":
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "runtime_manifest_managed_skill"})
    await assert_agent_accepts_project_skills(
        db, agent_id=agent_id, project_id=skill.project_id, skill_identities=identities
    )
    assert_agent_project_skill_total(
        len(sources) + (0 if any(source.id == skill.id for source in sources) else 1)
    )
    linked = await db.scalar(
        select(project_skill_context_binding())
        .select_from(AgentEnvironment)
        .join(Project, Project.id == skill.project_id)
        .where(AgentEnvironment.id == agent_id)
    )
    if linked:
        return AgentSkillReferenceResponse(
            agent_id=agent_id, skill_id=skill_id, desired_state="present"
        )
    reference = await db.get(AgentSkillReference, (agent_id, skill_id))
    if reference is None:
        db.add(AgentSkillReference(agent_id=agent_id, skill_id=skill_id))
    else:
        # An explicit retry fences previously captured failures without changing content ownership.
        reference.updated_at = datetime.now(UTC)
    await queue_runtime_manifest_changed(db, auth.user_id, agent_id)
    record_control_plane_audit(
        db,
        actor_type="user",
        actor_user_id=auth.user_id,
        target_user_id=auth.user_id,
        source="agent_skills.api",
        action="agent_skill.desired_present",
        resource_type="skill",
        resource_id=str(skill_id),
        environment_id=agent_id,
    )
    await db.commit()
    return AgentSkillReferenceResponse(
        agent_id=agent_id, skill_id=skill_id, desired_state="present"
    )


@router.delete(
    "/skill-references/{skill_id}",
    response_model=AgentSkillReferenceResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def delete_agent_skill_reference(
    agent_id: UUID,
    skill_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> AgentSkillReferenceResponse:
    await get_owned_agent_or_404(db, user_id=auth.user_id, agent_id=agent_id)
    skill = await db.get(Skill, skill_id)
    if skill is not None:
        await lock_project_binding_change(db, project_id=skill.project_id, agent_id=agent_id)
    reference = await db.get(AgentSkillReference, (agent_id, skill_id))
    if reference is not None:
        await db.delete(reference)
        await queue_runtime_manifest_changed(db, auth.user_id, agent_id)
    record_control_plane_audit(
        db,
        actor_type="user",
        actor_user_id=auth.user_id,
        target_user_id=auth.user_id,
        source="agent_skills.api",
        action="agent_skill.desired_absent",
        resource_type="skill",
        resource_id=str(skill_id),
        environment_id=agent_id,
    )
    await db.commit()
    return AgentSkillReferenceResponse(agent_id=agent_id, skill_id=skill_id, desired_state="absent")


@router.get("/skill-references/{skill_id}", response_model=SkillDetailResponse)
async def get_agent_skill_reference(
    agent_id: UUID,
    skill_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> SkillDetailResponse:
    await get_owned_agent_or_404(db, user_id=auth.user_id, agent_id=agent_id)
    if await db.get(AgentSkillReference, (agent_id, skill_id)) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill reference not found")
    skill = await _source_skill(db, auth, skill_id)
    return await build_skill_detail(skill, db)
