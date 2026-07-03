"""agent registration key

Revision ID: d7a9c3f2b4e1
Revises: c2f4a8b9d7e1
Create Date: 2026-07-02 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d7a9c3f2b4e1"
down_revision: str | Sequence[str] | None = "c2f4a8b9d7e1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "agent_environments",
        sa.Column("registration_key", sa.String(length=300), nullable=True),
    )
    op.execute(
        """
        UPDATE agent_environments
        SET registration_key = 'machine:' || machine_id || ':agent:' || agent_type
        WHERE registration_key IS NULL
        """
    )
    op.drop_constraint(
        "uq_agent_envs_user_machine_agent",
        "agent_environments",
        type_="unique",
    )
    op.create_unique_constraint(
        "uq_agent_envs_user_registration_key",
        "agent_environments",
        ["user_id", "registration_key"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_agent_envs_user_registration_key",
        "agent_environments",
        type_="unique",
    )
    op.create_unique_constraint(
        "uq_agent_envs_user_machine_agent",
        "agent_environments",
        ["user_id", "machine_id", "agent_type"],
    )
    op.drop_column("agent_environments", "registration_key")
