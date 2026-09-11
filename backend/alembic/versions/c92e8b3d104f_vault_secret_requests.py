"""Add one-time Vault field requests.

Revision ID: c92e8b3d104f
Revises: b81d7a2c903e
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "c92e8b3d104f"
down_revision = "b81d7a2c903e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "vault_secret_requests",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column(
            "vault_id", sa.UUID(), sa.ForeignKey("vaults.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "project_id",
            sa.UUID(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("section", sa.String(200), nullable=False),
        sa.Column("fields", postgresql.JSONB(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("supplied_at", sa.DateTime(timezone=True)),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_vault_secret_requests_vault_id", "vault_secret_requests", ["vault_id"])


def downgrade() -> None:
    op.drop_table("vault_secret_requests")
