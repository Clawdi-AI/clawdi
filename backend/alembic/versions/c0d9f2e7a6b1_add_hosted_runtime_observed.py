"""add hosted runtime observed state

Revision ID: c0d9f2e7a6b1
Revises: 8fb2d34c9a10
Create Date: 2026-06-11 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "c0d9f2e7a6b1"
down_revision: str | Sequence[str] | None = "8fb2d34c9a10"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "hosted_runtime_states",
        sa.Column("observed", postgresql.JSONB(none_as_null=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("hosted_runtime_states", "observed")
