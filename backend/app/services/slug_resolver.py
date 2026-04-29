"""Slug resolver — canonicalize entity names → wiki page slugs.

Same real-world entity reaches the wiki under many spellings:
  "Polymarket" / "polymarket" / "poly market" / "poly-market" / "PolyMarket"
All five must map to one canonical slug ("polymarket"). Otherwise we
get duplicate pages and the dashboard fragments.

Two-stage resolution:

1. **Normalize** (pure function): lowercase, whitespace/underscore →
   hyphen, drop non-alphanumeric, collapse repeated hyphens. Cheap and
   deterministic — covers 80% of variants.

2. **Fuzzy match** (DB-bound): if normalized form doesn't already exist
   for this user, search existing user slugs via pg_trgm similarity.
   If a near-match is found above threshold, return that existing slug
   instead of creating a new page. Catches typos and edit-distance
   variants the normalizer misses (e.g. "polymrket" → "polymarket").

Returns `(slug, exists)`. Caller decides whether to insert a new
WikiPage or attach evidence to the existing one.
"""

from __future__ import annotations

import re
import uuid

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.wiki import WikiPage

# pg_trgm similarity score required to consider a fuzzy match an alias
# of an existing page rather than a new page. Tuned conservatively —
# we'd rather create one extra page than silently merge unrelated
# entities. The synthesis pipeline can propose merges later.
DEFAULT_SIMILARITY_THRESHOLD = 0.6

# Max slug length matches the wiki_pages.slug column (200). Names longer
# than this get truncated; the original is preserved in title.
MAX_SLUG_LENGTH = 200


def normalize(name: str) -> str:
    """Deterministic name → slug. Pure function, no DB.

    Examples:
        "Polymarket"        → "polymarket"
        "Poly Market"       → "poly-market"
        "POLY_MARKET"       → "poly-market"
        "poly--market"      → "poly-market"
        "Poly's Market!"    → "polys-market"
        "  spaced  "        → "spaced"
        ""                  → ""
    """
    if not name:
        return ""
    s = name.lower().strip()
    # Whitespace and underscores → hyphen.
    s = re.sub(r"[\s_]+", "-", s)
    # Drop anything that's not alphanumeric or hyphen.
    s = re.sub(r"[^a-z0-9-]", "", s)
    # Collapse runs of hyphens.
    s = re.sub(r"-+", "-", s)
    s = s.strip("-")
    if len(s) > MAX_SLUG_LENGTH:
        s = s[:MAX_SLUG_LENGTH].rstrip("-")
    return s


class SlugResolver:
    """User-scoped slug resolution against existing wiki pages.

    Construct once per request (or extraction batch) for a given user,
    then call `resolve` for each entity name encountered.
    """

    def __init__(
        self,
        db: AsyncSession,
        user_id: uuid.UUID,
        similarity_threshold: float = DEFAULT_SIMILARITY_THRESHOLD,
    ) -> None:
        self.db = db
        self.user_id = user_id
        self.similarity_threshold = similarity_threshold

    async def resolve(self, name: str) -> tuple[str, bool]:
        """Resolve an entity name → (canonical_slug, exists_already).

        - exists_already=True means a wiki_pages row already exists for
          this user with that slug (exact or fuzzy match). Caller should
          attach evidence to that page.
        - exists_already=False means caller should insert a new page
          using the returned slug.

        Raises ValueError if the name normalizes to empty.
        """
        candidate = normalize(name)
        if not candidate:
            raise ValueError(f"Cannot derive slug from name: {name!r}")

        # Exact match: cheapest path.
        existing = await self.db.scalar(
            select(WikiPage.slug).where(
                WikiPage.user_id == self.user_id,
                WikiPage.slug == candidate,
            )
        )
        if existing:
            return existing, True

        # Fuzzy match via pg_trgm. Requires the pg_trgm extension —
        # already installed for the memories table.
        result = await self.db.execute(
            text(
                """
                SELECT slug, similarity(slug, :candidate) AS score
                FROM wiki_pages
                WHERE user_id = :user_id
                  AND similarity(slug, :candidate) > :threshold
                ORDER BY score DESC
                LIMIT 1
                """
            ),
            {
                "candidate": candidate,
                "user_id": self.user_id,
                "threshold": self.similarity_threshold,
            },
        )
        row = result.first()
        if row is not None:
            return row.slug, True

        return candidate, False
