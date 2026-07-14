from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import sqlalchemy as sa
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect
from sqlalchemy.ext.asyncio import AsyncEngine

REVISION = "f1a7c3d9e2b4"
MIGRATION_FILENAME = f"{REVISION}_finalize_unlaunched_agent_v2_schema.py"


def _load_migration():
    migration_path = Path(__file__).parents[1] / "alembic" / "versions" / MIGRATION_FILENAME
    spec = importlib.util.spec_from_file_location("agent_v2_final_schema_migration", migration_path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def _create_previous_schema(connection: sa.Connection) -> None:
    connection.execute(
        sa.text(
            """
            CREATE TABLE ai_providers (
                id integer PRIMARY KEY,
                scope varchar(40) NOT NULL DEFAULT 'account_global'
            )
            """
        )
    )
    connection.execute(
        sa.text(
            """
            CREATE TABLE hosted_runtime_states (
                environment_id uuid PRIMARY KEY,
                app_id varchar(200),
                observed jsonb
            )
            """
        )
    )


def test_agent_v2_final_schema_migration_is_single_head() -> None:
    backend_dir = Path(__file__).parents[1]
    config = Config(str(backend_dir / "alembic.ini"))
    config.set_main_option("script_location", str(backend_dir / "alembic"))
    scripts = ScriptDirectory.from_config(config)

    assert scripts.get_heads() == [REVISION]
    assert scripts.get_revision(REVISION).down_revision == "f3a1c7d9e2b4"


def test_agent_v2_final_schema_migration_is_additive_for_rolling_deploys(
    engine: AsyncEngine,
) -> None:
    migration = _load_migration()
    schema = f"agent_v2_final_schema_{uuid.uuid4().hex}"
    sync_engine = create_engine(engine.url.set(drivername="postgresql+psycopg2"))
    old_op = migration.op
    try:
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
            connection.execute(sa.text(f'SET search_path TO "{schema}"'))
            _create_previous_schema(connection)
            migration.op = Operations(MigrationContext.configure(connection))

            migration.upgrade()

            inspector = inspect(connection)
            provider_columns = {column["name"] for column in inspector.get_columns("ai_providers")}
            state_columns = {
                column["name"] for column in inspector.get_columns("hosted_runtime_states")
            }
            observation_columns = {
                column["name"]: column
                for column in inspector.get_columns("hosted_runtime_config_observations")
            }
            assert "scope" in provider_columns
            assert "app_id" in state_columns
            assert "observed" in state_columns
            assert set(observation_columns) == {
                "environment_id",
                "observed_at",
                "observed_config_generation",
                "observed_manifest_etag",
                "observed_source_revision",
                "diagnostics",
                "created_at",
                "updated_at",
            }
            assert observation_columns["diagnostics"]["nullable"] is False
            assert observation_columns["created_at"]["nullable"] is False
            assert observation_columns["updated_at"]["nullable"] is False

            migration.downgrade()

            inspector = inspect(connection)
            assert not inspector.has_table("hosted_runtime_config_observations")
            provider_columns = {column["name"] for column in inspector.get_columns("ai_providers")}
            state_columns = {
                column["name"] for column in inspector.get_columns("hosted_runtime_states")
            }
            assert "scope" in provider_columns
            assert "app_id" in state_columns
            assert "observed" in state_columns
    finally:
        migration.op = old_op
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        sync_engine.dispose()
