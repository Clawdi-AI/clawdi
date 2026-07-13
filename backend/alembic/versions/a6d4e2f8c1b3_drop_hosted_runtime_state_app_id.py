"""drop unused hosted runtime state app id

Revision ID: a6d4e2f8c1b3
Revises: f1a7c3d9e2b4
Create Date: 2026-07-13 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "a6d4e2f8c1b3"
down_revision: str | Sequence[str] | None = "f1a7c3d9e2b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_column("hosted_runtime_states", "app_id")


def downgrade() -> None:
    op.add_column(
        "hosted_runtime_states",
        sa.Column("app_id", sa.String(length=200), nullable=True),
    )
