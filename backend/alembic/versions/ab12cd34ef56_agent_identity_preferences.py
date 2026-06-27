"""agent identity preferences

Revision ID: ab12cd34ef56
Revises: f6a1b2c3d4e5
Create Date: 2026-06-27 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "ab12cd34ef56"
down_revision: str | Sequence[str] | None = "f6a1b2c3d4e5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("agent_environments", sa.Column("display_name", sa.String(length=120)))
    op.add_column("agent_environments", sa.Column("avatar_asset_key", sa.String(length=512)))
    op.add_column("agent_environments", sa.Column("avatar_preset", sa.String(length=40)))
    op.add_column(
        "agent_environments",
        sa.Column("sort_order", sa.Integer(), server_default="0", nullable=False),
    )

    bind = op.get_bind()
    bind.execute(
        sa.text(
            """
            WITH ordered AS (
                SELECT
                    id,
                    ROW_NUMBER() OVER (
                        PARTITION BY user_id
                        ORDER BY created_at ASC, id ASC
                    ) - 1 AS position
                FROM agent_environments
            )
            UPDATE agent_environments AS env
            SET sort_order = ordered.position
            FROM ordered
            WHERE env.id = ordered.id
            """
        )
    )

    op.create_index(
        "ix_agent_environments_user_sort_order",
        "agent_environments",
        ["user_id", "sort_order"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_agent_environments_user_sort_order", table_name="agent_environments")
    op.drop_column("agent_environments", "sort_order")
    op.drop_column("agent_environments", "avatar_preset")
    op.drop_column("agent_environments", "avatar_asset_key")
    op.drop_column("agent_environments", "display_name")
