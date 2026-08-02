"""add channel retention indexes

Revision ID: b5d8e2a7c4f1
Revises: f3b7c1d9e5a2
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b5d8e2a7c4f1"
down_revision: str | Sequence[str] | None = "f3b7c1d9e5a2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # These tables are written by live channel ingress and delivery paths.
    # Build the demonstrated retention indexes without blocking those writes.
    with op.get_context().autocommit_block():
        op.create_index(
            "ix_channel_bot_agent_links_retention_inactive",
            "channel_bot_agent_links",
            ["id"],
            postgresql_concurrently=True,
            postgresql_where=sa.text("status <> 'active' OR archived_at IS NOT NULL"),
        )
        op.create_index(
            "ix_channel_debug_events_retention_created",
            "channel_debug_events",
            ["created_at", "id"],
            postgresql_concurrently=True,
            postgresql_where=sa.text("provider IN ('telegram', 'discord')"),
        )
        op.create_index(
            "ix_channel_pair_codes_retention_terminal",
            "channel_pair_codes",
            ["updated_at", "id"],
            postgresql_concurrently=True,
            postgresql_include=["account_id"],
            postgresql_where=sa.text("status IN ('claimed', 'revoked')"),
        )
        op.create_index(
            "ix_channel_pair_codes_retention_expired",
            "channel_pair_codes",
            ["expires_at", "id"],
            postgresql_concurrently=True,
            postgresql_include=["account_id"],
            postgresql_where=sa.text("status = 'pending'"),
        )
        op.create_index(
            "ix_channel_agent_references_retention_orphaned",
            "channel_agent_references",
            ["updated_at", "id"],
            postgresql_concurrently=True,
            postgresql_where=sa.text(
                "provider IN ('telegram', 'discord') AND bot_agent_link_id IS NULL"
            ),
        )
        op.create_index(
            "ix_channel_agent_references_link_retention",
            "channel_agent_references",
            ["bot_agent_link_id", "updated_at", "id"],
            postgresql_concurrently=True,
            postgresql_where=sa.text(
                "provider IN ('telegram', 'discord') AND bot_agent_link_id IS NOT NULL"
            ),
        )
        op.create_index(
            "ix_channel_agent_references_discord_interaction",
            "channel_agent_references",
            ["created_at", "id"],
            postgresql_concurrently=True,
            postgresql_where=sa.text(
                "provider = 'discord' AND ref_kind IN "
                "('discord_interaction_id_token', 'discord_interaction_token')"
            ),
        )
        op.create_index(
            "ix_channel_messages_retention_delivered",
            "channel_messages",
            ["delivered_at", "id"],
            postgresql_concurrently=True,
            postgresql_where=sa.text("delivered_at IS NOT NULL"),
        )
        op.create_index(
            "ix_channel_messages_retention_unbound",
            "channel_messages",
            ["created_at", "id"],
            postgresql_concurrently=True,
            postgresql_where=sa.text("direction = 'inbound' AND binding_id IS NULL"),
        )
        op.create_index(
            "ix_channel_messages_discord_interaction_token",
            "channel_messages",
            ["created_at", "id"],
            postgresql_concurrently=True,
            postgresql_where=sa.text(
                "(payload ? 'token' AND payload ? 'application_id') OR "
                "(payload ->> 't' = 'INTERACTION_CREATE' AND (payload -> 'd') ? 'token')"
            ),
        )
        op.create_index(
            "ix_channel_deliveries_retention_terminal",
            "channel_deliveries",
            ["updated_at", "id"],
            postgresql_concurrently=True,
            postgresql_include=["message_id", "account_id"],
            postgresql_where=sa.text("status IN ('succeeded', 'failed')"),
        )


def downgrade() -> None:
    with op.get_context().autocommit_block():
        for table_name, index_name in (
            ("channel_deliveries", "ix_channel_deliveries_retention_terminal"),
            ("channel_messages", "ix_channel_messages_discord_interaction_token"),
            ("channel_messages", "ix_channel_messages_retention_unbound"),
            ("channel_messages", "ix_channel_messages_retention_delivered"),
            (
                "channel_agent_references",
                "ix_channel_agent_references_discord_interaction",
            ),
            (
                "channel_agent_references",
                "ix_channel_agent_references_link_retention",
            ),
            (
                "channel_agent_references",
                "ix_channel_agent_references_retention_orphaned",
            ),
            ("channel_pair_codes", "ix_channel_pair_codes_retention_expired"),
            ("channel_pair_codes", "ix_channel_pair_codes_retention_terminal"),
            ("channel_debug_events", "ix_channel_debug_events_retention_created"),
            (
                "channel_bot_agent_links",
                "ix_channel_bot_agent_links_retention_inactive",
            ),
        ):
            op.drop_index(
                index_name,
                table_name=table_name,
                postgresql_concurrently=True,
            )
