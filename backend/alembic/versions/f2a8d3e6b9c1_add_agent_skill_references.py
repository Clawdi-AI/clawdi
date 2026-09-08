"""Reference Cloud Library Skills from individual Agents.

Revision ID: f2a8d3e6b9c1
Revises: e1c7a4b9d2f6
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "f2a8d3e6b9c1"
down_revision = "e1c7a4b9d2f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_skill_references",
        sa.Column("agent_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("skill_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["agent_id"], ["agent_environments.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["skill_id"], ["skills.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("agent_id", "skill_id"),
    )
    op.create_index("ix_agent_skill_references_skill_id", "agent_skill_references", ["skill_id"])


def downgrade() -> None:
    op.drop_table("agent_skill_references")
