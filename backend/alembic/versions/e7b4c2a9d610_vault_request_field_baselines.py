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
    op.add_column(
        "vault_secret_requests",
        sa.Column("field_baselines", postgresql.JSONB(), nullable=True),
    )
    op.add_column("vault_secret_requests", sa.Column("conflicted_at", sa.DateTime(timezone=True)))
    # Preserve historical records, but no pre-cutover capability remains usable.
    op.execute("UPDATE vault_secret_requests SET field_baselines = '{}'::jsonb")
    op.execute(
        "UPDATE vault_secret_requests SET expires_at = LEAST(expires_at, now()) "
        "WHERE supplied_at IS NULL"
    )
    # No default: every new insert must explicitly supply its complete snapshot.
    op.alter_column("vault_secret_requests", "field_baselines", nullable=False)


def downgrade() -> None:
    op.execute(
        "UPDATE vault_secret_requests SET expires_at = LEAST(expires_at, now()) "
        "WHERE supplied_at IS NULL"
    )
    op.drop_column("vault_secret_requests", "conflicted_at")
    op.drop_column("vault_secret_requests", "field_baselines")
