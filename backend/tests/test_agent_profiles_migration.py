import uuid

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError, OperationalError

from tests.migration_harness import load_migration


@pytest.mark.parametrize("failure", [None, "invalid_index", "lock_timeout"])
def test_profile_migration_preserves_old_api_and_retries(engine, failure):
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
            if failure == "lock_timeout":
                with sync.connect() as blocker:
                    blocker.execute(text(f'LOCK TABLE "{schema}".sessions IN ACCESS SHARE MODE'))
                    with pytest.raises(OperationalError, match="lock timeout"):
                        with context.begin_transaction():
                            migration.upgrade()
                    connection.rollback()
                    blocker.rollback()
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
                == 1
            )
            assert (
                connection.execute(
                    text(
                        "SELECT count(*) FROM pg_constraint WHERE conrelid = 'sessions'::regclass "
                        "AND conname = 'uq_sessions_user_origin_profile_local'"
                    )
                ).scalar_one()
                == 0
            )
            # The deployed old API omits the profile column and names this constraint.
            connection.execute(
                text("""INSERT INTO sessions
                (id,user_id,origin_environment_id,local_session_id,content_hash)
                VALUES (:id,:u,:a,'same','old-api-update')
                ON CONFLICT ON CONSTRAINT uq_sessions_user_origin_local
                DO UPDATE SET content_hash=EXCLUDED.content_hash"""),
                {"id": uuid.uuid4(), "u": user, "a": agent},
            )
            assert connection.execute(
                text("SELECT id, file_key, content_hash, origin_profile_key FROM sessions")
            ).one() == (session, "content-key", "old-api-update", "")
            with pytest.raises(IntegrityError), connection.begin_nested():
                connection.execute(
                    text("""INSERT INTO sessions (id,user_id,origin_environment_id,local_session_id)
                    VALUES (:id,:u,:a,'same')"""),
                    {"id": uuid.uuid4(), "u": user, "a": agent},
                )
            with pytest.raises(IntegrityError), connection.begin_nested():
                connection.execute(
                    text("""INSERT INTO sessions
                        (id,user_id,origin_environment_id,origin_profile_key,local_session_id)
                    VALUES (:id,:u,:a,'work','same')"""),
                    {"id": uuid.uuid4(), "u": user, "a": agent},
                )
            connection.rollback()
            if failure == "invalid_index":
                connection.execute(
                    text("""INSERT INTO sessions
                    (id,user_id,origin_environment_id,local_session_id)
                    VALUES (:id,:u,:a,'different')"""),
                    {"id": uuid.uuid4(), "u": user, "a": agent},
                )
                connection.commit()
                connection.execution_options(isolation_level="AUTOCOMMIT")
                connection.execute(
                    text("DROP INDEX CONCURRENTLY uq_sessions_user_origin_profile_local")
                )
                with pytest.raises(IntegrityError):
                    connection.execute(
                        text(
                            "CREATE UNIQUE INDEX CONCURRENTLY "
                            "uq_sessions_user_origin_profile_local ON sessions (user_id)"
                        )
                    )
                assert (
                    connection.execute(
                        text(
                            "SELECT indisvalid FROM pg_index WHERE "
                            "indexrelid='uq_sessions_user_origin_profile_local'::regclass"
                        )
                    ).scalar_one()
                    is False
                )
                connection.rollback()
                connection.execution_options(isolation_level="READ COMMITTED")
            # Re-running committed DDL safely tolerates Alembic's concurrent-index boundaries.
            with context.begin_transaction():
                migration.upgrade()
            assert (
                connection.execute(
                    text(
                        "SELECT indisvalid FROM pg_index WHERE "
                        "indexrelid='uq_sessions_user_origin_profile_local'::regclass"
                    )
                ).scalar_one()
                is True
            )
            connection.rollback()
            if failure == "invalid_index":
                connection.execute(text("DELETE FROM sessions WHERE local_session_id='different'"))
                connection.commit()
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
