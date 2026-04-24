"""Global search across all entities — powers the Cmd+K palette.

Fires one query per type in parallel and returns top N of each. Results are
shaped for direct rendering (title/subtitle/href/type) so the frontend just
iterates groups and renders icons per type.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
from app.core.query_utils import like_needle
from app.models.session import AgentEnvironment, Session
from app.models.skill import Skill
from app.models.vault import Vault
from app.services.memory_provider import get_memory_provider

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


async def _search_sessions(db: AsyncSession, user_id: UUID, query: str) -> list[SearchHit]:
    needle = like_needle(query)
    stmt = (
        select(Session, AgentEnvironment.agent_type)
        .outerjoin(AgentEnvironment, Session.environment_id == AgentEnvironment.id)
        .where(Session.user_id == user_id)
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


async def _search_memories(db: AsyncSession, user_id: UUID, query: str) -> list[SearchHit]:
    provider = await get_memory_provider(str(user_id), db)
    rows = await provider.search(str(user_id), query, limit=TYPE_LIMIT)
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


async def _search_skills(db: AsyncSession, user_id: UUID, query: str) -> list[SearchHit]:
    needle = like_needle(query)
    stmt = (
        select(Skill)
        .where(Skill.user_id == user_id, Skill.is_active)
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
            href=f"/skills/{s.skill_key}",
        )
        for s in rows
    ]


async def _search_vaults(db: AsyncSession, user_id: UUID, query: str) -> list[SearchHit]:
    needle = like_needle(query)
    stmt = (
        select(Vault)
        .where(Vault.user_id == user_id)
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
    user_id = auth.user_id
    results = await asyncio.gather(
        _search_sessions(db, user_id, q),
        _search_memories(db, user_id, q),
        _search_skills(db, user_id, q),
        _search_vaults(db, user_id, q),
        return_exceptions=True,
    )
    hits: list[SearchHit] = []
    for source, r in zip(
        ("sessions", "memories", "skills", "vaults"), results, strict=True
    ):
        if isinstance(r, BaseException):
            log.warning("search source %s failed: %s", source, r)
            continue
        hits.extend(r)
    return SearchResponse(query=q, results=hits)
