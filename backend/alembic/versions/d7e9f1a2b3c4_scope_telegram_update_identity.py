"""Scope Telegram update identity to the physical account.

Revision ID: d7e9f1a2b3c4
Revises: c4a7e2d9f1b6
Create Date: 2026-07-31 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d7e9f1a2b3c4"
down_revision: str | Sequence[str] | None = "c4a7e2d9f1b6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "channel_messages",
        sa.Column(
            "provider_event_scope",
            sa.String(length=16),
            nullable=False,
            server_default="chat",
        ),
    )
    op.drop_index("ux_channel_messages_inbound_provider_event_account")

    # Existing Telegram rows stored raw ids. Namespace them by source and mark
    # update_id/callback ids as physical-account identities; message ids remain
    # chat-scoped because Telegram only guarantees them within a chat.
    op.execute(
        """
        UPDATE channel_messages AS message
        SET provider_event_id = CASE
                WHEN jsonb_typeof(message.payload -> 'update_id') IN ('number', 'string')
                     AND NULLIF(BTRIM(message.payload ->> 'update_id'), '') IS NOT NULL
                    THEN 'update:' || BTRIM(message.payload ->> 'update_id')
                WHEN jsonb_typeof(message.payload -> 'callback_query' -> 'id')
                         IN ('number', 'string')
                     AND NULLIF(BTRIM(message.payload -> 'callback_query' ->> 'id'), '')
                         IS NOT NULL
                    THEN 'callback:' || BTRIM(message.payload -> 'callback_query' ->> 'id')
                ELSE 'message:' || message.provider_event_id
            END,
            provider_event_scope = CASE
                WHEN (
                    jsonb_typeof(message.payload -> 'update_id') IN ('number', 'string')
                    AND NULLIF(BTRIM(message.payload ->> 'update_id'), '') IS NOT NULL
                ) OR (
                    jsonb_typeof(message.payload -> 'callback_query' -> 'id')
                        IN ('number', 'string')
                    AND NULLIF(BTRIM(message.payload -> 'callback_query' ->> 'id'), '')
                        IS NOT NULL
                ) THEN 'account'
                ELSE 'chat'
            END
        FROM channel_accounts AS account
        WHERE message.account_id = account.id
          AND account.provider = 'telegram'
          AND message.direction = 'inbound'
          AND message.provider_event_id IS NOT NULL
        """
    )

    op.execute(
        """
        WITH ranked AS (
            SELECT id,
                   row_number() OVER (
                       PARTITION BY account_id, provider_event_id
                       ORDER BY created_at, id
                   ) AS duplicate_rank
            FROM channel_messages
            WHERE direction = 'inbound'
              AND provider_event_id IS NOT NULL
              AND provider_event_scope = 'account'
        )
        UPDATE channel_messages AS message
        SET provider_event_id = NULL
        FROM ranked
        WHERE message.id = ranked.id AND ranked.duplicate_rank > 1
        """
    )
    op.execute(
        """
        WITH ranked AS (
            SELECT id,
                   row_number() OVER (
                       PARTITION BY account_id, external_chat_id, provider_event_id
                       ORDER BY created_at, id
                   ) AS duplicate_rank
            FROM channel_messages
            WHERE direction = 'inbound'
              AND provider_event_id IS NOT NULL
              AND provider_event_scope = 'chat'
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
        ["account_id", "provider_event_id"],
        unique=True,
        postgresql_where=sa.text(
            "direction = 'inbound' AND provider_event_id IS NOT NULL "
            "AND provider_event_scope = 'account'"
        ),
    )
    op.create_index(
        "ux_channel_messages_inbound_provider_event_chat",
        "channel_messages",
        ["account_id", "external_chat_id", "provider_event_id"],
        unique=True,
        postgresql_where=sa.text(
            "direction = 'inbound' AND provider_event_id IS NOT NULL "
            "AND provider_event_scope = 'chat'"
        ),
    )


def downgrade() -> None:
    op.drop_index("ux_channel_messages_inbound_provider_event_chat")
    op.drop_index("ux_channel_messages_inbound_provider_event_account")

    # Restore ids expected by the pre-migration application so a rollback does
    # not admit one replay merely because the deployed code uses raw ids.
    op.execute(
        """
        UPDATE channel_messages AS message
        SET provider_event_id = CASE
                WHEN message.provider_event_id LIKE 'update:%'
                    THEN substring(message.provider_event_id FROM 8)
                WHEN message.provider_event_id LIKE 'callback:%'
                    THEN substring(message.provider_event_id FROM 10)
                WHEN message.provider_event_id LIKE 'message:%'
                    THEN substring(message.provider_event_id FROM 9)
                ELSE message.provider_event_id
            END
        FROM channel_accounts AS account
        WHERE message.account_id = account.id
          AND account.provider = 'telegram'
          AND message.direction = 'inbound'
          AND message.provider_event_id IS NOT NULL
        """
    )
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
    op.drop_column("channel_messages", "provider_event_scope")
