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
async def test_agent_archival_migration_upgrade_downgrade_preserves_rows(engine: AsyncEngine):
    path = (
        Path(__file__).parents[1]
        / "alembic"
        / "versions"
        / "f3b7c1d9e5a2_archive_agent_lifecycle.py"
    )
    spec = importlib.util.spec_from_file_location("agent_archival_migration", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    schema = f"agent_archival_{uuid.uuid4().hex}"
    row_id = uuid.uuid4()

    def run(sync_conn):
        old_op = migration.op
        sync_conn.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
        sync_conn.execute(sa.text(f'SET search_path TO "{schema}"'))
        try:
            sync_conn.execute(sa.text("CREATE TABLE agent_environments (id uuid PRIMARY KEY)"))
            sync_conn.execute(
                sa.text("INSERT INTO agent_environments (id) VALUES (:id)"),
                {"id": row_id},
            )
            migration.op = Operations(MigrationContext.configure(sync_conn))
            migration.upgrade()
            assert (
                sync_conn.execute(
                    sa.text("SELECT archived_at FROM agent_environments WHERE id = :id"),
                    {"id": row_id},
                ).scalar_one()
                is None
            )
            migration.downgrade()
            assert (
                sync_conn.execute(
                    sa.text("SELECT count(*) FROM agent_environments WHERE id = :id"),
                    {"id": row_id},
                ).scalar_one()
                == 1
            )
        finally:
            migration.op = old_op
            sync_conn.execute(sa.text("SET search_path TO public"))
            sync_conn.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))

    async with engine.begin() as conn:
        await conn.run_sync(run)
