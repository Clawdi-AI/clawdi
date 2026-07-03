"""add memory search indexes (pg_trgm + tsvector)

Revision ID: 6a6bb7b46a4f
Revises: a3d1f2e4b567
Create Date: 2026-04-21 23:00:00.000000

"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "6a6bb7b46a4f"
down_revision: Union[str, Sequence[str], None] = "a3d1f2e4b567"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add FTS + trigram search indexes to memories.content."""
    # pg_trgm for fuzzy / partial-word / typo-tolerant matching.
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm;")
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_memories_content_trgm "
        "ON memories USING GIN (content gin_trgm_ops);"
    )

    # tsvector generated column for BM25-like word-level ranking.
    # Use 'simple' dictionary (no stemming, no stopwords) so mixed
    # Chinese / English content works without a language-specific config.
    op.execute(
        "ALTER TABLE memories "
        "ADD COLUMN IF NOT EXISTS content_tsv tsvector "
        "GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED;"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_memories_content_tsv "
        "ON memories USING GIN (content_tsv);"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_memories_content_tsv;")
    op.execute("ALTER TABLE memories DROP COLUMN IF EXISTS content_tsv;")
    op.execute("DROP INDEX IF EXISTS ix_memories_content_trgm;")
    # Don't drop pg_trgm extension — it may be used elsewhere.
