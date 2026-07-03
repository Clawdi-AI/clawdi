"""Add Agent default name.

Revision ID: e9c3a17d5b42
Revises: d7a9c3f2b4e1
Create Date: 2026-07-03
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e9c3a17d5b42"
down_revision: str | Sequence[str] | None = "d7a9c3f2b4e1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("agent_environments", sa.Column("default_name", sa.String(length=120)))
    op.execute(
        """
        UPDATE agent_environments
        SET default_name = NULLIF(TRIM(machine_name), '')
        WHERE default_name IS NULL
        """
    )


def downgrade() -> None:
    op.drop_column("agent_environments", "default_name")
