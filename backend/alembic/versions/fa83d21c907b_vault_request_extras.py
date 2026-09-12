"""Capture section creation snapshots and record user-supplied extra names."""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "fa83d21c907b"
down_revision = "e7b4c2a9d610"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "vault_secret_requests",
        sa.Column("extra_fields", postgresql.JSONB(), nullable=False, server_default="[]"),
    )
    # Earlier links have no full section snapshot. Preserve supplied history and values.
    op.execute(
        "UPDATE vault_secret_requests SET expires_at = LEAST(expires_at, now()), "
        "conflicted_at = now() WHERE supplied_at IS NULL"
    )


def downgrade() -> None:
    op.drop_column("vault_secret_requests", "extra_fields")
