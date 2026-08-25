"""Widen channel message text to preserve provider payloads.

Revision ID: 4a8d2c7e9f31
Revises: 2e6a9c4f1b7d
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "4a8d2c7e9f31"
down_revision: str | Sequence[str] | None = "2e6a9c4f1b7d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column(
        "channel_messages",
        "text",
        existing_type=sa.String(length=4096),
        type_=sa.Text(),
        existing_nullable=True,
    )


def downgrade() -> None:
    op.alter_column(
        "channel_messages",
        "text",
        existing_type=sa.Text(),
        type_=sa.String(length=4096),
        existing_nullable=True,
    )
