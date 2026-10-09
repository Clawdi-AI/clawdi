from __future__ import annotations

import uuid

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.migration_harness import load_migration


def test_retirement_removes_grants_preserves_snapshots_and_restores_empty_schema(
    engine: AsyncEngine,
) -> None:
    legacy = load_migration("d4e5f6a7b8c9_add_session_permissions.py", "legacy_session_permissions")
    retirement = load_migration(
        "d5f9a2b7c813_retire_live_session_shares.py", "retire_live_session_shares"
    )
    schema = f"live_share_retirement_{uuid.uuid4().hex}"
    sync_engine = create_engine(engine.url.set(drivername="postgresql+psycopg2"))
    original_legacy_op = legacy.op
    original_retirement_op = retirement.op
    try:
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f"CREATE SCHEMA {schema}"))
            connection.execute(sa.text(f"SET LOCAL search_path TO {schema}"))
            connection.execute(sa.text("CREATE TABLE users (id uuid PRIMARY KEY)"))
            connection.execute(sa.text("CREATE TABLE sessions (id uuid PRIMARY KEY)"))
            connection.execute(sa.text("CREATE TABLE session_shares (id uuid PRIMARY KEY)"))
            share_id = uuid.uuid4()
            connection.execute(sa.text("INSERT INTO session_shares VALUES (:id)"), {"id": share_id})
            legacy.op = Operations(MigrationContext.configure(connection))
            retirement.op = legacy.op
            legacy.upgrade()
            user_id, session_id = uuid.uuid4(), uuid.uuid4()
            connection.execute(sa.text("INSERT INTO users VALUES (:id)"), {"id": user_id})
            connection.execute(sa.text("INSERT INTO sessions VALUES (:id)"), {"id": session_id})
            connection.execute(
                sa.text(
                    "INSERT INTO session_permissions (id, session_id, kind) "
                    "VALUES (:id, :session_id, 'link')"
                ),
                {"id": uuid.uuid4(), "session_id": session_id},
            )
            retirement.upgrade()
            assert "session_permissions" not in sa.inspect(connection).get_table_names(
                schema=schema
            )
            assert (
                connection.execute(sa.text("SELECT id FROM session_shares")).scalar_one()
                == share_id
            )
            retirement.downgrade()
            assert (
                connection.execute(sa.text("SELECT count(*) FROM session_permissions")).scalar_one()
                == 0
            )
            assert {
                index["name"]
                for index in sa.inspect(connection).get_indexes(
                    "session_permissions", schema=schema
                )
            } == {
                "ix_session_permissions_session_id",
                "ix_session_permissions_user_id",
                "ix_session_permissions_email_pending",
                "uq_active_permission_per_principal",
            }
            retirement.upgrade()
    finally:
        legacy.op = original_legacy_op
        retirement.op = original_retirement_op
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f"DROP SCHEMA IF EXISTS {schema} CASCADE"))
        sync_engine.dispose()
