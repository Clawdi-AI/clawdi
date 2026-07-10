from __future__ import annotations

import importlib.util
import json
import uuid
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncEngine


def _load_migration(filename: str, module_name: str):
    migration_path = Path(__file__).parents[1] / "alembic" / "versions" / filename
    spec = importlib.util.spec_from_file_location(module_name, migration_path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def test_hosted_runtime_egress_migration_backfills_engine_type(
    engine: AsyncEngine,
) -> None:
    migration = _load_migration(
        "c4e8f1a2b3d5_rename_hosted_runtime_egress_columns.py",
        "hosted_runtime_egress_migration",
    )
    schema = f"hosted_runtime_egress_migration_{uuid.uuid4().hex}"
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
                        environment_id uuid PRIMARY KEY,
                        mitmproxy jsonb,
                        mitm_profiles jsonb
                    )
                    """
                )
            )
            sync_conn.execute(
                sa.text(
                    """
                    INSERT INTO hosted_runtime_states (
                        environment_id,
                        mitmproxy,
                        mitm_profiles
                    )
                    VALUES (
                        CAST(:environment_id AS uuid),
                        CAST(:engine AS jsonb),
                        CAST(:profiles AS jsonb)
                    )
                    """
                ),
                {
                    "environment_id": str(environment_id),
                    "engine": json.dumps(
                        {
                            "version": "12.2.3",
                            "url": "https://downloads.mitmproxy.org/12.2.3/mitmproxy.tar.gz",
                            "sha256": "a" * 64,
                        }
                    ),
                    "profiles": json.dumps({"profiles": []}),
                },
            )

            migration.op = Operations(MigrationContext.configure(sync_conn))
            migration.upgrade()

            columns = {
                row.column_name
                for row in sync_conn.execute(
                    sa.text(
                        """
                        SELECT column_name
                        FROM information_schema.columns
                        WHERE table_schema = :schema
                          AND table_name = 'hosted_runtime_states'
                        """
                    ),
                    {"schema": schema},
                )
            }
            assert "egress_engine" in columns
            assert "egress_profiles" in columns
            assert "mitmproxy" not in columns
            assert "mitm_profiles" not in columns

            row = sync_conn.execute(
                sa.text(
                    """
                    SELECT egress_engine, egress_profiles
                    FROM hosted_runtime_states
                    WHERE environment_id = CAST(:environment_id AS uuid)
                    """
                ),
                {"environment_id": str(environment_id)},
            ).one()
            assert row.egress_engine["type"] == "mitmproxy"
            assert row.egress_engine["version"] == "12.2.3"
            assert row.egress_profiles == {"profiles": []}
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
