from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncEngine

REVISION = "d8f2a1c4b6e9"
MIGRATION_FILENAME = f"{REVISION}_finalize_agent_v2_runtime_contract.py"


def _load_migration():
    migration_path = Path(__file__).parents[1] / "alembic" / "versions" / MIGRATION_FILENAME
    spec = importlib.util.spec_from_file_location(
        "agent_v2_runtime_contract_migration",
        migration_path,
    )
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def test_agent_v2_runtime_contract_migration_is_single_head() -> None:
    backend_dir = Path(__file__).parents[1]
    config = Config(str(backend_dir / "alembic.ini"))
    config.set_main_option("script_location", str(backend_dir / "alembic"))
    scripts = ScriptDirectory.from_config(config)

    assert scripts.get_heads() == [REVISION]
    assert scripts.get_revision(REVISION).down_revision == "c4e8f1a2b3d5"


def test_agent_v2_runtime_contract_migration_upgrades_and_downgrades_empty_state(
    engine: AsyncEngine,
) -> None:
    migration = _load_migration()
    schema = f"agent_v2_runtime_contract_migration_{uuid.uuid4().hex}"

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
                        clawdi_cli jsonb,
                        control_plane jsonb,
                        provider_id varchar(80),
                        system jsonb
                    )
                    """
                )
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
            assert column.is_nullable == "NO"
            assert column.column_default is None
            assert column.data_type == "jsonb"

            removed_cli_column = sync_conn.execute(
                sa.text(
                    """
                    SELECT count(*)
                    FROM information_schema.columns
                    WHERE table_schema = :schema
                      AND table_name = 'hosted_runtime_states'
                      AND column_name = 'clawdi_cli'
                    """
                ),
                {"schema": schema},
            ).scalar_one()
            assert removed_cli_column == 0

            removed_control_plane_column = sync_conn.execute(
                sa.text(
                    """
                    SELECT count(*)
                    FROM information_schema.columns
                    WHERE table_schema = :schema
                      AND table_name = 'hosted_runtime_states'
                      AND column_name = 'control_plane'
                    """
                ),
                {"schema": schema},
            ).scalar_one()
            assert removed_control_plane_column == 0

            removed_provider_column = sync_conn.execute(
                sa.text(
                    """
                    SELECT count(*)
                    FROM information_schema.columns
                    WHERE table_schema = :schema
                      AND table_name = 'hosted_runtime_states'
                      AND column_name = 'provider_id'
                    """
                ),
                {"schema": schema},
            ).scalar_one()
            assert removed_provider_column == 0

            required_system_column = sync_conn.execute(
                sa.text(
                    """
                    SELECT is_nullable, column_default, data_type
                    FROM information_schema.columns
                    WHERE table_schema = :schema
                      AND table_name = 'hosted_runtime_states'
                      AND column_name = 'system'
                    """
                ),
                {"schema": schema},
            ).one()
            assert required_system_column.is_nullable == "NO"
            assert required_system_column.column_default is None
            assert required_system_column.data_type == "jsonb"

            migration.downgrade()

            restored_cli_column = sync_conn.execute(
                sa.text(
                    """
                    SELECT is_nullable, column_default, data_type
                    FROM information_schema.columns
                    WHERE table_schema = :schema
                      AND table_name = 'hosted_runtime_states'
                      AND column_name = 'clawdi_cli'
                    """
                ),
                {"schema": schema},
            ).one()
            assert restored_cli_column.is_nullable == "YES"
            assert restored_cli_column.column_default is None
            assert restored_cli_column.data_type == "jsonb"

            restored_control_plane_column = sync_conn.execute(
                sa.text(
                    """
                    SELECT is_nullable, column_default, data_type
                    FROM information_schema.columns
                    WHERE table_schema = :schema
                      AND table_name = 'hosted_runtime_states'
                      AND column_name = 'control_plane'
                    """
                ),
                {"schema": schema},
            ).one()
            assert restored_control_plane_column.is_nullable == "YES"
            assert restored_control_plane_column.column_default is None
            assert restored_control_plane_column.data_type == "jsonb"

            restored_provider_column = sync_conn.execute(
                sa.text(
                    """
                    SELECT is_nullable, column_default, data_type, character_maximum_length
                    FROM information_schema.columns
                    WHERE table_schema = :schema
                      AND table_name = 'hosted_runtime_states'
                      AND column_name = 'provider_id'
                    """
                ),
                {"schema": schema},
            ).one()
            assert restored_provider_column.is_nullable == "YES"
            assert restored_provider_column.column_default is None
            assert restored_provider_column.data_type == "character varying"
            assert restored_provider_column.character_maximum_length == 80

            restored_system_column = sync_conn.execute(
                sa.text(
                    """
                    SELECT is_nullable, column_default, data_type
                    FROM information_schema.columns
                    WHERE table_schema = :schema
                      AND table_name = 'hosted_runtime_states'
                      AND column_name = 'system'
                    """
                ),
                {"schema": schema},
            ).one()
            assert restored_system_column.is_nullable == "YES"
            assert restored_system_column.column_default is None
            assert restored_system_column.data_type == "jsonb"

            removed_locale_column = sync_conn.execute(
                sa.text(
                    """
                    SELECT count(*)
                    FROM information_schema.columns
                    WHERE table_schema = :schema
                      AND table_name = 'hosted_runtime_states'
                      AND column_name = 'locale'
                    """
                ),
                {"schema": schema},
            ).scalar_one()
            assert removed_locale_column == 0
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


def test_agent_v2_runtime_contract_migration_rejects_existing_state_before_schema_changes(
    engine: AsyncEngine,
) -> None:
    migration = _load_migration()
    schema = f"agent_v2_runtime_contract_migration_guard_{uuid.uuid4().hex}"
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
                        clawdi_cli jsonb,
                        control_plane jsonb,
                        provider_id varchar(80),
                        system jsonb
                    )
                    """
                )
            )
            sync_conn.execute(
                sa.text(
                    """
                    INSERT INTO hosted_runtime_states (
                        environment_id,
                        clawdi_cli,
                        control_plane,
                        provider_id,
                        system
                    )
                    VALUES (
                        CAST(:environment_id AS uuid),
                        CAST(:clawdi_cli AS jsonb),
                        CAST(:control_plane AS jsonb),
                        :provider_id,
                        CAST(:system AS jsonb)
                    )
                    """
                ),
                {
                    "environment_id": str(environment_id),
                    "clawdi_cli": '{"channel":"beta"}',
                    "control_plane": '{"manifestUrl":"https://cloud.test/manifest"}',
                    "provider_id": "legacy-provider",
                    "system": '{"home":"/home/legacy"}',
                },
            )
            migration.op = Operations(MigrationContext.configure(sync_conn))

            with pytest.raises(
                RuntimeError,
                match=(
                    "hosted_runtime_states is not empty.*"
                    "rollout stop condition.*"
                    "approved operator procedure"
                ),
            ):
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
            assert columns == {
                "environment_id",
                "clawdi_cli",
                "control_plane",
                "provider_id",
                "system",
            }

            stored_state = sync_conn.execute(
                sa.text(
                    """
                    SELECT environment_id, clawdi_cli, control_plane, provider_id, system
                    FROM hosted_runtime_states
                    """
                )
            ).one()
            assert stored_state.environment_id == environment_id
            assert stored_state.clawdi_cli == {"channel": "beta"}
            assert stored_state.control_plane == {"manifestUrl": "https://cloud.test/manifest"}
            assert stored_state.provider_id == "legacy-provider"
            assert stored_state.system == {"home": "/home/legacy"}
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
