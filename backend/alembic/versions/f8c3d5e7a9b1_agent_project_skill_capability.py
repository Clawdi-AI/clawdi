"""Persist the connected Project Skill reconcile capability.

Revision ID: f8c3d5e7a9b1
Revises: e7b2c4d9a1f3
Create Date: 2026-08-05 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f8c3d5e7a9b1"
down_revision: str | Sequence[str] | None = "e7b2c4d9a1f3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "agent_environments",
        sa.Column("project_skill_reconcile_version", sa.Integer(), nullable=True),
    )
    op.create_check_constraint(
        "ck_agent_environments_project_skill_reconcile_version",
        "agent_environments",
        "project_skill_reconcile_version IS NULL OR project_skill_reconcile_version >= 1",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_agent_environments_project_skill_reconcile_version",
        "agent_environments",
        type_="check",
    )
    op.drop_column("agent_environments", "project_skill_reconcile_version")
