from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncEngine

MIGRATION_FILENAME = "c6e8a1f4d2b9_session_events_and_adapter_modules.py"


def _load_migration():
    migration_path = Path(__file__).parents[1] / "alembic" / "versions" / MIGRATION_FILENAME
    spec = importlib.util.spec_from_file_location("session_events_migration", migration_path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def _create_previous_schema(connection: sa.Connection) -> None:
    connection.execute(sa.text("CREATE TABLE agent_environments (id uuid PRIMARY KEY)"))
    connection.execute(
        sa.text(
            """
            CREATE TABLE session_sync_suppressions (
                user_id uuid NOT NULL,
                local_session_id varchar(200) NOT NULL,
                CONSTRAINT pk_session_sync_suppressions
                    PRIMARY KEY (user_id, local_session_id)
            )
            """
        )
    )
    connection.execute(
        sa.text(
            """
            CREATE TABLE sessions (
                id uuid PRIMARY KEY,
                user_id uuid NOT NULL,
                environment_id uuid,
                local_session_id varchar(200) NOT NULL,
                CONSTRAINT uq_sessions_user_local
                    UNIQUE (user_id, local_session_id)
            )
            """
        )
    )


def _insert_session(
    connection: sa.Connection,
    *,
    user_id: uuid.UUID,
    environment_id: uuid.UUID,
    local_session_id: str,
) -> None:
    connection.execute(
        sa.text(
            """
            INSERT INTO sessions (id, user_id, environment_id, local_session_id)
            VALUES (:id, :user_id, :environment_id, :local_session_id)
            """
        ),
        {
            "id": uuid.uuid4(),
            "user_id": user_id,
            "environment_id": environment_id,
            "local_session_id": local_session_id,
        },
    )


def _insert_suppression(
    connection: sa.Connection,
    *,
    user_id: uuid.UUID,
    local_session_id: str,
    origin_environment_id: uuid.UUID | None = None,
) -> None:
    values = {
        "user_id": user_id,
        "local_session_id": local_session_id,
    }
    if origin_environment_id is None:
        connection.execute(
            sa.text(
                "INSERT INTO session_sync_suppressions (user_id, local_session_id) "
                "VALUES (:user_id, :local_session_id)"
            ),
            values,
        )
        return
    connection.execute(
        sa.text(
            "INSERT INTO session_sync_suppressions "
            "(user_id, local_session_id, origin_environment_id) "
            "VALUES (:user_id, :local_session_id, :origin_environment_id)"
        ),
        {**values, "origin_environment_id": origin_environment_id},
    )


def test_session_events_migration_downgrade_is_lossless_or_fails_closed(
    engine: AsyncEngine,
) -> None:
    migration = _load_migration()
    schema = f"session_events_migration_{uuid.uuid4().hex}"
    sync_engine = create_engine(engine.url.set(drivername="postgresql+psycopg2"))
    original_op = migration.op
    try:
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
            connection.execute(sa.text(f'SET search_path TO "{schema}"'))
            _create_previous_schema(connection)
            migration.op = Operations(MigrationContext.configure(connection))

            user_id = uuid.uuid4()
            first_origin = uuid.uuid4()
            _insert_session(
                connection,
                user_id=user_id,
                environment_id=first_origin,
                local_session_id="pi.same-local-id",
            )
            _insert_suppression(
                connection,
                user_id=user_id,
                local_session_id="pi.same-local-id",
            )
            migration.upgrade()
            migration.downgrade()
            assert connection.execute(sa.text("SELECT count(*) FROM sessions")).scalar_one() == 1
            assert (
                connection.execute(
                    sa.text("SELECT count(*) FROM session_sync_suppressions")
                ).scalar_one()
                == 1
            )
            assert "origin_environment_id" not in {
                column["name"] for column in sa.inspect(connection).get_columns("sessions")
            }

            migration.upgrade()
            session_id = connection.execute(
                sa.text(
                    "SELECT id FROM sessions WHERE user_id = :user_id "
                    "AND local_session_id = :local_session_id"
                ),
                {"user_id": user_id, "local_session_id": "pi.same-local-id"},
            ).scalar_one()
            connection.execute(
                sa.text(
                    "INSERT INTO session_event_generations "
                    "(id, session_id, append_id, status, base_revision, base_count, "
                    "base_head_hash, final_count, final_head_hash) VALUES "
                    "(:id, :session_id, :append_id, 'staging', 0, 0, :head, 0, :head)"
                ),
                {
                    "id": uuid.uuid4(),
                    "session_id": session_id,
                    "append_id": uuid.uuid4(),
                    "head": "0" * 64,
                },
            )
            with pytest.raises(RuntimeError, match="events-v1 data exists"):
                migration.downgrade()
            assert (
                connection.execute(
                    sa.text("SELECT count(*) FROM session_event_generations")
                ).scalar_one()
                == 1
            )
            connection.execute(sa.text("DELETE FROM session_event_generations"))

            adapter_id = uuid.uuid4()
            connection.execute(
                sa.text(
                    "INSERT INTO agent_environments (id, adapter_modules) "
                    "VALUES (:id, ARRAY['sessions']::varchar[])"
                ),
                {"id": adapter_id},
            )
            with pytest.raises(RuntimeError, match="restricted adapter capabilities"):
                migration.downgrade()
            connection.execute(
                sa.text("UPDATE agent_environments SET adapter_modules = NULL WHERE id = :id"),
                {"id": adapter_id},
            )

            connection.execute(
                sa.text("UPDATE sessions SET environment_id = NULL WHERE id = :id"),
                {"id": session_id},
            )
            with pytest.raises(RuntimeError, match="immutable Session origin identity"):
                migration.downgrade()
            connection.execute(
                sa.text("UPDATE sessions SET environment_id = :origin WHERE id = :id"),
                {"id": session_id, "origin": first_origin},
            )

            connection.execute(
                sa.text(
                    "UPDATE session_sync_suppressions SET origin_environment_id = :origin "
                    "WHERE user_id = :user_id AND local_session_id = :local_session_id"
                ),
                {
                    "origin": first_origin,
                    "user_id": user_id,
                    "local_session_id": "pi.same-local-id",
                },
            )
            with pytest.raises(RuntimeError, match="origin-scoped Session suppressions"):
                migration.downgrade()
            connection.execute(
                sa.text(
                    "UPDATE session_sync_suppressions SET origin_environment_id = NULL "
                    "WHERE user_id = :user_id AND local_session_id = :local_session_id"
                ),
                {"user_id": user_id, "local_session_id": "pi.same-local-id"},
            )

            second_origin = uuid.uuid4()
            _insert_session(
                connection,
                user_id=user_id,
                environment_id=second_origin,
                local_session_id="pi.same-local-id",
            )
            connection.execute(
                sa.text(
                    "UPDATE sessions SET origin_environment_id = environment_id "
                    "WHERE origin_environment_id IS NULL"
                )
            )
            with pytest.raises(
                RuntimeError,
                match=("Cannot downgrade migration c6e8a1f4d2b9.*Sessions before retrying"),
            ):
                migration.downgrade()

            rows = connection.execute(
                sa.text(
                    "SELECT origin_environment_id FROM sessions "
                    "WHERE user_id = :user_id AND local_session_id = :local_session_id"
                ),
                {"user_id": user_id, "local_session_id": "pi.same-local-id"},
            ).scalars()
            assert set(rows) == {first_origin, second_origin}
            assert (
                connection.execute(
                    sa.text(
                        "SELECT count(*) FROM session_sync_suppressions "
                        "WHERE user_id = :user_id AND local_session_id = :local_session_id"
                    ),
                    {"user_id": user_id, "local_session_id": "pi.same-local-id"},
                ).scalar_one()
                == 1
            )
            assert "event_generation_id" in {
                column["name"] for column in sa.inspect(connection).get_columns("sessions")
            }
    finally:
        migration.op = original_op
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        sync_engine.dispose()
