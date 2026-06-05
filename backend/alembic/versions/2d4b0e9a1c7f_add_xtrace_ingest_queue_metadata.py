"""add xtrace ingest queue metadata

Revision ID: 2d4b0e9a1c7f
Revises: f49d6a8e2c31
Create Date: 2026-06-05 14:20:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "2d4b0e9a1c7f"
down_revision: str | Sequence[str] | None = "f49d6a8e2c31"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "xtrace_memory_ingests",
        sa.Column("attempt_count", sa.Integer(), server_default="0", nullable=False),
    )
    op.add_column(
        "xtrace_memory_ingests",
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "xtrace_memory_ingests",
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "xtrace_memory_ingests",
        sa.Column("claimed_by", sa.String(length=200), nullable=True),
    )
    op.add_column("xtrace_memory_ingests", sa.Column("error", sa.Text(), nullable=True))
    op.create_index("ix_xtrace_memory_ingests_claimed_by", "xtrace_memory_ingests", ["claimed_by"])
    op.create_index(
        "ix_xtrace_memory_ingests_next_attempt_at",
        "xtrace_memory_ingests",
        ["next_attempt_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_xtrace_memory_ingests_next_attempt_at", table_name="xtrace_memory_ingests")
    op.drop_index("ix_xtrace_memory_ingests_claimed_by", table_name="xtrace_memory_ingests")
    op.drop_column("xtrace_memory_ingests", "error")
    op.drop_column("xtrace_memory_ingests", "claimed_by")
    op.drop_column("xtrace_memory_ingests", "claimed_at")
    op.drop_column("xtrace_memory_ingests", "next_attempt_at")
    op.drop_column("xtrace_memory_ingests", "attempt_count")
