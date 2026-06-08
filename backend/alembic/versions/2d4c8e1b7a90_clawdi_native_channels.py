"""clawdi native channels

Revision ID: 2d4c8e1b7a90
Revises: 0b7c2a4e9d10
Create Date: 2026-06-05 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "2d4c8e1b7a90"
down_revision: str | Sequence[str] | None = "0b7c2a4e9d10"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _timestamp_columns() -> tuple[sa.Column, sa.Column]:
    return (
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )


def upgrade() -> None:
    op.execute("CREATE SEQUENCE IF NOT EXISTS channel_messages_inbox_sequence_seq")

    op.create_table(
        "channel_accounts",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("status", sa.String(length=32), server_default="active", nullable=False),
        sa.Column("visibility", sa.String(length=32), server_default="private", nullable=False),
        sa.Column("encrypted_provider_token", sa.LargeBinary(), nullable=True),
        sa.Column("provider_token_nonce", sa.LargeBinary(), nullable=True),
        sa.Column("webhook_secret_hash", sa.String(length=64), nullable=False),
        sa.Column("config", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamp_columns(),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_channel_accounts_provider"), "channel_accounts", ["provider"])
    op.create_index(op.f("ix_channel_accounts_user_id"), "channel_accounts", ["user_id"])
    op.create_index(op.f("ix_channel_accounts_visibility"), "channel_accounts", ["visibility"])
    op.create_index(
        "uq_channel_accounts_user_provider_name_active",
        "channel_accounts",
        ["user_id", "provider", "name"],
        unique=True,
        postgresql_where=sa.text("archived_at IS NULL"),
    )

    op.create_table(
        "channel_bot_agent_links",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("account_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("agent_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("agent_token_hash", sa.String(length=64), nullable=True),
        sa.Column("status", sa.String(length=32), server_default="active", nullable=False),
        sa.Column("config", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamp_columns(),
        sa.ForeignKeyConstraint(["account_id"], ["channel_accounts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["agent_id"], ["agent_environments.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_channel_bot_agent_links_account_id"),
        "channel_bot_agent_links",
        ["account_id"],
    )
    op.create_index(
        op.f("ix_channel_bot_agent_links_agent_id"),
        "channel_bot_agent_links",
        ["agent_id"],
    )
    op.create_index(
        op.f("ix_channel_bot_agent_links_agent_token_hash"),
        "channel_bot_agent_links",
        ["agent_token_hash"],
        unique=True,
    )
    op.create_index(
        op.f("ix_channel_bot_agent_links_user_id"),
        "channel_bot_agent_links",
        ["user_id"],
    )
    op.create_index(
        "uq_channel_bot_agent_links_account_agent_active",
        "channel_bot_agent_links",
        ["account_id", "agent_id"],
        unique=True,
        postgresql_where=sa.text("archived_at IS NULL"),
    )

    op.create_table(
        "channel_secrets",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("account_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("encrypted_value", sa.LargeBinary(), nullable=False),
        sa.Column("value_nonce", sa.LargeBinary(), nullable=False),
        *_timestamp_columns(),
        sa.ForeignKeyConstraint(["account_id"], ["channel_accounts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("account_id", "name", name="uq_channel_secrets_account_name"),
    )
    op.create_index(op.f("ix_channel_secrets_account_id"), "channel_secrets", ["account_id"])
    op.create_index(op.f("ix_channel_secrets_user_id"), "channel_secrets", ["user_id"])

    op.create_table(
        "channel_bindings",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("account_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("bot_agent_link_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("external_chat_id", sa.String(length=300), nullable=False),
        sa.Column("external_chat_type", sa.String(length=40), nullable=True),
        sa.Column("external_chat_name", sa.String(length=300), nullable=True),
        sa.Column("paired_external_user_id", sa.String(length=300), nullable=True),
        sa.Column("status", sa.String(length=32), server_default="active", nullable=False),
        *_timestamp_columns(),
        sa.ForeignKeyConstraint(["account_id"], ["channel_accounts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["bot_agent_link_id"],
            ["channel_bot_agent_links.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_channel_bindings_account_id"), "channel_bindings", ["account_id"])
    op.create_index(
        op.f("ix_channel_bindings_bot_agent_link_id"),
        "channel_bindings",
        ["bot_agent_link_id"],
    )
    op.create_index(op.f("ix_channel_bindings_user_id"), "channel_bindings", ["user_id"])
    op.create_index(
        "uq_channel_bindings_account_external_chat_active",
        "channel_bindings",
        ["account_id", "external_chat_id"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )

    op.create_table(
        "channel_binding_aliases",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("account_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("bot_agent_link_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("binding_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("alias_external_chat_id", sa.String(length=300), nullable=False),
        sa.Column("alias_kind", sa.String(length=40), server_default="jid_alias", nullable=False),
        *_timestamp_columns(),
        sa.ForeignKeyConstraint(["account_id"], ["channel_accounts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["bot_agent_link_id"],
            ["channel_bot_agent_links.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(["binding_id"], ["channel_bindings.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "account_id",
            "alias_external_chat_id",
            name="uq_channel_binding_aliases_account_alias",
        ),
    )
    op.create_index(
        op.f("ix_channel_binding_aliases_account_id"),
        "channel_binding_aliases",
        ["account_id"],
    )
    op.create_index(
        op.f("ix_channel_binding_aliases_binding_id"),
        "channel_binding_aliases",
        ["binding_id"],
    )
    op.create_index(
        op.f("ix_channel_binding_aliases_bot_agent_link_id"),
        "channel_binding_aliases",
        ["bot_agent_link_id"],
    )
    op.create_index(
        op.f("ix_channel_binding_aliases_user_id"),
        "channel_binding_aliases",
        ["user_id"],
    )

    op.create_table(
        "channel_pair_codes",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("account_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("bot_agent_link_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), server_default="pending", nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("claimed_external_chat_id", sa.String(length=300), nullable=True),
        sa.Column("claimed_external_user_id", sa.String(length=300), nullable=True),
        *_timestamp_columns(),
        sa.ForeignKeyConstraint(["account_id"], ["channel_accounts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["bot_agent_link_id"],
            ["channel_bot_agent_links.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code_hash", name="uq_channel_pair_codes_code_hash"),
    )
    op.create_index(op.f("ix_channel_pair_codes_account_id"), "channel_pair_codes", ["account_id"])
    op.create_index(
        op.f("ix_channel_pair_codes_bot_agent_link_id"),
        "channel_pair_codes",
        ["bot_agent_link_id"],
    )
    op.create_index(op.f("ix_channel_pair_codes_user_id"), "channel_pair_codes", ["user_id"])

    op.create_table(
        "channel_messages",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("account_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("bot_agent_link_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("binding_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("direction", sa.String(length=16), nullable=False),
        sa.Column(
            "inbox_sequence",
            sa.BigInteger(),
            server_default=sa.text("nextval('channel_messages_inbox_sequence_seq'::regclass)"),
            nullable=False,
        ),
        sa.Column("external_chat_id", sa.String(length=300), nullable=False),
        sa.Column("provider_message_id", sa.String(length=300), nullable=True),
        sa.Column("text", sa.String(length=4096), nullable=True),
        sa.Column("payload", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamp_columns(),
        sa.ForeignKeyConstraint(["account_id"], ["channel_accounts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["bot_agent_link_id"],
            ["channel_bot_agent_links.id"],
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(["binding_id"], ["channel_bindings.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_channel_messages_account_id"), "channel_messages", ["account_id"])
    op.create_index(
        op.f("ix_channel_messages_binding_id"),
        "channel_messages",
        ["binding_id"],
    )
    op.create_index(
        op.f("ix_channel_messages_bot_agent_link_id"),
        "channel_messages",
        ["bot_agent_link_id"],
    )
    op.create_index(
        op.f("ix_channel_messages_delivered_at"),
        "channel_messages",
        ["delivered_at"],
    )
    op.create_index(
        op.f("ix_channel_messages_external_chat_id"),
        "channel_messages",
        ["external_chat_id"],
    )
    op.create_index(
        op.f("ix_channel_messages_inbox_sequence"),
        "channel_messages",
        ["inbox_sequence"],
    )
    op.create_index(
        "ix_channel_messages_inbox_pending",
        "channel_messages",
        ["account_id", "direction", "delivered_at", "inbox_sequence"],
    )
    op.create_index(op.f("ix_channel_messages_user_id"), "channel_messages", ["user_id"])

    op.create_table(
        "channel_debug_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("account_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("external_chat_id", sa.String(length=300), nullable=True),
        sa.Column("direction", sa.String(length=32), nullable=False),
        sa.Column("stage", sa.String(length=80), nullable=False),
        sa.Column("outcome", sa.String(length=32), nullable=False),
        sa.Column("request_id", sa.String(length=120), nullable=True),
        sa.Column("status_code", sa.Integer(), nullable=True),
        sa.Column("error", sa.String(length=500), nullable=True),
        sa.Column("details", postgresql.JSONB(none_as_null=True), nullable=True),
        *_timestamp_columns(),
        sa.ForeignKeyConstraint(["account_id"], ["channel_accounts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_channel_debug_events_account_id"),
        "channel_debug_events",
        ["account_id"],
    )
    op.create_index(
        op.f("ix_channel_debug_events_direction"),
        "channel_debug_events",
        ["direction"],
    )
    op.create_index(
        op.f("ix_channel_debug_events_external_chat_id"),
        "channel_debug_events",
        ["external_chat_id"],
    )
    op.create_index(op.f("ix_channel_debug_events_outcome"), "channel_debug_events", ["outcome"])
    op.create_index(op.f("ix_channel_debug_events_provider"), "channel_debug_events", ["provider"])
    op.create_index(
        op.f("ix_channel_debug_events_request_id"),
        "channel_debug_events",
        ["request_id"],
    )
    op.create_index(op.f("ix_channel_debug_events_stage"), "channel_debug_events", ["stage"])
    op.create_index(op.f("ix_channel_debug_events_user_id"), "channel_debug_events", ["user_id"])

    op.create_table(
        "channel_attachment_uploads",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("account_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("upload_path", sa.String(length=500), nullable=False),
        sa.Column("file_key", sa.String(length=800), nullable=False),
        sa.Column("file_name", sa.String(length=300), nullable=True),
        sa.Column("content_type", sa.String(length=120), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamp_columns(),
        sa.ForeignKeyConstraint(["account_id"], ["channel_accounts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "account_id",
            "upload_path",
            name="uq_channel_attachment_uploads_account_path",
        ),
    )
    op.create_index(
        op.f("ix_channel_attachment_uploads_account_id"),
        "channel_attachment_uploads",
        ["account_id"],
    )
    op.create_index(
        op.f("ix_channel_attachment_uploads_consumed_at"),
        "channel_attachment_uploads",
        ["consumed_at"],
    )
    op.create_index(
        op.f("ix_channel_attachment_uploads_expires_at"),
        "channel_attachment_uploads",
        ["expires_at"],
    )
    op.create_index(
        op.f("ix_channel_attachment_uploads_user_id"),
        "channel_attachment_uploads",
        ["user_id"],
    )

    op.create_table(
        "channel_scheduled_messages",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("account_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("bot_agent_link_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("binding_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("external_chat_id", sa.String(length=300), nullable=False),
        sa.Column("status", sa.String(length=32), server_default="scheduled", nullable=False),
        sa.Column("scheduled_for", sa.DateTime(timezone=True), nullable=True),
        sa.Column("payload", postgresql.JSONB(none_as_null=True), nullable=False),
        *_timestamp_columns(),
        sa.ForeignKeyConstraint(["account_id"], ["channel_accounts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["bot_agent_link_id"],
            ["channel_bot_agent_links.id"],
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(["binding_id"], ["channel_bindings.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_channel_scheduled_messages_account_id"),
        "channel_scheduled_messages",
        ["account_id"],
    )
    op.create_index(
        op.f("ix_channel_scheduled_messages_binding_id"),
        "channel_scheduled_messages",
        ["binding_id"],
    )
    op.create_index(
        op.f("ix_channel_scheduled_messages_bot_agent_link_id"),
        "channel_scheduled_messages",
        ["bot_agent_link_id"],
    )
    op.create_index(
        op.f("ix_channel_scheduled_messages_external_chat_id"),
        "channel_scheduled_messages",
        ["external_chat_id"],
    )
    op.create_index(
        op.f("ix_channel_scheduled_messages_scheduled_for"),
        "channel_scheduled_messages",
        ["scheduled_for"],
    )
    op.create_index(
        op.f("ix_channel_scheduled_messages_status"),
        "channel_scheduled_messages",
        ["status"],
    )
    op.create_index(
        op.f("ix_channel_scheduled_messages_user_id"),
        "channel_scheduled_messages",
        ["user_id"],
    )

    op.create_table(
        "channel_agent_references",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("account_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("bot_agent_link_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("binding_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("message_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("ref_kind", sa.String(length=80), nullable=False),
        sa.Column("ref_value", sa.String(length=800), nullable=False),
        sa.Column("metadata", postgresql.JSONB(none_as_null=True), nullable=True),
        *_timestamp_columns(),
        sa.ForeignKeyConstraint(["account_id"], ["channel_accounts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["bot_agent_link_id"],
            ["channel_bot_agent_links.id"],
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(["binding_id"], ["channel_bindings.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["message_id"], ["channel_messages.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "account_id",
            "bot_agent_link_id",
            "ref_kind",
            "ref_value",
            name="uq_channel_agent_references_account_link_kind_value",
        ),
    )
    op.create_index(
        op.f("ix_channel_agent_references_account_id"),
        "channel_agent_references",
        ["account_id"],
    )
    op.create_index(
        op.f("ix_channel_agent_references_binding_id"),
        "channel_agent_references",
        ["binding_id"],
    )
    op.create_index(
        op.f("ix_channel_agent_references_bot_agent_link_id"),
        "channel_agent_references",
        ["bot_agent_link_id"],
    )
    op.create_index(
        op.f("ix_channel_agent_references_message_id"),
        "channel_agent_references",
        ["message_id"],
    )
    op.create_index(
        op.f("ix_channel_agent_references_provider"),
        "channel_agent_references",
        ["provider"],
    )
    op.create_index(
        op.f("ix_channel_agent_references_ref_kind"),
        "channel_agent_references",
        ["ref_kind"],
    )
    op.create_index(
        op.f("ix_channel_agent_references_user_id"),
        "channel_agent_references",
        ["user_id"],
    )

    op.create_table(
        "channel_deliveries",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("account_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("bot_agent_link_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("message_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("status", sa.String(length=32), server_default="pending", nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("max_attempts", sa.Integer(), server_default="5", nullable=False),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("locked_by", sa.String(length=120), nullable=True),
        sa.Column("last_error", sa.String(length=1000), nullable=True),
        sa.Column("provider_response", postgresql.JSONB(none_as_null=True), nullable=True),
        *_timestamp_columns(),
        sa.ForeignKeyConstraint(["account_id"], ["channel_accounts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["bot_agent_link_id"],
            ["channel_bot_agent_links.id"],
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(["message_id"], ["channel_messages.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_channel_deliveries_account_id"), "channel_deliveries", ["account_id"])
    op.create_index(
        op.f("ix_channel_deliveries_bot_agent_link_id"),
        "channel_deliveries",
        ["bot_agent_link_id"],
    )
    op.create_index(
        "ix_channel_deliveries_due",
        "channel_deliveries",
        ["status", "next_attempt_at", "created_at"],
    )
    op.create_index(op.f("ix_channel_deliveries_message_id"), "channel_deliveries", ["message_id"])
    op.create_index(op.f("ix_channel_deliveries_status"), "channel_deliveries", ["status"])
    op.create_index(op.f("ix_channel_deliveries_user_id"), "channel_deliveries", ["user_id"])

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
        *_timestamp_columns(),
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
        *_timestamp_columns(),
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


def downgrade() -> None:
    op.drop_table("channel_whatsapp_auth_certs")
    op.drop_table("channel_agent_credentials")
    op.drop_table("channel_deliveries")
    op.drop_table("channel_agent_references")
    op.drop_table("channel_scheduled_messages")
    op.drop_table("channel_attachment_uploads")
    op.drop_table("channel_debug_events")
    op.drop_table("channel_messages")
    op.execute("DROP SEQUENCE IF EXISTS channel_messages_inbox_sequence_seq")
    op.drop_table("channel_pair_codes")
    op.drop_table("channel_binding_aliases")
    op.drop_table("channel_bindings")
    op.drop_table("channel_secrets")
    op.drop_table("channel_bot_agent_links")
    op.drop_table("channel_accounts")
