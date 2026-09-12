"""Allow request-local optimistic updates of existing Vault fields.

Revision ID: e7b4c2a9d610
Revises: d3e5f7a9b1c2
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "e7b4c2a9d610"
down_revision = "d3e5f7a9b1c2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Empty baselines preserve absent-only authority for every old pending request.
    op.add_column(
        "vault_secret_requests",
        sa.Column("field_baselines", postgresql.JSONB(), nullable=False, server_default="{}"),
    )
    op.add_column("vault_secret_requests", sa.Column("conflicted_at", sa.DateTime(timezone=True)))


def downgrade() -> None:
    # Every new-format request records a baseline for each field, including null
    # for absence. Expire these and terminal legacy conflicts before dropping the
    # state, so old code cannot block fresh requests behind unusable v2 links.
    op.execute(
        "UPDATE vault_secret_requests SET expires_at = LEAST(expires_at, now()) "
        "WHERE supplied_at IS NULL AND "
        "(field_baselines <> '{}'::jsonb OR conflicted_at IS NOT NULL)"
    )
    op.drop_column("vault_secret_requests", "conflicted_at")
    op.drop_column("vault_secret_requests", "field_baselines")
