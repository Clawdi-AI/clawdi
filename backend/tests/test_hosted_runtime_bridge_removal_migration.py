from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncEngine

MIGRATION_FILENAME = "b7e4d2a9c6f1_drop_hosted_runtime_bridge.py"


def _load_migration():
    migration_path = Path(__file__).parents[1] / "alembic" / "versions" / MIGRATION_FILENAME
    spec = importlib.util.spec_from_file_location(
        "hosted_runtime_bridge_removal_migration",
        migration_path,
    )
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def test_hosted_runtime_bridge_removal_requires_empty_state_and_round_trips(
    engine: AsyncEngine,
) -> None:
    migration = _load_migration()
    schema = f"hosted_runtime_bridge_removal_{uuid.uuid4().hex}"

    def run_migration(sync_conn: sa.Connection) -> None:
        old_op = migration.op
        sync_conn.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
        sync_conn.execute(sa.text(f'SET search_path TO "{schema}"'))
        try:
            sync_conn.execute(
                sa.text(
                    """
                    CREATE TABLE hosted_runtime_states (
                        environment_id uuid PRIMARY KEY,
                        bridge jsonb
                    )
                    """
                )
            )
            migration.op = Operations(MigrationContext.configure(sync_conn))

            migration.upgrade()
            assert "bridge" not in {
                column["name"]
                for column in sa.inspect(sync_conn).get_columns("hosted_runtime_states")
            }

            migration.downgrade()
            restored_bridge = next(
                column
                for column in sa.inspect(sync_conn).get_columns("hosted_runtime_states")
                if column["name"] == "bridge"
            )
            assert restored_bridge["nullable"] is True

            sync_conn.execute(
                sa.text(
                    """
                    INSERT INTO hosted_runtime_states (environment_id, bridge)
                    VALUES (CAST(:environment_id AS uuid), NULL)
                    """
                ),
                {"environment_id": str(uuid.uuid4())},
            )
            with pytest.raises(
                RuntimeError,
                match=("Cannot apply migration b7e4d2a9c6f1: hosted_runtime_states is not empty"),
            ):
                migration.upgrade()
            assert "bridge" in {
                column["name"]
                for column in sa.inspect(sync_conn).get_columns("hosted_runtime_states")
            }
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
