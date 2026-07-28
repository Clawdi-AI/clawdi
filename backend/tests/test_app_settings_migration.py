from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncEngine

MIGRATION_FILENAME = "3e7a9c1d5b82_add_app_settings.py"


def _load_migration():
    path = Path(__file__).parents[1] / "alembic" / "versions" / MIGRATION_FILENAME
    spec = importlib.util.spec_from_file_location("app_settings_migration", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def test_app_settings_migration_seeds_one_disabled_global_oauth_value(
    engine: AsyncEngine,
) -> None:
    migration = _load_migration()
    schema = f"app_settings_{uuid.uuid4().hex}"
    sync_engine = create_engine(engine.url.set(drivername="postgresql+psycopg2"))
    original_op = migration.op
    try:
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
            connection.execute(sa.text(f'SET search_path TO "{schema}"'))
            migration.op = Operations(MigrationContext.configure(connection))

            migration.upgrade()

            row = (
                connection.execute(sa.text("SELECT key, value_json FROM app_settings"))
                .mappings()
                .one()
            )
            assert row["key"] == "clerk_cli_oauth"
            assert row["value_json"] == {
                "enabled": False,
                "schema_version": 1,
                "issuer": "",
                "client_id": "",
                "application_id": "",
                "redirect_uri": "",
                "audience": "",
                "authorized_parties": [],
            }

            migration.downgrade()
            assert "app_settings" not in sa.inspect(connection).get_table_names()
    finally:
        migration.op = original_op
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        sync_engine.dispose()
