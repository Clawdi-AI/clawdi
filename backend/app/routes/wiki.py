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
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
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
    # When source_type ∈ {memory, session} AND a kind=source page exists for
    # this atom (mem-<id>/src-<id>), these surface its slug + title so the UI
    # can render a clickable preview card instead of a bare UUID.
    source_page_slug: str | None = None
    source_page_title: str | None = None


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


class WikiStatus(BaseModel):
    """Health/progress snapshot for the dashboard 'syncing' indicator.

    Numbers are user-scoped so each tenant sees their own state.
    `is_active` is a heuristic — true if any extraction or synthesis
    log entry landed within the last 60s — used to drive the spinner.
    """

    pages_total: int
    pages_synthesized: int
    pages_by_kind: dict[str, int]
    sessions_total: int
    sessions_extracted: int
    memories_total: int
    last_extraction_at: datetime | None
    last_synthesis_at: datetime | None
    is_active: bool


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/pages", response_model=PageList)
async def list_pages(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
    kind: Literal[
        "entity", "concept", "synthesis", "source", "overview", "comparison", "query"
    ]
    | None = Query(default=None),
    stale: bool | None = Query(
        default=None, description="Filter by stale flag. Omit to include both."
    ),
    q: str | None = Query(
        default=None,
        description="Full-text search over title + slug + compiled_truth. "
        "When set, results are ordered by relevance (overrides sort).",
    ),
    sort: Literal["updated_at", "title", "source_count"] = Query(default="updated_at"),
    order: Literal["asc", "desc"] = Query(default="desc"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
) -> PageList:
    """List wiki pages for the current user, paginated.

    Default ordering shows most-recently-updated first, matching dashboard
    expectations for an "activity" view. When `q` is provided, results are
    ranked by simple ILIKE relevance (title hits weighted higher than
    compiled_truth hits).
    """
    base_filters = [WikiPage.user_id == auth.user_id]
    if kind is not None:
        base_filters.append(WikiPage.kind == kind)
    if stale is not None:
        base_filters.append(WikiPage.stale == stale)

    if q:
        # Tokenized ranked search: split q into words and OR-match each word
        # against title / slug / compiled_truth. Sum the per-word scores so
        # pages that match more query words rank higher. Title hits weighted
        # 1.0, slug 0.7, body 0.3 (entity-name lookup is the dominant agent
        # query pattern). ts_rank over a generated tsvector would be cleaner
        # but requires a migration; this works against existing pages
        # immediately and handles "Twilio account SID" correctly.
        import re as _re

        from sqlalchemy import case, or_

        # Tokenize: drop common stopwords + tokens shorter than 3 chars so
        # noise like "the / what / is / a" doesnt match every page.
        stopwords = {
            "the",
            "a",
            "an",
            "what",
            "whats",
            "is",
            "are",
            "of",
            "for",
            "in",
            "on",
            "to",
            "do",
            "i",
            "my",
            "you",
            "your",
            "and",
            "or",
            "how",
            "why",
            "where",
            "when",
            "who",
            "does",
            "did",
            "be",
            "this",
            "that",
            "with",
            "by",
            "from",
            "use",
            "uses",
            "using",
        }
        tokens = [
            t.lower()
            for t in _re.findall(r"[a-zA-Z][a-zA-Z0-9-]{2,}", q)
            if t.lower() not in stopwords
        ]
        if not tokens:
            tokens = [q.strip()]  # fallback: whole string match

        title_terms = []
        slug_terms = []
        body_terms = []
        match_terms = []
        for tok in tokens:
            pat = f"%{tok}%"
            title_terms.append(case((WikiPage.title.ilike(pat), 1.0), else_=0.0))
            slug_terms.append(case((WikiPage.slug.ilike(pat), 0.7), else_=0.0))
            body_terms.append(case((WikiPage.compiled_truth.ilike(pat), 0.3), else_=0.0))
            match_terms.append(WikiPage.title.ilike(pat))
            match_terms.append(WikiPage.slug.ilike(pat))
            match_terms.append(WikiPage.compiled_truth.ilike(pat))

        # Sum across tokens — pages that match more of the query rank higher.
        # Then bias toward pages with more source links: a personal-wiki entity
        # mentioned in 30 sessions ("Rico") should outrank a one-shot mention
        # ("linkedin-reply-bot") even when both match the query token "bot".
        # log(source_count+1) keeps the boost sublinear so a single very-popular
        # page can't dominate every search.
        from sqlalchemy import cast as sql_cast
        from sqlalchemy.types import Float

        ln = func.ln(sql_cast(WikiPage.source_count, Float) + 1.0)
        relevance = (
            sum(title_terms) + sum(slug_terms) + sum(body_terms) + 0.5 * ln
        ).label("relevance")
        base_filters.append(or_(*match_terms))

        total = (await db.scalar(select(func.count(WikiPage.id)).where(*base_filters))) or 0
        rows = (
            (
                await db.execute(
                    select(WikiPage)
                    .where(*base_filters)
                    .order_by(relevance.desc(), WikiPage.source_count.desc())
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
                    created_at=p.created_at,
                    updated_at=p.updated_at,
                )
                for p in rows
            ],
            total=total,
            page=page,
            page_size=page_size,
        )

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

    # Resolve source-page (kind=source) refs in one batch so the detail UI
    # can render a clickable preview per source link instead of a raw UUID.
    # Slug convention: memory atoms -> mem-<id-prefix>, sessions -> src-<id-prefix>.
    src_slugs: set[str] = set()
    for link, _to_slug, _to_title in outgoing_rows:
        if link.source_type == "memory" and link.source_ref:
            src_slugs.add(f"mem-{link.source_ref[:8]}")
        elif link.source_type == "session" and link.source_ref:
            src_slugs.add(f"src-{link.source_ref[:8]}")

    src_page_lookup: dict[str, tuple[str, str]] = {}
    if src_slugs:
        for s, t in (
            await db.execute(
                select(WikiPage.slug, WikiPage.title).where(
                    WikiPage.user_id == auth.user_id,
                    WikiPage.kind == "source",
                    WikiPage.slug.in_(src_slugs),
                )
            )
        ).all():
            src_page_lookup[s] = (s, t)

    def _src_page_for(link: WikiLink) -> tuple[str | None, str | None]:
        if not link.source_ref:
            return None, None
        if link.source_type == "memory":
            entry = src_page_lookup.get(f"mem-{link.source_ref[:8]}")
        elif link.source_type == "session":
            entry = src_page_lookup.get(f"src-{link.source_ref[:8]}")
        else:
            entry = None
        return (entry[0], entry[1]) if entry else (None, None)

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
            source_page_slug=_src_page_for(link)[0],
            source_page_title=_src_page_for(link)[1],
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
        # Prefer LLM-driven extraction when configured. The heuristic
        # extractor produces too many noise pages (common-word slugs)
        # and is kept only for environments without an LLM.
        from app.core.config import settings as _settings

        if _settings.llm_api_key:
            from app.services.wiki_llm_extraction import llm_extract_for_user

            out.extraction = await llm_extract_for_user(db, auth.user_id)
        else:
            out.extraction = await extract_for_user(db, auth.user_id)
    if body.synthesize:
        out.synthesis = await synthesize_for_user(db, auth.user_id, force=body.force_synthesis)
    return out


class QueryRequest(BaseModel):
    """Ask a question to the wiki — 4-phase retrieval + LLM answer with citations."""

    q: str
    # Top-K wiki pages to retrieve as context. ~5 keeps cost predictable;
    # 20 lets a thorough question pull in more graph-related pages.
    top_k: int = 8
    # Whether to follow page-to-page co-occurrence edges from the seed
    # set to find related pages (graph expansion phase).
    expand_graph: bool = True


class QueryCitation(BaseModel):
    n: int  # 1-based number used in the answer text
    slug: str
    title: str
    snippet: str | None  # ~280 chars of compiled_truth


class QueryResponse(BaseModel):
    answer: str
    citations: list[QueryCitation]
    pages_considered: int
    mode: str  # "llm" | "no_llm" | "no_match"


@router.post("/query", response_model=QueryResponse)
async def query_wiki(
    body: QueryRequest,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> QueryResponse:
    """4-phase retrieval + LLM-answered query against the user's wiki.

    Phase 1 — tokenized FTS over title/slug/compiled_truth (same logic as
    GET /api/wiki/pages?q=...).
    Phase 2 — graph expansion: follow page→page co-occurrence edges from
    the top seeds to surface related pages even if the keyword didn't hit
    them directly.
    Phase 3 — budget control: cap to top_k pages by combined relevance.
    Phase 4 — context assembly: number pages 1..N, send them to the LLM
    with a system prompt that instructs cite-by-number in the answer.
    """
    # ---------- Phase 1: tokenized FTS ----------
    import re as _re

    from sqlalchemy import case as sql_case
    from sqlalchemy import or_

    stopwords = {
        "the",
        "a",
        "an",
        "what",
        "whats",
        "is",
        "are",
        "of",
        "for",
        "in",
        "on",
        "to",
        "do",
        "i",
        "my",
        "you",
        "your",
        "and",
        "or",
        "how",
        "why",
        "where",
        "when",
        "who",
        "does",
        "did",
        "be",
        "this",
        "that",
        "with",
        "by",
        "from",
        "use",
        "uses",
        "using",
    }
    tokens = [
        t.lower()
        for t in _re.findall(r"[a-zA-Z][a-zA-Z0-9-]{2,}", body.q)
        if t.lower() not in stopwords
    ]
    if not tokens:
        tokens = [body.q.strip()]

    title_terms = []
    slug_terms = []
    body_terms = []
    match_terms = []
    for tok in tokens:
        pat = f"%{tok}%"
        title_terms.append(sql_case((WikiPage.title.ilike(pat), 1.0), else_=0.0))
        slug_terms.append(sql_case((WikiPage.slug.ilike(pat), 0.7), else_=0.0))
        body_terms.append(sql_case((WikiPage.compiled_truth.ilike(pat), 0.3), else_=0.0))
        match_terms.append(WikiPage.title.ilike(pat))
        match_terms.append(WikiPage.slug.ilike(pat))
        match_terms.append(WikiPage.compiled_truth.ilike(pat))

    relevance = (sum(title_terms) + sum(slug_terms) + sum(body_terms)).label("relevance")

    seed_rows = (
        (
            await db.execute(
                select(WikiPage)
                .where(WikiPage.user_id == auth.user_id, or_(*match_terms))
                .order_by(relevance.desc(), WikiPage.source_count.desc())
                .limit(body.top_k)
            )
        )
        .scalars()
        .all()
    )

    # ---------- Phase 1b: pgvector cosine over compiled_truth ----------
    # Catches semantic matches that tokenized FTS misses (paraphrases,
    # synonyms, abstract concepts). Pages with NULL embedding are skipped.
    try:
        from app.services.embedding import resolve_embedder

        embedder = resolve_embedder()
        if embedder is not None:
            q_vec = await embedder.embed(body.q)
            qvec_literal = "[" + ",".join(repr(float(v)) for v in q_vec) + "]"
            from sqlalchemy import text as sa_text

            vec_rows = (
                await db.execute(
                    sa_text("""
                        SELECT id FROM wiki_pages
                        WHERE user_id = :uid
                          AND compiled_truth_embedding IS NOT NULL
                          AND (compiled_truth_embedding <=> CAST(:qvec AS vector)) < 0.65
                        ORDER BY compiled_truth_embedding <=> CAST(:qvec AS vector)
                        LIMIT :lim
                    """),
                    {"uid": auth.user_id, "qvec": qvec_literal, "lim": body.top_k},
                )
            ).all()
            vec_ids = {r[0] for r in vec_rows}
            if vec_ids:
                missing = [pid for pid in vec_ids if not any(p.id == pid for p in seed_rows)]
                if missing:
                    extra = (
                        (await db.execute(select(WikiPage).where(WikiPage.id.in_(missing))))
                        .scalars()
                        .all()
                    )
                    seed_rows = list(seed_rows) + list(extra)
    except Exception as e:
        log.warning("vector-rank in /query failed (FTS-only fallback): %s", e)

    # ---------- Phase 2: graph expansion ----------
    pages_by_id: dict[uuid.UUID, WikiPage] = {p.id: p for p in seed_rows}
    if body.expand_graph and seed_rows:
        seed_ids = [p.id for p in seed_rows]
        # Follow co-occurs edges out from seeds; bring in up to 2x more pages.
        neighbor_ids = (
            (
                await db.execute(
                    select(WikiLink.to_page_id)
                    .where(
                        WikiLink.user_id == auth.user_id,
                        WikiLink.from_page_id.in_(seed_ids),
                        WikiLink.to_page_id.is_not(None),
                        WikiLink.link_type == "co-occurs",
                    )
                    .distinct()
                )
            )
            .scalars()
            .all()
        )
        # Cap expansion at body.top_k more pages, prioritizing high-source.
        if neighbor_ids:
            new_ids = [nid for nid in neighbor_ids if nid not in pages_by_id]
            if new_ids:
                neighbor_pages = (
                    (
                        await db.execute(
                            select(WikiPage)
                            .where(
                                WikiPage.user_id == auth.user_id,
                                WikiPage.id.in_(new_ids),
                            )
                            .order_by(WikiPage.source_count.desc())
                            .limit(body.top_k)
                        )
                    )
                    .scalars()
                    .all()
                )
                for p in neighbor_pages:
                    pages_by_id[p.id] = p

    if not pages_by_id:
        return QueryResponse(
            answer=(
                "No matching wiki pages for that query. Try different keywords, "
                "or run `/api/wiki/refresh` if you've recently added new memories."
            ),
            citations=[],
            pages_considered=0,
            mode="no_match",
        )

    # ---------- Phase 3: budget control + numbering ----------
    # Sort: pages that hit the keyword directly first, then graph-expanded.
    seed_id_set = {p.id for p in seed_rows}
    ordered_pages = sorted(
        pages_by_id.values(),
        key=lambda p: (
            0 if p.id in seed_id_set else 1,
            -(p.source_count or 0),
        ),
    )

    # ---------- Phase 4: context assembly + LLM call ----------
    from app.core.config import settings as _settings

    if not _settings.llm_api_key:
        # No LLM: return the citations alone, the agent can decide
        return QueryResponse(
            answer="LLM not configured; returning ranked pages without synthesis.",
            citations=[
                QueryCitation(
                    n=i + 1,
                    slug=p.slug,
                    title=p.title,
                    snippet=(p.compiled_truth or "")[:280] or None,
                )
                for i, p in enumerate(ordered_pages)
            ],
            pages_considered=len(ordered_pages),
            mode="no_llm",
        )

    from openai import AsyncOpenAI

    client = AsyncOpenAI(
        base_url=_settings.llm_base_url or None,
        api_key=_settings.llm_api_key,
    )

    # Pull a couple of source pages whose transcript matches the query —
    # these carry the verbatim values (IDs, URLs, ports, file paths) that
    # entity pages' compiled_truth paraphrases away. The user is asking
    # their own wiki with their own API key; verbatim transcript content
    # in the LLM context is fine. compiled_truth (which is what gets
    # synthesized + shared) still goes through the sanitizer pipeline.
    raw_source_pages: list[WikiPage] = []
    if body.q.strip():
        already = set(pages_by_id.keys())
        # `websearch_to_tsquery` parses natural-language queries — handles
        # stopwords, apostrophes, quoted phrases, and `-foo` exclusions. The
        # previous `to_tsquery` + manual `|` join silently failed on inputs
        # like "what's the SID" because Postgres won't tokenize stopwords
        # in to_tsquery and threw on apostrophes.
        try:
            # Per-token ILIKE OR — same shape as /api/wiki/pages search.
            # `websearch_to_tsquery` does AND-of-tokens which excludes the
            # right page whenever any one query word isn't in it (e.g.
            # "phone number voice agent answer" misses the Voice Call Twilio
            # Setup memory because it has 'voice' + 'phone' but no 'agent').
            # OR-of-tokens with summed score per match brings any page that
            # touches the topic into candidate set; ts_rank then orders.
            import re as _re
            from typing import Any as _Any

            from sqlalchemy import case as _case
            from sqlalchemy import or_ as _or

            stopwords = {
                "the",
                "a",
                "an",
                "what",
                "whats",
                "is",
                "are",
                "of",
                "for",
                "in",
                "on",
                "to",
                "do",
                "i",
                "my",
                "you",
                "your",
                "and",
                "or",
                "how",
                "why",
                "where",
                "when",
                "who",
                "does",
                "did",
                "be",
                "this",
                "that",
                "with",
                "by",
                "from",
                "use",
                "uses",
                "using",
                "at",
                "answer",
            }
            q_tokens = [
                t.lower()
                for t in _re.findall(r"[a-zA-Z][a-zA-Z0-9-]{2,}", body.q)
                if t.lower() not in stopwords
            ]
            if q_tokens:
                title_terms: list[_Any] = []
                slug_terms: list[_Any] = []
                body_terms: list[_Any] = []
                match_terms: list[_Any] = []
                for tok in q_tokens:
                    pat = f"%{tok}%"
                    # Source pages: title is most discriminative for mem-*
                    # (first line of memory content), so weight it heaviest.
                    title_terms.append(_case((WikiPage.title.ilike(pat), 1.5), else_=0.0))
                    slug_terms.append(_case((WikiPage.slug.ilike(pat), 0.5), else_=0.0))
                    body_terms.append(_case((WikiPage.compiled_truth.ilike(pat), 0.4), else_=0.0))
                    match_terms.append(WikiPage.title.ilike(pat))
                    match_terms.append(WikiPage.slug.ilike(pat))
                    match_terms.append(WikiPage.compiled_truth.ilike(pat))
                relevance = (sum(title_terms) + sum(slug_terms) + sum(body_terms)).label(
                    "relevance"
                )
                rs = (
                    (
                        await db.execute(
                            select(WikiPage)
                            .where(
                                WikiPage.user_id == auth.user_id,
                                WikiPage.kind == "source",
                                _or(*match_terms),
                            )
                            .order_by(relevance.desc())
                            .limit(6)
                        )
                    )
                    .scalars()
                    .all()
                )
                raw_source_pages = [p for p in rs if p.id not in already]
        except Exception as e:
            log.warning("/query source-page lookup failed: %s", e)

    pages_block: list[str] = []
    citations: list[QueryCitation] = []
    n = 0
    for p in ordered_pages:
        n += 1
        title_line = f"[{n}] {p.title} ({p.slug})"
        body_text = (
            p.compiled_truth or "(no synthesized summary; entity exists with sources)"
        ).strip()
        pages_block.append(f"{title_line}\n{body_text}")
        citations.append(
            QueryCitation(
                n=n,
                slug=p.slug,
                title=p.title,
                snippet=(p.compiled_truth or "")[:280] or None,
            )
        )
    # Append source-page raw transcripts after entity pages so the LLM
    # treats them as "verbatim source material" — useful for exact-value
    # questions (SIDs, ports, URLs).
    for p in raw_source_pages:
        n += 1
        title_line = f"[{n}] {p.title} ({p.slug}) [raw transcript excerpt]"
        # Cap raw chunk size — these are session tails that can be 8k chars
        # each. 4k per source × 3 sources = 12k extra tokens, fits easily.
        body_text = (p.compiled_truth or "")[-4_000:]
        pages_block.append(f"{title_line}\n{body_text}")
        citations.append(
            QueryCitation(
                n=n,
                slug=p.slug,
                title=p.title,
                snippet=(p.compiled_truth or "")[:280] or None,
            )
        )

    system_prompt = (
        "You answer questions from a personal knowledge wiki. Each numbered "
        "page below is one entity in the user's life — a project, tool, "
        "service, person, or concept they work with. Pages tagged "
        "[raw transcript excerpt] contain verbatim source text from a session "
        "or memory atom; pages without that tag are synthesized summaries.\n\n"
        "Answer style:\n"
        "- Be helpful and synthesize across multiple pages. The wiki captures "
        "what the user knows; it's fine to draw reasonable inferences from "
        "the pages even when they don't state the answer literally.\n"
        "- Cite pages by their number in [n] form when you state a specific "
        "fact, e.g. 'Twilio is the voice provider [1].'\n"
        "- **If the question asks for a specific value** — port, ID, URL, "
        "key, phone number, file path, exact name, hash, account ID — search "
        "the [raw transcript excerpt] pages first and quote the value verbatim "
        "from there. The user is asking their own wiki; do not say "
        "'check elsewhere' if the value is in the cited pages. If the raw "
        "excerpt contains the literal answer, return it.\n"
        "- For broad questions like 'what is X' or 'how do I debug Y', "
        "summarize what the user's wiki says about that topic across the "
        "relevant pages, even if no single page is a complete answer.\n"
        "- If the pages genuinely contain nothing related, say so directly "
        "and suggest the user try Deep Research (web-augmented) for that "
        "question — they can switch to that view from the sidebar."
    )
    user_prompt = f"Question: {body.q}\n\nPages ({len(ordered_pages)}):\n\n" + "\n\n---\n\n".join(
        pages_block
    )

    try:
        response = await client.chat.completions.create(
            model=_settings.llm_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            max_tokens=600,
            temperature=0.2,
        )
        answer = (response.choices[0].message.content or "").strip()
    except Exception as e:
        log.warning("wiki_query LLM failed: %s", e)
        answer = f"LLM error: {str(e)[:200]}. Cited pages still attached below."

    return QueryResponse(
        answer=answer or "(empty)",
        citations=citations,
        pages_considered=len(ordered_pages),
        mode="llm",
    )


class DeepResearchRequest(BaseModel):
    q: str
    save: bool = False  # auto-save the research result as a wiki page


class DeepResearchResponse(BaseModel):
    answer: str
    citations: list[dict]  # web sources cited inline
    saved_slug: str | None
    mode: str  # "web_search" | "llm_only" | "no_llm"


@router.post("/research", response_model=DeepResearchResponse)
async def deep_research(
    body: DeepResearchRequest,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> DeepResearchResponse:
    """Web-augmented research over a question, optionally saved to the wiki.

    Tries the OpenAI Responses API with the `web_search_preview` tool
    first. If that fails (older model / wrong endpoint / 4xx), falls
    back to a normal chat completion using the LLM's own knowledge —
    clearly marking the response as `mode: "llm_only"` so the user knows
    it's not actually web-augmented.

    With body.save=true, the result is upserted into the wiki as a
    `synthesis` page so it lives alongside the rest of the user's
    knowledge graph. Title comes from a slug derived from the question.
    """
    from app.core.config import settings as _settings

    if not _settings.llm_api_key:
        return DeepResearchResponse(
            answer="LLM not configured on this deployment.",
            citations=[],
            saved_slug=None,
            mode="no_llm",
        )

    from openai import AsyncOpenAI

    client = AsyncOpenAI(
        base_url=_settings.llm_base_url or None,
        api_key=_settings.llm_api_key,
    )

    answer = ""
    citations: list[dict] = []
    mode = "llm_only"

    # Path 1: try OpenAI Responses API with web_search_preview tool.
    try:
        response = await client.responses.create(
            model=_settings.llm_model,
            input=body.q,
            tools=[{"type": "web_search_preview"}],
        )
        # responses.output is a list; collect text + URL citations.
        for item in response.output or []:
            if getattr(item, "type", None) == "message":
                for content in getattr(item, "content", []) or []:
                    if getattr(content, "type", None) == "output_text":
                        answer += getattr(content, "text", "")
                        for ann in getattr(content, "annotations", []) or []:
                            if getattr(ann, "type", None) == "url_citation":
                                citations.append(
                                    {
                                        "url": getattr(ann, "url", ""),
                                        "title": getattr(ann, "title", ""),
                                        "start_index": getattr(ann, "start_index", 0),
                                        "end_index": getattr(ann, "end_index", 0),
                                    }
                                )
        mode = "web_search"
    except Exception as e:
        log.warning("deep research web_search_preview failed, falling back to chat: %s", e)
        # Path 2: plain chat completion fallback.
        try:
            chat_resp = await client.chat.completions.create(
                model=_settings.llm_model,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You are a research assistant. Answer the user's question "
                            "thoroughly using your training knowledge. State clearly when "
                            "you don't have current information about a topic."
                        ),
                    },
                    {"role": "user", "content": body.q},
                ],
                max_tokens=1000,
                temperature=0.3,
            )
            answer = (chat_resp.choices[0].message.content or "").strip()
            mode = "llm_only"
        except Exception as e2:
            answer = f"Research failed: {str(e2)[:200]}"
            mode = "llm_only"

    if not answer:
        answer = "(no response)"

    saved_slug = None
    if body.save and answer and answer != "(no response)":
        # Build a synthesis page. Title from question, body = answer + sources.
        from app.services.slug_resolver import SlugResolver

        resolver = SlugResolver(db, auth.user_id)
        title = body.q if len(body.q) <= 80 else f"{body.q[:77]}..."
        sources_block = ""
        if citations:
            sources_block = "\n\n## Web sources\n" + "\n".join(
                f"- [{c.get('title') or c.get('url')}]({c.get('url')})" for c in citations
            )
        body_md = f"**Q:** {body.q}\n\n{answer}{sources_block}"

        try:
            slug, exists = await resolver.resolve(title)
            page = None
            if exists:
                page = await db.scalar(
                    select(WikiPage).where(WikiPage.user_id == auth.user_id, WikiPage.slug == slug)
                )
            if page is None:
                page = WikiPage(
                    user_id=auth.user_id,
                    slug=slug,
                    title=title,
                    kind="synthesis",
                    compiled_truth=body_md,
                    frontmatter={"source": "deep_research", "mode": mode},
                    last_synthesis_at=datetime.now(),
                )
                db.add(page)
            else:
                page.compiled_truth = body_md
                page.last_synthesis_at = datetime.now()
                page.frontmatter = {
                    **(page.frontmatter or {}),
                    "source": "deep_research",
                    "mode": mode,
                }
            db.add(
                WikiLogEntry(
                    user_id=auth.user_id,
                    page_id=page.id,
                    action="deep_research_saved",
                    source_type="manual",
                    source_ref=None,
                    metadata_={"mode": mode, "citations": len(citations)},
                    ts=datetime.now(),
                )
            )
            await db.commit()
            saved_slug = slug
        except Exception as e:
            log.warning("deep research save failed: %s", e)

    return DeepResearchResponse(
        answer=answer,
        citations=citations,
        saved_slug=saved_slug,
        mode=mode,
    )


class SavePageRequest(BaseModel):
    """Manually save / upsert a wiki page from arbitrary text.

    Used by the dashboard's "save to wiki" buttons (chat answers,
    research notes, manual entity creation). The body is treated as
    canonical compiled_truth — no further synthesis runs.
    """

    title: str
    content: str
    slug: str | None = None  # auto-derived from title if absent
    kind: Literal[
        "entity", "concept", "synthesis", "source", "overview", "comparison", "query"
    ] = "synthesis"


class SavePageResponse(BaseModel):
    slug: str
    title: str
    kind: str
    created: bool  # True if newly created, False if updated existing


@router.post("/save", response_model=SavePageResponse)
async def save_page(
    body: SavePageRequest,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> SavePageResponse:
    """Upsert a wiki page from manual text (chat answer, research note, etc.).

    Mirrors llm_wiki's "Save to Wiki" pattern. The synthesizer's vault
    sanitizer is NOT run here — the caller is responsible for not pasting
    secrets. (We can add a sanitize step later if needed.)
    """
    from app.services.slug_resolver import SlugResolver

    resolver = SlugResolver(db, auth.user_id)
    candidate = body.slug or body.title
    try:
        slug, exists = await resolver.resolve(candidate)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="title or slug is empty after normalization",
        ) from None

    page = None
    if exists:
        page = await db.scalar(
            select(WikiPage).where(WikiPage.user_id == auth.user_id, WikiPage.slug == slug)
        )

    created = page is None
    if page is None:
        page = WikiPage(
            user_id=auth.user_id,
            slug=slug,
            title=body.title,
            kind=body.kind,
            compiled_truth=body.content,
            frontmatter={"source": "manual_save"},
            last_synthesis_at=datetime.now(),
        )
        db.add(page)
    else:
        page.title = body.title
        page.compiled_truth = body.content
        page.kind = body.kind
        page.last_synthesis_at = datetime.now()
        page.frontmatter = {**(page.frontmatter or {}), "source": "manual_save"}

    db.add(
        WikiLogEntry(
            user_id=auth.user_id,
            page_id=page.id,
            action="manually_saved",
            source_type="manual",
            source_ref=None,
            metadata_={"chars": len(body.content)},
            ts=datetime.now(),
        )
    )
    await db.commit()
    return SavePageResponse(slug=slug, title=page.title, kind=page.kind, created=created)


class ReviewItem(BaseModel):
    page_id: uuid.UUID
    slug: str
    title: str
    reason: str  # "vault_leak" | "low_confidence" | "stale" | "no_synthesis"
    detail: str | None
    detected_at: datetime


class ReviewQueue(BaseModel):
    items: list[ReviewItem]
    total: int


@router.get("/review", response_model=ReviewQueue)
async def list_review(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
    page_size: int = Query(default=50, ge=1, le=200),
) -> ReviewQueue:
    """Pages flagged for human review.

    Three signals get a page on the queue:
      - `vault_leak`: synthesis was aborted because the LLM output contained
        a vault value (caught by SecretScanner). The page sits at its prior
        compiled_truth (or NULL if it never synthesized).
      - `stale`: the user or a maintenance job marked it stale.
      - `low_confidence`: every incoming wiki_link to the page has
        confidence < 0.6 — the extractor wasn't sure these are even
        about the same entity.

    Items are ordered most-recent-detection first. UI surfaces a "resolve"
    button that calls POST /api/wiki/review/{slug}/resolve.
    """
    items: list[ReviewItem] = []

    # 1. Vault leaks: walk wiki_log for synthesis_aborted_vault_leak entries.
    leak_rows = (
        await db.execute(
            select(WikiLogEntry, WikiPage.slug, WikiPage.title)
            .join(WikiPage, WikiPage.id == WikiLogEntry.page_id)
            .where(
                WikiLogEntry.user_id == auth.user_id,
                WikiLogEntry.action == "synthesis_aborted_vault_leak",
            )
            .order_by(WikiLogEntry.ts.desc())
            .limit(page_size)
        )
    ).all()
    for entry, slug, title in leak_rows:
        items.append(
            ReviewItem(
                page_id=entry.page_id or uuid.UUID(int=0),
                slug=slug,
                title=title,
                reason="vault_leak",
                detail=str((entry.metadata_ or {}).get("leak_count", "?")),
                detected_at=entry.ts,
            )
        )

    # 2. Stale pages.
    stale_rows = (
        (
            await db.execute(
                select(WikiPage)
                .where(WikiPage.user_id == auth.user_id, WikiPage.stale.is_(True))
                .order_by(WikiPage.updated_at.desc())
                .limit(page_size)
            )
        )
        .scalars()
        .all()
    )
    for p in stale_rows:
        items.append(
            ReviewItem(
                page_id=p.id,
                slug=p.slug,
                title=p.title,
                reason="stale",
                detail=None,
                detected_at=p.updated_at,
            )
        )

    # 3. Low-confidence: pages where every incoming source-link has
    # confidence < 0.6 AND has at least 1 link. Subset of single-mention
    # pages where even the LLM hedged.
    low_conf_pages = (
        await db.execute(
            select(WikiPage, func.max(WikiLink.confidence))
            .join(
                WikiLink,
                (WikiLink.from_page_id == WikiPage.id) & (WikiLink.source_type.is_not(None)),
            )
            .where(WikiPage.user_id == auth.user_id)
            .group_by(WikiPage.id)
            .having(func.max(WikiLink.confidence) < 0.6)
            .order_by(WikiPage.updated_at.desc())
            .limit(page_size)
        )
    ).all()
    for p, max_conf in low_conf_pages:
        items.append(
            ReviewItem(
                page_id=p.id,
                slug=p.slug,
                title=p.title,
                reason="low_confidence",
                detail=f"max link confidence: {max_conf:.2f}",
                detected_at=p.updated_at,
            )
        )

    # Sort by detected_at desc (mixed reasons interleave naturally).
    items.sort(key=lambda x: x.detected_at, reverse=True)
    return ReviewQueue(items=items[:page_size], total=len(items))


@router.post("/review/{slug}/resolve")
async def resolve_review(
    slug: str,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> dict:
    """Mark a flagged page as reviewed by the user.

    Effects:
      - clears the stale flag
      - logs a 'reviewed' action
    The vault_leak / low_confidence signals are derived from log entries
    and link confidence — clearing them entirely would require deleting
    log rows or re-extracting. The 'reviewed' log entry shadows them.
    """
    page = await db.scalar(
        select(WikiPage).where(WikiPage.user_id == auth.user_id, WikiPage.slug == slug)
    )
    if page is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Page not found")

    page.stale = False
    db.add(
        WikiLogEntry(
            user_id=auth.user_id,
            page_id=page.id,
            action="reviewed",
            source_type="manual",
            source_ref=None,
            metadata_={"resolved_by": "user"},
            ts=datetime.now(),
        )
    )
    await db.commit()
    return {"slug": slug, "stale": False}


class WikiContextResponse(BaseModel):
    purpose: str
    index: str
    overview: str


@router.get("/context", response_model=WikiContextResponse)
async def wiki_context(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> WikiContextResponse:
    """Generate purpose / index / overview context files on demand.

    Mirrors nashsu/llm_wiki's purpose.md / index.md / overview.md context
    files. We dont store these as wiki_pages — they're derived from the
    user's existing pages every time. Cached client-side.

    - purpose: who the user is, what they work on (top-3 entities by
      source_count + their compiled_truth gist)
    - index: the entity catalog grouped by kind
    - overview: most-recently-touched pages (activity snapshot)
    """
    rows = (
        (
            await db.execute(
                select(WikiPage)
                .where(WikiPage.user_id == auth.user_id)
                .order_by(WikiPage.source_count.desc(), WikiPage.updated_at.desc())
            )
        )
        .scalars()
        .all()
    )
    if not rows:
        return WikiContextResponse(
            purpose="(no wiki pages yet)",
            index="(empty)",
            overview="(empty)",
        )

    top3 = rows[:3]
    purpose = "# Purpose\n\nThe top entities in this wiki, by aggregated evidence:\n\n" + "\n".join(
        f"- **{p.title}** ({p.source_count} sources): "
        f"{(p.compiled_truth or '(not synthesized yet)').splitlines()[0][:200]}"
        for p in top3
    )

    by_kind: dict[str, list[WikiPage]] = {}
    for p in rows:
        by_kind.setdefault(p.kind or "entity", []).append(p)
    index_parts = ["# Index\n"]
    for kind, pages in sorted(by_kind.items()):
        index_parts.append(f"\n## {kind} ({len(pages)})\n")
        for p in pages[:50]:
            index_parts.append(f"- [{p.title}]({p.slug}) — {p.source_count} sources")
        if len(pages) > 50:
            index_parts.append(f"- … and {len(pages) - 50} more")
    index_md = "\n".join(index_parts)

    by_recent = sorted(rows, key=lambda p: p.updated_at, reverse=True)[:10]
    overview = "# Overview\n\nMost-recently-touched pages:\n\n" + "\n".join(
        f"- **{p.title}** ({p.kind}, updated {p.updated_at.date().isoformat()})" for p in by_recent
    )

    return WikiContextResponse(purpose=purpose, index=index_md, overview=overview)


class TypeLinksResponse(BaseModel):
    typed: int
    skipped: int
    failed: int


@router.post("/type-links", response_model=TypeLinksResponse)
async def type_links(
    sample_size: int = Query(default=200, ge=1, le=2000),
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> TypeLinksResponse:
    """Second-pass LLM call to type co-occurs edges.

    For each co-occurs edge between two pages, ask the LLM to choose a
    more-specific link_type from {uses, depends-on, defines, mentions,
    contradicts, supersedes, related} based on the two pages' titles +
    compiled_truth.

    Idempotent: only edges whose link_type is still "co-occurs" get
    typed; once an edge has a richer type it stays.
    """
    from app.core.config import settings as _settings

    if not _settings.llm_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="LLM not configured",
        )

    from openai import AsyncOpenAI

    client = AsyncOpenAI(
        base_url=_settings.llm_base_url or None,
        api_key=_settings.llm_api_key,
    )

    # Pull sample untyped edges. Page→page only (source_type IS NULL).
    edge_rows = (
        await db.execute(
            select(WikiLink, WikiPage)
            .join(WikiPage, WikiPage.id == WikiLink.from_page_id)
            .where(
                WikiLink.user_id == auth.user_id,
                WikiLink.link_type == "co-occurs",
                WikiLink.to_page_id.is_not(None),
            )
            .limit(sample_size)
        )
    ).all()

    typed_count = 0
    skipped = 0
    failed = 0

    # Cache target page lookups
    target_ids = list({e.to_page_id for e, _from in edge_rows if e.to_page_id})
    targets_rows = (
        (
            await db.execute(
                select(WikiPage).where(
                    WikiPage.user_id == auth.user_id, WikiPage.id.in_(target_ids)
                )
            )
        )
        .scalars()
        .all()
    )
    targets_by_id = {p.id: p for p in targets_rows}

    SYSTEM = (
        "You classify the relationship between two entities in a personal "
        "knowledge wiki. Given the two pages (title + compiled_truth gist), "
        "respond with ONE of these labels — nothing else:\n"
        "  uses           — page A uses or invokes page B\n"
        "  depends-on     — A requires B to function\n"
        "  defines        — A specifies / configures B\n"
        "  mentions       — generic loose connection\n"
        "  contradicts    — A states something opposite to B\n"
        "  supersedes     — A is a newer version replacing B\n"
        "  related        — strong topical connection but no specific role\n"
        "Default to 'related' when uncertain. Output: just the label, lowercase."
    )

    for edge, from_page in edge_rows:
        target = targets_by_id.get(edge.to_page_id)
        if not target:
            skipped += 1
            continue
        ft = (from_page.compiled_truth or from_page.title)[:600]
        tt = (target.compiled_truth or target.title)[:600]
        user_prompt = f"Page A: {from_page.title}\n{ft}\n\nPage B: {target.title}\n{tt}\n\nLabel:"
        try:
            resp = await client.chat.completions.create(
                model=_settings.llm_model,
                messages=[
                    {"role": "system", "content": SYSTEM},
                    {"role": "user", "content": user_prompt},
                ],
                max_tokens=8,
                temperature=0.0,
            )
            label = (resp.choices[0].message.content or "").strip().lower().split()[0]
            if label in {
                "uses",
                "depends-on",
                "defines",
                "mentions",
                "contradicts",
                "supersedes",
                "related",
            }:
                edge.link_type = label
                edge.confidence = 0.75
                typed_count += 1
            else:
                skipped += 1
        except Exception as e:
            failed += 1
            log.warning("type-links LLM failed: %s", e)

    await db.commit()
    return TypeLinksResponse(typed=typed_count, skipped=skipped, failed=failed)


class GenerateSourcePagesResponse(BaseModel):
    created: int
    skipped: int
    links_added: int = 0


@router.post("/source-pages", response_model=GenerateSourcePagesResponse)
async def generate_source_pages(
    limit: int = Query(default=200, ge=1, le=1000),
    refresh_titles: bool = Query(
        default=False,
        description="When true, re-derive title for existing source pages "
        "from the transcript (use after changing title heuristics).",
    ),
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> GenerateSourcePagesResponse:
    """Generate kind=source wiki pages for sessions.

    One wiki page per session, slug = "src-<session-id-prefix>".
    Title = the session's local id or a tail-truncated label.
    compiled_truth = the rendered transcript (tail-biased so conclusions
    survive truncation). The page carries a `defines` link back to the
    session atom for graph traversal.

    Idempotent: skips sessions that already have a kind=source page.
    """
    from app.models.session import Session as SessionModel
    from app.services.wiki_llm_extraction import _load_session_transcript

    rows = (
        (
            await db.execute(
                select(SessionModel)
                .where(
                    SessionModel.user_id == auth.user_id,
                    SessionModel.file_key.is_not(None),
                )
                .order_by(SessionModel.updated_at.desc().nullslast())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )

    created = 0
    skipped = 0
    links_added = 0
    for s in rows:
        slug = f"src-{str(s.id)[:8]}"
        existing = await db.scalar(
            select(WikiPage).where(WikiPage.user_id == auth.user_id, WikiPage.slug == slug)
        )
        if existing is None:
            transcript = await _load_session_transcript(s)
            if not transcript:
                continue
            # Use the session summary if Paco's distillation populated it;
            # otherwise pull the first user prompt out of the transcript so
            # FTS on title actually has signal (the previous fallback to
            # `local_session_id` produced titles like "claude_code" which
            # dilute every search).
            title: str | None = (s.summary or "").strip().split("\n", 1)[0].strip()
            if not title:
                for line in transcript.splitlines():
                    if line.startswith("[user]"):
                        candidate = line[len("[user]") :].strip()
                        # Strip wrapping JSON/markup that the agent harness
                        # sometimes emits (e.g. `<ide_opened_file>...</...>`).
                        candidate = candidate.split("\n", 1)[0].strip()
                        if candidate and len(candidate) > 10:
                            title = candidate
                            break
            if not title:
                title = s.local_session_id or f"Session {str(s.id)[:8]}"
            title = title[:80]
            # Tail-bias: keep the latest 8K chars — that's where decisions land.
            body = transcript[-8_000:] if len(transcript) > 8_000 else transcript
            page = WikiPage(
                user_id=auth.user_id,
                slug=slug,
                title=title,
                kind="source",
                compiled_truth=body,
                frontmatter={
                    "source_type": "session",
                    "source_ref": str(s.id),
                    "local_session_id": s.local_session_id,
                    "agent": getattr(s, "agent", None),
                    "project_path": getattr(s, "project_path", None),
                },
                last_synthesis_at=datetime.now(),
                source_count=1,
            )
            db.add(page)
            await db.flush()
            created += 1
        else:
            page = existing
            skipped += 1
            if refresh_titles:
                transcript = await _load_session_transcript(s)
                if transcript:
                    new_title: str | None = (s.summary or "").strip().split("\n", 1)[0].strip()
                    if not new_title:
                        for line in transcript.splitlines():
                            if line.startswith("[user]"):
                                cand = line[len("[user]") :].strip().split("\n", 1)[0].strip()
                                if cand and len(cand) > 10:
                                    new_title = cand
                                    break
                    if new_title:
                        page.title = new_title[:80]

        # Ensure a WikiLink (source-page -> session atom) exists.
        link_exists = await db.scalar(
            select(func.count(WikiLink.id)).where(
                WikiLink.user_id == auth.user_id,
                WikiLink.from_page_id == page.id,
                WikiLink.source_type == "session",
                WikiLink.source_ref == str(s.id),
            )
        )
        if not link_exists:
            db.add(
                WikiLink(
                    user_id=auth.user_id,
                    from_page_id=page.id,
                    to_page_id=None,
                    source_type="session",
                    source_ref=str(s.id),
                    link_type="defines",
                    confidence=1.0,
                    created_at=datetime.now(),
                )
            )
            links_added += 1

    # Memory source pages — slug `mem-<id-prefix>` so they don't collide with
    # session source pages. Hand-written memory files (Marvin-curated notes
    # like "Voice Call Twilio Setup") are critical signal that doesn't appear
    # in any session transcript; without these the wiki misses curated facts
    # entirely after the session-only extraction shift. Also indexes
    # session-extracted memories so /api/wiki/query has a second path to the
    # same content.
    from app.models.memory import Memory

    mem_rows = (
        (
            await db.execute(
                select(Memory)
                .where(Memory.user_id == auth.user_id)
                .order_by(Memory.created_at.desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    for mem in mem_rows:
        m_slug = f"mem-{str(mem.id)[:8]}"
        existing_m = await db.scalar(
            select(WikiPage).where(WikiPage.user_id == auth.user_id, WikiPage.slug == m_slug)
        )
        if existing_m is None:
            content = mem.content or ""
            first_line = content.split("\n", 1)[0].strip().lstrip("# ").strip()
            m_title = (first_line or f"Memory {str(mem.id)[:8]}")[:80]
            page_m = WikiPage(
                user_id=auth.user_id,
                slug=m_slug,
                title=m_title,
                kind="source",
                compiled_truth=content,
                frontmatter={
                    "source_type": "memory",
                    "source_ref": str(mem.id),
                    "category": mem.category,
                    "tags": mem.tags or [],
                },
                last_synthesis_at=datetime.now(),
                source_count=1,
            )
            db.add(page_m)
            await db.flush()
            created += 1
        else:
            page_m = existing_m
            skipped += 1

        link_exists = await db.scalar(
            select(func.count(WikiLink.id)).where(
                WikiLink.user_id == auth.user_id,
                WikiLink.from_page_id == page_m.id,
                WikiLink.source_type == "memory",
                WikiLink.source_ref == str(mem.id),
            )
        )
        if not link_exists:
            db.add(
                WikiLink(
                    user_id=auth.user_id,
                    from_page_id=page_m.id,
                    to_page_id=None,
                    source_type="memory",
                    source_ref=str(mem.id),
                    link_type="defines",
                    confidence=1.0,
                    created_at=datetime.now(),
                )
            )
            links_added += 1

    await db.commit()
    return GenerateSourcePagesResponse(
        created=created, skipped=skipped, links_added=links_added
    )


@router.post("/reclassify-kinds")
async def reclassify_kinds(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> dict:
    """One-shot backfill: promote pages from `entity` to `concept` based on
    `frontmatter.type` set by the LLM extractor.

    Mirrors nashsu/llm_wiki's `type` field — categories show up grouped in
    the knowledge tree. Pages whose stored `frontmatter.type == "concept"`
    are promoted; everything else stays. Idempotent — safe to re-run.

    We never demote (concept -> entity) here because the LLM may revisit
    the same slug across atoms with different opinions; the highest-fidelity
    classification (concept) wins.
    """
    rows = (
        (
            await db.execute(
                select(WikiPage).where(
                    WikiPage.user_id == auth.user_id,
                    WikiPage.kind == "entity",
                    WikiPage.frontmatter.is_not(None),
                )
            )
        )
        .scalars()
        .all()
    )
    promoted = 0
    for page in rows:
        fm_type = (page.frontmatter or {}).get("type")
        if isinstance(fm_type, str) and fm_type.lower() == "concept":
            page.kind = "concept"
            promoted += 1
    await db.commit()
    return {"considered": len(rows), "promoted_to_concept": promoted}


@router.post("/embed-backfill")
async def embed_backfill_wiki(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> dict:
    """One-shot: compute compiled_truth_embedding for every synthesized page.

    Pages synthesized BEFORE the e8f5b3c9a2d1 migration have
    compiled_truth filled but compiled_truth_embedding NULL. This endpoint
    backfills them so the vector-rank phase of /query has data to score
    against. Idempotent: skips pages that already have an embedding.
    """
    from app.services.embedding import resolve_embedder

    embedder = resolve_embedder()
    if embedder is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="No embedding provider configured",
        )

    rows = (
        (
            await db.execute(
                select(WikiPage).where(
                    WikiPage.user_id == auth.user_id,
                    WikiPage.compiled_truth.is_not(None),
                    WikiPage.compiled_truth_embedding.is_(None),
                )
            )
        )
        .scalars()
        .all()
    )

    processed = 0
    failed = 0
    for page in rows:
        try:
            page.compiled_truth_embedding = await embedder.embed(page.compiled_truth or "")
            processed += 1
            if processed % 25 == 0:
                await db.commit()
        except Exception as e:
            failed += 1
            log.warning("embed-backfill failed for %s: %s", page.slug, e)
    await db.commit()
    return {"considered": len(rows), "processed": processed, "failed": failed}


@router.post("/recompute-graph")
async def recompute_graph(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> dict:
    """Build page-to-page co-occurs edges from existing source links.

    Two entity pages that both link to the same source atom (memory /
    skill / session / vault) get a co-occurs edge. Bidirectional.

    Idempotent: skips edges that already exist. Used to retro-fill the
    graph after deploying the page-to-page edge logic, which only writes
    edges for NEW atoms processed via the LLM extractor.
    """
    from sqlalchemy import text

    sql = text("""
        WITH pages_per_atom AS (
            SELECT source_type, source_ref, array_agg(DISTINCT from_page_id) AS page_ids
            FROM wiki_links
            WHERE user_id = :uid AND source_type IS NOT NULL
            GROUP BY source_type, source_ref
            HAVING COUNT(DISTINCT from_page_id) >= 2
        ),
        candidate_edges AS (
            SELECT DISTINCT a.elem AS p1, b.elem AS p2
            FROM pages_per_atom,
                 LATERAL unnest(page_ids) WITH ORDINALITY AS a(elem, idx_a),
                 LATERAL unnest(page_ids) WITH ORDINALITY AS b(elem, idx_b)
            WHERE a.elem <> b.elem
        ),
        new_edges AS (
            SELECT ce.p1, ce.p2
            FROM candidate_edges ce
            WHERE NOT EXISTS (
                SELECT 1 FROM wiki_links wl
                WHERE wl.user_id = :uid
                  AND wl.from_page_id = ce.p1
                  AND wl.to_page_id = ce.p2
            )
        )
        INSERT INTO wiki_links (
            id, user_id, from_page_id, to_page_id, source_type, source_ref,
            link_type, confidence, created_at
        )
        SELECT gen_random_uuid(), :uid, p1, p2, NULL, NULL, 'co-occurs', 0.6, now()
        FROM new_edges
        RETURNING id
    """)
    res = await db.execute(sql, {"uid": auth.user_id})
    inserted = len(res.fetchall())
    await db.commit()

    total_pp = await db.scalar(
        select(func.count(WikiLink.id)).where(
            WikiLink.user_id == auth.user_id,
            WikiLink.to_page_id.is_not(None),
        )
    )
    return {"new_edges": inserted, "total_page_to_page_edges": total_pp or 0}


class GraphNode(BaseModel):
    id: str  # slug, used as the sigma node id
    title: str
    kind: str
    source_count: int


class GraphEdge(BaseModel):
    source: str
    target: str
    link_type: str
    weight: float


class GraphResponse(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]


@router.get("/status", response_model=WikiStatus)
async def wiki_status(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> WikiStatus:
    """Live progress snapshot — drives the dashboard 'syncing' banner.

    Six lightweight queries; ~5ms total. Frontend polls every ~5s while
    the user is on a wiki tab. `is_active` is true when an extraction
    or synthesis log entry landed in the last 60s, so the banner shows
    only during a real sync window.
    """
    from datetime import timedelta

    from app.models.memory import Memory
    from app.models.session import Session as SessionModel

    pages_total = (
        await db.scalar(
            select(func.count(WikiPage.id)).where(WikiPage.user_id == auth.user_id)
        )
    ) or 0
    pages_synthesized = (
        await db.scalar(
            select(func.count(WikiPage.id)).where(
                WikiPage.user_id == auth.user_id,
                WikiPage.last_synthesis_at.is_not(None),
            )
        )
    ) or 0

    by_kind_rows = (
        await db.execute(
            select(WikiPage.kind, func.count(WikiPage.id))
            .where(WikiPage.user_id == auth.user_id)
            .group_by(WikiPage.kind)
        )
    ).all()
    by_kind = {k: int(c) for k, c in by_kind_rows}

    sessions_total = (
        await db.scalar(
            select(func.count(SessionModel.id)).where(
                SessionModel.user_id == auth.user_id, SessionModel.file_key.is_not(None)
            )
        )
    ) or 0
    sessions_extracted = (
        await db.scalar(
            select(func.count(func.distinct(WikiLogEntry.source_ref))).where(
                WikiLogEntry.user_id == auth.user_id,
                WikiLogEntry.action == "extracted_from_session",
            )
        )
    ) or 0
    memories_total = (
        await db.scalar(
            select(func.count(Memory.id)).where(Memory.user_id == auth.user_id)
        )
    ) or 0

    last_extraction = await db.scalar(
        select(func.max(WikiLogEntry.ts)).where(
            WikiLogEntry.user_id == auth.user_id,
            WikiLogEntry.action.like("extracted_from_%"),
        )
    )
    last_synthesis = await db.scalar(
        select(func.max(WikiLogEntry.ts)).where(
            WikiLogEntry.user_id == auth.user_id,
            WikiLogEntry.action == "synthesized",
        )
    )

    now = datetime.now(UTC)
    is_active = False
    for ts in (last_extraction, last_synthesis):
        if ts is not None and now - ts < timedelta(seconds=60):
            is_active = True
            break

    return WikiStatus(
        pages_total=pages_total,
        pages_synthesized=pages_synthesized,
        pages_by_kind=by_kind,
        sessions_total=sessions_total,
        sessions_extracted=sessions_extracted,
        memories_total=memories_total,
        last_extraction_at=last_extraction,
        last_synthesis_at=last_synthesis,
        is_active=is_active,
    )


@router.get("/graph", response_model=GraphResponse)
async def get_graph(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
    limit: int = Query(default=200, ge=10, le=500),
    min_sources: int = Query(default=1, ge=0),
) -> GraphResponse:
    """Full knowledge graph in one payload — nodes + page-to-page edges.

    Returns the top `limit` pages by source_count (filtered to entity/synthesis
    kind) and every wiki_link between them where both endpoints are in the
    selected node set. Designed for the sigma.js / ForceAtlas2 frontend.

    Edge weight is derived from link_type + confidence so the renderer can
    size and color edges. Co-occurs edges are weaker; typed (uses, depends-on,
    defines, references) are stronger.
    """
    page_rows = (
        (
            await db.execute(
                select(WikiPage)
                .where(
                    WikiPage.user_id == auth.user_id,
                    WikiPage.kind.in_(["entity", "synthesis"]),
                    WikiPage.source_count >= min_sources,
                )
                .order_by(WikiPage.source_count.desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    if not page_rows:
        return GraphResponse(nodes=[], edges=[])

    page_id_to_slug: dict[uuid.UUID, str] = {p.id: p.slug for p in page_rows}
    nodes = [
        GraphNode(
            id=p.slug,
            title=p.title,
            kind=p.kind,
            source_count=p.source_count or 0,
        )
        for p in page_rows
    ]

    link_rows = (
        (
            await db.execute(
                select(WikiLink).where(
                    WikiLink.user_id == auth.user_id,
                    WikiLink.from_page_id.in_(page_id_to_slug.keys()),
                    WikiLink.to_page_id.in_(page_id_to_slug.keys()),
                )
            )
        )
        .scalars()
        .all()
    )

    weight_by_type = {
        "co-occurs": 0.4,
        "mentions": 0.5,
        "references": 0.7,
        "uses": 0.9,
        "depends-on": 1.0,
        "defines": 1.0,
        "related-to": 0.6,
    }
    edges: list[GraphEdge] = []
    seen: set[tuple[str, str]] = set()
    for link in link_rows:
        if link.to_page_id is None or link.from_page_id is None:
            continue
        src = page_id_to_slug.get(link.from_page_id)
        dst = page_id_to_slug.get(link.to_page_id)
        if not src or not dst or src == dst:
            continue
        # Sigma renders both directions as one undirected line; dedupe pairs.
        pair = (src, dst) if src < dst else (dst, src)
        if pair in seen:
            continue
        seen.add(pair)
        base = weight_by_type.get(link.link_type, 0.5)
        conf = link.confidence if link.confidence is not None else 0.6
        edges.append(
            GraphEdge(
                source=src,
                target=dst,
                link_type=link.link_type,
                weight=round(base * float(conf), 3),
            )
        )

    return GraphResponse(nodes=nodes, edges=edges)


async def _bootstrap_one_user(user_id: uuid.UUID) -> None:
    """BackgroundTask: extract + synthesize wiki for one user.

    Each user gets a fresh AsyncSession + its own try/except so a single
    failing user doesn't break the others. Logs progress so the admin can
    grep the API logs for "bootstrap user=" to follow along.
    """
    from app.core.database import async_session_factory
    from app.services.wiki_llm_extraction import llm_extract_for_user
    from app.services.wiki_synthesis import synthesize_for_user

    log.info("bootstrap user=%s — start", user_id)
    try:
        async with async_session_factory() as db:
            ext = await llm_extract_for_user(db, user_id)
            log.info("bootstrap user=%s — extraction: %s", user_id, ext)
            synth = await synthesize_for_user(db, user_id)
            log.info("bootstrap user=%s — synthesis: %s", user_id, synth)
    except Exception as e:  # noqa: BLE001 — best-effort per-user job
        log.warning("bootstrap user=%s — failed: %s", user_id, e)


@router.post("/admin/bootstrap-all-users")
async def bootstrap_all_users(
    background: BackgroundTasks,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> dict:
    """Queue extraction + synthesis BackgroundTasks for every user with data.

    Returns immediately with the list of queued user_ids. Each user runs
    in its own BackgroundTask, so the request handler doesn't hold the
    worker for tens of minutes (which previously OOM'd the container).

    Each per-user task:
      1. Opens a fresh AsyncSession.
      2. Runs llm_extract_for_user (sessions / skills / vault).
      3. Runs synthesize_for_user.
      4. Logs `bootstrap user=<id> — ...` lines so the admin can tail
         /var/log via Coolify to monitor.

    No admin gating today: any authenticated user can call this and
    trigger LLM work for everyone in the snapshot. Preview-only; gate
    with X-Admin-Token before enabling on prod.
    """
    from app.models.memory import Memory
    from app.models.session import Session as SessionModel

    log.info("admin/bootstrap-all-users invoked by user_id=%s", auth.user_id)

    user_ids_sessions = {
        u
        for u in (
            (
                await db.execute(
                    select(SessionModel.user_id).distinct().where(SessionModel.user_id.is_not(None))
                )
            )
            .scalars()
            .all()
        )
        if u is not None
    }
    user_ids_memories = {
        u
        for u in (
            (
                await db.execute(
                    select(Memory.user_id).distinct().where(Memory.user_id.is_not(None))
                )
            )
            .scalars()
            .all()
        )
        if u is not None
    }
    user_ids = sorted(user_ids_sessions | user_ids_memories, key=str)
    log.info("bootstrap: found %d active users to enqueue", len(user_ids))

    for uid in user_ids:
        background.add_task(_bootstrap_one_user, uid)

    return {
        "users_queued": len(user_ids),
        "user_ids": [str(u) for u in user_ids],
        "note": (
            "Tasks running in background. "
            "Poll GET /api/wiki/admin/bootstrap-status to track progress."
        ),
    }


@router.get("/admin/bootstrap-status")
async def bootstrap_status(
    auth: AuthContext = Depends(get_auth),  # noqa: ARG001 — auth required, value unused
    db: AsyncSession = Depends(get_session),
) -> dict:
    """Per-user wiki page counts across the deployment. Drives the admin
    progress view for `bootstrap-all-users`. Returns up to 50 users.
    """
    rows = (
        await db.execute(
            select(
                WikiPage.user_id,
                func.count(WikiPage.id).label("pages"),
                func.count(WikiPage.id)
                .filter(WikiPage.last_synthesis_at.is_not(None))
                .label("synthd"),
            )
            .group_by(WikiPage.user_id)
            .order_by(func.count(WikiPage.id).desc())
            .limit(50)
        )
    ).all()
    return {
        "users": [
            {"user_id": str(uid), "pages": int(p), "synthesized": int(s)}
            for uid, p, s in rows
        ]
    }


@router.post("/wipe")
async def wipe_wiki(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> dict:
    """Delete every wiki page, link, and log entry for this user.

    Used to clear out a heuristic-extractor's noise pages before re-running
    extraction with the LLM-driven path. CASCADE on the FKs takes care of
    links + log entries when wiki_pages rows are deleted.
    """
    from sqlalchemy import delete as sql_delete

    log_count = await db.scalar(
        select(func.count(WikiLogEntry.id)).where(WikiLogEntry.user_id == auth.user_id)
    )
    page_count = await db.scalar(
        select(func.count(WikiPage.id)).where(WikiPage.user_id == auth.user_id)
    )
    await db.execute(sql_delete(WikiLogEntry).where(WikiLogEntry.user_id == auth.user_id))
    await db.execute(sql_delete(WikiLink).where(WikiLink.user_id == auth.user_id))
    await db.execute(sql_delete(WikiPage).where(WikiPage.user_id == auth.user_id))
    await db.commit()
    return {"deleted_pages": page_count or 0, "deleted_log_entries": log_count or 0}


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
