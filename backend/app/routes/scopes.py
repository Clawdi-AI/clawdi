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

from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
from app.core.scope import resolve_default_write_scope, scope_ids_visible_to
from app.models.scope import Scope

router = APIRouter(prefix="/api/scopes", tags=["scopes"])


class ScopeResponse(BaseModel):
    id: str
    name: str
    slug: str
    kind: str
    origin_environment_id: str | None
    archived_at: datetime | None
    created_at: datetime


class DefaultScopeResponse(BaseModel):
    scope_id: str


@router.get("/default")
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


@router.get("")
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
    return [
        ScopeResponse(
            id=str(s.id),
            name=s.name,
            slug=s.slug,
            kind=s.kind,
            origin_environment_id=(
                str(s.origin_environment_id) if s.origin_environment_id else None
            ),
            archived_at=s.archived_at,
            created_at=s.created_at,
        )
        for s in rows
    ]
