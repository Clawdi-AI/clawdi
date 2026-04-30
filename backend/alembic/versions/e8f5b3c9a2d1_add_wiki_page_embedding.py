"""add wiki_pages.compiled_truth_embedding for vector search

Revision ID: e8f5b3c9a2d1
Revises: d7e3f8a4c1b2
Create Date: 2026-04-29 18:00:00.000000

Adds a 768-dim pgvector column to wiki_pages so the wiki/query endpoint
can rank pages by semantic similarity to the user's question, in addition
to the existing tokenized FTS. Closes the last gap to gbrain on fuzzy
queries that don't tokenize well.

The embedding is computed at synthesis time from compiled_truth and stored
on the same row. NULL until the page has been synthesized AND
re-embedded (one-time backfill required for pages that synthesized
before this migration).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from pgvector.sqlalchemy import Vector

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e8f5b3c9a2d1"
down_revision: str | Sequence[str] | None = "d7e3f8a4c1b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "wiki_pages",
        sa.Column("compiled_truth_embedding", Vector(768), nullable=True),
    )
    # ivfflat ANN index for cosine-distance lookups.
    op.create_index(
        "ix_wiki_pages_compiled_truth_embedding",
        "wiki_pages",
        ["compiled_truth_embedding"],
        unique=False,
        postgresql_using="ivfflat",
        postgresql_ops={"compiled_truth_embedding": "vector_cosine_ops"},
        postgresql_with={"lists": 100},
    )


def downgrade() -> None:
    op.drop_index(
        "ix_wiki_pages_compiled_truth_embedding",
        table_name="wiki_pages",
    )
    op.drop_column("wiki_pages", "compiled_truth_embedding")
