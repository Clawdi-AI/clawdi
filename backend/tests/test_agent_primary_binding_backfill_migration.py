from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy.ext.asyncio import AsyncEngine

SCRATCH_TABLES = """
CREATE TABLE projects (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  archived_at timestamptz
);
CREATE TABLE project_memberships (
  project_id uuid NOT NULL,
  member_user_id uuid NOT NULL
);
CREATE TABLE agent_environments (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  default_project_id uuid
);
CREATE TABLE agent_project_bindings (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL,
  project_id uuid NOT NULL,
  binding_type varchar(20) NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  default_write_enabled boolean NOT NULL DEFAULT false,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT uq_agent_project UNIQUE (agent_id, project_id),
  CONSTRAINT uq_agent_type_priority UNIQUE (agent_id, binding_type, priority),
  CONSTRAINT ck_write_priority CHECK (
    (binding_type = 'primary' AND default_write_enabled = true AND priority = 0)
    OR (binding_type = 'context' AND default_write_enabled = false AND priority >= 1)
  )
);
CREATE UNIQUE INDEX uq_one_primary ON agent_project_bindings (agent_id)
  WHERE binding_type = 'primary';
"""


@pytest.mark.asyncio
async def test_backfill_materializes_primary_and_drops_unreadable_links(engine: AsyncEngine):
    path = (
        Path(__file__).parents[1]
        / "alembic"
        / "versions"
        / "a7d3f1c9b2e4_agent_primary_binding_backfill.py"
    )
    spec = importlib.util.spec_from_file_location("agent_primary_binding_backfill", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    schema = f"agent_primary_backfill_{uuid.uuid4().hex}"
    user, other_user = uuid.uuid4(), uuid.uuid4()
    ids = {name: uuid.uuid4() for name in ("missing", "stale", "context", "links", "ok")}
    homes = {name: uuid.uuid4() for name in ids}
    owned_workspace, owned_extra = uuid.uuid4(), uuid.uuid4()
    archived, foreign, shared = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    ok_primary = uuid.uuid4()

    def run(sync_conn):
        old_op = migration.op

        def execute(statement: str, **params):
            return sync_conn.execute(sa.text(statement), params)

        def binding(agent, project, binding_type, priority):
            execute(
                "INSERT INTO agent_project_bindings (id, agent_id, project_id, binding_type, "
                "priority, default_write_enabled, created_by_user_id) "
                "VALUES (:id, :agent, :project, :type, :priority, :write, :user)",
                id=uuid.uuid4(),
                agent=agent,
                project=project,
                type=binding_type,
                priority=priority,
                write=binding_type == "primary",
                user=user,
            )

        def bindings():
            return {
                (row.agent_id, row.project_id): (row.binding_type, row.priority)
                for row in execute(
                    "SELECT agent_id, project_id, binding_type, priority "
                    "FROM agent_project_bindings"
                )
            }

        sync_conn.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
        sync_conn.execute(sa.text(f'SET search_path TO "{schema}"'))
        try:
            for statement in SCRATCH_TABLES.split(";"):
                if statement.strip():
                    execute(statement)
            for name, agent_id in ids.items():
                execute(
                    "INSERT INTO projects (id, user_id) VALUES (:id, :user)",
                    id=homes[name],
                    user=user,
                )
                execute(
                    "INSERT INTO agent_environments (id, user_id, default_project_id) "
                    "VALUES (:id, :user, :project)",
                    id=agent_id,
                    user=user,
                    project=homes[name],
                )
            for project_id in (owned_workspace, owned_extra):
                execute(
                    "INSERT INTO projects (id, user_id) VALUES (:id, :user)",
                    id=project_id,
                    user=user,
                )
            execute(
                "INSERT INTO projects (id, user_id, archived_at) VALUES (:id, :user, now())",
                id=archived,
                user=user,
            )
            for project_id in (foreign, shared):
                execute(
                    "INSERT INTO projects (id, user_id) VALUES (:id, :user)",
                    id=project_id,
                    user=other_user,
                )
            execute(
                "INSERT INTO project_memberships (project_id, member_user_id) VALUES (:p, :u)",
                p=shared,
                u=user,
            )
            # Legacy primary on another owned Project next to an existing context link.
            binding(ids["stale"], owned_workspace, "primary", 0)
            binding(ids["stale"], owned_extra, "context", 2)
            # The Agent Project was linked as context.
            binding(ids["context"], homes["context"], "context", 1)
            # Unreadable links are dropped; the shared membership link is kept.
            binding(ids["links"], homes["links"], "primary", 0)
            binding(ids["links"], archived, "context", 1)
            binding(ids["links"], foreign, "context", 2)
            binding(ids["links"], shared, "context", 3)
            execute(
                "INSERT INTO agent_project_bindings (id, agent_id, project_id, binding_type, "
                "priority, default_write_enabled, created_by_user_id) "
                "VALUES (:id, :agent, :project, 'primary', 0, true, :user)",
                id=ok_primary,
                agent=ids["ok"],
                project=homes["ok"],
                user=user,
            )

            migration.op = Operations(MigrationContext.configure(sync_conn))
            migration.upgrade()
            expected = {
                (ids["missing"], homes["missing"]): ("primary", 0),
                (ids["stale"], homes["stale"]): ("primary", 0),
                (ids["stale"], owned_workspace): ("context", 3),
                (ids["stale"], owned_extra): ("context", 2),
                (ids["context"], homes["context"]): ("primary", 0),
                (ids["links"], homes["links"]): ("primary", 0),
                (ids["links"], shared): ("context", 3),
                (ids["ok"], homes["ok"]): ("primary", 0),
            }
            assert bindings() == expected
            assert (
                execute(
                    "SELECT id FROM agent_project_bindings WHERE agent_id = :agent",
                    agent=ids["ok"],
                ).scalar_one()
                == ok_primary
            )

            migration.upgrade()
            assert bindings() == expected
            migration.downgrade()
            assert bindings() == expected
        finally:
            migration.op = old_op
            sync_conn.execute(sa.text("SET search_path TO public"))
            sync_conn.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))

    async with engine.begin() as conn:
        await conn.run_sync(run)
