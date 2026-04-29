"""Entity extraction → wiki page upsert.

Scans atoms (memories, skills, sessions, vault scopes) for proper-noun
entities and creates / links wiki pages. Heuristic-only for v1 — no LLM
call per atom. Catches the cases that matter (Polymarket, Stripe, Phala
Cloud, Twilio, ClawdBot, etc.) and stays cheap. LLM-driven extraction
can be layered on later for low-confidence cases.

Pipeline per call to extract_for_user:
  1. Find unprocessed atoms (memories not yet entered in wiki_log with
     action='extracted_from_memory').
  2. For each atom, run heuristic extractor → list of candidate names.
  3. For each candidate, SlugResolver.resolve → upsert page.
  4. Create wiki_link from page → source atom (mentions / uses link_type).
  5. Increment page.source_count.
  6. Log to wiki_log so we don't reprocess.

This service is intentionally idempotent: re-running over the same atoms
is a no-op because of the wiki_log dedup. The synthesis service runs
SEPARATELY and consumes pages with new evidence since last_synthesis_at.
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.memory import Memory
from app.models.skill import Skill
from app.models.wiki import WikiLink, WikiLogEntry, WikiPage
from app.services.slug_resolver import SlugResolver, normalize

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Heuristic entity extractor
# ---------------------------------------------------------------------------

# Multi-word capitalized phrases ("Phala Cloud", "Voice Call Twilio Setup",
# "Hermes + OpenClaw" — well, the + breaks the run, that's fine).
# We allow 1–4 words to capture both single-word brands ("Stripe") and
# realistic project names ("Phala Cloud", "Voice Call Twilio Setup").
_PROPER_NOUN_RE = re.compile(
    r"\b[A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+){0,3}\b"
)

# All-caps acronyms / shouted brand names (POSTHOG, METABASE, etc.).
# Min 3 chars to avoid noise like "OK", "ID".
_ACRONYM_RE = re.compile(r"\b[A-Z]{3,}\b")

# Camel-case compound names (ClawdBot, OpenClaw, RedPill).
_CAMEL_RE = re.compile(r"\b[A-Z][a-z]+[A-Z][a-zA-Z]+\b")

# Noise to strip — common English stopwords that appear capitalized at
# sentence starts. The proper-noun regex doesn't gate on sentence
# position so we'd otherwise get "The", "This", etc.
_STOPWORDS: frozenset[str] = frozenset(
    [
        # English sentence-start
        "The",
        "This",
        "That",
        "These",
        "Those",
        "It",
        "Its",
        "If",
        "When",
        "While",
        "Where",
        "What",
        "Who",
        "Why",
        "How",
        "After",
        "Before",
        "But",
        "And",
        "Or",
        "Then",
        "Here",
        "There",
        "Now",
        "Yes",
        "No",
        "OK",
        # Pronouns
        "I",
        "We",
        "You",
        "He",
        "She",
        "They",
        # Generic verbs that often start sentences in tech writing
        "Run",
        "Use",
        "Set",
        "Get",
        "Add",
        "Save",
        "Load",
        "Make",
        "See",
        "Note",
        "Call",
        "Check",
        "Test",
        "Build",
        "Try",
        "Find",
        "Update",
        "Fix",
        "Create",
        "Delete",
        "Remove",
        # Months / days
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
        "Mon",
        "Tue",
        "Wed",
        "Thu",
        "Fri",
        "Sat",
        "Sun",
        # Common doc patterns
        "TODO",
        "FIXME",
        "WARN",
        "INFO",
        "DEBUG",
        "ERROR",
        "DB",
        "API",
        "URL",
        "JSON",
        "YAML",
        "ENV",
        "CWD",
        "ID",
    ]
)

# Minimum candidate length (post-trim). Below this is too noisy.
MIN_CANDIDATE_LENGTH = 3


def extract_candidates(text: str) -> list[str]:
    """Return a list of candidate entity names from raw text.

    Pure function — no DB. Order is preserved (first-seen wins for dedup).
    Returned strings are display-cased (preserve original casing) but
    deduplicated case-insensitively. The caller normalizes to slugs.
    """
    if not text:
        return []

    seen_lower: set[str] = set()
    candidates: list[str] = []

    def add(raw: str) -> None:
        s = raw.strip()
        if len(s) < MIN_CANDIDATE_LENGTH:
            return
        if s in _STOPWORDS:
            return
        # Strip trailing/leading punctuation that often clings to
        # word-boundary captures: "ClawdBot.", "(Stripe)".
        s = s.strip(".,;:!?()[]{}\"'`")
        if not s:
            return
        key = s.lower()
        if key in seen_lower:
            return
        seen_lower.add(key)
        candidates.append(s)

    # Order matters: more-specific patterns first (camel and acronym
    # forms produce better single-token candidates than the multi-word
    # fallback). This biases towards the cleanest representation.
    for m in _CAMEL_RE.finditer(text):
        add(m.group(0))
    for m in _ACRONYM_RE.finditer(text):
        add(m.group(0))
    for m in _PROPER_NOUN_RE.finditer(text):
        add(m.group(0))
        # Also emit each individual capitalized token from the multi-word
        # match, so "Query Polymarket" yields BOTH the full phrase AND
        # "Polymarket" alone. The cleaner single-word form is usually
        # the right entity; the phrase remains as a more-specific alias.
        # The slug resolver's pg_trgm fuzzy match later collapses
        # near-equivalent slugs.
        for token in m.group(0).split():
            if len(token) >= MIN_CANDIDATE_LENGTH and token not in _STOPWORDS:
                add(token)

    return candidates


# ---------------------------------------------------------------------------
# DB pipeline
# ---------------------------------------------------------------------------


async def _already_processed(
    db: AsyncSession, user_id: uuid.UUID, source_type: str, source_ref: str
) -> bool:
    """Check wiki_log for a prior 'extracted_from_<type>' entry on this atom."""
    res = await db.scalar(
        select(func.count(WikiLogEntry.id)).where(
            WikiLogEntry.user_id == user_id,
            WikiLogEntry.action == f"extracted_from_{source_type}",
            WikiLogEntry.source_type == source_type,
            WikiLogEntry.source_ref == source_ref,
        )
    )
    return bool(res and res > 0)


async def _link_already_exists(
    db: AsyncSession,
    user_id: uuid.UUID,
    page_id: uuid.UUID,
    source_type: str,
    source_ref: str,
) -> bool:
    res = await db.scalar(
        select(func.count(WikiLink.id)).where(
            WikiLink.user_id == user_id,
            WikiLink.from_page_id == page_id,
            WikiLink.source_type == source_type,
            WikiLink.source_ref == source_ref,
        )
    )
    return bool(res and res > 0)


async def _process_atom(
    db: AsyncSession,
    user_id: uuid.UUID,
    resolver: SlugResolver,
    *,
    source_type: str,
    source_ref: str,
    text: str,
    title_for_new_page: str | None = None,
) -> dict:
    """Process one atom. Returns {pages_touched, links_added, candidates}."""
    candidates = extract_candidates(text)
    if not candidates:
        # Still log so we don't reprocess.
        db.add(
            WikiLogEntry(
                user_id=user_id,
                action=f"extracted_from_{source_type}",
                source_type=source_type,
                source_ref=source_ref,
                metadata_={"candidates": 0},
                ts=datetime.now(timezone.utc),
            )
        )
        return {"pages_touched": 0, "links_added": 0, "candidates": []}

    pages_touched = 0
    links_added = 0

    for candidate in candidates:
        try:
            slug, exists = await resolver.resolve(candidate)
        except ValueError:
            continue

        # Upsert the page.
        if exists:
            page = await db.scalar(
                select(WikiPage).where(
                    WikiPage.user_id == user_id, WikiPage.slug == slug
                )
            )
            if page is None:
                # Race: resolver said exists but page is gone. Treat as new.
                page = WikiPage(
                    user_id=user_id,
                    slug=slug,
                    title=candidate,
                    kind="entity",
                )
                db.add(page)
                await db.flush()
        else:
            page = WikiPage(
                user_id=user_id,
                slug=slug,
                title=title_for_new_page or candidate,
                kind="entity",
            )
            db.add(page)
            await db.flush()
            pages_touched += 1

        # De-dup: don't double-link the same atom to the same page.
        already = await _link_already_exists(
            db, user_id, page.id, source_type, source_ref
        )
        if already:
            continue

        db.add(
            WikiLink(
                user_id=user_id,
                from_page_id=page.id,
                to_page_id=None,
                source_type=source_type,
                source_ref=source_ref,
                link_type="mentions",
                confidence=0.6,  # heuristic-extraction default; LLM bumps later
                created_at=datetime.now(timezone.utc),
            )
        )
        links_added += 1
        # Bump source_count on the page.
        page.source_count = (page.source_count or 0) + 1

    db.add(
        WikiLogEntry(
            user_id=user_id,
            action=f"extracted_from_{source_type}",
            source_type=source_type,
            source_ref=source_ref,
            metadata_={
                "candidates": len(candidates),
                "links_added": links_added,
                "pages_touched": pages_touched,
            },
            ts=datetime.now(timezone.utc),
        )
    )

    return {
        "pages_touched": pages_touched,
        "links_added": links_added,
        "candidates": candidates,
    }


async def extract_from_memories(
    db: AsyncSession, user_id: uuid.UUID, limit: int = 200
) -> dict:
    """Run heuristic entity extraction over unprocessed memories."""
    resolver = SlugResolver(db, user_id)
    total = {"atoms": 0, "links_added": 0, "pages_created": 0, "skipped_processed": 0}

    rows = (
        await db.execute(
            select(Memory)
            .where(Memory.user_id == user_id)
            .order_by(Memory.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()

    for mem in rows:
        if await _already_processed(db, user_id, "memory", str(mem.id)):
            total["skipped_processed"] += 1
            continue
        result = await _process_atom(
            db,
            user_id,
            resolver,
            source_type="memory",
            source_ref=str(mem.id),
            text=mem.content,
        )
        total["atoms"] += 1
        total["links_added"] += result["links_added"]
        total["pages_created"] += result["pages_touched"]

    await db.commit()
    return total


async def extract_from_skills(
    db: AsyncSession, user_id: uuid.UUID, limit: int = 200
) -> dict:
    """Run extraction over skills — title + description form the source text."""
    resolver = SlugResolver(db, user_id)
    total = {"atoms": 0, "links_added": 0, "pages_created": 0, "skipped_processed": 0}

    rows = (
        await db.execute(
            select(Skill)
            .where(Skill.user_id == user_id, Skill.is_active.is_(True))
            .order_by(Skill.updated_at.desc())
            .limit(limit)
        )
    ).scalars().all()

    for sk in rows:
        # For skills we use skill_key as the source_ref so MCP tools can
        # follow the link back without an extra UUID lookup.
        source_ref = sk.skill_key
        if await _already_processed(db, user_id, "skill", source_ref):
            total["skipped_processed"] += 1
            continue
        text = f"{sk.name}\n{sk.description or ''}"
        # The skill itself IS an entity — we always add the skill's name
        # as a forced candidate, even if the regex misses it (e.g.
        # all-lowercase skill names like "polymarket").
        forced_candidate = sk.name
        result = await _process_atom(
            db,
            user_id,
            resolver,
            source_type="skill",
            source_ref=source_ref,
            text=f"{forced_candidate}\n{text}",
            title_for_new_page=forced_candidate,
        )
        total["atoms"] += 1
        total["links_added"] += result["links_added"]
        total["pages_created"] += result["pages_touched"]

    await db.commit()
    return total


async def extract_for_user(
    db: AsyncSession, user_id: uuid.UUID
) -> dict:
    """Run entity extraction across all atom types for a user.

    Returns a summary dict suitable for the API response. Idempotent:
    re-running is a no-op for already-processed atoms.
    """
    mem_result = await extract_from_memories(db, user_id)
    skill_result = await extract_from_skills(db, user_id)
    return {
        "memories": mem_result,
        "skills": skill_result,
    }


__all__ = [
    "extract_candidates",
    "extract_for_user",
    "extract_from_memories",
    "extract_from_skills",
]
