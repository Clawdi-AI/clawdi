from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncEngine


def _migration():
    path = (
        Path(__file__).parents[1]
        / "alembic"
        / "versions"
        / "f7c2d4a9e1b6_ai_provider_incarnation.py"
    )
    spec = importlib.util.spec_from_file_location("ai_provider_incarnation", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_ai_provider_incarnation_migration_backfills_defaults_and_downgrades(
    engine: AsyncEngine,
) -> None:
    migration = _migration()
    schema = f"ai_provider_incarnation_{uuid.uuid4().hex}"
    historical_ids = [uuid.uuid4(), uuid.uuid4()]

    def run(connection: sa.Connection) -> None:
        previous_op = migration.op
        connection.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
        connection.execute(sa.text(f'SET search_path TO "{schema}"'))
        try:
            connection.execute(sa.text("CREATE TABLE ai_providers (id uuid PRIMARY KEY)"))
            connection.execute(
                sa.text("INSERT INTO ai_providers (id) VALUES (:first), (:second)"),
                {"first": historical_ids[0], "second": historical_ids[1]},
            )
            migration.op = Operations(MigrationContext.configure(connection))

            migration.upgrade()
            incarnations = connection.scalars(
                sa.text("SELECT incarnation_id FROM ai_providers ORDER BY id")
            ).all()
            assert len(set(incarnations)) == 2
            column = connection.execute(
                sa.text(
                    "SELECT is_nullable, column_default FROM information_schema.columns "
                    "WHERE table_schema = :schema AND table_name = 'ai_providers' "
                    "AND column_name = 'incarnation_id'"
                ),
                {"schema": schema},
            ).one()
            assert column.is_nullable == "NO"
            assert column.column_default == "gen_random_uuid()"

            fresh_id = uuid.uuid4()
            connection.execute(
                sa.text("INSERT INTO ai_providers (id) VALUES (:id)"),
                {"id": fresh_id},
            )
            assert (
                connection.scalar(
                    sa.text("SELECT incarnation_id FROM ai_providers WHERE id = :id"),
                    {"id": fresh_id},
                )
                is not None
            )

            migration.downgrade()
            columns = {
                row.column_name
                for row in connection.execute(
                    sa.text(
                        "SELECT column_name FROM information_schema.columns "
                        "WHERE table_schema = :schema AND table_name = 'ai_providers'"
                    ),
                    {"schema": schema},
                )
            }
            assert "incarnation_id" not in columns
        finally:
            migration.op = previous_op

    sync_engine = create_engine(engine.url.set(drivername="postgresql+psycopg2"))
    try:
        with sync_engine.begin() as connection:
            run(connection)
    finally:
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        sync_engine.dispose()
