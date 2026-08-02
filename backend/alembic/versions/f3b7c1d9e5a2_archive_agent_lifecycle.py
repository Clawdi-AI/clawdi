"""archive agent lifecycle

Revision ID: f3b7c1d9e5a2
Revises: e8f4a1c9d2b7
"""

import sqlalchemy as sa

from alembic import op

revision = "f3b7c1d9e5a2"
down_revision = "e8f4a1c9d2b7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "agent_environments",
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_agent_environments_archived_at", "agent_environments", ["archived_at"])


def downgrade() -> None:
    op.drop_index("ix_agent_environments_archived_at", table_name="agent_environments")
    op.drop_column("agent_environments", "archived_at")
