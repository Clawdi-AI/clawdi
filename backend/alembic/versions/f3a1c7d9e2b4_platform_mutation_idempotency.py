"""Add durable platform mutation idempotency.

Revision ID: f3a1c7d9e2b4
Revises: a26c40c6965e
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "f3a1c7d9e2b4"
down_revision: str | Sequence[str] | None = "a26c40c6965e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "platform_mutation_idempotency",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("operation", sa.String(length=100), nullable=False),
        sa.Column("idempotency_key", sa.String(length=200), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("owner_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("resource_type", sa.String(length=80), nullable=False),
        sa.Column("resource_id", sa.String(length=200), nullable=True),
        sa.Column("response_status", sa.Integer(), nullable=False),
        sa.Column("encrypted_response", sa.LargeBinary(), nullable=False),
        sa.Column("response_nonce", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "operation",
            "idempotency_key",
            name="uq_platform_mutation_idempotency_operation_key",
        ),
    )
    op.create_index(
        "ix_platform_mutation_idempotency_owner_user_id",
        "platform_mutation_idempotency",
        ["owner_user_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_platform_mutation_idempotency_owner_user_id",
        table_name="platform_mutation_idempotency",
    )
    op.drop_table("platform_mutation_idempotency")
