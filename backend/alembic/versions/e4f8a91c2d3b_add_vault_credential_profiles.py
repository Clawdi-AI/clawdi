"""add vault credential profiles

Revision ID: e4f8a91c2d3b
Revises: b8e4d1c6f23a
Create Date: 2026-05-19 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "e4f8a91c2d3b"
down_revision: str | Sequence[str] | None = "b8e4d1c6f23a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "vault_credential_profiles",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tool", sa.String(length=80), nullable=False),
        sa.Column("profile", sa.String(length=120), server_default="default", nullable=False),
        sa.Column("encrypted_payload", sa.LargeBinary(), nullable=False),
        sa.Column("nonce", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "project_id",
            "tool",
            "profile",
            name="uq_vault_credential_profiles_project_tool_profile",
        ),
    )
    op.create_index(
        op.f("ix_vault_credential_profiles_project_id"),
        "vault_credential_profiles",
        ["project_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_vault_credential_profiles_user_id"),
        "vault_credential_profiles",
        ["user_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_vault_credential_profiles_user_id"), table_name="vault_credential_profiles")
    op.drop_index(
        op.f("ix_vault_credential_profiles_project_id"),
        table_name="vault_credential_profiles",
    )
    op.drop_table("vault_credential_profiles")
