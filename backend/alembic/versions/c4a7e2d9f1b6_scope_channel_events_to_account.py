"""Scope channel provider event identity to the account.

Revision ID: c4a7e2d9f1b6
Revises: 8d3f1a6c9b2e
Create Date: 2026-07-30 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c4a7e2d9f1b6"
down_revision: str | Sequence[str] | None = "8d3f1a6c9b2e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_index("ux_channel_messages_inbound_provider_message_unbound")
    op.drop_index("ux_channel_messages_inbound_provider_message_bound")
    # Earlier schemas allowed one copy per AgentLink. Keep the earliest event as
    # the durable identity and retain later rows only as non-identity history.
    op.execute(
        """
        WITH ranked AS (
            SELECT id,
                   row_number() OVER (
                       PARTITION BY account_id, external_chat_id, provider_event_id
                       ORDER BY created_at, id
                   ) AS duplicate_rank
            FROM channel_messages
            WHERE direction = 'inbound' AND provider_event_id IS NOT NULL
        )
        UPDATE channel_messages AS message
        SET provider_event_id = NULL
        FROM ranked
        WHERE message.id = ranked.id AND ranked.duplicate_rank > 1
        """
    )
    op.create_index(
        "ux_channel_messages_inbound_provider_event_account",
        "channel_messages",
        ["account_id", "external_chat_id", "provider_event_id"],
        unique=True,
        postgresql_where=sa.text("direction = 'inbound' AND provider_event_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ux_channel_messages_inbound_provider_event_account")
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
