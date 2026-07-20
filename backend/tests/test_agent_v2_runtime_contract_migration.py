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
HEAD_REVISION = "a6d2f4c8b1e7"
RUNTIME_OBSERVATION_DOWN_REVISION = "c7e4a9b2d6f1"
WORKLOAD_OAUTH_DOWN_REVISION = "f1a7c3d9e2b4"
CONFIG_OBSERVATION_REVISION = "f3a1c7d9e2b4"
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


def test_agent_v2_runtime_contract_migration_precedes_config_observation_migration() -> None:
    backend_dir = Path(__file__).parents[1]
    config = Config(str(backend_dir / "alembic.ini"))
    config.set_main_option("script_location", str(backend_dir / "alembic"))
    scripts = ScriptDirectory.from_config(config)

    assert scripts.get_heads() == [HEAD_REVISION]
    assert scripts.get_revision(HEAD_REVISION).down_revision == "4c8f2a1d7e9b"
    assert scripts.get_revision("4c8f2a1d7e9b").down_revision == RUNTIME_OBSERVATION_DOWN_REVISION
    assert (
        scripts.get_revision(RUNTIME_OBSERVATION_DOWN_REVISION).down_revision
        == WORKLOAD_OAUTH_DOWN_REVISION
    )
    assert (
        scripts.get_revision(WORKLOAD_OAUTH_DOWN_REVISION).down_revision
        == CONFIG_OBSERVATION_REVISION
    )
    assert scripts.get_revision(CONFIG_OBSERVATION_REVISION).down_revision == "a26c40c6965e"
    assert scripts.get_revision("a26c40c6965e").down_revision == REVISION
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
                        system jsonb,
                        live_sync jsonb,
                        recovery jsonb
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

            cli_package_spec_column = sync_conn.execute(
                sa.text(
                    """
                    SELECT is_nullable, column_default, data_type, character_maximum_length
                    FROM information_schema.columns
                    WHERE table_schema = :schema
                      AND table_name = 'hosted_runtime_states'
                      AND column_name = 'cli_package_spec'
                    """
                ),
                {"schema": schema},
            ).one()
            assert cli_package_spec_column.is_nullable == "NO"
            assert cli_package_spec_column.column_default is None
            assert cli_package_spec_column.data_type == "character varying"
            assert cli_package_spec_column.character_maximum_length == 200

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

            for required_column_name in ("live_sync", "recovery"):
                required_column = sync_conn.execute(
                    sa.text(
                        """
                        SELECT is_nullable, column_default, data_type
                        FROM information_schema.columns
                        WHERE table_schema = :schema
                          AND table_name = 'hosted_runtime_states'
                          AND column_name = :column_name
                        """
                    ),
                    {"schema": schema, "column_name": required_column_name},
                ).one()
                assert required_column.is_nullable == "NO"
                assert required_column.column_default is None
                assert required_column.data_type == "jsonb"

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

            for restored_column_name in ("live_sync", "recovery"):
                restored_column = sync_conn.execute(
                    sa.text(
                        """
                        SELECT is_nullable, column_default, data_type
                        FROM information_schema.columns
                        WHERE table_schema = :schema
                          AND table_name = 'hosted_runtime_states'
                          AND column_name = :column_name
                        """
                    ),
                    {"schema": schema, "column_name": restored_column_name},
                ).one()
                assert restored_column.is_nullable == "YES"
                assert restored_column.column_default is None
                assert restored_column.data_type == "jsonb"

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

            removed_cli_package_spec_column = sync_conn.execute(
                sa.text(
                    """
                    SELECT count(*)
                    FROM information_schema.columns
                    WHERE table_schema = :schema
                      AND table_name = 'hosted_runtime_states'
                      AND column_name = 'cli_package_spec'
                    """
                ),
                {"schema": schema},
            ).scalar_one()
            assert removed_cli_package_spec_column == 0
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
                        system jsonb,
                        live_sync jsonb,
                        recovery jsonb
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
                "live_sync",
                "recovery",
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


def test_agent_v2_runtime_contract_migration_rejects_nonempty_downgrade_before_schema_changes(
    engine: AsyncEngine,
) -> None:
    migration = _load_migration()
    schema = f"agent_v2_runtime_contract_downgrade_guard_{uuid.uuid4().hex}"
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
                        cli_package_spec varchar(200) NOT NULL,
                        locale jsonb NOT NULL,
                        system jsonb NOT NULL,
                        live_sync jsonb NOT NULL,
                        recovery jsonb NOT NULL
                    )
                    """
                )
            )
            sync_conn.execute(
                sa.text(
                    """
                    INSERT INTO hosted_runtime_states (
                        environment_id,
                        cli_package_spec,
                        locale,
                        system,
                        live_sync,
                        recovery
                    )
                    VALUES (
                        CAST(:environment_id AS uuid),
                        :cli_package_spec,
                        CAST(:locale AS jsonb),
                        CAST(:system AS jsonb),
                        CAST(:live_sync AS jsonb),
                        CAST(:recovery AS jsonb)
                    )
                    """
                ),
                {
                    "environment_id": str(environment_id),
                    "cli_package_spec": "clawdi@0.12.10-beta.51",
                    "locale": '{"language":"en","timezone":"UTC"}',
                    "system": '{"home":"/home/clawdi"}',
                    "live_sync": '{"enabled":false,"agents":[]}',
                    "recovery": '{"cacheManifest":true,"allowOfflineBoot":true}',
                },
            )
            migration.op = Operations(MigrationContext.configure(sync_conn))

            columns_before = sync_conn.execute(
                sa.text(
                    """
                    SELECT column_name, is_nullable, column_default, data_type,
                           character_maximum_length
                    FROM information_schema.columns
                    WHERE table_schema = :schema
                      AND table_name = 'hosted_runtime_states'
                    ORDER BY ordinal_position
                    """
                ),
                {"schema": schema},
            ).all()
            state_before = sync_conn.execute(
                sa.text(
                    """
                    SELECT environment_id, cli_package_spec, locale, system, live_sync, recovery
                    FROM hosted_runtime_states
                    """
                )
            ).one()

            with pytest.raises(
                RuntimeError,
                match=(
                    "Cannot downgrade migration d8f2a1c4b6e9.*"
                    "hosted_runtime_states is not empty.*"
                    "data-loss stop condition.*"
                    "approved operator procedure"
                ),
            ):
                migration.downgrade()

            columns_after = sync_conn.execute(
                sa.text(
                    """
                    SELECT column_name, is_nullable, column_default, data_type,
                           character_maximum_length
                    FROM information_schema.columns
                    WHERE table_schema = :schema
                      AND table_name = 'hosted_runtime_states'
                    ORDER BY ordinal_position
                    """
                ),
                {"schema": schema},
            ).all()
            state_after = sync_conn.execute(
                sa.text(
                    """
                    SELECT environment_id, cli_package_spec, locale, system, live_sync, recovery
                    FROM hosted_runtime_states
                    """
                )
            ).one()

            assert columns_after == columns_before
            assert state_after == state_before
            assert state_after.environment_id == environment_id
            assert state_after.cli_package_spec == "clawdi@0.12.10-beta.51"
            assert state_after.locale == {"language": "en", "timezone": "UTC"}
            assert state_after.system == {"home": "/home/clawdi"}
            assert state_after.live_sync == {"enabled": False, "agents": []}
            assert state_after.recovery == {
                "cacheManifest": True,
                "allowOfflineBoot": True,
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
