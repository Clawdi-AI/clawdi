from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy.ext.asyncio import AsyncEngine


def _load_migration():
    path = (
        Path(__file__).parents[1]
        / "alembic"
        / "versions"
        / "c8f2a6d1e4b9_connected_agent_machine_fence.py"
    )
    spec = importlib.util.spec_from_file_location("connected_agent_machine_fence", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


@pytest.mark.asyncio
async def test_connected_agent_machine_fence_migration_is_legacy_compatible(
    engine: AsyncEngine,
) -> None:
    migration = _load_migration()
    schema = f"connected_agent_fence_{uuid.uuid4().hex}"

    def run_migration(sync_conn: sa.Connection) -> None:
        old_op = migration.op
        sync_conn.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
        sync_conn.execute(sa.text(f'SET search_path TO "{schema}"'))
        try:
            sync_conn.execute(sa.text("CREATE TABLE agent_environments (id uuid PRIMARY KEY)"))
            legacy_id = uuid.uuid4()
            sync_conn.execute(
                sa.text("INSERT INTO agent_environments (id) VALUES (CAST(:id AS uuid))"),
                {"id": str(legacy_id)},
            )
            migration.op = Operations(MigrationContext.configure(sync_conn))
            migration.upgrade()

            column = next(
                item
                for item in sa.inspect(sync_conn).get_columns("agent_environments", schema=schema)
                if item["name"] == "machine_fence_required"
            )
            assert column["nullable"] is False
            assert column["default"] in ("false", "false::boolean")
            assert (
                sync_conn.scalar(
                    sa.text("SELECT machine_fence_required FROM agent_environments WHERE id = :id"),
                    {"id": legacy_id},
                )
                is False
            )

            inserted_id = uuid.uuid4()
            sync_conn.execute(
                sa.text("INSERT INTO agent_environments (id) VALUES (CAST(:id AS uuid))"),
                {"id": str(inserted_id)},
            )
            assert (
                sync_conn.scalar(
                    sa.text("SELECT machine_fence_required FROM agent_environments WHERE id = :id"),
                    {"id": inserted_id},
                )
                is False
            )
        finally:
            migration.op = old_op
            sync_conn.execute(sa.text("SET search_path TO public"))
            sync_conn.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))

    async with engine.begin() as conn:
        await conn.run_sync(run_migration)
