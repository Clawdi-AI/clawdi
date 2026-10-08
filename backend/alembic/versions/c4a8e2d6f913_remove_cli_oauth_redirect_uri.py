"""Remove the retired CLI OAuth callback from the stored setting.

Revision ID: c4a8e2d6f913
Revises: b1c7d9e4f2a6
Create Date: 2026-10-08

Contract step (2026-10-08): deploy only after #1799's tolerant model is serving.
The normal automated deployment runs this migration first, while serving
processes tolerate both row shapes. The accompanying code then removes the
before validator, completing the dated transition TODO in the same release.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c4a8e2d6f913"
down_revision: str | Sequence[str] | None = "b1c7d9e4f2a6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        sa.text(
            """
            UPDATE app_settings
            SET value_json = value_json - 'redirect_uri'
            WHERE key = 'clerk_cli_oauth'
              AND jsonb_typeof(value_json) = 'object'
              AND value_json ? 'redirect_uri'
            """
        )
    )


def downgrade() -> None:
    # Irreversible data cleanup: do not invent or restore a retired callback.
    # No schema changes need reversing.
    pass
