"""Add hosted runtime skills desired state.

Revision ID: e2a7c9f4b6d1
Revises: b7e4d2a9c6f1
Create Date: 2026-07-28 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "e2a7c9f4b6d1"
down_revision: str | Sequence[str] | None = "b7e4d2a9c6f1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "hosted_runtime_states",
        sa.Column("skills", postgresql.JSONB(none_as_null=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("hosted_runtime_states", "skills")
