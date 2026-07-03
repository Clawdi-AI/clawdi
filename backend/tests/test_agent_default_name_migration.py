from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy.ext.asyncio import AsyncEngine


@pytest.mark.asyncio
async def test_agent_default_name_migration_backfills_long_machine_name(engine: AsyncEngine):
    """The migration must handle existing machine_name values over the old
    display-name cap. It runs against a temporary schema with the real Alembic
    operations so the column DDL and backfill SQL are both exercised.
    """

    migration_path = (
        Path(__file__).parents[1] / "alembic" / "versions" / "e9c3a17d5b42_agent_default_name.py"
    )
    spec = importlib.util.spec_from_file_location("agent_default_name_migration", migration_path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)

    schema = f"agent_default_name_migration_{uuid.uuid4().hex}"
    long_machine_name = "agent-" + ("x" * 144)

    def run_migration(sync_conn):
        old_op = migration.op
        sync_conn.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
        sync_conn.execute(sa.text(f'SET search_path TO "{schema}"'))
        try:
            sync_conn.execute(
                sa.text(
                    """
                    CREATE TABLE agent_environments (
                        id uuid PRIMARY KEY,
                        machine_name varchar(200) NOT NULL
                    )
                    """
                )
            )
            sync_conn.execute(
                sa.text(
                    """
                    INSERT INTO agent_environments (id, machine_name)
                    VALUES (CAST(:id AS uuid), :machine_name)
                    """
                ),
                {"id": str(uuid.uuid4()), "machine_name": long_machine_name},
            )

            migration.op = Operations(MigrationContext.configure(sync_conn))
            migration.upgrade()

            row = sync_conn.execute(sa.text("SELECT default_name FROM agent_environments")).one()
            assert row.default_name == long_machine_name
        finally:
            migration.op = old_op
            sync_conn.execute(sa.text("SET search_path TO public"))
            sync_conn.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))

    async with engine.begin() as conn:
        await conn.run_sync(run_migration)
