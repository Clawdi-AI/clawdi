from __future__ import annotations

import uuid

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from tests.migration_harness import load_migration


async def test_first_sync_migration_excludes_history_but_new_rows_start_unsynced(engine):
    migration = load_migration("d6f2a9c4e810_session_first_sync.py", "session_first_sync_migration")
    schema = f"session_first_sync_{uuid.uuid4().hex}"

    def run(connection):
        original_op = migration.op
        connection.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
        connection.execute(sa.text(f'SET LOCAL search_path TO "{schema}"'))
        try:
            connection.execute(sa.text("CREATE TABLE sessions (id integer PRIMARY KEY)"))
            connection.execute(sa.text("INSERT INTO sessions VALUES (1)"))
            migration.op = Operations(MigrationContext.configure(connection))
            migration.upgrade()
            connection.execute(sa.text("INSERT INTO sessions (id) VALUES (2)"))
            rows = connection.execute(
                sa.text("SELECT first_synced_at FROM sessions ORDER BY id")
            ).all()
            assert rows[0].first_synced_at is not None
            assert rows[1].first_synced_at is None
            migration.downgrade()
            columns = {column["name"] for column in sa.inspect(connection).get_columns("sessions")}
            assert columns == {"id"}
        finally:
            migration.op = original_op
            connection.execute(sa.text("SET LOCAL search_path TO public"))
            connection.execute(sa.text(f'DROP SCHEMA "{schema}" CASCADE'))

    async with engine.begin() as connection:
        await connection.run_sync(run)
