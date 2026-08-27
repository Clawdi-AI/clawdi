"""Add shared API rate-limit buckets and SSE leases.

Revision ID: a9c4e2f7b1d6
Revises: c6e8a1f4d2b9
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "a9c4e2f7b1d6"
down_revision: str | Sequence[str] | None = "c6e8a1f4d2b9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "shared_rate_limit_buckets",
        sa.Column("namespace", sa.String(length=64), nullable=False),
        sa.Column("key_hash", sa.String(length=64), nullable=False),
        sa.Column(
            "attempts",
            postgresql.ARRAY(sa.DateTime(timezone=True)),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint(
            "namespace",
            "key_hash",
            name="pk_shared_rate_limit_buckets",
        ),
    )
    op.create_index(
        "ix_shared_rate_limit_buckets_expiry",
        "shared_rate_limit_buckets",
        ["namespace", "expires_at"],
    )

    op.create_table(
        "sync_subscription_leases",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("bound_api_key_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["bound_api_key_id"],
            ["api_keys.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_sync_subscription_leases_user_expiry",
        "sync_subscription_leases",
        ["user_id", "expires_at"],
    )
    op.create_index(
        "ix_sync_subscription_leases_bound_key_expiry",
        "sync_subscription_leases",
        ["bound_api_key_id", "expires_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_sync_subscription_leases_bound_key_expiry",
        table_name="sync_subscription_leases",
    )
    op.drop_index(
        "ix_sync_subscription_leases_user_expiry",
        table_name="sync_subscription_leases",
    )
    op.drop_table("sync_subscription_leases")
    op.drop_index(
        "ix_shared_rate_limit_buckets_expiry",
        table_name="shared_rate_limit_buckets",
    )
    op.drop_table("shared_rate_limit_buckets")
