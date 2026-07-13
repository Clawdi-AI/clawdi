from __future__ import annotations

import importlib.util
import json
import uuid
from pathlib import Path

import sqlalchemy as sa
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncEngine

REVISION = "f1a7c3d9e2b4"
MIGRATION_FILENAME = f"{REVISION}_separate_hosted_runtime_config_observations.py"


def _load_migration():
    migration_path = Path(__file__).parents[1] / "alembic" / "versions" / MIGRATION_FILENAME
    spec = importlib.util.spec_from_file_location(
        "hosted_runtime_observation_migration",
        migration_path,
    )
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def test_hosted_runtime_config_observation_migration_is_single_head() -> None:
    backend_dir = Path(__file__).parents[1]
    config = Config(str(backend_dir / "alembic.ini"))
    config.set_main_option("script_location", str(backend_dir / "alembic"))
    scripts = ScriptDirectory.from_config(config)

    assert scripts.get_heads() == [REVISION]
    assert scripts.get_revision(REVISION).down_revision == "d8f2a1c4b6e9"


def test_hosted_runtime_config_observation_migration_preserves_diagnostics_and_compute_state(
    engine: AsyncEngine,
) -> None:
    migration = _load_migration()
    schema = f"hosted_runtime_observation_migration_{uuid.uuid4().hex}"
    environment_id = uuid.uuid4()
    empty_environment_id = uuid.uuid4()
    legacy_diagnostics = {
        "schemaVersion": "clawdi.hostedRuntimeObserved.v1",
        "reportedAt": "2026-07-13T00:00:00Z",
        "status": "ok",
        "legacyDiagnostic": {"preserved": True},
    }

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
                        observed jsonb,
                        desired_generation integer,
                        observed_generation integer
                    )
                    """
                )
            )
            sync_conn.execute(
                sa.text(
                    """
                    INSERT INTO hosted_runtime_states (
                        environment_id,
                        observed,
                        desired_generation,
                        observed_generation
                    )
                    VALUES
                        (CAST(:environment_id AS uuid), CAST(:observed AS jsonb), 17, 13),
                        (CAST(:empty_environment_id AS uuid), NULL, 23, 19)
                    """
                ),
                {
                    "environment_id": str(environment_id),
                    "empty_environment_id": str(empty_environment_id),
                    "observed": json.dumps(legacy_diagnostics),
                },
            )
            migration.op = Operations(MigrationContext.configure(sync_conn))
            migration.upgrade()

            state_columns = {
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
            assert state_columns == {
                "environment_id",
                "desired_generation",
                "observed_generation",
            }

            compute_state = sync_conn.execute(
                sa.text(
                    """
                    SELECT desired_generation, observed_generation
                    FROM hosted_runtime_states
                    WHERE environment_id = :environment_id
                    """
                ),
                {"environment_id": environment_id},
            ).one()
            assert compute_state.desired_generation == 17
            assert compute_state.observed_generation == 13

            observation = sync_conn.execute(
                sa.text(
                    """
                    SELECT environment_id, observed_at, observed_config_generation,
                           observed_manifest_etag, diagnostics
                    FROM hosted_runtime_config_observations
                    """
                )
            ).one()
            assert observation.environment_id == environment_id
            assert observation.diagnostics == legacy_diagnostics
            assert observation.observed_at is None
            assert observation.observed_config_generation is None
            assert observation.observed_manifest_etag is None

            migration.downgrade()

            restored = sync_conn.execute(
                sa.text(
                    """
                    SELECT environment_id, observed, desired_generation, observed_generation
                    FROM hosted_runtime_states
                    ORDER BY environment_id
                    """
                )
            ).all()
            restored_by_id = {row.environment_id: row for row in restored}
            assert restored_by_id[environment_id].observed == legacy_diagnostics
            assert restored_by_id[environment_id].desired_generation == 17
            assert restored_by_id[environment_id].observed_generation == 13
            assert restored_by_id[empty_environment_id].observed is None
            assert restored_by_id[empty_environment_id].desired_generation == 23
            assert restored_by_id[empty_environment_id].observed_generation == 19
            observation_table_count = sync_conn.execute(
                sa.text(
                    """
                    SELECT count(*)
                    FROM information_schema.tables
                    WHERE table_schema = :schema
                      AND table_name = 'hosted_runtime_config_observations'
                    """
                ),
                {"schema": schema},
            ).scalar_one()
            assert observation_table_count == 0
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


def test_hosted_runtime_config_observation_cascades_with_runtime_state(
    engine: AsyncEngine,
) -> None:
    migration = _load_migration()
    schema = f"hosted_runtime_observation_cascade_{uuid.uuid4().hex}"
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
                        observed jsonb
                    )
                    """
                )
            )
            sync_conn.execute(
                sa.text(
                    """
                    INSERT INTO hosted_runtime_states (environment_id, observed)
                    VALUES (CAST(:environment_id AS uuid), '{"status":"ok"}'::jsonb)
                    """
                ),
                {"environment_id": str(environment_id)},
            )
            migration.op = Operations(MigrationContext.configure(sync_conn))
            migration.upgrade()

            sync_conn.execute(
                sa.text("DELETE FROM hosted_runtime_states WHERE environment_id = :environment_id"),
                {"environment_id": environment_id},
            )
            observation_count = sync_conn.execute(
                sa.text("SELECT count(*) FROM hosted_runtime_config_observations")
            ).scalar_one()
            assert observation_count == 0

            migration.downgrade()
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
