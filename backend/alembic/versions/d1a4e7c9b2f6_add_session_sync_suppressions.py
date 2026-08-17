"""Add durable Session sync suppressions.

Revision ID: d1a4e7c9b2f6
Revises: c3e8f1a6d2b9
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "d1a4e7c9b2f6"
down_revision: str | Sequence[str] | None = "c3e8f1a6d2b9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "session_sync_suppressions",
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("local_session_id", sa.String(length=200), nullable=False),
        sa.PrimaryKeyConstraint(
            "user_id",
            "local_session_id",
            name="pk_session_sync_suppressions",
        ),
    )


def downgrade() -> None:
    op.drop_table("session_sync_suppressions")
