from __future__ import annotations

import importlib.util
from pathlib import Path
from uuid import uuid4

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from app.models.channel import ChannelBinding


def test_webhook_retry_migration_defaults_constraint_and_downgrade(engine):
    path = (
        Path(__file__).parents[1]
        / "alembic/versions/a6d9c2e4f7b1_add_binding_webhook_retry_state.py"
    )
    spec = importlib.util.spec_from_file_location("webhook_retry_migration", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    sync_engine = sa.create_engine(engine.url.set(drivername="postgresql+psycopg2"))
    schema = f"webhook_retry_{uuid4().hex}"
    try:
        with sync_engine.begin() as connection:
            # Compare the migrated real application table to the ORM contract.
            columns = {
                column["name"]: column
                for column in sa.inspect(connection).get_columns("channel_bindings")
            }
            for name in ("webhook_retry_at", "webhook_retry_step"):
                assert columns[name]["nullable"] == ChannelBinding.__table__.c[name].nullable
                assert columns[name]["type"].compile(
                    dialect=connection.dialect
                ) == ChannelBinding.__table__.c[name].type.compile(dialect=connection.dialect)
            connection.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
            connection.execute(sa.text(f'SET LOCAL search_path TO "{schema}"'))
            connection.execute(sa.text("CREATE TABLE channel_bindings (id integer PRIMARY KEY)"))
            connection.execute(sa.text("INSERT INTO channel_bindings VALUES (1)"))
            migration.op = Operations(MigrationContext.configure(connection))
            migration.upgrade()
            assert connection.execute(
                sa.text(
                    "SELECT webhook_retry_at, webhook_retry_step FROM channel_bindings WHERE id = 1"
                )
            ).one() == (None, 0)
            with pytest.raises(sa.exc.IntegrityError), connection.begin_nested():
                connection.execute(sa.text("UPDATE channel_bindings SET webhook_retry_step = -1"))
            connection.execute(
                sa.text(
                    "UPDATE channel_bindings SET webhook_retry_step = 7, webhook_retry_at = now()"
                )
            )
            migration.downgrade()
            assert [
                column["name"]
                for column in sa.inspect(connection).get_columns("channel_bindings", schema=schema)
            ] == ["id"]
            assert connection.scalar(sa.text("SELECT id FROM channel_bindings")) == 1
            migration.upgrade()
            assert connection.execute(
                sa.text("SELECT webhook_retry_at, webhook_retry_step FROM channel_bindings")
            ).one() == (None, 0)
            connection.execute(sa.text(f'DROP SCHEMA "{schema}" CASCADE'))
    finally:
        sync_engine.dispose()
