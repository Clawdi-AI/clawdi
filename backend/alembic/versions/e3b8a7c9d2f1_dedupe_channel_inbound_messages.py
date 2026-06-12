"""hosted runtime and channel follow-up state

Production preflight on 2026-06-12 reported channel_messages at reltuples=-1
and 80 kB total size, so regular unique index creation is acceptable for this
release. Revisit CONCURRENTLY if the table is large in a future environment.

Revision ID: e3b8a7c9d2f1
Revises: 2d4c8e1b7a90
Create Date: 2026-06-12 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "e3b8a7c9d2f1"
down_revision: str | Sequence[str] | None = "2d4c8e1b7a90"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "hosted_runtime_states",
        sa.Column("environment_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("deployment_id", sa.String(length=200), nullable=False),
        sa.Column("app_id", sa.String(length=200), nullable=True),
        sa.Column("instance_id", sa.String(length=200), nullable=False),
        sa.Column("generation", sa.Integer(), nullable=False),
        sa.Column("provider_id", sa.String(length=80), nullable=True),
        sa.Column("system", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("control_plane", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("clawdi_cli", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("runtimes", postgresql.JSONB(none_as_null=True), nullable=False),
        sa.Column("live_sync", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("recovery", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("mitm_profiles", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("observed", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("mcp", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("tools", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.ForeignKeyConstraint(
            ["environment_id"],
            ["agent_environments.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("environment_id"),
    )
    op.add_column(
        "channel_bot_agent_links",
        sa.Column("encrypted_agent_token", sa.LargeBinary(), nullable=True),
    )
    op.add_column(
        "channel_bot_agent_links",
        sa.Column("agent_token_nonce", sa.LargeBinary(), nullable=True),
    )
    op.create_table(
        "control_plane_audit_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("actor_type", sa.String(length=32), nullable=False),
        sa.Column("actor_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("target_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("source", sa.String(length=64), nullable=False),
        sa.Column("action", sa.String(length=100), nullable=False),
        sa.Column("resource_type", sa.String(length=80), nullable=False),
        sa.Column("resource_id", sa.String(length=200), nullable=True),
        sa.Column("environment_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("channel_account_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("channel_agent_link_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "details",
            postgresql.JSONB(none_as_null=True),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["actor_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["target_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["environment_id"], ["agent_environments.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["channel_account_id"], ["channel_accounts.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["channel_agent_link_id"],
            ["channel_bot_agent_links.id"],
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_control_plane_audit_events_target_created",
        "control_plane_audit_events",
        ["target_user_id", "created_at"],
    )
    for column in (
        "actor_type",
        "actor_user_id",
        "target_user_id",
        "source",
        "action",
        "resource_type",
        "resource_id",
        "environment_id",
        "channel_account_id",
        "channel_agent_link_id",
    ):
        op.create_index(
            f"ix_control_plane_audit_events_{column}",
            "control_plane_audit_events",
            [column],
        )
    op.execute(
        """
        WITH ranked AS (
            SELECT
                id,
                row_number() OVER (
                    PARTITION BY
                        account_id,
                        external_chat_id,
                        provider_message_id,
                        bot_agent_link_id
                    ORDER BY created_at ASC, id ASC
                ) AS duplicate_rank
            FROM channel_messages
            WHERE direction = 'inbound'
              AND provider_message_id IS NOT NULL
              AND bot_agent_link_id IS NOT NULL
        )
        DELETE FROM channel_messages AS message
        USING ranked
        WHERE message.id = ranked.id
          AND ranked.duplicate_rank > 1
        """
    )
    op.execute(
        """
        WITH ranked AS (
            SELECT
                id,
                row_number() OVER (
                    PARTITION BY account_id, external_chat_id, provider_message_id
                    ORDER BY created_at ASC, id ASC
                ) AS duplicate_rank
            FROM channel_messages
            WHERE direction = 'inbound'
              AND provider_message_id IS NOT NULL
              AND bot_agent_link_id IS NULL
        )
        DELETE FROM channel_messages AS message
        USING ranked
        WHERE message.id = ranked.id
          AND ranked.duplicate_rank > 1
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS ux_channel_messages_inbound_provider_message_bound
        ON channel_messages (
            account_id,
            external_chat_id,
            provider_message_id,
            bot_agent_link_id
        )
        WHERE direction = 'inbound'
          AND provider_message_id IS NOT NULL
          AND bot_agent_link_id IS NOT NULL
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS ux_channel_messages_inbound_provider_message_unbound
        ON channel_messages (account_id, external_chat_id, provider_message_id)
        WHERE direction = 'inbound'
          AND provider_message_id IS NOT NULL
          AND bot_agent_link_id IS NULL
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ux_channel_messages_inbound_provider_message_unbound")
    op.execute("DROP INDEX IF EXISTS ux_channel_messages_inbound_provider_message_bound")
    for column in (
        "channel_agent_link_id",
        "channel_account_id",
        "environment_id",
        "resource_id",
        "resource_type",
        "action",
        "source",
        "target_user_id",
        "actor_user_id",
        "actor_type",
    ):
        op.drop_index(
            f"ix_control_plane_audit_events_{column}",
            table_name="control_plane_audit_events",
        )
    op.drop_index(
        "ix_control_plane_audit_events_target_created",
        table_name="control_plane_audit_events",
    )
    op.drop_table("control_plane_audit_events")
    op.drop_column("channel_bot_agent_links", "agent_token_nonce")
    op.drop_column("channel_bot_agent_links", "encrypted_agent_token")
    op.drop_table("hosted_runtime_states")
