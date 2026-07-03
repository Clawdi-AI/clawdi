"""widen memory embedding to 768 dim

Revision ID: e81a04e870b4
Revises: 7ac3349475ec
Create Date: 2026-04-22 00:30:00.000000

Switches the default local embedding model from BAAI/bge-small-en-v1.5
(384 dim, English-only) to paraphrase-multilingual-mpnet-base-v2
(768 dim, 50+ languages). Since the embedding dimension changes, any
existing embeddings are invalidated — the column is dropped and
recreated, and users must re-run `POST /api/memories/embed-backfill`
to populate the new column.

The API path (OpenAI / OpenRouter) is unaffected in principle: the
`dimensions` parameter still truncates Matryoshka embeddings, we just
ask for 768 instead of 384 now.
"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e81a04e870b4"
down_revision: Union[str, Sequence[str], None] = "7ac3349475ec"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Drop the HNSW index first — ALTER COLUMN TYPE with a different dim
    # would fail on an indexed vector column.
    op.execute("DROP INDEX IF EXISTS ix_memories_embedding;")
    # Drop the 384-dim column entirely. Values are useless for a
    # different model anyway; users will re-backfill with the new model.
    op.execute("ALTER TABLE memories DROP COLUMN IF EXISTS embedding;")
    op.execute("ALTER TABLE memories ADD COLUMN embedding vector(768);")
    op.execute(
        "CREATE INDEX ix_memories_embedding "
        "ON memories USING hnsw (embedding vector_cosine_ops);"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_memories_embedding;")
    op.execute("ALTER TABLE memories DROP COLUMN IF EXISTS embedding;")
    op.execute("ALTER TABLE memories ADD COLUMN embedding vector(384);")
    op.execute(
        "CREATE INDEX ix_memories_embedding "
        "ON memories USING hnsw (embedding vector_cosine_ops);"
    )
