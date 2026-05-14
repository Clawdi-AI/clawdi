"""Project metadata routes.

List the caller's projects and resolve the default write project.
"""

from __future__ import annotations

import re
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth, require_user_auth_unbound
from app.core.database import get_session
from app.core.scope import resolve_default_write_scope, scope_ids_visible_to
from app.models.project import PROJECT_KIND_WORKSPACE, Project

router = APIRouter(prefix="/api/projects", tags=["projects"])


class ProjectResponse(BaseModel):
    id: str
    name: str
    slug: str
    kind: str
    origin_environment_id: str | None
    archived_at: datetime | None
    created_at: datetime
    # Derived per-caller: True if the caller owns this project, False
    # if it's visible via a ProjectMembership (shared with them). Lets
    # the dashboard render "My projects" vs "Shared with me" sections
    # and the CLI render a shared_with_me column.
    is_owner: bool = True


class DefaultProjectResponse(BaseModel):
    project_id: str


SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,79}$")


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    slug: str | None = Field(default=None, min_length=1, max_length=80, pattern=SLUG_RE.pattern)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value:
            raise ValueError("name is required")
        return value

    @field_validator("slug")
    @classmethod
    def normalize_slug(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip().lower()
        if not SLUG_RE.fullmatch(value):
            raise ValueError("slug must use lowercase letters, numbers, and hyphens")
        return value


def _project_response(project: Project, caller_user_id) -> ProjectResponse:
    return ProjectResponse(
        id=str(project.id),
        name=project.name,
        slug=project.slug,
        kind=project.kind,
        origin_environment_id=(
            str(project.origin_environment_id) if project.origin_environment_id else None
        ),
        archived_at=project.archived_at,
        created_at=project.created_at,
        is_owner=project.user_id == caller_user_id,
    )


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    slug = re.sub(r"-{2,}", "-", slug)
    return (slug or "project")[:80].strip("-") or "project"


async def _unique_slug(
    db: AsyncSession,
    user_id,
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

    Resolution rules match `resolve_default_write_scope`:
      - api_key bound to env → that env's `default_project_id`
      - Clerk JWT or unbound api_key → most-recently-active env's
        project, falling back to Personal if no envs.
    """
    project_id = await resolve_default_write_scope(db, auth)
    return DefaultProjectResponse(project_id=str(project_id))


@router.post("", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
async def create_project(
    body: ProjectCreate,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> ProjectResponse:
    """Create an explicit project/team container owned by the caller.

    Env-bound deploy keys are rejected: creating shareable projects is
    an account-level action, not something a hosted agent pod should do
    with a leaked environment key.
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
    return _project_response(project, user_id)


@router.get("", response_model=list[ProjectResponse])
async def list_projects(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> list[ProjectResponse]:
    """List every project the caller can read. JWT auth -> all of
    the user's visible projects. api_key -> the bound env's project only.
    """
    visible_scope_ids = await scope_ids_visible_to(db, auth)
    if not visible_scope_ids:
        return []
    result = await db.execute(
        select(Project).where(Project.id.in_(visible_scope_ids)).order_by(Project.created_at.desc())
    )
    rows = result.scalars().all()
    caller_user_id = auth.user_id
    return [_project_response(p, caller_user_id) for p in rows]
