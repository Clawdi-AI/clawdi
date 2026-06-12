"""dedupe channel inbound messages

Revision ID: e3b8a7c9d2f1
Revises: da72b4f51c03
Create Date: 2026-06-12 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "e3b8a7c9d2f1"
down_revision: str | Sequence[str] | None = "da72b4f51c03"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
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
