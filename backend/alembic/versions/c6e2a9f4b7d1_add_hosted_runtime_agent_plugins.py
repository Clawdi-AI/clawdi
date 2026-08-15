"""Add hosted runtime Agent Plugins desired state.

Revision ID: c6e2a9f4b7d1
Revises: a4f9c2e7d1b6
Create Date: 2026-08-08 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "c6e2a9f4b7d1"
down_revision: str | Sequence[str] | None = "a4f9c2e7d1b6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "hosted_runtime_states",
        sa.Column("agent_plugins", postgresql.JSONB(none_as_null=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("hosted_runtime_states", "agent_plugins")
