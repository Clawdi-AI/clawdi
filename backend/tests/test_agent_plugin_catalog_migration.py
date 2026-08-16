from __future__ import annotations

import importlib.util
import json
import uuid
from pathlib import Path

import pytest
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
        / "e6a1c9f3b7d2_plugin_catalog_desired_state.py"
    )
    spec = importlib.util.spec_from_file_location("plugin_catalog_desired_state", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _source_migration():
    path = (
        Path(__file__).parents[1]
        / "alembic"
        / "versions"
        / "c3e8f1a6d2b9_agent_plugin_catalog_sources.py"
    )
    spec = importlib.util.spec_from_file_location("agent_plugin_catalog_sources", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _base_tables(conn: sa.Connection) -> None:
    conn.execute(sa.text("CREATE TABLE agent_environments (id uuid PRIMARY KEY)"))
    conn.execute(
        sa.text(
            "CREATE TABLE hosted_runtime_states ("
            "environment_id uuid PRIMARY KEY, agent_plugins jsonb)"
        )
    )


def test_agent_plugin_catalog_migration_moves_authority_and_guards_downgrade(
    engine: AsyncEngine,
) -> None:
    migration = _migration()
    source_migration = _source_migration()
    schema = f"plugin_catalog_migration_{uuid.uuid4().hex}"
    environment_id = uuid.uuid4()
    installation_id = uuid.uuid4()
    revision = "a" * 40

    def run(conn: sa.Connection) -> None:
        old_op = migration.op
        old_source_op = source_migration.op
        conn.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
        conn.execute(sa.text(f'SET search_path TO "{schema}"'))
        try:
            _base_tables(conn)
            conn.execute(
                sa.text(
                    "INSERT INTO agent_environments (id) VALUES (CAST(:id AS uuid));"
                    "INSERT INTO hosted_runtime_states (environment_id, agent_plugins) "
                    "VALUES (CAST(:id AS uuid), CAST(:plugins AS jsonb))"
                ),
                {
                    "id": str(environment_id),
                    "plugins": json.dumps({"schemaVersion": 1, "installations": {}}),
                },
            )
            migration.op = Operations(MigrationContext.configure(conn))
            migration.upgrade()

            columns = {
                row.column_name
                for row in conn.execute(
                    sa.text(
                        "SELECT column_name FROM information_schema.columns "
                        "WHERE table_schema = :schema AND table_name = 'hosted_runtime_states'"
                    ),
                    {"schema": schema},
                )
            }
            assert "agent_plugins" not in columns

            conn.execute(
                sa.text(
                    "INSERT INTO plugin_catalog_snapshots "
                    "(revision, schema_version, entry_count, fetched_at) "
                    "VALUES (:revision, 1, 1, now());"
                    "INSERT INTO plugin_catalog_entries "
                    "(snapshot_revision, name, version, agent_plugins_schema, "
                    "source_path, content_digest, metadata, has_configuration, "
                    "compatible_runtimes) VALUES "
                    "(:revision, 'clawdi', '1.0.0', :schema_uri, "
                    "'v2/plugins/clawdi', :digest, '{}'::jsonb, false, '[\"openclaw\"]'::jsonb);"
                    "INSERT INTO agent_plugin_installations "
                    "(id, environment_id, plugin_name, catalog_revision, version, "
                    "agent_plugins_schema, source_path, content_digest) VALUES "
                    "(CAST(:installation_id AS uuid), CAST(:environment_id AS uuid), "
                    "'clawdi', :revision, '1.0.0', :schema_uri, 'v2/plugins/clawdi', :digest)"
                ),
                {
                    "revision": revision,
                    "installation_id": str(installation_id),
                    "environment_id": str(environment_id),
                    "schema_uri": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
                    "digest": f"sha256-tree-v1:{'b' * 64}",
                },
            )
            source_migration.op = Operations(MigrationContext.configure(conn))
            conn.execute(sa.text("UPDATE plugin_catalog_entries SET has_configuration = true"))
            with pytest.raises(RuntimeError, match="configuration metadata"):
                source_migration.upgrade()
            conn.execute(sa.text("UPDATE plugin_catalog_entries SET has_configuration = false"))
            source_migration.upgrade()
            has_configuration_column = conn.execute(
                sa.text(
                    "SELECT EXISTS (SELECT 1 FROM information_schema.columns "
                    "WHERE table_schema = :schema AND table_name = 'plugin_catalog_entries' "
                    "AND column_name = 'has_configuration')"
                ),
                {"schema": schema},
            ).scalar_one()
            assert has_configuration_column is False
            source = conn.execute(
                sa.text("SELECT source FROM agent_plugin_installations WHERE id = :id"),
                {"id": str(installation_id)},
            ).scalar_one()
            assert source == {
                "type": "github",
                "url": "https://github.com/Clawdi-AI/store",
                "path": "v2/plugins/clawdi",
                "commit": revision,
            }
            conn.execute(
                sa.text(
                    "UPDATE agent_plugin_installations SET source = "
                    "jsonb_build_object('type', 'github-release') WHERE id = :id"
                ),
                {"id": str(installation_id)},
            )
            with pytest.raises(RuntimeError, match="Cannot downgrade Agent Plugin source"):
                source_migration.downgrade()
            conn.execute(
                sa.text(
                    "UPDATE agent_plugin_installations "
                    "SET source = CAST(:source AS jsonb) WHERE id = :id"
                ),
                {"id": str(installation_id), "source": json.dumps(source)},
            )
            source_migration.downgrade()
            restored_configuration = conn.execute(
                sa.text("SELECT has_configuration FROM plugin_catalog_entries")
            ).scalar_one()
            assert restored_configuration is False
            with pytest.raises(RuntimeError, match="Cannot downgrade"):
                migration.downgrade()

            conn.execute(sa.text("DELETE FROM agent_plugin_installations"))
            migration.downgrade()
            restored = conn.execute(
                sa.text(
                    "SELECT data_type FROM information_schema.columns "
                    "WHERE table_schema = :schema AND table_name = 'hosted_runtime_states' "
                    "AND column_name = 'agent_plugins'"
                ),
                {"schema": schema},
            ).scalar_one()
            assert restored == "jsonb"
        finally:
            migration.op = old_op
            source_migration.op = old_source_op

    sync_engine = create_engine(engine.url.set(drivername="postgresql+psycopg2"))
    try:
        with sync_engine.begin() as conn:
            run(conn)
    finally:
        with sync_engine.begin() as conn:
            conn.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        sync_engine.dispose()


def test_agent_plugin_catalog_migration_rejects_malformed_legacy_state(
    engine: AsyncEngine,
) -> None:
    migration = _migration()
    schema = f"plugin_catalog_legacy_guard_{uuid.uuid4().hex}"

    def run(conn: sa.Connection) -> None:
        old_op = migration.op
        conn.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
        conn.execute(sa.text(f'SET search_path TO "{schema}"'))
        try:
            _base_tables(conn)
            conn.execute(
                sa.text(
                    "INSERT INTO hosted_runtime_states (environment_id, agent_plugins) "
                    "VALUES (CAST(:id AS uuid), '{}'::jsonb)"
                ),
                {"id": str(uuid.uuid4())},
            )
            migration.op = Operations(MigrationContext.configure(conn))
            with pytest.raises(RuntimeError, match="Cannot migrate non-empty or malformed"):
                migration.upgrade()
        finally:
            migration.op = old_op

    sync_engine = create_engine(engine.url.set(drivername="postgresql+psycopg2"))
    try:
        with sync_engine.begin() as conn:
            run(conn)
    finally:
        with sync_engine.begin() as conn:
            conn.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        sync_engine.dispose()
