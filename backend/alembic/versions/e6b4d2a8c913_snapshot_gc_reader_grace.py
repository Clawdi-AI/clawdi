"""Track snapshot collection candidates without changing existing rows.

Revision ID: e6b4d2a8c913
Revises: d5f9a2b7c813
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e6b4d2a8c913"
down_revision: str | Sequence[str] | None = "d5f9a2b7c813"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "session_snapshot_gc_candidates",
        sa.Column("file_key", sa.Text(), primary_key=True),
        sa.Column("unreferenced_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_session_snapshot_gc_candidates_unreferenced_at",
        "session_snapshot_gc_candidates",
        ["unreferenced_at"],
    )


def downgrade() -> None:
    # Forgetting candidates only restarts their grace after a later upgrade.
    # Neither migration direction reads, modifies, or deletes stored objects.
    op.drop_table("session_snapshot_gc_candidates")
