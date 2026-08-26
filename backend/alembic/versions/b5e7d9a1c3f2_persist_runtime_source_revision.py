"""Persist hosted runtime source revisions.

Revision ID: b5e7d9a1c3f2
Revises: 4a8d2c7e9f31
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b5e7d9a1c3f2"
down_revision: str | Sequence[str] | None = "4a8d2c7e9f31"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "hosted_runtime_states",
        sa.Column("source_revision", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "hosted_runtime_states",
        sa.Column("source_revision_contract", sa.String(length=64), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("hosted_runtime_states", "source_revision_contract")
    op.drop_column("hosted_runtime_states", "source_revision")
