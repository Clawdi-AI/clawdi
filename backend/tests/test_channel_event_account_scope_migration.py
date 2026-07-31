from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect
from sqlalchemy.ext.asyncio import AsyncEngine

REVISION = "c4a7e2d9f1b6"
MIGRATION_FILENAME = f"{REVISION}_scope_channel_events_to_account.py"


def _load_migration():
    path = Path(__file__).parents[1] / "alembic" / "versions" / MIGRATION_FILENAME
    spec = importlib.util.spec_from_file_location("channel_event_account_scope", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def test_channel_event_account_scope_migration_dedupes_cross_link_rows(
    engine: AsyncEngine,
) -> None:
    migration = _load_migration()
    schema = f"channel_event_account_{uuid.uuid4().hex}"
    account_id = uuid.uuid4()
    first_id = uuid.uuid4()
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
                    CREATE TABLE channel_messages (
                        id uuid PRIMARY KEY,
                        account_id uuid NOT NULL,
                        direction varchar(16) NOT NULL,
                        external_chat_id varchar(300) NOT NULL,
                        provider_event_id varchar(300),
                        bot_agent_link_id uuid,
                        created_at timestamptz NOT NULL
                    );
                    CREATE UNIQUE INDEX ux_channel_messages_inbound_provider_message_bound
                    ON channel_messages (
                        account_id, external_chat_id, provider_event_id, bot_agent_link_id
                    ) WHERE direction = 'inbound' AND provider_event_id IS NOT NULL
                      AND bot_agent_link_id IS NOT NULL;
                    CREATE UNIQUE INDEX ux_channel_messages_inbound_provider_message_unbound
                    ON channel_messages (account_id, external_chat_id, provider_event_id)
                    WHERE direction = 'inbound' AND provider_event_id IS NOT NULL
                      AND bot_agent_link_id IS NULL
                    """
                )
            )
            connection.execute(
                sa.text(
                    """
                    INSERT INTO channel_messages (
                        id, account_id, direction, external_chat_id, provider_event_id,
                        bot_agent_link_id, created_at
                    ) VALUES
                    (:first_id, :account_id, 'inbound', '42', '7001', :first_link,
                     '2026-07-30T00:00:00Z'),
                    (:second_id, :account_id, 'inbound', '42', '7001', :second_link,
                     '2026-07-30T00:00:01Z')
                    """
                ),
                {
                    "first_id": first_id,
                    "second_id": second_id,
                    "account_id": account_id,
                    "first_link": uuid.uuid4(),
                    "second_link": uuid.uuid4(),
                },
            )
            migration.op = Operations(MigrationContext.configure(connection))

            migration.upgrade()

            rows = connection.execute(
                sa.text(
                    "SELECT id, provider_event_id FROM channel_messages ORDER BY created_at, id"
                )
            ).all()
            assert rows == [(first_id, "7001"), (second_id, None)]
            indexes = {
                index["name"]: index
                for index in inspect(connection).get_indexes("channel_messages")
            }
            scoped = indexes["ux_channel_messages_inbound_provider_event_account"]
            assert scoped["unique"] is True
            assert scoped["column_names"] == [
                "account_id",
                "external_chat_id",
                "provider_event_id",
            ]

            migration.downgrade()
            downgraded = {
                index["name"] for index in inspect(connection).get_indexes("channel_messages")
            }
            assert "ux_channel_messages_inbound_provider_message_bound" in downgraded
            assert "ux_channel_messages_inbound_provider_message_unbound" in downgraded
    finally:
        migration.op = old_op
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        sync_engine.dispose()
