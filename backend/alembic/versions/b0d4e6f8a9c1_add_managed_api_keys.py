"""add managed api keys

Revision ID: b0d4e6f8a9c1
Revises: 9a6c1f2d8e34
Create Date: 2026-07-09 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b0d4e6f8a9c1"
down_revision: str | Sequence[str] | None = "9a6c1f2d8e34"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "api_keys",
        sa.Column(
            "managed",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("api_keys", "managed")
