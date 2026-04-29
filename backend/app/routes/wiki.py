"""Personal wiki — read-only API.

Three endpoints today:
- GET /api/wiki/pages          → paginated list of pages (filter by kind)
- GET /api/wiki/pages/{slug}   → one page + its backlinks + outgoing links
- GET /api/wiki/log            → chronological activity feed

Write-side endpoints (page creation, evidence linking, manual stale flag)
land alongside the entity extraction pipeline. For now, these read-only
endpoints serve the dashboard MVP — the dashboard renders correctly with
an empty wiki, then lights up as the pipeline starts producing pages.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
from app.models.wiki import WikiLink, WikiLogEntry, WikiPage
from app.services.wiki_extraction import extract_for_user
from app.services.wiki_synthesis import synthesize_for_user

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/wiki", tags=["wiki"])


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------


class WikiPageSummary(BaseModel):
    id: uuid.UUID
    slug: str
    title: str
    kind: str
    source_count: int
    stale: bool
    last_synthesis_at: datetime | None
    updated_at: datetime


class WikiLinkOut(BaseModel):
    """Outgoing or incoming edge from/to a page."""

    id: uuid.UUID
    link_type: str
    confidence: float | None
    # Exactly one of (to_page_*) or (source_*) is populated.
    to_page_id: uuid.UUID | None
    to_page_slug: str | None
    to_page_title: str | None
    source_type: str | None
    source_ref: str | None


class WikiPageDetail(BaseModel):
    id: uuid.UUID
    slug: str
    title: str
    kind: str
    compiled_truth: str | None
    frontmatter: dict | None
    source_count: int
    stale: bool
    last_synthesis_at: datetime | None
    created_at: datetime
    updated_at: datetime
    outgoing_links: list[WikiLinkOut]
    backlinks: list[WikiLinkOut]


class WikiLogOut(BaseModel):
    id: uuid.UUID
    page_id: uuid.UUID | None
    page_slug: str | None
    action: str
    source_type: str | None
    source_ref: str | None
    metadata: dict | None
    ts: datetime


class PageList(BaseModel):
    items: list[WikiPageSummary]
    total: int
    page: int
    page_size: int


class LogList(BaseModel):
    items: list[WikiLogOut]
    total: int
    page: int
    page_size: int


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/pages", response_model=PageList)
async def list_pages(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
    kind: Literal["entity", "concept", "synthesis"] | None = Query(default=None),
    stale: bool | None = Query(
        default=None, description="Filter by stale flag. Omit to include both."
    ),
    sort: Literal["updated_at", "title", "source_count"] = Query(default="updated_at"),
    order: Literal["asc", "desc"] = Query(default="desc"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
) -> PageList:
    """List wiki pages for the current user, paginated.

    Default ordering shows most-recently-updated first, matching dashboard
    expectations for an "activity" view.
    """
    base_filters = [WikiPage.user_id == auth.user_id]
    if kind is not None:
        base_filters.append(WikiPage.kind == kind)
    if stale is not None:
        base_filters.append(WikiPage.stale == stale)

    sort_col = {
        "updated_at": WikiPage.updated_at,
        "title": WikiPage.title,
        "source_count": WikiPage.source_count,
    }[sort]
    sort_clause = sort_col.desc() if order == "desc" else sort_col.asc()

    total = (await db.scalar(select(func.count(WikiPage.id)).where(*base_filters))) or 0

    rows = (
        (
            await db.execute(
                select(WikiPage)
                .where(*base_filters)
                .order_by(sort_clause)
                .limit(page_size)
                .offset((page - 1) * page_size)
            )
        )
        .scalars()
        .all()
    )

    return PageList(
        items=[
            WikiPageSummary(
                id=p.id,
                slug=p.slug,
                title=p.title,
                kind=p.kind,
                source_count=p.source_count,
                stale=p.stale,
                last_synthesis_at=p.last_synthesis_at,
                updated_at=p.updated_at,
            )
            for p in rows
        ],
        total=int(total),
        page=page,
        page_size=page_size,
    )


@router.get("/pages/{slug}", response_model=WikiPageDetail)
async def get_page(
    slug: str,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> WikiPageDetail:
    """Fetch one page, its outgoing links, and its backlinks."""
    page = (
        await db.execute(
            select(WikiPage).where(
                WikiPage.user_id == auth.user_id,
                WikiPage.slug == slug,
            )
        )
    ).scalar_one_or_none()
    if page is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Wiki page not found: {slug}",
        )

    # Outgoing edges from this page. If the edge points to another page,
    # join to fetch its slug/title for display.
    outgoing_rows = (
        await db.execute(
            select(WikiLink, WikiPage.slug, WikiPage.title)
            .outerjoin(
                WikiPage,
                WikiPage.id == WikiLink.to_page_id,
            )
            .where(
                WikiLink.user_id == auth.user_id,
                WikiLink.from_page_id == page.id,
            )
        )
    ).all()

    outgoing = [
        WikiLinkOut(
            id=link.id,
            link_type=link.link_type,
            confidence=link.confidence,
            to_page_id=link.to_page_id,
            to_page_slug=to_slug,
            to_page_title=to_title,
            source_type=link.source_type,
            source_ref=link.source_ref,
        )
        for link, to_slug, to_title in outgoing_rows
    ]

    # Incoming edges (backlinks) — only from-page-to-page edges. We don't
    # display "memory X mentions this page" as a backlink because that's
    # captured by the source_count + outgoing_links from the source side.
    backlink_rows = (
        await db.execute(
            select(WikiLink, WikiPage.slug, WikiPage.title)
            .join(WikiPage, WikiPage.id == WikiLink.from_page_id)
            .where(
                WikiLink.user_id == auth.user_id,
                WikiLink.to_page_id == page.id,
            )
        )
    ).all()

    backlinks = [
        WikiLinkOut(
            id=link.id,
            link_type=link.link_type,
            confidence=link.confidence,
            # For backlinks we surface the SOURCE page (i.e. the from
            # side) under the to_page_* fields so the UI can render
            # "← linked from <title>" uniformly.
            to_page_id=link.from_page_id,
            to_page_slug=from_slug,
            to_page_title=from_title,
            source_type=None,
            source_ref=None,
        )
        for link, from_slug, from_title in backlink_rows
    ]

    return WikiPageDetail(
        id=page.id,
        slug=page.slug,
        title=page.title,
        kind=page.kind,
        compiled_truth=page.compiled_truth,
        frontmatter=page.frontmatter,
        source_count=page.source_count,
        stale=page.stale,
        last_synthesis_at=page.last_synthesis_at,
        created_at=page.created_at,
        updated_at=page.updated_at,
        outgoing_links=outgoing,
        backlinks=backlinks,
    )


class RefreshRequest(BaseModel):
    """Trigger an extraction + synthesis pass for the current user."""

    extract: bool = True
    synthesize: bool = True
    # When true, re-synthesize every eligible page even if not stale.
    # Useful for the first run after a backfill or model change.
    force_synthesis: bool = False


class RefreshResponse(BaseModel):
    extraction: dict | None = None
    synthesis: dict | None = None


@router.post("/refresh", response_model=RefreshResponse)
async def refresh_wiki(
    body: RefreshRequest,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> RefreshResponse:
    """Run the wiki pipeline once for the authenticated user.

    Idempotent for extraction (atoms processed once stay processed).
    Synthesis re-runs only stale pages unless force_synthesis is true.
    Designed to be safe to call from a scheduled job, the dashboard's
    "rebuild wiki" button, or an ops shell.
    """
    out = RefreshResponse()
    if body.extract:
        out.extraction = await extract_for_user(db, auth.user_id)
    if body.synthesize:
        out.synthesis = await synthesize_for_user(db, auth.user_id, force=body.force_synthesis)
    return out


@router.get("/log", response_model=LogList)
async def list_log(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
    page_id: uuid.UUID | None = Query(
        default=None, description="Filter to events on a single page."
    ),
    action: str | None = Query(
        default=None,
        description="Filter to a specific action, e.g. 'synthesized', 'flagged_stale'.",
    ),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
) -> LogList:
    """Chronological wiki activity feed for the current user."""
    filters = [WikiLogEntry.user_id == auth.user_id]
    if page_id is not None:
        filters.append(WikiLogEntry.page_id == page_id)
    if action is not None:
        filters.append(WikiLogEntry.action == action)

    total = (await db.scalar(select(func.count(WikiLogEntry.id)).where(*filters))) or 0

    rows = (
        await db.execute(
            select(WikiLogEntry, WikiPage.slug)
            .outerjoin(WikiPage, WikiPage.id == WikiLogEntry.page_id)
            .where(*filters)
            .order_by(WikiLogEntry.ts.desc())
            .limit(page_size)
            .offset((page - 1) * page_size)
        )
    ).all()

    return LogList(
        items=[
            WikiLogOut(
                id=entry.id,
                page_id=entry.page_id,
                page_slug=page_slug,
                action=entry.action,
                source_type=entry.source_type,
                source_ref=entry.source_ref,
                metadata=entry.metadata_,
                ts=entry.ts,
            )
            for entry, page_slug in rows
        ],
        total=int(total),
        page=page,
        page_size=page_size,
    )
