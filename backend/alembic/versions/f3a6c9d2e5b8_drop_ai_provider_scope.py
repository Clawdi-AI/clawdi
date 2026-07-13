"""drop constant AI provider scope

Revision ID: f3a6c9d2e5b8
Revises: d8f2a1c4b6e9
Create Date: 2026-07-13 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f3a6c9d2e5b8"
down_revision: str | Sequence[str] | None = "d8f2a1c4b6e9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_column("ai_providers", "scope")


def downgrade() -> None:
    op.add_column(
        "ai_providers",
        sa.Column(
            "scope",
            sa.String(length=40),
            server_default="account_global",
            nullable=False,
        ),
    )
