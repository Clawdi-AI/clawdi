"""add memory embedding (pgvector)

Revision ID: 7ac3349475ec
Revises: 6a6bb7b46a4f
Create Date: 2026-04-21 23:30:00.000000

"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "7ac3349475ec"
down_revision: Union[str, Sequence[str], None] = "6a6bb7b46a4f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add pgvector column + HNSW index for semantic memory search.

    Dimension 384 is chosen to match BAAI/bge-small-en-v1.5 (local,
    fastembed default) natively; OpenAI text-embedding-3-small is
    truncated to 384 via the `dimensions` parameter at embed time,
    so one column serves all embedding modes.
    """
    op.execute("CREATE EXTENSION IF NOT EXISTS vector;")
    op.execute(
        "ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding vector(384);"
    )
    # HNSW beats IVFFlat for small-to-medium datasets (<10M rows) and
    # needs no training step. Use cosine distance ops to match our
    # search-time `<=>` operator choice.
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_memories_embedding "
        "ON memories USING hnsw (embedding vector_cosine_ops);"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_memories_embedding;")
    op.execute("ALTER TABLE memories DROP COLUMN IF EXISTS embedding;")
    # Don't drop vector extension — it may be used elsewhere.
