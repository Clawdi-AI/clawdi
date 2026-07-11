"""add hosted runtime locale

Revision ID: d8f2a1c4b6e9
Revises: c4e8f1a2b3d5
Create Date: 2026-07-11 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "d8f2a1c4b6e9"
down_revision: str | Sequence[str] | None = "c4e8f1a2b3d5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "hosted_runtime_states",
        sa.Column(
            "locale",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
    )
    op.drop_column("hosted_runtime_states", "clawdi_cli")


def downgrade() -> None:
    op.add_column(
        "hosted_runtime_states",
        sa.Column(
            "clawdi_cli",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )
    op.drop_column("hosted_runtime_states", "locale")
