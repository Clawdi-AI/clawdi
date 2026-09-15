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
        / "fca5e43eb29d_provider_identity_activation.py"
    )
    spec = importlib.util.spec_from_file_location("provider_identity_activation", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_provider_identity_activation_migration_backfills_defaults_and_downgrades(
    engine: AsyncEngine,
) -> None:
    migration = _migration()
    schema = f"provider_identity_activation_{uuid.uuid4().hex}"
    historical_ids = [uuid.uuid4(), uuid.uuid4()]

    def run(connection: sa.Connection) -> None:
        previous_op = migration.op
        connection.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
        connection.execute(sa.text(f'SET search_path TO "{schema}"'))
        try:
            connection.execute(
                sa.text(
                    "CREATE TABLE ai_providers (id uuid PRIMARY KEY, "
                    "configuration_mode text NOT NULL DEFAULT 'custom')"
                )
            )
            connection.execute(
                sa.text("INSERT INTO ai_providers (id) VALUES (:first), (:second)"),
                {"first": historical_ids[0], "second": historical_ids[1]},
            )
            migration.op = Operations(MigrationContext.configure(connection))
            migration.upgrade()
            assert connection.scalars(
                sa.text("SELECT identity_enabled FROM ai_providers")
            ).all() == [False, False]
            fresh_id = uuid.uuid4()
            connection.execute(
                sa.text("INSERT INTO ai_providers (id) VALUES (:id)"), {"id": fresh_id}
            )
            assert (
                connection.scalar(
                    sa.text("SELECT identity_enabled FROM ai_providers WHERE id = :id"),
                    {"id": fresh_id},
                )
                is True
            )
            import pytest

            with pytest.raises(RuntimeError, match="capability-compatible"):
                migration.downgrade()
            connection.execute(sa.text("UPDATE ai_providers SET identity_enabled = true"))
            migration.downgrade()
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
