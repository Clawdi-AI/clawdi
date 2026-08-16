"""Add durable AI provider incarnation identity.

Revision ID: f7c2d4a9e1b6
Revises: e6a1c9f3b7d2
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "f7c2d4a9e1b6"
down_revision: str | Sequence[str] | None = "e6a1c9f3b7d2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "ai_providers",
        sa.Column(
            "incarnation_id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=True,
        ),
    )
    op.execute(
        sa.text(
            "UPDATE ai_providers SET incarnation_id = gen_random_uuid() "
            "WHERE incarnation_id IS NULL"
        )
    )
    op.alter_column("ai_providers", "incarnation_id", nullable=False)


def downgrade() -> None:
    op.drop_column("ai_providers", "incarnation_id")
