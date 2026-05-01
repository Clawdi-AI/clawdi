"""Global search across all entities — powers the Cmd+K palette.

Fires one query per type in parallel and returns top N of each. Results are
shaped for direct rendering (title/subtitle/href/type) so the frontend just
iterates groups and renders icons per type.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, _is_env_bound_api_key, _is_scoped_api_key, get_auth
from app.core.database import get_session
from app.core.query_utils import like_needle
from app.core.scope import scope_ids_visible_to
from app.models.session import AgentEnvironment, Session
from app.models.skill import Skill
from app.models.vault import Vault
from app.services.memory_provider import get_memory_provider


def _has_scope(auth: AuthContext, scope: str) -> bool:
    """JWT (dashboard) and legacy api_keys (scopes=NULL) bypass; only
    explicitly-scoped api_keys get gated. Mirrors require_scope's
    bypass logic — search has to enforce the same boundaries the
    direct routes do, otherwise it becomes a side-channel."""
    if not auth.is_cli or auth.api_key is None:
        return True
    if auth.api_key.scopes is None:
        return True
    return scope in auth.api_key.scopes


log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/search", tags=["search"])

SearchType = Literal["session", "memory", "skill", "vault"]


class SearchHit(BaseModel):
    type: SearchType
    id: str
    title: str
    subtitle: str | None = None
    href: str


class SearchResponse(BaseModel):
    query: str
    results: list[SearchHit]


TYPE_LIMIT = 5


async def _search_sessions(db: AsyncSession, auth: AuthContext, query: str) -> list[SearchHit]:
    needle = like_needle(query)
    stmt = (
        select(Session, AgentEnvironment.agent_type)
        .outerjoin(AgentEnvironment, Session.environment_id == AgentEnvironment.id)
        .where(Session.user_id == auth.user_id)
        .where(
            or_(
                Session.summary.ilike(needle, escape="\\"),
                Session.project_path.ilike(needle, escape="\\"),
                Session.local_session_id.ilike(needle, escape="\\"),
            )
        )
        .order_by(Session.started_at.desc())
        .limit(TYPE_LIMIT)
    )
    # Bound api_keys can only see sessions in their own env — same
    # boundary the direct list_sessions route enforces.
    if auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None:
        stmt = stmt.where(Session.environment_id == auth.api_key.environment_id)
    rows = (await db.execute(stmt)).all()
    hits: list[SearchHit] = []
    for s, agent_type in rows:
        title = (s.summary or "").strip() or s.local_session_id[:16]
        subtitle_parts = [p for p in (agent_type, s.project_path) if p]
        hits.append(
            SearchHit(
                type="session",
                id=str(s.id),
                title=title,
                subtitle=" · ".join(subtitle_parts) or None,
                href=f"/sessions/{s.id}",
            )
        )
    return hits


async def _search_memories(db: AsyncSession, auth: AuthContext, query: str) -> list[SearchHit]:
    provider = await get_memory_provider(str(auth.user_id), db)
    # Same overfetch trick the direct `/api/memories?q=` path uses
    # for scoped keys: provider.search returns top-N ranked across
    # ALL of the user's memories, then `_scope_filter_memories`
    # drops out-of-env rows. Asking for only TYPE_LIMIT hits when
    # other envs rank ahead truncated the in-env hits to nothing.
    # Overfetch by 10x then re-cap to TYPE_LIMIT after the filter
    # so the response shape stays predictable.
    fetch_limit = max(TYPE_LIMIT * 10, 100) if _is_env_bound_api_key(auth) else TYPE_LIMIT
    rows = await provider.search(str(auth.user_id), query, limit=fetch_limit)
    # Apply the same env-scope filter the direct /api/memories route
    # uses. Without this, a scoped env-bound key with `memories:read`
    # could read memories from other envs (or manual memories with
    # no env attribution) via the search palette — a side-channel
    # around _scope_filter_memories. Imported lazily to avoid a
    # circular import between search.py and memories.py.
    from app.routes.memories import _scope_filter_memories

    rows = await _scope_filter_memories(db, auth, list(rows))
    rows = rows[:TYPE_LIMIT]
    return [
        SearchHit(
            type="memory",
            id=str(m["id"]),
            title=m["content"][:80] + ("…" if len(m["content"]) > 80 else ""),
            subtitle=m.get("category"),
            href=f"/memories/{m['id']}",
        )
        for m in rows
    ]


async def _search_skills(db: AsyncSession, auth: AuthContext, query: str) -> list[SearchHit]:
    needle = like_needle(query)
    visible_scope_ids = await scope_ids_visible_to(db, auth)
    stmt = (
        select(Skill)
        .where(
            Skill.user_id == auth.user_id,
            Skill.is_active,
            Skill.scope_id.in_(visible_scope_ids),
        )
        .where(
            or_(
                Skill.skill_key.ilike(needle, escape="\\"),
                Skill.name.ilike(needle, escape="\\"),
                Skill.description.ilike(needle, escape="\\"),
            )
        )
        .order_by(Skill.skill_key)
        .limit(TYPE_LIMIT)
    )
    rows = (await db.execute(stmt)).scalars().all()
    return [
        SearchHit(
            type="skill",
            id=str(s.id),
            title=s.name or s.skill_key,
            subtitle=s.description,
            # Include the scope so a multi-agent account where the
            # same `skill_key` exists in two scopes routes the
            # palette click to the row that actually matched. The
            # legacy `/skills/{key}` route resolves to "most-
            # recently-updated across visible scopes", which can
            # land the user on agent A's copy of `foo` after they
            # picked agent B's hit — and any subsequent edit lands
            # under the wrong scope.
            # Percent-encode skill_key so nested Hermes keys like
            # `category/foo` don't collapse the dashboard's single
            # `[key]` segment into multiple path parts (would
            # 404 the palette click). `safe=""` quotes `/` too.
            href=f"/skills/{quote(s.skill_key, safe='')}?scope={s.scope_id}",
        )
        for s in rows
    ]


async def _search_vaults(db: AsyncSession, auth: AuthContext, query: str) -> list[SearchHit]:
    needle = like_needle(query)
    visible_scope_ids = await scope_ids_visible_to(db, auth)
    stmt = (
        select(Vault)
        .where(
            Vault.user_id == auth.user_id,
            Vault.scope_id.in_(visible_scope_ids),
        )
        .where(
            or_(
                Vault.slug.ilike(needle, escape="\\"),
                Vault.name.ilike(needle, escape="\\"),
            )
        )
        .order_by(Vault.slug)
        .limit(TYPE_LIMIT)
    )
    rows = (await db.execute(stmt)).scalars().all()
    return [
        SearchHit(
            type="vault",
            id=str(v.id),
            title=v.name or v.slug,
            subtitle="encrypted secrets",
            href="/vault",
        )
        for v in rows
    ]


@router.get("")
async def global_search(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
    q: str = Query(..., min_length=1, max_length=200),
) -> SearchResponse:
    """Fan out to each entity searcher and concat results.

    Each searcher returns at most `TYPE_LIMIT` rows; total is capped at
    4*TYPE_LIMIT which keeps the palette responsive even with noisy queries.

    Sessions/skills/vaults use `ILIKE` (small tables) — memories goes through
    the hybrid provider (FTS + trgm + optional pgvector) for quality.

    A single failing source (e.g. the memory provider briefly unavailable)
    degrades to partial results rather than failing the whole request —
    palette UX beats strict all-or-nothing consistency here.
    """
    # Each subsource enforces the same scope boundary the direct
    # route does. Skills, sessions, and memories subqueries are
    # gated by the caller's scope list so a narrowly-scoped api_key
    # (e.g. one the dashboard mints with `scopes=["sessions:write"]`)
    # can't use global search as a side-channel to read resources
    # its scope list doesn't cover. Deploy keys default to full
    # access and pass all gates — same as a self-installed clawdi.
    # Vault is the most sensitive: items can hold credentials, so
    # we limit it to user JWT and wide-access personal CLI keys
    # (mirrors `require_user_auth` semantics on the direct vault
    # routes).
    coros: list = []
    labels: list[str] = []
    if _has_scope(auth, "skills:read"):
        coros.append(_search_skills(db, auth, q))
        labels.append("skills")
    if not _is_scoped_api_key(auth):
        coros.append(_search_vaults(db, auth, q))
        labels.append("vaults")
    if _has_scope(auth, "sessions:read"):
        coros.insert(0, _search_sessions(db, auth, q))
        labels.insert(0, "sessions")
    if _has_scope(auth, "memories:read"):
        # Insert memories right after sessions if present, otherwise first.
        idx = 1 if "sessions" in labels else 0
        coros.insert(idx, _search_memories(db, auth, q))
        labels.insert(idx, "memories")
    results = await asyncio.gather(*coros, return_exceptions=True)
    hits: list[SearchHit] = []
    for source, r in zip(labels, results):
        if isinstance(r, BaseException):
            log.warning(
                "search source %s failed for user %s: %s",
                source,
                auth.user_id,
                r,
                exc_info=r,
            )
            continue
        hits.extend(r)
    return SearchResponse(query=q, results=hits)
