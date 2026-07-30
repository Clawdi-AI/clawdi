"""Add hosted runtime apply generation.

Revision ID: 7c2e9a4b6d1f
Revises: 5d2a9c7e4b18
Create Date: 2026-07-30 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "7c2e9a4b6d1f"
down_revision: str | Sequence[str] | None = "5d2a9c7e4b18"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "hosted_runtime_states",
        sa.Column("apply_generation", sa.Integer(), nullable=True),
    )
    op.create_check_constraint(
        "ck_hosted_runtime_states_apply_generation",
        "hosted_runtime_states",
        "apply_generation IS NULL OR apply_generation >= 1",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_hosted_runtime_states_apply_generation",
        "hosted_runtime_states",
        type_="check",
    )
    op.drop_column("hosted_runtime_states", "apply_generation")
