from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import inspect, text

MIGRATION_FILENAME = "c7e4a9b2d6f1_platform_workload_oauth.py"


def _load_migration():
    migration_path = Path(__file__).parents[1] / "alembic" / "versions" / MIGRATION_FILENAME
    spec = importlib.util.spec_from_file_location(
        "platform_workload_oauth_migration",
        migration_path,
    )
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


async def test_platform_workload_oauth_migration_upgrades_and_downgrades(engine):
    schema = f"platform_workload_oauth_{uuid.uuid4().hex}"
    migration = _load_migration()

    async with engine.begin() as connection:
        await connection.execute(text(f'CREATE SCHEMA "{schema}"'))

        def run(sync_connection):
            try:
                sync_connection.execute(text(f'SET search_path TO "{schema}"'))
                migration.op = Operations(MigrationContext.configure(sync_connection))
                migration.upgrade()

                inspector = inspect(sync_connection)
                assert set(inspector.get_table_names()) == {
                    "platform_workload_assertion_replays",
                    "platform_workload_clients",
                    "platform_workload_signing_keys",
                }
                client_checks = {
                    check["name"]
                    for check in inspector.get_check_constraints("platform_workload_clients")
                }
                assert "ck_platform_workload_clients_allowed_scopes" in client_checks
                assert "ck_platform_workload_clients_public_jwk_only" in client_checks
                assert "ck_platform_workload_clients_public_jwk_identity" in client_checks
                assert "ck_platform_workload_clients_public_jwk_key_type" in client_checks
                replay_uniques = {
                    unique["name"]
                    for unique in inspector.get_unique_constraints(
                        "platform_workload_assertion_replays"
                    )
                }
                assert "uq_platform_workload_assertion_replays_client_jti" in replay_uniques
                signing_columns = {
                    column["name"]
                    for column in inspector.get_columns("platform_workload_signing_keys")
                }
                assert "private_key_ref" in signing_columns
                assert "private_key" not in signing_columns

                migration.downgrade()
                assert inspect(sync_connection).get_table_names() == []

                migration.upgrade()
                assert set(inspect(sync_connection).get_table_names()) == {
                    "platform_workload_assertion_replays",
                    "platform_workload_clients",
                    "platform_workload_signing_keys",
                }
                migration.downgrade()
                assert inspect(sync_connection).get_table_names() == []
            finally:
                sync_connection.execute(text("SET search_path TO public"))

        try:
            await connection.run_sync(run)
        finally:
            await connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
