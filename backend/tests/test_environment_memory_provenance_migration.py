from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine

MIGRATION_FILENAME = "6a9d2c4e8f10_add_environment_memory_provenance.py"
STRICT_PREVIOUS_SCOPES = [
    "connectors:read",
    "connectors:invoke",
    "runtime-observations:write",
    "sessions:read",
    "sessions:write",
    "skills:read",
    "skills:write",
]
STRICT_SCOPES = [
    "connectors:read",
    "connectors:invoke",
    "memories:read",
    "memories:write",
    "projects:read",
    "runtime-observations:write",
    "sessions:read",
    "sessions:write",
    "skills:read",
    "skills:write",
    "vault:metadata:read",
]
PLATFORM_PREVIOUS_SCOPES = ["sessions:write", "skills:read", "skills:write"]
PLATFORM_SCOPES = [
    "memories:read",
    "memories:write",
    "projects:read",
    "sessions:write",
    "skills:read",
    "skills:write",
    "vault:metadata:read",
]


def _load_migration():
    migration_path = Path(__file__).parents[1] / "alembic" / "versions" / MIGRATION_FILENAME
    spec = importlib.util.spec_from_file_location("environment_memory_provenance", migration_path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def _create_previous_schema(connection: sa.Connection) -> None:
    connection.execute(
        sa.text(
            """
            CREATE TABLE agent_environments (
                id uuid PRIMARY KEY
            );
            CREATE TABLE memories (
                id uuid PRIMARY KEY
            );
            CREATE TABLE api_keys (
                id uuid PRIMARY KEY,
                managed boolean NOT NULL,
                environment_id uuid,
                runtime_deployment_id varchar(200),
                scopes varchar[]
            );
            """
        )
    )


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
            "environment_id": str(environment_id) if environment_id else None,
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


def test_environment_memory_provenance_migration_backfills_only_hosted_defaults(
    engine: AsyncEngine,
) -> None:
    migration = _load_migration()
    schema = f"environment_memory_provenance_{uuid.uuid4().hex}"
    environment_id = uuid.uuid4()
    sync_engine = create_engine(engine.url.set(drivername="postgresql+psycopg2"))
    old_op = migration.op
    try:
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
            connection.execute(sa.text(f'SET search_path TO "{schema}"'))
            _create_previous_schema(connection)
            connection.execute(
                sa.text("INSERT INTO agent_environments (id) VALUES (CAST(:id AS uuid))"),
                {"id": str(environment_id)},
            )
            strict_key = _insert_key(
                connection,
                managed=True,
                environment_id=environment_id,
                runtime_deployment_id="strict-existing",
                scopes=[*STRICT_PREVIOUS_SCOPES, "future:runtime-capability"],
            )
            platform_default_key = _insert_key(
                connection,
                managed=True,
                environment_id=environment_id,
                runtime_deployment_id=None,
                scopes=PLATFORM_PREVIOUS_SCOPES,
            )
            platform_narrow_key = _insert_key(
                connection,
                managed=True,
                environment_id=environment_id,
                runtime_deployment_id=None,
                scopes=["sessions:write"],
            )
            interactive_key = _insert_key(
                connection,
                managed=False,
                environment_id=None,
                runtime_deployment_id=None,
                scopes=None,
            )
            migration.op = Operations(MigrationContext.configure(connection))

            migration.upgrade()

            assert _scopes(connection, strict_key) == [
                *STRICT_SCOPES,
                "future:runtime-capability",
            ]
            assert _scopes(connection, platform_default_key) == PLATFORM_SCOPES
            assert _scopes(connection, platform_narrow_key) == ["sessions:write"]
            assert _scopes(connection, interactive_key) is None

            columns = {column["name"] for column in sa.inspect(connection).get_columns("memories")}
            assert "source_environment_id" in columns
            indexes = {index["name"] for index in sa.inspect(connection).get_indexes("memories")}
            assert "ix_memories_source_environment_id" in indexes
            foreign_keys = {
                foreign_key["name"]: foreign_key
                for foreign_key in sa.inspect(connection).get_foreign_keys("memories")
            }
            assert (
                foreign_keys["fk_memories_source_environment_id_agent_environments"][
                    "referred_table"
                ]
                == "agent_environments"
            )

            memory_id = uuid.uuid4()
            connection.execute(
                sa.text(
                    """
                    INSERT INTO memories (id, source_environment_id)
                    VALUES (CAST(:id AS uuid), CAST(:environment_id AS uuid))
                    """
                ),
                {"id": str(memory_id), "environment_id": str(environment_id)},
            )
            with pytest.raises(IntegrityError):
                with connection.begin_nested():
                    connection.execute(
                        sa.text(
                            """
                            INSERT INTO memories (id, source_environment_id)
                            VALUES (CAST(:id AS uuid), CAST(:environment_id AS uuid))
                            """
                        ),
                        {"id": str(uuid.uuid4()), "environment_id": str(uuid.uuid4())},
                    )
            connection.execute(
                sa.text("DELETE FROM agent_environments WHERE id = CAST(:id AS uuid)"),
                {"id": str(environment_id)},
            )
            assert (
                connection.execute(
                    sa.text(
                        "SELECT source_environment_id FROM memories WHERE id = CAST(:id AS uuid)"
                    ),
                    {"id": str(memory_id)},
                ).scalar_one()
                is None
            )

            migration.downgrade()

            assert _scopes(connection, strict_key) == [
                *STRICT_PREVIOUS_SCOPES,
                "future:runtime-capability",
            ]
            assert _scopes(connection, platform_default_key) == PLATFORM_PREVIOUS_SCOPES
            assert _scopes(connection, platform_narrow_key) == ["sessions:write"]
            columns = {column["name"] for column in sa.inspect(connection).get_columns("memories")}
            assert "source_environment_id" not in columns
    finally:
        migration.op = old_op
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        sync_engine.dispose()
