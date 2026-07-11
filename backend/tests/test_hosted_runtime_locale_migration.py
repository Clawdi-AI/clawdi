from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import sqlalchemy as sa
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncEngine

REVISION = "d8f2a1c4b6e9"
MIGRATION_FILENAME = f"{REVISION}_add_hosted_runtime_locale.py"


def _load_migration():
    migration_path = Path(__file__).parents[1] / "alembic" / "versions" / MIGRATION_FILENAME
    spec = importlib.util.spec_from_file_location("hosted_runtime_locale_migration", migration_path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def test_hosted_runtime_locale_migration_is_single_head() -> None:
    backend_dir = Path(__file__).parents[1]
    config = Config(str(backend_dir / "alembic.ini"))
    config.set_main_option("script_location", str(backend_dir / "alembic"))
    scripts = ScriptDirectory.from_config(config)

    assert scripts.get_heads() == [REVISION]
    assert scripts.get_revision(REVISION).down_revision == "c4e8f1a2b3d5"


def test_hosted_runtime_locale_migration_adds_nullable_column_without_backfill(
    engine: AsyncEngine,
) -> None:
    migration = _load_migration()
    schema = f"hosted_runtime_locale_migration_{uuid.uuid4().hex}"
    environment_id = uuid.uuid4()

    def run_migration(sync_conn: sa.Connection) -> None:
        old_op = migration.op
        sync_conn.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
        sync_conn.execute(sa.text(f'SET search_path TO "{schema}"'))
        try:
            sync_conn.execute(
                sa.text(
                    """
                    CREATE TABLE hosted_runtime_states (
                        environment_id uuid PRIMARY KEY
                    )
                    """
                )
            )
            sync_conn.execute(
                sa.text(
                    """
                    INSERT INTO hosted_runtime_states (environment_id)
                    VALUES (CAST(:environment_id AS uuid))
                    """
                ),
                {"environment_id": str(environment_id)},
            )

            migration.op = Operations(MigrationContext.configure(sync_conn))
            migration.upgrade()

            column = sync_conn.execute(
                sa.text(
                    """
                    SELECT is_nullable, column_default, data_type
                    FROM information_schema.columns
                    WHERE table_schema = :schema
                      AND table_name = 'hosted_runtime_states'
                      AND column_name = 'locale'
                    """
                ),
                {"schema": schema},
            ).one()
            assert column.is_nullable == "YES"
            assert column.column_default is None
            assert column.data_type == "jsonb"

            locale = sync_conn.execute(
                sa.text(
                    """
                    SELECT locale
                    FROM hosted_runtime_states
                    WHERE environment_id = CAST(:environment_id AS uuid)
                    """
                ),
                {"environment_id": str(environment_id)},
            ).scalar_one()
            assert locale is None
        finally:
            migration.op = old_op

    sync_url = engine.url.set(drivername="postgresql+psycopg2")
    sync_engine = create_engine(sync_url)
    try:
        with sync_engine.begin() as conn:
            run_migration(conn)
    finally:
        with sync_engine.begin() as conn:
            conn.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        sync_engine.dispose()
