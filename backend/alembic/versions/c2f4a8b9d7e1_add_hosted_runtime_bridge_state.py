"""add hosted runtime bridge state

Revision ID: c2f4a8b9d7e1
Revises: ab12cd34ef56
Create Date: 2026-06-30 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "c2f4a8b9d7e1"
down_revision: str | Sequence[str] | None = "ab12cd34ef56"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "hosted_runtime_states",
        sa.Column("bridge", postgresql.JSONB(none_as_null=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("hosted_runtime_states", "bridge")
