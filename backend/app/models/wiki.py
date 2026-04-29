"""Personal wiki — synthesized entity pages aggregated across memory, skills,
sessions, and vault.

The wiki layer sits ON TOP of the four atomic stores. It does not replace
them. Each entity that recurs across the user's data gets one wiki page
with a Compiled-Truth synthesis (LLM-rewritable summary) and a Timeline
(append-only evidence). Pages link back to source items — never copy them.

Design notes:
- Pages are user-scoped (multi-tenant). Slugs are unique per user, not globally.
- Compiled truth is regenerated incrementally on new evidence; timeline is
  append-only.
- Vault keys are linked by NAME ONLY. Values are NEVER copied into pages
  or compiled_truth. The synthesis pipeline runs through a sanitizer.
- Source links can point to another wiki page (graph edge) or to an
  external item (memory uuid / skill_key / session uuid / vault scope).
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class WikiPage(Base, TimestampMixin):
    __tablename__ = "wiki_pages"
    __table_args__ = (
        UniqueConstraint("user_id", "slug", name="wiki_pages_user_slug_unique"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False, index=True
    )
    # Lowercase canonical slug, e.g. "polymarket", "twilio-voice-agent".
    # Resolver maps "Polymarket" / "poly market" / "PolyMarket" → same slug.
    slug: Mapped[str] = mapped_column(String(200), nullable=False)
    # Display title with original casing, e.g. "Polymarket".
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    # entity (default) — concrete thing: a tool, project, person, service.
    # concept — abstract topic that aggregates across entities.
    # synthesis — meta-page summarizing a query result that's worth keeping.
    kind: Mapped[str] = mapped_column(String(50), server_default="entity")
    # LLM-synthesized 1–2 paragraph "what we know" snapshot. Rewritable.
    # NEVER contains vault values — sanitizer enforces this.
    compiled_truth: Mapped[str | None] = mapped_column(Text)
    # Typed metadata: {aliases: ["Polymarket", "poly"], confidence: 0.9, ...}
    frontmatter: Mapped[dict | None] = mapped_column(JSONB)
    # Number of unique source items this page aggregates (memories + skills
    # + sessions + vault scopes). Derived; updated on link insert/delete.
    source_count: Mapped[int] = mapped_column(Integer, server_default="0")
    # When compiled_truth was last regenerated. Used to skip work in the
    # synthesis job if no new evidence has arrived since.
    last_synthesis_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Marked when sources are removed, contradictions are flagged, or no
    # new evidence in N months. Surfaced in the dashboard as a stale badge.
    stale: Mapped[bool] = mapped_column(Boolean, server_default="false")


class WikiLink(Base):
    """Edge: from a page to either another page (graph) or a source item.

    Exactly one of {to_page_id, (source_type, source_ref)} must be set.
    """

    __tablename__ = "wiki_links"
    __table_args__ = (
        CheckConstraint(
            "(to_page_id IS NOT NULL AND source_type IS NULL) OR "
            "(to_page_id IS NULL AND source_type IS NOT NULL "
            "AND source_ref IS NOT NULL)",
            name="wiki_links_target_check",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False, index=True
    )
    from_page_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("wiki_pages.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Edge to another page (graph traversal).
    to_page_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("wiki_pages.id", ondelete="CASCADE"),
        nullable=True,
    )
    # Edge to an external source item.
    # source_type ∈ {memory, skill, session, vault}.
    # source_ref: memory.id (uuid), skill.skill_key, session.id (uuid),
    #             vault scope slug.
    source_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    source_ref: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # Typed link semantics: mentions, uses, references, related_to,
    # contradicts, supersedes.
    link_type: Mapped[str] = mapped_column(String(50), nullable=False)
    # Confidence of the extraction (0..1). Low-confidence links surface
    # in the HITL queue rather than auto-applying.
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )


class WikiLogEntry(Base):
    """Chronological log — every action that touched a page.

    Equivalent to llm_wiki's log.md / gbrain's timeline. Used to show
    activity in the dashboard and for debugging the synthesis pipeline.
    """

    __tablename__ = "wiki_log"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False, index=True
    )
    page_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("wiki_pages.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # action ∈ {created, synthesized, merged, flagged_stale, link_added,
    #           link_removed, contradicted, deleted}
    action: Mapped[str] = mapped_column(String(50), nullable=False)
    # Trigger source: 'memory' / 'session' / 'manual' / 'cron' / 'extraction'
    source_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    source_ref: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # Free-form metadata: {model: "claude-haiku-4-5", input_tokens: 234, ...}
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB)
    ts: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
