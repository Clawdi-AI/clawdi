from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.ext.asyncio import AsyncEngine


def _migration():
    path = (
        Path(__file__).parents[1]
        / "alembic"
        / "versions"
        / "a5d8f3c1e7b9_drop_redundant_channel_delivery_status_index.py"
    )
    spec = importlib.util.spec_from_file_location("drop_channel_delivery_status_index", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def test_channel_delivery_status_index_migration_upgrades_and_downgrades(
    engine: AsyncEngine,
) -> None:
    migration = _migration()
    schema = f"channel_delivery_index_{uuid.uuid4().hex}"
    sync_engine = create_engine(engine.url.set(drivername="postgresql+psycopg2"))

    try:
        with sync_engine.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
            connection.execute(text(f'SET search_path TO "{schema}"'))
            connection.execute(
                text(
                    "CREATE TABLE channel_deliveries "
                    "(id uuid PRIMARY KEY, status varchar(32) NOT NULL)"
                )
            )
            connection.execute(
                text("CREATE INDEX ix_channel_deliveries_status ON channel_deliveries (status)")
            )
            migration.op = Operations(MigrationContext.configure(connection))

            migration.upgrade()
            assert "ix_channel_deliveries_status" not in {
                index["name"] for index in inspect(connection).get_indexes("channel_deliveries")
            }

            migration.downgrade()
            assert "ix_channel_deliveries_status" in {
                index["name"] for index in inspect(connection).get_indexes("channel_deliveries")
            }
            connection.execute(text("SET search_path TO public"))
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
    finally:
        sync_engine.dispose()
