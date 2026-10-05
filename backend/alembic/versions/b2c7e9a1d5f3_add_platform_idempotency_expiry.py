"""Bound platform mutation idempotency retention.

Revision ID: b2c7e9a1d5f3
Revises: a5d8f3c1e7b9
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b2c7e9a1d5f3"
down_revision: str | Sequence[str] | None = "a5d8f3c1e7b9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_FOREIGN_KEY = "platform_mutation_idempotency_owner_user_id_fkey"


def upgrade() -> None:
    op.add_column(
        "platform_mutation_idempotency",
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute(
        sa.text(
            "UPDATE platform_mutation_idempotency "
            "SET expires_at = created_at + INTERVAL '7 days' "
            "WHERE expires_at IS NULL"
        )
    )
    op.alter_column("platform_mutation_idempotency", "expires_at", nullable=False)
    op.create_index(
        "ix_platform_mutation_idempotency_expires_at",
        "platform_mutation_idempotency",
        ["expires_at"],
    )
    op.drop_constraint(_FOREIGN_KEY, "platform_mutation_idempotency", type_="foreignkey")
    op.create_foreign_key(
        _FOREIGN_KEY,
        "platform_mutation_idempotency",
        "users",
        ["owner_user_id"],
        ["id"],
        ondelete="CASCADE",
    )


def downgrade() -> None:
    op.drop_constraint(_FOREIGN_KEY, "platform_mutation_idempotency", type_="foreignkey")
    op.create_foreign_key(
        _FOREIGN_KEY,
        "platform_mutation_idempotency",
        "users",
        ["owner_user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.drop_index(
        "ix_platform_mutation_idempotency_expires_at",
        table_name="platform_mutation_idempotency",
    )
    op.drop_column("platform_mutation_idempotency", "expires_at")
