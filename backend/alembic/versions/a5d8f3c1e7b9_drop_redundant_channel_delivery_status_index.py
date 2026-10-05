"""Drop the redundant channel delivery status index.

Revision ID: a5d8f3c1e7b9
Revises: fca5e43eb29d
"""

from collections.abc import Sequence

from alembic import op

revision: str = "a5d8f3c1e7b9"
down_revision: str | Sequence[str] | None = "fca5e43eb29d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_index("ix_channel_deliveries_status", table_name="channel_deliveries")


def downgrade() -> None:
    op.create_index(
        "ix_channel_deliveries_status",
        "channel_deliveries",
        ["status"],
    )
