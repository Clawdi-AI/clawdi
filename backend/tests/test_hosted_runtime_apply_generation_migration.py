from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect
from sqlalchemy.ext.asyncio import AsyncEngine

REVISION = "7c2e9a4b6d1f"
MIGRATION_FILENAME = f"{REVISION}_add_hosted_runtime_apply_generation.py"


def _load_migration():
    migration_path = Path(__file__).parents[1] / "alembic" / "versions" / MIGRATION_FILENAME
    spec = importlib.util.spec_from_file_location("hosted_runtime_apply_generation", migration_path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def test_hosted_runtime_apply_generation_migration_is_additive_and_constrained(
    engine: AsyncEngine,
) -> None:
    migration = _load_migration()
    schema = f"hosted_runtime_apply_generation_{uuid.uuid4().hex}"
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
                    CREATE TABLE hosted_runtime_states (
                        environment_id uuid PRIMARY KEY,
                        generation integer NOT NULL
                    )
                    """
                )
            )
            connection.execute(
                sa.text(
                    "INSERT INTO hosted_runtime_states (environment_id, generation) "
                    "VALUES (:environment_id, 2)"
                ),
                {"environment_id": environment_id},
            )
            migration.op = Operations(MigrationContext.configure(connection))

            migration.upgrade()

            columns = {
                column["name"]: column
                for column in inspect(connection).get_columns("hosted_runtime_states")
            }
            assert columns["apply_generation"]["nullable"] is True
            assert (
                connection.scalar(
                    sa.text(
                        "SELECT apply_generation FROM hosted_runtime_states "
                        "WHERE environment_id = :environment_id"
                    ),
                    {"environment_id": environment_id},
                )
                is None
            )

            connection.execute(
                sa.text(
                    "UPDATE hosted_runtime_states SET apply_generation = 1 "
                    "WHERE environment_id = :environment_id"
                ),
                {"environment_id": environment_id},
            )
            assert (
                connection.scalar(
                    sa.text(
                        "SELECT apply_generation FROM hosted_runtime_states "
                        "WHERE environment_id = :environment_id"
                    ),
                    {"environment_id": environment_id},
                )
                == 1
            )

            connection.execute(
                sa.text(
                    "UPDATE hosted_runtime_states SET apply_generation = 3 "
                    "WHERE environment_id = :environment_id"
                ),
                {"environment_id": environment_id},
            )
            assert (
                connection.scalar(
                    sa.text(
                        "SELECT apply_generation FROM hosted_runtime_states "
                        "WHERE environment_id = :environment_id"
                    ),
                    {"environment_id": environment_id},
                )
                == 3
            )

            for invalid in (0, -1):
                with pytest.raises(sa.exc.IntegrityError), connection.begin_nested():
                    connection.execute(
                        sa.text(
                            "UPDATE hosted_runtime_states SET apply_generation = :invalid "
                            "WHERE environment_id = :environment_id"
                        ),
                        {"invalid": invalid, "environment_id": environment_id},
                    )

            migration.downgrade()
            assert "apply_generation" not in {
                column["name"]
                for column in inspect(connection).get_columns("hosted_runtime_states")
            }
    finally:
        migration.op = old_op
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        sync_engine.dispose()
