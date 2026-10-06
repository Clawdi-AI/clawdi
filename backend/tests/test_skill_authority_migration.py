from __future__ import annotations

import uuid

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.migration_harness import load_migration

MIGRATION_FILENAME = "5d2a9c7e4b18_add_skill_authority.py"


def _create_previous_schema(connection: sa.Connection) -> None:
    connection.execute(
        sa.text(
            """
            CREATE TABLE agent_environments (
                id uuid PRIMARY KEY
            )
            """
        )
    )
    connection.execute(
        sa.text(
            """
            CREATE TABLE skills (
                id uuid PRIMARY KEY
            )
            """
        )
    )


def test_skill_authority_migration_downgrade_requires_cloud_only_rows(
    engine: AsyncEngine,
) -> None:
    migration = load_migration(MIGRATION_FILENAME, "skill_authority_migration")
    schema = f"skill_authority_{uuid.uuid4().hex}"
    sync_engine = create_engine(engine.url.set(drivername="postgresql+psycopg2"))
    old_op = migration.op
    try:
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
            connection.execute(sa.text(f'SET search_path TO "{schema}"'))
            _create_previous_schema(connection)
            migration.op = Operations(MigrationContext.configure(connection))

            migration.upgrade()
            cloud_skill_id = uuid.uuid4()
            connection.execute(
                sa.text("INSERT INTO skills (id) VALUES (CAST(:id AS uuid))"),
                {"id": str(cloud_skill_id)},
            )
            migration.downgrade()
            assert {column["name"] for column in sa.inspect(connection).get_columns("skills")} == {
                "id"
            }

            migration.upgrade()
            agent_id = uuid.uuid4()
            connection.execute(
                sa.text("INSERT INTO agent_environments (id) VALUES (CAST(:agent_id AS uuid))"),
                {"agent_id": str(agent_id)},
            )
            connection.execute(
                sa.text(
                    """
                    UPDATE skills
                    SET authority = 'agent_sync',
                        authority_agent_id = CAST(:agent_id AS uuid)
                    WHERE id = CAST(:skill_id AS uuid)
                    """
                ),
                {"agent_id": str(agent_id), "skill_id": str(cloud_skill_id)},
            )

            with pytest.raises(
                RuntimeError,
                match="Cannot downgrade migration 5d2a9c7e4b18",
            ):
                migration.downgrade()
            columns = {column["name"] for column in sa.inspect(connection).get_columns("skills")}
            assert {"authority", "authority_agent_id"} <= columns

            connection.execute(
                sa.text(
                    """
                    UPDATE skills
                    SET authority = 'cloud', authority_agent_id = NULL
                    WHERE id = CAST(:skill_id AS uuid)
                    """
                ),
                {"skill_id": str(cloud_skill_id)},
            )
            migration.downgrade()
    finally:
        migration.op = old_op
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        sync_engine.dispose()
