"""Add encrypted hosted runtime secret values.

Revision ID: a9c4e7d2f1b6
Revises: d7e9f1a2b3c4
Create Date: 2026-07-31 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "a9c4e7d2f1b6"
down_revision: str | Sequence[str] | None = "d7e9f1a2b3c4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "hosted_runtime_secrets",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("environment_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("secret_ref", sa.String(length=1000), nullable=False),
        sa.Column("encrypted_value", sa.LargeBinary(), nullable=False),
        sa.Column("nonce", sa.LargeBinary(), nullable=False),
        sa.Column(
            "key_version",
            sa.String(length=64),
            server_default="vault.v1",
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["environment_id"], ["hosted_runtime_states.environment_id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "environment_id",
            "secret_ref",
            name="uq_hosted_runtime_secrets_environment_ref",
        ),
    )
    op.create_index(
        "ix_hosted_runtime_secrets_environment_id",
        "hosted_runtime_secrets",
        ["environment_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_hosted_runtime_secrets_environment_id",
        table_name="hosted_runtime_secrets",
    )
    op.drop_table("hosted_runtime_secrets")
