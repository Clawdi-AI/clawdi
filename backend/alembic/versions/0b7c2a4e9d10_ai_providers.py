"""ai providers

Revision ID: 0b7c2a4e9d10
Revises: 91d2c0f4e8a3
Create Date: 2026-06-01 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0b7c2a4e9d10"
down_revision: str | Sequence[str] | None = "91d2c0f4e8a3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "ai_providers",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("owner_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("scope", sa.String(length=40), server_default="account_global", nullable=False),
        sa.Column("provider_id", sa.String(length=80), nullable=False),
        sa.Column("type", sa.String(length=80), nullable=False),
        sa.Column("label", sa.String(length=200), nullable=True),
        sa.Column("base_url", sa.String(length=1000), nullable=False),
        sa.Column("default_model", sa.String(length=300), nullable=True),
        sa.Column("api_mode", sa.String(length=80), nullable=True),
        sa.Column("capabilities", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("auth_type", sa.String(length=80), nullable=False),
        sa.Column("auth_ref", sa.String(length=1000), nullable=True),
        sa.Column("auth_metadata", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("managed_by", sa.String(length=80), server_default="user", nullable=False),
        sa.Column("runtime_env_name", sa.String(length=128), nullable=True),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "owner_user_id",
            "provider_id",
            name="uq_ai_providers_owner_provider_id",
        ),
    )
    op.create_index(
        op.f("ix_ai_providers_owner_user_id"),
        "ai_providers",
        ["owner_user_id"],
        unique=False,
    )

    op.create_table(
        "ai_provider_auth_payloads",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("owner_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("provider_id", sa.String(length=80), nullable=False),
        sa.Column("auth_profile", sa.String(length=120), server_default="default", nullable=False),
        sa.Column("kind", sa.String(length=80), nullable=False),
        sa.Column("source", sa.String(length=80), nullable=False),
        sa.Column("encrypted_payload", sa.LargeBinary(), nullable=False),
        sa.Column("nonce", sa.LargeBinary(), nullable=False),
        sa.Column("payload_metadata", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "owner_user_id",
            "provider_id",
            "auth_profile",
            name="uq_ai_provider_auth_payloads_owner_provider_profile",
        ),
    )
    op.create_index(
        op.f("ix_ai_provider_auth_payloads_owner_user_id"),
        "ai_provider_auth_payloads",
        ["owner_user_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_ai_provider_auth_payloads_owner_user_id"),
        table_name="ai_provider_auth_payloads",
    )
    op.drop_table("ai_provider_auth_payloads")
    op.drop_index(op.f("ix_ai_providers_owner_user_id"), table_name="ai_providers")
    op.drop_table("ai_providers")
