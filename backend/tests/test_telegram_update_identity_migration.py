from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect
from sqlalchemy.ext.asyncio import AsyncEngine

REVISION = "d7e9f1a2b3c4"
MIGRATION_FILENAME = f"{REVISION}_scope_telegram_update_identity.py"


def _load_migration():
    path = Path(__file__).parents[1] / "alembic" / "versions" / MIGRATION_FILENAME
    spec = importlib.util.spec_from_file_location("telegram_update_identity", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def test_telegram_update_identity_migration_scopes_and_round_trips(
    engine: AsyncEngine,
) -> None:
    migration = _load_migration()
    schema = f"telegram_update_identity_{uuid.uuid4().hex}"
    telegram_account_id = uuid.uuid4()
    discord_account_id = uuid.uuid4()
    update_first_id = uuid.uuid4()
    update_duplicate_id = uuid.uuid4()
    message_first_id = uuid.uuid4()
    message_other_chat_id = uuid.uuid4()
    discord_id = uuid.uuid4()
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
                        account_id uuid NOT NULL REFERENCES channel_accounts(id),
                        direction varchar(16) NOT NULL,
                        external_chat_id varchar(300) NOT NULL,
                        provider_event_id varchar(300),
                        payload jsonb,
                        created_at timestamptz NOT NULL
                    );
                    CREATE UNIQUE INDEX ux_channel_messages_inbound_provider_event_account
                    ON channel_messages (account_id, external_chat_id, provider_event_id)
                    WHERE direction = 'inbound' AND provider_event_id IS NOT NULL
                    """
                )
            )
            connection.execute(
                sa.text(
                    "INSERT INTO channel_accounts (id, provider) VALUES "
                    "(:telegram, 'telegram'), (:discord, 'discord')"
                ),
                {"telegram": telegram_account_id, "discord": discord_account_id},
            )
            connection.execute(
                sa.text(
                    """
                    INSERT INTO channel_messages (
                        id, account_id, direction, external_chat_id,
                        provider_event_id, payload, created_at
                    ) VALUES
                    (:update_first, :telegram, 'inbound', 'chat-a', '7001',
                     '{"update_id": 7001}', '2026-07-31T00:00:00Z'),
                    (:update_duplicate, :telegram, 'inbound', 'chat-b', '7001',
                     '{"update_id": 7001}', '2026-07-31T00:00:01Z'),
                    (:message_first, :telegram, 'inbound', 'chat-a', '55',
                     '{"message": {"message_id": 55}}', '2026-07-31T00:00:02Z'),
                    (:message_other_chat, :telegram, 'inbound', 'chat-b', '55',
                     '{"message": {"message_id": 55}}', '2026-07-31T00:00:03Z'),
                    (:discord_id, :discord, 'inbound', 'guild-a', '7001',
                     '{}', '2026-07-31T00:00:04Z')
                    """
                ),
                {
                    "telegram": telegram_account_id,
                    "discord": discord_account_id,
                    "update_first": update_first_id,
                    "update_duplicate": update_duplicate_id,
                    "message_first": message_first_id,
                    "message_other_chat": message_other_chat_id,
                    "discord_id": discord_id,
                },
            )
            migration.op = Operations(MigrationContext.configure(connection))

            migration.upgrade()

            rows = connection.execute(
                sa.text(
                    "SELECT id, provider_event_id, provider_event_scope "
                    "FROM channel_messages ORDER BY created_at, id"
                )
            ).all()
            assert rows == [
                (update_first_id, "update:7001", "account"),
                (update_duplicate_id, None, "account"),
                (message_first_id, "message:55", "chat"),
                (message_other_chat_id, "message:55", "chat"),
                (discord_id, "7001", "chat"),
            ]
            indexes = {
                index["name"]: index
                for index in inspect(connection).get_indexes("channel_messages")
            }
            assert indexes["ux_channel_messages_inbound_provider_event_account"][
                "column_names"
            ] == ["account_id", "provider_event_id"]
            assert indexes["ux_channel_messages_inbound_provider_event_chat"]["column_names"] == [
                "account_id",
                "external_chat_id",
                "provider_event_id",
            ]

            migration.downgrade()

            downgraded_rows = connection.execute(
                sa.text(
                    "SELECT id, provider_event_id FROM channel_messages ORDER BY created_at, id"
                )
            ).all()
            assert downgraded_rows == [
                (update_first_id, "7001"),
                (update_duplicate_id, None),
                (message_first_id, "55"),
                (message_other_chat_id, "55"),
                (discord_id, "7001"),
            ]
            assert "provider_event_scope" not in {
                column["name"] for column in inspect(connection).get_columns("channel_messages")
            }
    finally:
        migration.op = old_op
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        sync_engine.dispose()
