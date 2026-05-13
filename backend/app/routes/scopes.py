"""Scope metadata routes — list a user's scopes and pick the
default. Skill / vault / memory scope-explicit operations live
on their own routers (e.g. `/api/scopes/{scope_id}/skills/...`)
so the routing tree stays organised by entity type.

CLI commands hitting phase-2 scope-explicit URLs need to know
*which* scope to address. The api_key is bound to an env on the
server side, but the daemon-started CLI doesn't know its own
env's default_scope_id without a round-trip. `/api/scopes/default`
exposes the same logic `resolve_default_write_scope` runs
server-side as an HTTP read so any caller can ask "where would
my next write land?" without local env tracking.
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
from app.models.scope import SCOPE_KIND_WORKSPACE, Scope

router = APIRouter(prefix="/api/scopes", tags=["scopes"])


class ScopeResponse(BaseModel):
    id: str
    name: str
    slug: str
    kind: str
    origin_environment_id: str | None
    archived_at: datetime | None
    created_at: datetime
    # Derived per-caller: True if the caller owns this scope, False
    # if it's visible via a ScopeMembership (shared with them). Lets
    # the dashboard render "My scopes" vs "Shared with me" sections
    # and the CLI render a shared_with_me column.
    is_owner: bool = True


class DefaultScopeResponse(BaseModel):
    scope_id: str


SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,79}$")


class ScopeCreate(BaseModel):
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


def _scope_response(scope: Scope, caller_user_id) -> ScopeResponse:
    return ScopeResponse(
        id=str(scope.id),
        name=scope.name,
        slug=scope.slug,
        kind=scope.kind,
        origin_environment_id=(
            str(scope.origin_environment_id) if scope.origin_environment_id else None
        ),
        archived_at=scope.archived_at,
        created_at=scope.created_at,
        is_owner=scope.user_id == caller_user_id,
    )


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    slug = re.sub(r"-{2,}", "-", slug)
    return (slug or "scope")[:80].strip("-") or "scope"


async def _unique_slug(
    db: AsyncSession,
    user_id,
    preferred: str,
    *,
    allow_suffix: bool = True,
) -> str:
    base = preferred[:80].strip("-") or "scope"
    result = await db.execute(select(Scope.slug).where(Scope.user_id == user_id))
    existing = set(result.scalars().all())
    if base not in existing:
        return base
    if not allow_suffix:
        raise HTTPException(status.HTTP_409_CONFLICT, "A scope with this slug already exists")

    for suffix in range(2, 10_000):
        suffix_text = f"-{suffix}"
        candidate = f"{base[: 80 - len(suffix_text)]}{suffix_text}"
        if candidate not in existing:
            return candidate
    raise HTTPException(status.HTTP_409_CONFLICT, "Could not allocate a unique scope slug")


@router.get("/default", response_model=DefaultScopeResponse)
async def get_default_scope(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> DefaultScopeResponse:
    """Return the scope_id where the caller's next write would
    land if they used a legacy non-scoped route. Lets CLI tools
    construct phase-2 `/api/scopes/{scope_id}/...` URLs without
    locally tracking which env they're bound to.

    Resolution rules match `resolve_default_write_scope`:
      - api_key bound to env → that env's `default_scope_id`
      - Clerk JWT or unbound api_key → most-recently-active env's
        scope, falling back to Personal if no envs.
    """
    scope_id = await resolve_default_write_scope(db, auth)
    return DefaultScopeResponse(scope_id=str(scope_id))


@router.post("", response_model=ScopeResponse, status_code=status.HTTP_201_CREATED)
async def create_scope(
    body: ScopeCreate,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> ScopeResponse:
    """Create an explicit project/team scope owned by the caller.

    Env-bound deploy keys are rejected: creating shareable scopes is
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
    scope = Scope(
        user_id=user_id,
        name=body.name,
        slug=slug,
        kind=SCOPE_KIND_WORKSPACE,
    )
    db.add(scope)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "A scope with this slug already exists",
        ) from exc
    await db.refresh(scope)
    return _scope_response(scope, user_id)


@router.get("", response_model=list[ScopeResponse])
async def list_scopes(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> list[ScopeResponse]:
    """List every scope the caller can read. JWT auth → all of
    the user's scopes. api_key → the bound env's scope only.
    """
    visible_scope_ids = await scope_ids_visible_to(db, auth)
    if not visible_scope_ids:
        return []
    result = await db.execute(
        select(Scope).where(Scope.id.in_(visible_scope_ids)).order_by(Scope.created_at.desc())
    )
    rows = result.scalars().all()
    caller_user_id = auth.user_id
    return [_scope_response(s, caller_user_id) for s in rows]
