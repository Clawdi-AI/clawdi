"""add skill chunks search index

Revision ID: 3d0b4d7f9a2e
Revises: 0b7c2a4e9d10
Create Date: 2026-06-04 16:15:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "3d0b4d7f9a2e"
down_revision: str | Sequence[str] | None = "0b7c2a4e9d10"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm;")
    op.execute("CREATE EXTENSION IF NOT EXISTS vector;")

    op.create_table(
        "skill_chunks",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
        ),
        sa.Column(
            "skill_id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
        ),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("skill_key", sa.String(length=200), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("file_path", sa.Text(), nullable=False),
        sa.Column("chunk_index", sa.Integer(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("embedding", Vector(768), nullable=True),
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
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["skill_id"], ["skills.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.execute("ALTER TABLE skill_chunks ALTER COLUMN id SET DEFAULT gen_random_uuid();")
    op.create_index("ix_skill_chunks_project_id", "skill_chunks", ["project_id"])
    op.create_index(
        "ix_skill_chunks_skill_file_chunk",
        "skill_chunks",
        ["skill_id", "file_path", "chunk_index"],
        unique=True,
    )
    op.create_index("ix_skill_chunks_skill_id", "skill_chunks", ["skill_id"])
    op.create_index("ix_skill_chunks_user_id", "skill_chunks", ["user_id"])
    op.create_index(
        "ix_skill_chunks_user_project_key",
        "skill_chunks",
        ["user_id", "project_id", "skill_key"],
    )
    op.execute(
        "ALTER TABLE skill_chunks "
        "ADD COLUMN content_tsv tsvector "
        "GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED;"
    )
    op.execute(
        "CREATE INDEX ix_skill_chunks_content_tsv "
        "ON skill_chunks USING GIN (content_tsv);"
    )
    op.execute(
        "CREATE INDEX ix_skill_chunks_content_trgm "
        "ON skill_chunks USING GIN (content gin_trgm_ops);"
    )
    op.execute(
        "CREATE INDEX ix_skill_chunks_embedding "
        "ON skill_chunks USING hnsw (embedding vector_cosine_ops);"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_skill_chunks_embedding;")
    op.execute("DROP INDEX IF EXISTS ix_skill_chunks_content_trgm;")
    op.execute("DROP INDEX IF EXISTS ix_skill_chunks_content_tsv;")
    op.drop_index("ix_skill_chunks_user_project_key", table_name="skill_chunks")
    op.drop_index("ix_skill_chunks_user_id", table_name="skill_chunks")
    op.drop_index("ix_skill_chunks_skill_id", table_name="skill_chunks")
    op.drop_index("ix_skill_chunks_skill_file_chunk", table_name="skill_chunks")
    op.drop_index("ix_skill_chunks_project_id", table_name="skill_chunks")
    op.drop_table("skill_chunks")
    # Keep pg_trgm/vector extensions; other tables may use them.
