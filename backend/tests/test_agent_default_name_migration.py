from __future__ import annotations

import importlib.util
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy.ext.asyncio import AsyncEngine


def _load_migration(filename: str, module_name: str):
    migration_path = Path(__file__).parents[1] / "alembic" / "versions" / filename
    spec = importlib.util.spec_from_file_location(module_name, migration_path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


@pytest.mark.asyncio
async def test_agent_default_name_migration_backfills_long_machine_name(engine: AsyncEngine):
    """The migration must handle existing machine_name values over the old
    display-name cap. It runs against a temporary schema with the real Alembic
    operations so the column DDL and backfill SQL are both exercised.
    """

    migration = _load_migration(
        "e9c3a17d5b42_agent_default_name.py",
        "agent_default_name_migration",
    )

    schema = f"agent_default_name_migration_{uuid.uuid4().hex}"
    long_machine_name = "agent-" + ("x" * 144)

    def run_migration(sync_conn):
        old_op = migration.op
        sync_conn.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
        sync_conn.execute(sa.text(f'SET search_path TO "{schema}"'))
        try:
            sync_conn.execute(
                sa.text(
                    """
                    CREATE TABLE agent_environments (
                        id uuid PRIMARY KEY,
                        machine_name varchar(200) NOT NULL
                    )
                    """
                )
            )
            sync_conn.execute(
                sa.text(
                    """
                    INSERT INTO agent_environments (id, machine_name)
                    VALUES (CAST(:id AS uuid), :machine_name)
                    """
                ),
                {"id": str(uuid.uuid4()), "machine_name": long_machine_name},
            )

            migration.op = Operations(MigrationContext.configure(sync_conn))
            migration.upgrade()

            row = sync_conn.execute(sa.text("SELECT default_name FROM agent_environments")).one()
            assert row.default_name == long_machine_name
        finally:
            migration.op = old_op
            sync_conn.execute(sa.text("SET search_path TO public"))
            sync_conn.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))

    async with engine.begin() as conn:
        await conn.run_sync(run_migration)


@pytest.mark.asyncio
async def test_agent_default_name_cleanup_migration_reassigns_explicit_and_clears_self_managed(
    engine: AsyncEngine,
):
    migration = _load_migration(
        "74d1b8e2c9a3_reassign_agent_default_names.py",
        "reassign_agent_default_names_migration",
    )

    schema = f"agent_default_name_cleanup_{uuid.uuid4().hex}"
    user_a = uuid.uuid4()
    user_b = uuid.uuid4()
    base_time = datetime(2026, 7, 3, tzinfo=UTC)
    ids = {
        "self_openclaw": uuid.uuid4(),
        "openclaw_one": uuid.uuid4(),
        "openclaw_two": uuid.uuid4(),
        "hermes": uuid.uuid4(),
        "codex": uuid.uuid4(),
        "claude_code": uuid.uuid4(),
        "other_openclaw": uuid.uuid4(),
    }

    def run_migration(sync_conn):
        old_op = migration.op
        sync_conn.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
        sync_conn.execute(sa.text(f'SET search_path TO "{schema}"'))
        try:
            sync_conn.execute(
                sa.text(
                    """
                    CREATE TABLE agent_environments (
                        id uuid PRIMARY KEY,
                        user_id uuid NOT NULL,
                        machine_name varchar(200) NOT NULL,
                        agent_type varchar(50) NOT NULL,
                        registration_key varchar(300),
                        default_name varchar(200),
                        created_at timestamptz NOT NULL
                    )
                    """
                )
            )
            rows = [
                (
                    ids["self_openclaw"],
                    user_a,
                    "self-managed-openclaw",
                    "openclaw",
                    "machine:self:agent:openclaw",
                    "self-managed-openclaw",
                    base_time,
                ),
                (
                    ids["openclaw_one"],
                    user_a,
                    "hosted-openclaw-old",
                    "openclaw",
                    None,
                    "hosted-openclaw-old",
                    base_time + timedelta(seconds=1),
                ),
                (
                    ids["openclaw_two"],
                    user_a,
                    "hosted-openclaw-new",
                    "openclaw",
                    None,
                    "hosted-openclaw-new",
                    base_time + timedelta(seconds=2),
                ),
                (
                    ids["hermes"],
                    user_a,
                    "hosted-hermes",
                    "hermes",
                    None,
                    "hosted-hermes",
                    base_time + timedelta(seconds=3),
                ),
                (
                    ids["codex"],
                    user_a,
                    "hosted-codex",
                    "codex",
                    None,
                    "hosted-codex",
                    base_time + timedelta(seconds=4),
                ),
                (
                    ids["claude_code"],
                    user_a,
                    "hosted-claude-code",
                    "claude_code",
                    None,
                    "hosted-claude-code",
                    base_time + timedelta(seconds=5),
                ),
                (
                    ids["other_openclaw"],
                    user_b,
                    "other-hosted-openclaw",
                    "openclaw",
                    None,
                    "other-hosted-openclaw",
                    base_time + timedelta(seconds=6),
                ),
            ]
            sync_conn.execute(
                sa.text(
                    """
                    INSERT INTO agent_environments (
                        id,
                        user_id,
                        machine_name,
                        agent_type,
                        registration_key,
                        default_name,
                        created_at
                    )
                    VALUES (
                        CAST(:id AS uuid),
                        CAST(:user_id AS uuid),
                        :machine_name,
                        :agent_type,
                        :registration_key,
                        :default_name,
                        :created_at
                    )
                    """
                ),
                [
                    {
                        "id": str(row[0]),
                        "user_id": str(row[1]),
                        "machine_name": row[2],
                        "agent_type": row[3],
                        "registration_key": row[4],
                        "default_name": row[5],
                        "created_at": row[6],
                    }
                    for row in rows
                ],
            )

            migration.op = Operations(MigrationContext.configure(sync_conn))
            migration.upgrade()

            upgraded = {
                row.id: row.default_name
                for row in sync_conn.execute(
                    sa.text("SELECT id, default_name FROM agent_environments")
                )
            }
            assert upgraded[ids["self_openclaw"]] is None
            assert upgraded[ids["openclaw_one"]] == "OpenClaw"
            assert upgraded[ids["openclaw_two"]] == "OpenClaw 2"
            assert upgraded[ids["other_openclaw"]] == "OpenClaw"
            assert upgraded[ids["hermes"]] == "Hermes"
            assert upgraded[ids["codex"]] == "Codex"
            assert upgraded[ids["claude_code"]] == "Claude Code"

            migration.downgrade()
            downgraded = {
                row.id: row.default_name
                for row in sync_conn.execute(
                    sa.text("SELECT id, default_name FROM agent_environments")
                )
            }
            assert downgraded == {row[0]: row[2] for row in rows}
        finally:
            migration.op = old_op
            sync_conn.execute(sa.text("SET search_path TO public"))
            sync_conn.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))

    async with engine.begin() as conn:
        await conn.run_sync(run_migration)
