"""add hosted runtime mitmproxy pin

Revision ID: 9a6c1f2d8e34
Revises: 8b7d2f1a6c4e
Create Date: 2026-07-09 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "9a6c1f2d8e34"
down_revision: str | Sequence[str] | None = "8b7d2f1a6c4e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "hosted_runtime_states",
        sa.Column("mitmproxy", postgresql.JSONB(none_as_null=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("hosted_runtime_states", "mitmproxy")
