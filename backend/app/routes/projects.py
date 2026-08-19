"""Project metadata routes.

List the caller's projects and resolve the default write project.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth, require_user_auth_unbound
from app.core.database import get_session
from app.core.project import project_ids_visible_to, resolve_default_write_project
from app.models.agent_project_binding import AgentProjectBinding
from app.models.project import PROJECT_KIND_WORKSPACE, Project
from app.models.project_membership import ProjectMembership
from app.models.session import AgentEnvironment
from app.models.skill import Skill
from app.models.user import User
from app.models.vault import VaultProjectAttachment
from app.services.agent_bindings import (
    attach_project_to_owned_agents,
    update_project_owned_agent_links,
)
from app.services.agent_lifecycle import active_project_filter
from app.services.project_runtime_skills import (
    lock_project_change,
    lock_project_runtime_graph,
    queue_project_runtime_manifest_changed,
)
from app.services.sharing import safe_owner_display, safe_owner_handle

router = APIRouter(prefix="/projects", tags=["projects"])


class ProjectResponse(BaseModel):
    id: str
    name: str
    slug: str
    kind: str
    description: str | None
    origin_environment_id: str | None
    archived_at: datetime | None
    created_at: datetime
    # Derived per-caller: True if the caller owns this project, False
    # if it's visible via a ProjectMembership (shared with them). Lets
    # the dashboard render "My projects" vs "Shared with me" sections
    # and the CLI render a shared_with_me column.
    is_owner: bool = True
    owner_display: str | None = None
    owner_handle: str | None = None
    skill_count: int = 0
    vault_count: int = 0
    agent_count: int = 0
    member_count: int = 0


class DefaultProjectResponse(BaseModel):
    project_id: str


SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,79}$")


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    slug: str | None = Field(default=None, min_length=1, max_length=80, pattern=SLUG_RE.pattern)
    description: str | None = Field(default=None, max_length=2000)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value:
            raise ValueError("name is required")
        return value

    @field_validator("description")
    @classmethod
    def normalize_description(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None

    @field_validator("slug")
    @classmethod
    def normalize_slug(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip().lower()
        if not SLUG_RE.fullmatch(value):
            raise ValueError("slug must use lowercase letters, numbers, and hyphens")
        return value


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = " ".join(value.split())
        if not normalized:
            raise ValueError("name is required")
        return normalized

    @field_validator("description")
    @classmethod
    def normalize_updated_description(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None


class ProjectArchiveResponse(BaseModel):
    status: str = "archived"
    unlinked_agent_count: int


class ProjectAgentLinkBody(BaseModel):
    agent_ids: list[str] = Field(min_length=1, max_length=200)


class ProjectAgentLinkResponse(BaseModel):
    project_id: str
    bound_agent_ids: list[str]


class ProjectAgentDeltaBody(BaseModel):
    add_agent_ids: list[UUID] = Field(default_factory=list, max_length=200)
    remove_agent_ids: list[UUID] = Field(default_factory=list, max_length=200)

    @model_validator(mode="after")
    def validate_disjoint_ids(self) -> ProjectAgentDeltaBody:
        if set(self.add_agent_ids) & set(self.remove_agent_ids):
            raise ValueError("Agent ids to add and remove must be disjoint")
        return self


class ProjectAgentDeltaResponse(BaseModel):
    project_id: str
    added_agent_ids: list[str]
    removed_agent_ids: list[str]


def _project_response(
    project: Project,
    caller_user_id: UUID,
    *,
    owner: User | None = None,
    membership: ProjectMembership | None = None,
    skill_count: int = 0,
    vault_count: int = 0,
    agent_count: int = 0,
    member_count: int = 0,
) -> ProjectResponse:
    is_owner = project.user_id == caller_user_id
    owner_display = safe_owner_display(owner) if owner is not None else None
    owner_handle = None
    if is_owner:
        owner_handle = safe_owner_handle(owner) if owner is not None else None
    elif membership is not None:
        owner_handle = membership.resolved_owner_handle
    return ProjectResponse(
        id=str(project.id),
        name=project.name,
        slug=project.slug,
        kind=project.kind,
        description=project.description,
        origin_environment_id=(
            str(project.origin_environment_id) if project.origin_environment_id else None
        ),
        archived_at=project.archived_at,
        created_at=project.created_at,
        is_owner=is_owner,
        owner_display=owner_display,
        owner_handle=owner_handle,
        skill_count=skill_count,
        vault_count=vault_count,
        agent_count=agent_count,
        member_count=member_count,
    )


def _project_count_columns(caller_user_id: UUID):
    return (
        select(func.count(Skill.id))
        .where(Skill.project_id == Project.id, Skill.is_active)
        .correlate(Project)
        .scalar_subquery()
        .label("skill_count"),
        select(func.count(VaultProjectAttachment.id))
        .where(VaultProjectAttachment.project_id == Project.id)
        .correlate(Project)
        .scalar_subquery()
        .label("vault_count"),
        select(func.count(AgentProjectBinding.id))
        .join(AgentEnvironment, AgentEnvironment.id == AgentProjectBinding.agent_id)
        .where(
            AgentProjectBinding.project_id == Project.id,
            AgentEnvironment.user_id == caller_user_id,
            AgentEnvironment.archived_at.is_(None),
        )
        .correlate(Project)
        .scalar_subquery()
        .label("agent_count"),
        select(func.count(ProjectMembership.id))
        .where(ProjectMembership.project_id == Project.id)
        .correlate(Project)
        .scalar_subquery()
        .label("member_count"),
    )


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    slug = re.sub(r"-{2,}", "-", slug)
    return (slug or "project")[:80].strip("-") or "project"


async def _unique_slug(
    db: AsyncSession,
    user_id: UUID,
    preferred: str,
    *,
    allow_suffix: bool = True,
) -> str:
    base = preferred[:80].strip("-") or "project"
    result = await db.execute(select(Project.slug).where(Project.user_id == user_id))
    existing = set(result.scalars().all())
    if base not in existing:
        return base
    if not allow_suffix:
        raise HTTPException(status.HTTP_409_CONFLICT, "A project with this slug already exists")

    for suffix in range(2, 10_000):
        suffix_text = f"-{suffix}"
        candidate = f"{base[: 80 - len(suffix_text)]}{suffix_text}"
        if candidate not in existing:
            return candidate
    raise HTTPException(status.HTTP_409_CONFLICT, "Could not allocate a unique project slug")


@router.get("/default", response_model=DefaultProjectResponse)
async def get_default_project(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> DefaultProjectResponse:
    """Return the project ID where the caller's next write lands.

    Resolution rules match `resolve_default_write_project`:
      - Agent API key → that Agent Project id
      - Clerk JWT or unbound api_key → most-recently-active Agent Project,
        falling back to Personal if no Agents are registered.
    """
    project_id = await resolve_default_write_project(db, auth)
    return DefaultProjectResponse(project_id=str(project_id))


@router.post("", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
async def create_project(
    body: ProjectCreate,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> ProjectResponse:
    """Create an explicit project/team container owned by the caller.

    Agent API keys are rejected: creating shareable Projects is
    an account-level action, not something a hosted agent pod should do
    with a leaked key.
    """
    user_id = auth.user_id
    explicit_slug = body.slug is not None
    slug = await _unique_slug(
        db,
        user_id,
        body.slug or _slugify(body.name),
        allow_suffix=not explicit_slug,
    )
    project = Project(
        user_id=user_id,
        name=body.name,
        slug=slug,
        kind=PROJECT_KIND_WORKSPACE,
        description=body.description,
    )
    db.add(project)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "A project with this slug already exists",
        ) from exc
    await db.refresh(project)
    return _project_response(project, user_id, owner=auth.user)


@router.get("", response_model=list[ProjectResponse])
async def list_projects(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> list[ProjectResponse]:
    """List every project the caller can read. JWT auth -> all of
    the user's visible projects. Agent API key -> that Agent Project only.
    """
    caller_user_id = auth.user_id
    membership_join = and_(
        ProjectMembership.project_id == Project.id,
        ProjectMembership.member_user_id == caller_user_id,
    )
    count_columns = _project_count_columns(caller_user_id)
    stmt = (
        select(Project, User, ProjectMembership, *count_columns)
        .outerjoin(User, User.id == Project.user_id)
        .outerjoin(ProjectMembership, membership_join)
        .where(active_project_filter())
        .order_by(Project.created_at.desc())
    )
    if auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None:
        bound_project_id = await resolve_default_write_project(db, auth)
        stmt = stmt.where(Project.id == bound_project_id)
    else:
        stmt = stmt.where(
            or_(
                Project.user_id == caller_user_id,
                ProjectMembership.member_user_id == caller_user_id,
            )
        )

    result = await db.execute(stmt)
    return [
        _project_response(
            project,
            caller_user_id,
            owner=owner,
            membership=membership,
            skill_count=skill_count,
            vault_count=vault_count,
            agent_count=agent_count,
            member_count=member_count,
        )
        for (
            project,
            owner,
            membership,
            skill_count,
            vault_count,
            agent_count,
            member_count,
        ) in result.all()
    ]


@router.get("/{project_id}", response_model=ProjectResponse)
async def get_project(
    project_id: str,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> ProjectResponse:
    """Show one project if it is visible to the caller."""
    try:
        from uuid import UUID

        project_uuid = UUID(project_id)
    except ValueError as err:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found") from err

    visible_project_ids = await project_ids_visible_to(db, auth)
    if project_uuid not in visible_project_ids:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")
    row = (
        await db.execute(
            select(Project, *_project_count_columns(auth.user_id)).where(
                Project.id == project_uuid,
                active_project_filter(),
            )
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")
    project, skill_count, vault_count, agent_count, member_count = row
    owner = (await db.execute(select(User).where(User.id == project.user_id))).scalar_one_or_none()
    membership = (
        await db.execute(
            select(ProjectMembership).where(
                ProjectMembership.project_id == project.id,
                ProjectMembership.member_user_id == auth.user_id,
            )
        )
    ).scalar_one_or_none()
    return _project_response(
        project,
        auth.user_id,
        owner=owner,
        membership=membership,
        skill_count=skill_count,
        vault_count=vault_count,
        agent_count=agent_count,
        member_count=member_count,
    )


@router.patch("/{project_id}", response_model=ProjectResponse)
async def update_project(
    project_id: UUID,
    body: ProjectUpdate,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> ProjectResponse:
    if not body.model_fields_set:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "No Project changes provided")
    if "name" in body.model_fields_set and body.name is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Project name cannot be empty")
    await lock_project_change(db, project_id)
    project = (
        await db.execute(
            select(Project).where(
                Project.id == project_id,
                Project.user_id == auth.user_id,
                active_project_filter(),
            )
        )
    ).scalar_one_or_none()
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")
    if project.kind != PROJECT_KIND_WORKSPACE:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Only user-created Projects can be edited",
        )
    if "name" in body.model_fields_set and body.name is not None:
        project.name = body.name
    if "description" in body.model_fields_set:
        project.description = body.description
    await db.commit()
    await db.refresh(project)
    counts = (
        await db.execute(
            select(*_project_count_columns(auth.user_id)).where(Project.id == project.id)
        )
    ).one()
    return _project_response(
        project,
        auth.user_id,
        owner=auth.user,
        skill_count=counts.skill_count,
        vault_count=counts.vault_count,
        agent_count=counts.agent_count,
        member_count=counts.member_count,
    )


@router.post("/{project_id}/agents", response_model=ProjectAgentLinkResponse)
async def link_project_agents(
    project_id: UUID,
    body: ProjectAgentLinkBody,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> ProjectAgentLinkResponse:
    bound_agent_ids = await attach_project_to_owned_agents(
        db,
        user_id=auth.user_id,
        project_id=project_id,
        raw_agent_ids=body.agent_ids,
    )
    await db.commit()
    return ProjectAgentLinkResponse(
        project_id=str(project_id),
        bound_agent_ids=bound_agent_ids,
    )


@router.patch("/{project_id}/agents", response_model=ProjectAgentDeltaResponse)
async def update_project_agents(
    project_id: UUID,
    body: ProjectAgentDeltaBody,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> ProjectAgentDeltaResponse:
    result = await update_project_owned_agent_links(
        db,
        user_id=auth.user_id,
        project_id=project_id,
        add_agent_ids=body.add_agent_ids,
        remove_agent_ids=body.remove_agent_ids,
    )
    await db.commit()
    return ProjectAgentDeltaResponse(
        project_id=str(project_id),
        added_agent_ids=[str(agent_id) for agent_id in result.added_ids],
        removed_agent_ids=[str(agent_id) for agent_id in result.removed_ids],
    )


@router.delete("/{project_id}", response_model=ProjectArchiveResponse)
async def archive_project(
    project_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> ProjectArchiveResponse:
    project = (
        await db.execute(
            select(Project).where(
                Project.id == project_id,
                Project.user_id == auth.user_id,
                active_project_filter(),
            )
        )
    ).scalar_one_or_none()
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")
    if project.kind != PROJECT_KIND_WORKSPACE:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Only user-created Projects can be archived",
        )
    agent_ids = await lock_project_runtime_graph(db, project_id)
    project = (
        await db.execute(
            select(Project).where(
                Project.id == project_id,
                Project.user_id == auth.user_id,
                active_project_filter(),
            )
        )
    ).scalar_one_or_none()
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")
    if project.kind != PROJECT_KIND_WORKSPACE:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Only user-created Projects can be archived",
        )
    await queue_project_runtime_manifest_changed(db, project_id=project_id)
    await db.execute(
        delete(AgentProjectBinding).where(
            AgentProjectBinding.project_id == project_id,
            AgentProjectBinding.binding_type == "context",
        )
    )
    project.archived_at = datetime.now(UTC)
    await db.commit()
    return ProjectArchiveResponse(unlinked_agent_count=len(agent_ids))
