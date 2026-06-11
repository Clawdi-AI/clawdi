"""add hosted runtime mcp tools desired state

Revision ID: f12a8c4d6e90
Revises: c0d9f2e7a6b1
Create Date: 2026-06-11 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "f12a8c4d6e90"
down_revision: str | Sequence[str] | None = "c0d9f2e7a6b1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "hosted_runtime_states",
        sa.Column("mcp", postgresql.JSONB(none_as_null=True), nullable=True),
    )
    op.add_column(
        "hosted_runtime_states",
        sa.Column("tools", postgresql.JSONB(none_as_null=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("hosted_runtime_states", "tools")
    op.drop_column("hosted_runtime_states", "mcp")
