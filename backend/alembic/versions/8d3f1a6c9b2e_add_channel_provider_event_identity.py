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
        """
        UPDATE channel_messages AS message
        SET provider_event_id = CASE
            WHEN account.provider = 'telegram'
             AND jsonb_typeof(message.payload->'update_id') IN ('number', 'string')
            THEN COALESCE(
                NULLIF(BTRIM(message.payload->>'update_id'), ''),
                message.provider_message_id
            )
            ELSE message.provider_message_id
        END
        FROM channel_accounts AS account
        WHERE message.account_id = account.id
          AND message.direction = 'inbound'
          AND (
              message.provider_message_id IS NOT NULL
              OR (
                  account.provider = 'telegram'
                  AND jsonb_typeof(message.payload->'update_id') IN ('number', 'string')
                  AND NULLIF(BTRIM(message.payload->>'update_id'), '') IS NOT NULL
              )
          )
        """
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
    # The old schema cannot represent edited provider events that share a message ID.
    # Keep the earliest public ID and clear later duplicates before restoring its indexes.
    op.execute(
        """
        WITH ranked AS (
            SELECT id,
                   row_number() OVER (
                       PARTITION BY account_id, external_chat_id,
                                    provider_message_id, bot_agent_link_id
                       ORDER BY created_at, id
                   ) AS duplicate_rank
            FROM channel_messages
            WHERE direction = 'inbound' AND provider_message_id IS NOT NULL
        )
        UPDATE channel_messages AS message
        SET provider_message_id = NULL
        FROM ranked
        WHERE message.id = ranked.id AND ranked.duplicate_rank > 1
        """
    )
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
