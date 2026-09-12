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
    # Take the DDL lock before rewriting history, excluding concurrent supplies/creates.
    op.execute("LOCK TABLE vault_secret_requests IN ACCESS EXCLUSIVE MODE")
    # Old readers use fields for supplied history. Retain every saved name and
    # its creation baseline (including explicit null for newly added fields).
    op.execute(
        "UPDATE vault_secret_requests SET fields = fields || extra_fields, "
        "field_baselines = (SELECT jsonb_object_agg(name, "
        "COALESCE(field_baselines -> name, 'null'::jsonb)) "
        "FROM jsonb_array_elements_text(fields || extra_fields) AS names(name)) "
        "WHERE supplied_at IS NOT NULL AND extra_fields <> '[]'::jsonb"
    )
    # No capability created under the new contract survives a rollback.
    op.execute(
        "UPDATE vault_secret_requests SET expires_at = LEAST(expires_at, now()), "
        "conflicted_at = COALESCE(conflicted_at, now()) WHERE supplied_at IS NULL"
    )
    op.drop_column("vault_secret_requests", "extra_fields")
