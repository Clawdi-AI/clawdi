"""Add opt-in Connected Agent machine fencing.

Revision ID: c8f2a6d1e4b9
Revises: b6d1e4c9f2a7
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c8f2a6d1e4b9"
down_revision: str | Sequence[str] | None = "b6d1e4c9f2a7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "agent_environments",
        sa.Column(
            "machine_fence_required",
            sa.Boolean(),
            server_default=sa.false(),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("agent_environments", "machine_fence_required")
