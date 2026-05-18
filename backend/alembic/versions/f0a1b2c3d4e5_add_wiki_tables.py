"""add wiki tables (pages, links, log)

Revision ID: f0a1b2c3d4e5
Revises: 672acd66fc7d
Create Date: 2026-04-28 00:00:00.000000

Adds the personal wiki layer — synthesized entity pages aggregated across
memory, skills, sessions, and vault scopes. See app/models/wiki.py for the
design rationale.

Three tables:
- wiki_pages: one row per canonical entity per user; stores compiled_truth
- wiki_links: typed edges between pages or to source items (memory/skill/
  session/vault); CHECK constraint enforces exactly one target type
- wiki_log: chronological log of every wiki mutation for activity feed +
  pipeline debugging
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "f0a1b2c3d4e5"
down_revision: Union[str, Sequence[str], None] = "672acd66fc7d"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "wiki_pages",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("slug", sa.String(length=200), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column(
            "kind", sa.String(length=50), server_default="entity", nullable=False
        ),
        sa.Column("compiled_truth", sa.Text(), nullable=True),
        sa.Column(
            "frontmatter",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column(
            "source_count", sa.Integer(), server_default="0", nullable=False
        ),
        sa.Column(
            "last_synthesis_at", sa.DateTime(timezone=True), nullable=True
        ),
        sa.Column(
            "stale", sa.Boolean(), server_default="false", nullable=False
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id", "slug", name="wiki_pages_user_slug_unique"
        ),
    )
    op.create_index(
        op.f("ix_wiki_pages_user_id"), "wiki_pages", ["user_id"], unique=False
    )
    # Frequent dashboard query: list pages by kind for a user.
    op.create_index(
        "ix_wiki_pages_user_kind",
        "wiki_pages",
        ["user_id", "kind"],
        unique=False,
    )
    # Activity feed / "recently updated" view.
    op.create_index(
        "ix_wiki_pages_user_updated",
        "wiki_pages",
        ["user_id", sa.text("updated_at DESC")],
        unique=False,
    )

    op.create_table(
        "wiki_links",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("from_page_id", sa.UUID(), nullable=False),
        sa.Column("to_page_id", sa.UUID(), nullable=True),
        sa.Column("source_type", sa.String(length=20), nullable=True),
        sa.Column("source_ref", sa.String(length=200), nullable=True),
        sa.Column("link_type", sa.String(length=50), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["from_page_id"], ["wiki_pages.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["to_page_id"], ["wiki_pages.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "(to_page_id IS NOT NULL AND source_type IS NULL) OR "
            "(to_page_id IS NULL AND source_type IS NOT NULL "
            "AND source_ref IS NOT NULL)",
            name="wiki_links_target_check",
        ),
    )
    op.create_index(
        op.f("ix_wiki_links_user_id"),
        "wiki_links",
        ["user_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_wiki_links_from_page_id"),
        "wiki_links",
        ["from_page_id"],
        unique=False,
    )
    # Backlinks lookup (what pages point to this page) — graph traversal.
    op.create_index(
        "ix_wiki_links_to_page",
        "wiki_links",
        ["to_page_id"],
        unique=False,
        postgresql_where=sa.text("to_page_id IS NOT NULL"),
    )
    # Reverse lookup: given an external source item (memory/skill/session/
    # vault), find pages that reference it. Used by the synthesis job to
    # propagate updates when a memory changes.
    op.create_index(
        "ix_wiki_links_source",
        "wiki_links",
        ["source_type", "source_ref"],
        unique=False,
        postgresql_where=sa.text("source_type IS NOT NULL"),
    )

    op.create_table(
        "wiki_log",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("page_id", sa.UUID(), nullable=True),
        sa.Column("action", sa.String(length=50), nullable=False),
        sa.Column("source_type", sa.String(length=20), nullable=True),
        sa.Column("source_ref", sa.String(length=200), nullable=True),
        sa.Column(
            "metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column(
            "ts",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["page_id"], ["wiki_pages.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_wiki_log_user_id"),
        "wiki_log",
        ["user_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_wiki_log_page_id"),
        "wiki_log",
        ["page_id"],
        unique=False,
    )
    # Activity feed query: per-user newest first.
    op.create_index(
        "ix_wiki_log_user_ts",
        "wiki_log",
        ["user_id", sa.text("ts DESC")],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_wiki_log_user_ts", table_name="wiki_log")
    op.drop_index(op.f("ix_wiki_log_page_id"), table_name="wiki_log")
    op.drop_index(op.f("ix_wiki_log_user_id"), table_name="wiki_log")
    op.drop_table("wiki_log")

    op.drop_index("ix_wiki_links_source", table_name="wiki_links")
    op.drop_index("ix_wiki_links_to_page", table_name="wiki_links")
    op.drop_index(
        op.f("ix_wiki_links_from_page_id"), table_name="wiki_links"
    )
    op.drop_index(op.f("ix_wiki_links_user_id"), table_name="wiki_links")
    op.drop_table("wiki_links")

    op.drop_index("ix_wiki_pages_user_updated", table_name="wiki_pages")
    op.drop_index("ix_wiki_pages_user_kind", table_name="wiki_pages")
    op.drop_index(op.f("ix_wiki_pages_user_id"), table_name="wiki_pages")
    op.drop_table("wiki_pages")
