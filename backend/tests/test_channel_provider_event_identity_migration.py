from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect
from sqlalchemy.ext.asyncio import AsyncEngine

REVISION = "8d3f1a6c9b2e"
MIGRATION_FILENAME = f"{REVISION}_add_channel_provider_event_identity.py"


def _load_migration():
    path = Path(__file__).parents[1] / "alembic" / "versions" / MIGRATION_FILENAME
    spec = importlib.util.spec_from_file_location("channel_provider_event_identity", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def test_channel_provider_event_identity_migration_backfills_and_downgrades(
    engine: AsyncEngine,
) -> None:
    migration = _load_migration()
    schema = f"channel_provider_event_{uuid.uuid4().hex}"
    account_id = uuid.uuid4()
    link_id = uuid.uuid4()
    first_id = uuid.uuid4()
    malformed_id = uuid.uuid4()
    second_id = uuid.uuid4()
    sync_engine = create_engine(engine.url.set(drivername="postgresql+psycopg2"))
    old_op = migration.op
    try:
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
            connection.execute(sa.text(f'SET search_path TO "{schema}"'))
            connection.execute(
                sa.text(
                    """
                    CREATE TABLE channel_accounts (
                        id uuid PRIMARY KEY,
                        provider varchar(32) NOT NULL
                    );
                    CREATE TABLE channel_messages (
                        id uuid PRIMARY KEY,
                        account_id uuid NOT NULL,
                        direction varchar(16) NOT NULL,
                        external_chat_id varchar(300) NOT NULL,
                        provider_message_id varchar(300),
                        bot_agent_link_id uuid,
                        payload jsonb,
                        created_at timestamptz NOT NULL
                    );
                    CREATE UNIQUE INDEX ux_channel_messages_inbound_provider_message_bound
                    ON channel_messages (
                        account_id, external_chat_id, provider_message_id, bot_agent_link_id
                    ) WHERE direction = 'inbound' AND provider_message_id IS NOT NULL
                      AND bot_agent_link_id IS NOT NULL;
                    CREATE UNIQUE INDEX ux_channel_messages_inbound_provider_message_unbound
                    ON channel_messages (account_id, external_chat_id, provider_message_id)
                    WHERE direction = 'inbound' AND provider_message_id IS NOT NULL
                      AND bot_agent_link_id IS NULL
                    """
                )
            )
            connection.execute(
                sa.text("INSERT INTO channel_accounts (id, provider) VALUES (:id, 'telegram')"),
                {"id": account_id},
            )
            connection.execute(
                sa.text(
                    """
                    INSERT INTO channel_messages (
                        id, account_id, direction, external_chat_id, provider_message_id,
                        bot_agent_link_id, payload, created_at
                    ) VALUES (
                        :id, :account_id, 'inbound', '42', '88', :link_id,
                        CAST(:payload AS jsonb), '2026-07-30T00:00:00Z'
                    )
                    """
                ),
                {
                    "id": first_id,
                    "account_id": account_id,
                    "link_id": link_id,
                    "payload": '{"update_id": 7001}',
                },
            )
            connection.execute(
                sa.text(
                    """
                    INSERT INTO channel_messages (
                        id, account_id, direction, external_chat_id, provider_message_id,
                        bot_agent_link_id, payload, created_at
                    ) VALUES (
                        :id, :account_id, 'inbound', '43', '99', :link_id,
                        CAST(:payload AS jsonb), '2026-07-30T00:00:00Z'
                    )
                    """
                ),
                {
                    "id": malformed_id,
                    "account_id": account_id,
                    "link_id": link_id,
                    "payload": '{"update_id": {"malformed": true}}',
                },
            )
            migration.op = Operations(MigrationContext.configure(connection))

            migration.upgrade()
            assert (
                connection.scalar(
                    sa.text("SELECT provider_event_id FROM channel_messages WHERE id = :id"),
                    {"id": first_id},
                )
                == "7001"
            )
            assert (
                connection.scalar(
                    sa.text("SELECT provider_event_id FROM channel_messages WHERE id = :id"),
                    {"id": malformed_id},
                )
                == "99"
            )

            connection.execute(
                sa.text(
                    """
                    INSERT INTO channel_messages (
                        id, account_id, direction, external_chat_id, provider_message_id,
                        provider_event_id, bot_agent_link_id, payload, created_at
                    ) VALUES (
                        :id, :account_id, 'inbound', '42', '88', '7002', :link_id,
                        CAST(:payload AS jsonb), '2026-07-30T00:00:01Z'
                    )
                    """
                ),
                {
                    "id": second_id,
                    "account_id": account_id,
                    "link_id": link_id,
                    "payload": '{"update_id": 7002}',
                },
            )

            migration.downgrade()
            assert "provider_event_id" not in {
                column["name"] for column in inspect(connection).get_columns("channel_messages")
            }
            provider_ids = connection.execute(
                sa.text(
                    "SELECT provider_message_id FROM channel_messages "
                    "WHERE external_chat_id = '42' ORDER BY created_at, id"
                )
            ).scalars()
            assert list(provider_ids) == ["88", None]
    finally:
        migration.op = old_op
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        sync_engine.dispose()
