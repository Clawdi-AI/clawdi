from __future__ import annotations

import importlib.util
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.ext.asyncio import AsyncEngine


def _migration():
    path = (
        Path(__file__).parents[1]
        / "alembic"
        / "versions"
        / "b2c7e9a1d5f3_add_platform_idempotency_expiry.py"
    )
    spec = importlib.util.spec_from_file_location("platform_idempotency_expiry", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def test_platform_idempotency_migration_backfills_expiry_and_cascades_user_delete(
    engine: AsyncEngine,
) -> None:
    migration = _migration()
    schema = f"platform_idempotency_{uuid.uuid4().hex}"
    user_id = uuid.uuid4()
    row_id = uuid.uuid4()
    created_at = datetime.now(UTC) - timedelta(days=1)
    sync_engine = create_engine(engine.url.set(drivername="postgresql+psycopg2"))

    try:
        with sync_engine.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
            connection.execute(text(f'SET search_path TO "{schema}"'))
            connection.execute(text("CREATE TABLE users (id uuid PRIMARY KEY)"))
            connection.execute(
                text(
                    "CREATE TABLE platform_mutation_idempotency ("
                    "id uuid PRIMARY KEY, operation varchar(100) NOT NULL, "
                    "idempotency_key varchar(200) NOT NULL, request_hash varchar(64) NOT NULL, "
                    "owner_user_id uuid, resource_type varchar(80) NOT NULL, "
                    "resource_id varchar(200), response_status integer NOT NULL, "
                    "encrypted_response bytea NOT NULL, response_nonce bytea NOT NULL, "
                    "created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, "
                    "CONSTRAINT platform_mutation_idempotency_owner_user_id_fkey "
                    "FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL)"
                )
            )
            connection.execute(
                text(
                    "INSERT INTO users (id) VALUES (:user_id); "
                    "INSERT INTO platform_mutation_idempotency "
                    "(id, operation, idempotency_key, request_hash, owner_user_id, "
                    "resource_type, response_status, encrypted_response, response_nonce, "
                    "created_at, updated_at) VALUES "
                    "(:row_id, 'op', 'key', 'hash', :user_id, 'resource', 200, "
                    "'cipher'::bytea, 'nonce'::bytea, :created_at, :created_at)"
                ),
                {"user_id": user_id, "row_id": row_id, "created_at": created_at},
            )
            migration.op = Operations(MigrationContext.configure(connection))

            migration.upgrade()
            expires_at = connection.scalar(
                text(
                    "SELECT expires_at FROM platform_mutation_idempotency "
                    "WHERE id = :row_id"
                ),
                {"row_id": row_id},
            )
            assert expires_at == created_at + timedelta(days=7)
            foreign_keys = inspect(connection).get_foreign_keys("platform_mutation_idempotency")
            assert foreign_keys[0]["options"]["ondelete"] == "CASCADE"
            connection.execute(text("DELETE FROM users WHERE id = :user_id"), {"user_id": user_id})
            assert connection.scalar(
                text("SELECT count(*) FROM platform_mutation_idempotency")
            ) == 0

            migration.downgrade()
            assert "expires_at" not in {
                column["name"]
                for column in inspect(connection).get_columns("platform_mutation_idempotency")
            }
            foreign_keys = inspect(connection).get_foreign_keys("platform_mutation_idempotency")
            assert foreign_keys[0]["options"]["ondelete"] == "SET NULL"
            connection.execute(text("SET search_path TO public"))
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
    finally:
        sync_engine.dispose()
