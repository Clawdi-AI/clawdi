"""Drop obsolete WhatsApp runtime credential material.

Revision ID: f2b7d4c9a1e6
Revises: e8f4a1c9d2b7
Create Date: 2026-08-01 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "f2b7d4c9a1e6"
down_revision: str | Sequence[str] | None = "e8f4a1c9d2b7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_table("channel_whatsapp_auth_certs")
    op.drop_table("channel_agent_credentials")


def downgrade() -> None:
    op.create_table(
        "channel_agent_credentials",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("account_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("bot_agent_link_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("identity_pub_key_hash", sa.String(length=64), nullable=False),
        sa.Column("identity_public_key", sa.LargeBinary(), nullable=False),
        sa.Column("synthetic_jid", sa.String(length=300), nullable=False),
        sa.Column("encrypted_credentials", sa.LargeBinary(), nullable=False),
        sa.Column("credential_nonce", sa.LargeBinary(), nullable=False),
        sa.Column("config", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["account_id"], ["channel_accounts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["bot_agent_link_id"],
            ["channel_bot_agent_links.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "account_id",
            "identity_pub_key_hash",
            name="uq_channel_agent_credentials_account_identity",
        ),
    )
    op.create_index(
        op.f("ix_channel_agent_credentials_account_id"),
        "channel_agent_credentials",
        ["account_id"],
    )
    op.create_index(
        op.f("ix_channel_agent_credentials_bot_agent_link_id"),
        "channel_agent_credentials",
        ["bot_agent_link_id"],
    )
    op.create_index(
        op.f("ix_channel_agent_credentials_provider"),
        "channel_agent_credentials",
        ["provider"],
    )
    op.create_index(
        op.f("ix_channel_agent_credentials_revoked_at"),
        "channel_agent_credentials",
        ["revoked_at"],
    )
    op.create_index(
        op.f("ix_channel_agent_credentials_user_id"),
        "channel_agent_credentials",
        ["user_id"],
    )

    op.create_table(
        "channel_whatsapp_auth_certs",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("account_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("root_public_key", sa.LargeBinary(), nullable=False),
        sa.Column("encrypted_root_private_key", sa.LargeBinary(), nullable=False),
        sa.Column("root_private_key_nonce", sa.LargeBinary(), nullable=False),
        sa.Column("intermediate_public_key", sa.LargeBinary(), nullable=False),
        sa.Column("encrypted_intermediate_private_key", sa.LargeBinary(), nullable=False),
        sa.Column("intermediate_private_key_nonce", sa.LargeBinary(), nullable=False),
        sa.Column("serial", sa.Integer(), server_default="0", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["account_id"], ["channel_accounts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_channel_whatsapp_auth_certs_account_id"),
        "channel_whatsapp_auth_certs",
        ["account_id"],
        unique=True,
    )
    op.create_index(
        op.f("ix_channel_whatsapp_auth_certs_user_id"),
        "channel_whatsapp_auth_certs",
        ["user_id"],
    )
