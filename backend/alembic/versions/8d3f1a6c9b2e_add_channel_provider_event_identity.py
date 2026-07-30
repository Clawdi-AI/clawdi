"""Add channel provider event identity.

Revision ID: 8d3f1a6c9b2e
Revises: 7c2e9a4b6d1f
Create Date: 2026-07-30 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "8d3f1a6c9b2e"
down_revision: str | Sequence[str] | None = "7c2e9a4b6d1f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "channel_messages",
        sa.Column("provider_event_id", sa.String(length=300), nullable=True),
    )
    op.execute(
        "UPDATE channel_messages SET provider_event_id = provider_message_id "
        "WHERE direction = 'inbound' AND provider_message_id IS NOT NULL"
    )
    op.drop_index("ux_channel_messages_inbound_provider_message_bound")
    op.drop_index("ux_channel_messages_inbound_provider_message_unbound")
    op.create_index(
        "ux_channel_messages_inbound_provider_message_bound",
        "channel_messages",
        ["account_id", "external_chat_id", "provider_event_id", "bot_agent_link_id"],
        unique=True,
        postgresql_where=sa.text(
            "direction = 'inbound' AND provider_event_id IS NOT NULL "
            "AND bot_agent_link_id IS NOT NULL"
        ),
    )
    op.create_index(
        "ux_channel_messages_inbound_provider_message_unbound",
        "channel_messages",
        ["account_id", "external_chat_id", "provider_event_id"],
        unique=True,
        postgresql_where=sa.text(
            "direction = 'inbound' AND provider_event_id IS NOT NULL AND bot_agent_link_id IS NULL"
        ),
    )


def downgrade() -> None:
    op.drop_index("ux_channel_messages_inbound_provider_message_unbound")
    op.drop_index("ux_channel_messages_inbound_provider_message_bound")
    op.create_index(
        "ux_channel_messages_inbound_provider_message_bound",
        "channel_messages",
        ["account_id", "external_chat_id", "provider_message_id", "bot_agent_link_id"],
        unique=True,
        postgresql_where=sa.text(
            "direction = 'inbound' AND provider_message_id IS NOT NULL "
            "AND bot_agent_link_id IS NOT NULL"
        ),
    )
    op.create_index(
        "ux_channel_messages_inbound_provider_message_unbound",
        "channel_messages",
        ["account_id", "external_chat_id", "provider_message_id"],
        unique=True,
        postgresql_where=sa.text(
            "direction = 'inbound' AND provider_message_id IS NOT NULL "
            "AND bot_agent_link_id IS NULL"
        ),
    )
    op.drop_column("channel_messages", "provider_event_id")
