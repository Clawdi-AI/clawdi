import uuid

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError

from tests.migration_harness import load_migration


def test_profile_migration_preserves_rows_and_concurrent_unique_identity(engine):
    migration = load_migration("a8c4f2d9e610_agent_profiles.py", "profile_migration")
    schema = f"profile_migration_{uuid.uuid4().hex}"
    sync = create_engine(engine.url.set(drivername="postgresql+psycopg2"))
    original_op = migration.op
    agent, user, session = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    try:
        with sync.connect() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
            connection.execute(text(f'SET search_path TO "{schema}"'))
            connection.execute(text("CREATE TABLE agent_environments (id uuid PRIMARY KEY)"))
            connection.execute(text("CREATE TABLE projects (id uuid PRIMARY KEY)"))
            connection.execute(
                text("""CREATE TABLE sessions (id uuid PRIMARY KEY,
                user_id uuid NOT NULL, origin_environment_id uuid, local_session_id varchar(200),
                file_key text, content_hash text,
                CONSTRAINT uq_sessions_user_origin_local UNIQUE
                    (user_id, origin_environment_id, local_session_id))""")
            )
            connection.execute(
                text("""CREATE TABLE session_sync_suppressions (user_id uuid,
                origin_environment_id uuid, local_session_id varchar(200))""")
            )
            connection.execute(
                text("""CREATE UNIQUE INDEX uq_session_sync_suppressions_origin
                ON session_sync_suppressions (user_id, origin_environment_id, local_session_id)
                WHERE origin_environment_id IS NOT NULL""")
            )
            connection.execute(
                text("""CREATE UNIQUE INDEX uq_session_sync_suppressions_legacy
                ON session_sync_suppressions (user_id, local_session_id)
                WHERE origin_environment_id IS NULL""")
            )
            connection.execute(text("INSERT INTO agent_environments VALUES (:id)"), {"id": agent})
            connection.execute(
                text("""INSERT INTO sessions VALUES
                (:id, :user, :agent, 'same', 'content-key', 'unchanged-hash')"""),
                {"id": session, "user": user, "agent": agent},
            )
            connection.execute(
                text("INSERT INTO session_sync_suppressions VALUES (:u, :a, 'deleted')"),
                {"u": user, "a": agent},
            )
            connection.commit()
            context = MigrationContext.configure(connection)
            migration.op = Operations(context)
            with context.begin_transaction():
                migration.upgrade()
            assert connection.execute(
                text("SELECT profile_key, upstream_key, is_default FROM agent_profiles")
            ).one() == ("", "", True)
            row = connection.execute(
                text("SELECT id, file_key, content_hash, origin_profile_key FROM sessions")
            ).one()
            assert row == (session, "content-key", "unchanged-hash", "")
            assert (
                connection.execute(
                    text("SELECT origin_profile_key FROM session_sync_suppressions")
                ).scalar_one()
                == ""
            )
            assert (
                connection.execute(
                    text(
                        "SELECT indisvalid FROM pg_index WHERE indexrelid = "
                        "'uq_sessions_user_origin_profile_local'::regclass"
                    )
                ).scalar_one()
                is True
            )
            assert (
                connection.execute(
                    text(
                        "SELECT count(*) FROM pg_constraint WHERE conrelid = 'sessions'::regclass "
                        "AND conname = 'uq_sessions_user_origin_local'"
                    )
                ).scalar_one()
                == 0
            )
            with pytest.raises(IntegrityError), connection.begin_nested():
                connection.execute(
                    text("""INSERT INTO sessions (id,user_id,origin_environment_id,local_session_id)
                    VALUES (:id,:u,:a,'same')"""),
                    {"id": uuid.uuid4(), "u": user, "a": agent},
                )
            connection.execute(
                text("""INSERT INTO sessions
                    (id,user_id,origin_environment_id,origin_profile_key,local_session_id)
                VALUES (:id,:u,:a,'work','same')"""),
                {"id": uuid.uuid4(), "u": user, "a": agent},
            )
            assert connection.execute(text("SELECT count(*) FROM sessions")).scalar_one() == 2
            connection.rollback()
            # Re-running committed DDL safely tolerates Alembic's concurrent-index boundaries.
            with context.begin_transaction():
                migration.upgrade()
            with context.begin_transaction():
                migration.downgrade()
            assert connection.execute(
                text("SELECT id, file_key, content_hash FROM sessions")
            ).one() == (session, "content-key", "unchanged-hash")
    finally:
        migration.op = original_op
        with sync.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        sync.dispose()
