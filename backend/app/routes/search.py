"""Global search across all entities — powers the Cmd+K palette.

Runs one query per type and returns top N of each. Results are shaped for
direct rendering (title/subtitle/href/type) so the frontend just iterates
groups and renders icons per type.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Literal
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import and_, case, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth, is_scoped_api_key
from app.core.database import get_session
from app.core.project import project_ids_visible_to
from app.core.query_utils import (
    escape_like,
    lexical_search_filter,
    like_needle,
    search_excerpt,
    search_terms,
)
from app.models.project import Project
from app.models.project_membership import ProjectMembership
from app.models.session import AgentEnvironment, Session
from app.models.skill import Skill
from app.models.user import User
from app.models.vault import Vault, VaultProjectAttachment
from app.schemas.session import SessionSearchMatchResponse
from app.services.agent_environments import agent_name_from_fields, agent_type_default_label
from app.services.agent_lifecycle import active_agent_filter
from app.services.memory_provider import get_memory_provider
from app.services.memory_types import MemoryItem
from app.services.session_search import (
    session_search_match_response,
    session_search_matches,
)
from app.services.sharing import safe_owner_display
from app.services.skill_search import (
    skill_search_filter,
    skill_search_rank,
    skill_search_subtitle,
)


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

router = APIRouter(prefix="/search", tags=["search"])

SearchType = Literal["agent", "session", "memory", "project", "skill", "vault"]


class SearchHit(BaseModel):
    type: SearchType
    id: str
    title: str
    subtitle: str | None = None
    href: str
    search_match: SessionSearchMatchResponse | None = None


class SearchResponse(BaseModel):
    query: str
    results: list[SearchHit]


TYPE_LIMIT = 5
type Searcher = Callable[
    [AsyncSession, AuthContext, str],
    Awaitable[list[SearchHit]],
]


async def _search_agents(db: AsyncSession, auth: AuthContext, query: str) -> list[SearchHit]:
    exact = escape_like(query)
    prefix = f"{exact}%"
    fields = (
        AgentEnvironment.display_name,
        AgentEnvironment.default_name,
        AgentEnvironment.machine_name,
        AgentEnvironment.agent_type,
    )
    rank = case(
        *[(field.ilike(exact, escape="\\"), index) for index, field in enumerate(fields)],
        *[
            (field.ilike(prefix, escape="\\"), index + len(fields))
            for index, field in enumerate(fields)
        ],
        else_=len(fields) * 2,
    )
    stmt = (
        select(AgentEnvironment)
        .where(
            AgentEnvironment.user_id == auth.user_id,
            active_agent_filter(),
            lexical_search_filter(query, fields),
        )
        .order_by(
            rank,
            AgentEnvironment.sort_order,
            AgentEnvironment.created_at,
            AgentEnvironment.id,
        )
        .limit(TYPE_LIMIT)
    )
    if auth.bound_environment_id is not None:
        stmt = stmt.where(AgentEnvironment.id == auth.bound_environment_id)
    agents = (await db.execute(stmt)).scalars().all()
    return [
        SearchHit(
            type="agent",
            id=str(agent.id),
            title=agent_name_from_fields(
                agent.display_name,
                agent.default_name,
                agent.machine_name,
                agent.agent_type,
            ),
            subtitle=_agent_search_subtitle(agent, query),
            href=f"/agents/{agent.id}",
        )
        for agent in agents
    ]


def _agent_search_subtitle(agent: AgentEnvironment, query: str) -> str | None:
    title = agent_name_from_fields(
        agent.display_name,
        agent.default_name,
        agent.machine_name,
        agent.agent_type,
    )
    type_label = agent_type_default_label(agent.agent_type)
    terms = tuple(term.casefold() for term in search_terms(query))
    title_terms = tuple(term for term in terms if term not in title.casefold())
    candidates = (
        agent.display_name,
        agent.default_name,
        agent.machine_name,
        type_label,
        agent.agent_type,
    )
    for candidate in candidates:
        label = (candidate or "").strip()
        if (
            label
            and label.casefold() != title.casefold()
            and any(term in label.casefold() for term in (title_terms or terms))
        ):
            return label
    context = [
        label for label in (type_label, agent.machine_name) if label.casefold() != title.casefold()
    ]
    return " · ".join(dict.fromkeys(context)) or None


async def _search_sessions(db: AsyncSession, auth: AuthContext, query: str) -> list[SearchHit]:
    matches = session_search_matches(auth.user_id, query)
    # Historical search retains archived Agent labels; this join grants no
    # operational Agent authority.
    stmt = (
        select(
            Session,
            AgentEnvironment.agent_type,
            matches.c.content,
            matches.c.role,
            matches.c.position,
            matches.c.content_revision,
        )
        .outerjoin(AgentEnvironment, Session.environment_id == AgentEnvironment.id)
        .join(matches, matches.c.session_id == Session.id)
        .where(Session.user_id == auth.user_id)
        .order_by(matches.c.score.desc(), Session.last_activity_at.desc(), Session.id.asc())
        .limit(TYPE_LIMIT)
    )
    # Bound api_keys can only see sessions in their own env — same
    # boundary the direct list_sessions route enforces.
    if auth.bound_environment_id is not None:
        stmt = stmt.where(Session.environment_id == auth.bound_environment_id)
    rows = (await db.execute(stmt)).all()
    hits: list[SearchHit] = []
    for s, agent_type, content, role, position, revision in rows:
        title = (s.summary or "").strip() or s.local_session_id[:16]
        subtitle_parts = [p for p in (agent_type, s.project_path) if p]
        search_match = session_search_match_response(
            s,
            query,
            content=content,
            role=role,
            position=position,
            revision=revision,
        )
        hits.append(
            SearchHit(
                type="session",
                id=str(s.id),
                title=title,
                subtitle=" · ".join(subtitle_parts) or None,
                href=f"/sessions/{s.id}",
                search_match=search_match,
            )
        )
    return hits


async def _search_memories(db: AsyncSession, auth: AuthContext, query: str) -> list[SearchHit]:
    provider = await get_memory_provider(str(auth.user_id), db)
    rows = await provider.search(
        str(auth.user_id),
        query,
        limit=TYPE_LIMIT,
    )
    hits: list[SearchHit] = []
    for item in rows:
        if hit := _memory_search_hit(item, query):
            hits.append(hit)
    return hits


def _memory_search_hit(item: MemoryItem, query: str) -> SearchHit | None:
    memory_id = item.get("id")
    content = item.get("content")
    category = item.get("category")
    if not isinstance(memory_id, str) or not isinstance(content, str):
        return None
    return SearchHit(
        type="memory",
        id=memory_id,
        title=search_excerpt(content, query, limit=160),
        subtitle=category if isinstance(category, str) else None,
        href=f"/memories/{memory_id}",
    )


async def _search_skills(db: AsyncSession, auth: AuthContext, query: str) -> list[SearchHit]:
    visible_project_ids = await project_ids_visible_to(db, auth)
    stmt = (
        select(Skill)
        .where(
            Skill.is_active,
            Skill.project_id.in_(visible_project_ids),
        )
        .where(skill_search_filter(query))
        .order_by(skill_search_rank(query), Skill.skill_key, Skill.project_id, Skill.id)
        .limit(TYPE_LIMIT)
    )
    rows = (await db.execute(stmt)).scalars().all()
    return [
        SearchHit(
            type="skill",
            id=str(s.id),
            title=s.name or s.skill_key,
            subtitle=skill_search_subtitle(s, query),
            # Include the project so a multi-agent account where the
            # same `skill_key` exists in two projects routes the
            # palette click to the row that actually matched. The
            # legacy `/skills/{key}` route resolves to "most-
            # recently-updated across visible projects", which can
            # land the user on agent A's copy of `foo` after they
            # picked agent B's hit — and any subsequent edit lands
            # under the wrong project.
            # Percent-encode skill_key so nested Hermes keys like
            # `category/foo` don't collapse the dashboard's single
            # `[key]` segment into multiple path parts (would
            # 404 the palette click). `safe=""` quotes `/` too.
            href=f"/skills/{quote(s.skill_key, safe='')}?project={s.project_id}",
        )
        for s in rows
    ]


async def _search_projects(db: AsyncSession, auth: AuthContext, query: str) -> list[SearchHit]:
    exact = escape_like(query)
    prefix = f"{exact}%"
    needle = like_needle(query)
    visible_project_ids = await project_ids_visible_to(db, auth)
    membership_join = and_(
        ProjectMembership.project_id == Project.id,
        ProjectMembership.member_user_id == auth.user_id,
    )
    project_match = lexical_search_filter(
        query,
        (
            Project.name,
            Project.slug,
            Project.description,
            case((Project.user_id != auth.user_id, User.name), else_=""),
            case(
                (
                    and_(Project.user_id != auth.user_id, User.name.is_(None)),
                    User.email,
                ),
                else_="",
            ),
            case(
                (
                    Project.user_id != auth.user_id,
                    ProjectMembership.resolved_owner_handle,
                ),
                else_="",
            ),
        ),
    )
    rank = case(
        (Project.name.ilike(exact, escape="\\"), 0),
        (Project.slug.ilike(exact, escape="\\"), 1),
        (Project.name.ilike(prefix, escape="\\"), 2),
        (Project.slug.ilike(prefix, escape="\\"), 3),
        (Project.name.ilike(needle, escape="\\"), 4),
        (Project.slug.ilike(needle, escape="\\"), 5),
        (Project.description.ilike(needle, escape="\\"), 6),
        else_=7,
    )
    stmt = (
        select(Project, User, ProjectMembership)
        .join(User, User.id == Project.user_id)
        .outerjoin(ProjectMembership, membership_join)
        .where(
            Project.id.in_(visible_project_ids),
            Project.archived_at.is_(None),
            project_match,
        )
        .order_by(rank, Project.name, Project.id)
        .limit(TYPE_LIMIT)
    )
    rows = (await db.execute(stmt)).all()
    return [
        SearchHit(
            type="project",
            id=str(p.id),
            title=p.name,
            subtitle=_project_search_subtitle(
                p,
                query,
                owner=owner,
                membership=membership,
                caller_user_id=auth.user_id,
            ),
            href=f"/projects/{p.id}",
        )
        for p, owner, membership in rows
    ]


def _project_search_subtitle(
    project: Project,
    query: str,
    *,
    owner: User,
    membership: ProjectMembership | None,
    caller_user_id: UUID,
) -> str:
    description = (project.description or "").strip()
    terms = tuple(term.casefold() for term in search_terms(query))
    if any(term in project.slug.casefold() for term in terms):
        return project.slug
    if description and any(term in description.casefold() for term in terms):
        return search_excerpt(description, query, limit=160)
    if project.user_id != caller_user_id:
        owner_labels = [safe_owner_display(owner)]
        if membership is not None:
            owner_labels.append(membership.resolved_owner_handle)
        if label := next(
            (label for label in owner_labels if any(term in label.casefold() for term in terms)),
            None,
        ):
            return f"Shared by {label}"
    return description or project.slug


async def _search_vaults(db: AsyncSession, auth: AuthContext, query: str) -> list[SearchHit]:
    exact = escape_like(query)
    prefix = f"{exact}%"
    needle = like_needle(query)
    visible_project_ids = await project_ids_visible_to(db, auth)
    visible_vault = (
        select(VaultProjectAttachment.id)
        .where(
            VaultProjectAttachment.vault_id == Vault.id,
            VaultProjectAttachment.project_id.in_(visible_project_ids),
        )
        .exists()
    )
    visibility = (
        visible_vault
        if auth.bound_environment_id is not None
        else or_(Vault.user_id == auth.user_id, visible_vault)
    )
    rank = case(
        (Vault.name.ilike(exact, escape="\\"), 0),
        (Vault.slug.ilike(exact, escape="\\"), 1),
        (Vault.name.ilike(prefix, escape="\\"), 2),
        (Vault.slug.ilike(prefix, escape="\\"), 3),
        (Vault.name.ilike(needle, escape="\\"), 4),
        (Vault.slug.ilike(needle, escape="\\"), 5),
        else_=6,
    )
    stmt = (
        select(Vault)
        .where(visibility)
        .where(lexical_search_filter(query, (Vault.slug, Vault.name)))
        .order_by(rank, Vault.name, Vault.id)
        .limit(TYPE_LIMIT)
    )
    rows = (await db.execute(stmt)).scalars().all()
    return [
        SearchHit(
            type="vault",
            id=str(v.id),
            title=v.name or v.slug,
            subtitle=(
                v.slug
                if any(term.casefold() in v.slug.casefold() for term in search_terms(query))
                and v.slug.casefold() != v.name.casefold()
                else "encrypted secrets"
            ),
            href=f"/vaults/{quote(v.slug, safe='')}?vault={v.id}",
        )
        for v in rows
    ]


@router.get("")
async def global_search(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
    q: str = Query(..., min_length=1, max_length=200),
) -> SearchResponse:
    """Run each entity searcher and concat results.

    Each searcher returns at most `TYPE_LIMIT` rows; total is capped at
    6*TYPE_LIMIT which keeps the palette responsive even with noisy queries.

    Sessions/projects/skills/vaults use literal + PostgreSQL full-text search;
    memories use the hybrid provider (FTS + trgm + optional pgvector).

    A single failing source (e.g. the memory provider briefly unavailable)
    degrades to partial results rather than failing the whole request —
    palette UX beats strict all-or-nothing consistency here. The queries run
    sequentially because SQLAlchemy AsyncSession is not safe for concurrent
    operations on the same request-scoped session.
    """
    query = q.strip()
    if not query:
        return SearchResponse(query=query, results=[])

    # Each subsource enforces the same permission boundary the direct
    # route does. Skills, sessions, and memories subqueries are
    # gated by the caller's API-permission list so a narrowly-scoped
    # api_key (e.g. one the dashboard mints with
    # `scopes=["sessions:write"]`)
    # can't use global search as a side-channel to read resources
    # its permission list doesn't cover. Deploy keys default to full
    # access and pass all gates — same as a self-installed clawdi.
    # Vault is the most sensitive: items can hold credentials, so
    # we limit it to user JWT and wide-access personal CLI keys
    # (mirrors `require_user_auth` semantics on the direct vault
    # routes).
    jobs: list[tuple[str, Searcher]] = [("agents", _search_agents)]
    if _has_scope(auth, "skills:read"):
        jobs.append(("skills", _search_skills))
    if not is_scoped_api_key(auth):
        jobs.append(("vaults", _search_vaults))
    if _has_scope(auth, "sessions:read"):
        jobs.insert(0, ("sessions", _search_sessions))
    if _has_scope(auth, "memories:read"):
        # Insert memories right after sessions if present, otherwise first.
        idx = 1 if any(label == "sessions" for label, _fn in jobs) else 0
        jobs.insert(idx, ("memories", _search_memories))
    if _has_scope(auth, "projects:read"):
        # Projects are the Library hubs — after activity objects, before assets.
        idx = next((i + 1 for i, (label, _fn) in enumerate(jobs) if label == "memories"), len(jobs))
        jobs.insert(idx, ("projects", _search_projects))
    hits: list[SearchHit] = []
    for source, searcher in jobs:
        try:
            r = await searcher(db, auth, query)
        except Exception as exc:
            log.warning(
                "search source %s failed for user %s: %s",
                source,
                auth.user_id,
                exc,
                exc_info=exc,
            )
            continue
        hits.extend(r)
    return SearchResponse(query=query, results=hits)
