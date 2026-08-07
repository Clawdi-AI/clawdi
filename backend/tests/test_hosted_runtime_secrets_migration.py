from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy.ext.asyncio import AsyncEngine

from app.models.hosted_runtime import HostedRuntimeSecret

MIGRATION_FILENAME = "a9c4e7d2f1b6_hosted_runtime_secret_values.py"


def _load_migration():
    path = Path(__file__).parents[1] / "alembic" / "versions" / MIGRATION_FILENAME
    spec = importlib.util.spec_from_file_location("hosted_runtime_secret_values_migration", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def test_hosted_runtime_secret_model_matches_encrypted_owner_schema() -> None:
    columns = HostedRuntimeSecret.__table__.columns
    assert set(columns.keys()) == {
        "id",
        "environment_id",
        "secret_ref",
        "encrypted_value",
        "nonce",
        "key_version",
        "created_at",
        "updated_at",
    }
    assert columns.encrypted_value.nullable is False
    assert columns.nonce.nullable is False
    assert columns.key_version.nullable is False
    assert columns.created_at.nullable is False
    assert columns.updated_at.nullable is False


@pytest.mark.asyncio
async def test_hosted_runtime_secret_migration_creates_encrypted_cascade_owner(
    engine: AsyncEngine,
) -> None:
    migration = _load_migration()
    schema = f"hosted_runtime_secret_values_{uuid.uuid4().hex}"
    environment_id = uuid.uuid4()

    def run_migration(sync_conn: sa.Connection) -> None:
        old_op = migration.op
        sync_conn.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
        sync_conn.execute(sa.text(f'SET search_path TO "{schema}"'))
        try:
            sync_conn.execute(
                sa.text("CREATE TABLE hosted_runtime_states (environment_id uuid PRIMARY KEY)")
            )
            migration.op = Operations(MigrationContext.configure(sync_conn))
            migration.upgrade()
            columns = {
                row.column_name: row.is_nullable
                for row in sync_conn.execute(
                    sa.text(
                        """
                        SELECT column_name, is_nullable
                        FROM information_schema.columns
                        WHERE table_schema = :schema
                          AND table_name = 'hosted_runtime_secrets'
                        """
                    ),
                    {"schema": schema},
                )
            }
            assert columns["encrypted_value"] == "NO"
            assert columns["nonce"] == "NO"
            assert columns["key_version"] == "NO"
            assert columns["created_at"] == "NO"
            assert columns["updated_at"] == "NO"
            assert "plaintext" not in columns
            sync_conn.execute(
                sa.text(
                    "INSERT INTO hosted_runtime_states (environment_id) VALUES (:environment_id)"
                ),
                {"environment_id": environment_id},
            )
            sync_conn.execute(
                sa.text(
                    """
                    INSERT INTO hosted_runtime_secrets (
                        id, environment_id, secret_ref, encrypted_value, nonce
                    ) VALUES (
                        :id, :environment_id, 'secret://runtime/test', :ciphertext, :nonce
                    )
                    """
                ),
                {
                    "id": uuid.uuid4(),
                    "environment_id": environment_id,
                    "ciphertext": b"ciphertext",
                    "nonce": b"nonce",
                },
            )
            key_version = sync_conn.scalar(
                sa.text("SELECT key_version FROM hosted_runtime_secrets")
            )
            assert key_version == "vault.v1"
            sync_conn.execute(
                sa.text("DELETE FROM hosted_runtime_states WHERE environment_id = :environment_id"),
                {"environment_id": environment_id},
            )
            assert sync_conn.scalar(sa.text("SELECT count(*) FROM hosted_runtime_secrets")) == 0
            migration.downgrade()
        finally:
            migration.op = old_op
            sync_conn.execute(sa.text("RESET search_path"))
            sync_conn.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))

    async with engine.begin() as conn:
        await conn.run_sync(run_migration)
