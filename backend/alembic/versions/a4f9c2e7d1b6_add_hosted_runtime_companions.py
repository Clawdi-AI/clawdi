"""Add server-owned hosted runtime companions desired state.

Revision ID: a4f9c2e7d1b6
Revises: f8c3d5e7a9b1
Create Date: 2026-08-05 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "a4f9c2e7d1b6"
down_revision: str | Sequence[str] | None = "f8c3d5e7a9b1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "hosted_runtime_states",
        sa.Column("companions", postgresql.JSONB(none_as_null=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("hosted_runtime_states", "companions")
