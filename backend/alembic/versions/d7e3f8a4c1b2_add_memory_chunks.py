"""add memory_chunks table for chunk-level retrieval

Revision ID: d7e3f8a4c1b2
Revises: f0a1b2c3d4e5
Create Date: 2026-04-29 11:00:00.000000

Splits long memory `content` into per-paragraph chunks, each with its own
embedding. Search joins through chunks and rolls up to the parent memory,
which closes most of the retrieval gap measured in clawdi-bench
2026-04-29 (Hit@5 71% → expected ~90% on real data).

Why a separate table instead of widening `memories`:
- Each chunk needs its own embedding; Memory is a 1:1 model
- DISTINCT ON (memory_id) keeps the result shape unchanged for callers
- ON DELETE CASCADE means dropping a memory drops its chunks atomically
- Existing rows still searchable via Memory.embedding fallback while the
  one-shot backfill runs

The position=0 chunk gets FTS weight 'A' (other chunks 'B'). This biases
exact-title matches to the top — a memory titled "clawdi-cloud local dev
setup" outranks 50 other memories that mention "clawdi" in their bodies.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from pgvector.sqlalchemy import Vector

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d7e3f8a4c1b2"
down_revision: str | Sequence[str] | None = "f0a1b2c3d4e5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "memory_chunks",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("memory_id", sa.UUID(), nullable=False),
        # 0 = first chunk (heading-ish text); higher = body
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        # Generated tsvector with weighted setweight: position 0 → 'A',
        # otherwise → 'B'. Together with ts_rank's default weights
        # ({A:1.0, B:0.4}), title-ish chunks rank ~2.5x higher than body
        # chunks at equal text-similarity.
        sa.Column(
            "content_tsv",
            sa.dialects.postgresql.TSVECTOR(),
            sa.Computed(
                "setweight(to_tsvector('simple', content), "
                "CASE WHEN position = 0 THEN 'A'::\"char\" "
                "ELSE 'B'::\"char\" END)",
                persisted=True,
            ),
            nullable=False,
        ),
        sa.Column("embedding", Vector(768), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["memory_id"], ["memories.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("memory_id", "position", name="memory_chunks_memory_position_unique"),
    )
    op.create_index(
        "ix_memory_chunks_memory_id",
        "memory_chunks",
        ["memory_id"],
        unique=False,
    )
    # GIN over the generated tsvector column for FTS lookup.
    op.create_index(
        "ix_memory_chunks_content_tsv",
        "memory_chunks",
        ["content_tsv"],
        unique=False,
        postgresql_using="gin",
    )
    # ivfflat over the embedding column for ANN search. lists=100 is
    # appropriate up to ~100k chunks; revisit at scale.
    op.create_index(
        "ix_memory_chunks_embedding",
        "memory_chunks",
        ["embedding"],
        unique=False,
        postgresql_using="ivfflat",
        postgresql_ops={"embedding": "vector_cosine_ops"},
        postgresql_with={"lists": 100},
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_memory_chunks_embedding", table_name="memory_chunks")
    op.drop_index("ix_memory_chunks_content_tsv", table_name="memory_chunks")
    op.drop_index("ix_memory_chunks_memory_id", table_name="memory_chunks")
    op.drop_table("memory_chunks")
