from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncEngine

MIGRATION_FILENAME = "e1c7a4b9d2f6_add_vault_write_runtime_scope.py"
PREVIOUS_RUNTIME_SCOPES = [
    "connectors:read",
    "connectors:invoke",
    "memories:read",
    "memories:write",
    "projects:read",
    "sessions:read",
    "sessions:write",
    "skills:read",
    "skills:write",
    "vault:read",
]


def _load_migration():
    migration_path = Path(__file__).parents[1] / "alembic" / "versions" / MIGRATION_FILENAME
    spec = importlib.util.spec_from_file_location("vault_write_scope_migration", migration_path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def _insert_key(
    connection: sa.Connection,
    *,
    managed: bool,
    environment_id: uuid.UUID | None,
    runtime_deployment_id: str | None,
    scopes: list[str] | None,
) -> uuid.UUID:
    key_id = uuid.uuid4()
    connection.execute(
        sa.text(
            """
            INSERT INTO api_keys (id, managed, environment_id, runtime_deployment_id, scopes)
            VALUES (
                CAST(:id AS uuid),
                :managed,
                CAST(:environment_id AS uuid),
                :runtime_deployment_id,
                :scopes
            )
            """
        ),
        {
            "id": str(key_id),
            "managed": managed,
            "environment_id": str(environment_id) if environment_id is not None else None,
            "runtime_deployment_id": runtime_deployment_id,
            "scopes": scopes,
        },
    )
    return key_id


def _scopes(connection: sa.Connection, key_id: uuid.UUID) -> list[str] | None:
    return connection.execute(
        sa.text("SELECT scopes FROM api_keys WHERE id = CAST(:id AS uuid)"),
        {"id": str(key_id)},
    ).scalar_one()


def test_vault_write_scope_migration_reconciles_runtime_keys_without_widening_narrow_keys(
    engine: AsyncEngine,
) -> None:
    migration = _load_migration()
    schema = f"vault_write_scope_{uuid.uuid4().hex}"
    environment_id = uuid.uuid4()
    sync_engine = create_engine(engine.url.set(drivername="postgresql+psycopg2"))
    old_op = migration.op
    try:
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
            connection.execute(sa.text(f'SET search_path TO "{schema}"'))
            connection.execute(
                sa.text(
                    """
                    CREATE TABLE api_keys (
                        id uuid PRIMARY KEY,
                        managed boolean NOT NULL,
                        environment_id uuid,
                        runtime_deployment_id varchar(200),
                        scopes varchar[]
                    )
                    """
                )
            )
            strict_key = _insert_key(
                connection,
                managed=True,
                environment_id=environment_id,
                runtime_deployment_id="strict-runtime",
                scopes=[*PREVIOUS_RUNTIME_SCOPES, "runtime-observations:write", "future:scope"],
            )
            strict_narrow_key = _insert_key(
                connection,
                managed=True,
                environment_id=environment_id,
                runtime_deployment_id="strict-narrow",
                scopes=["runtime-observations:write"],
            )
            legacy_full_key = _insert_key(
                connection,
                managed=True,
                environment_id=environment_id,
                runtime_deployment_id=None,
                scopes=PREVIOUS_RUNTIME_SCOPES,
            )
            narrow_key = _insert_key(
                connection,
                managed=True,
                environment_id=environment_id,
                runtime_deployment_id=None,
                scopes=["sessions:write", "skills:read", "skills:write"],
            )
            unbound_key = _insert_key(
                connection,
                managed=False,
                environment_id=None,
                runtime_deployment_id=None,
                scopes=PREVIOUS_RUNTIME_SCOPES,
            )
            migration.op = Operations(MigrationContext.configure(connection))

            migration.upgrade()

            assert _scopes(connection, strict_key) == [
                *PREVIOUS_RUNTIME_SCOPES,
                "runtime-observations:write",
                "future:scope",
                "vault:write",
            ]
            assert _scopes(connection, strict_narrow_key) == ["runtime-observations:write"]
            assert _scopes(connection, legacy_full_key) == [
                *PREVIOUS_RUNTIME_SCOPES,
                "vault:write",
            ]
            assert _scopes(connection, narrow_key) == [
                "sessions:write",
                "skills:read",
                "skills:write",
            ]
            assert _scopes(connection, unbound_key) == PREVIOUS_RUNTIME_SCOPES

            migration.downgrade()

            assert "vault:write" not in (_scopes(connection, strict_key) or [])
            assert _scopes(connection, strict_narrow_key) == ["runtime-observations:write"]
            assert _scopes(connection, legacy_full_key) == PREVIOUS_RUNTIME_SCOPES
            assert _scopes(connection, narrow_key) == [
                "sessions:write",
                "skills:read",
                "skills:write",
            ]
            assert _scopes(connection, unbound_key) == PREVIOUS_RUNTIME_SCOPES
    finally:
        migration.op = old_op
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        sync_engine.dispose()
