"""clawdi serve v1 schema (consolidated)

Single consolidated migration for the `clawdi serve` daemon
PR. Produces the same end-state schema the previous chain of
six migrations did (api_key scopes/env_id, agent_env
observability + dedup unique, projects table + per-row project_id
backfill, vault per-project slug, skill_conflicts removed,
sessions composite indexes, and Personal-project-for-every-user
backfill) but in a single ordered upgrade() — no skill_conflicts
ever created (it was added then dropped in the previous chain),
no duplicate Personal-project step needed.

End-state guarantees the rest of the codebase relies on:
  - every `user` has exactly one `projects` row with `kind='personal'`
  - every `agent_environment` has exactly one `projects` row with
    `kind='environment'` and matching `default_project_id`
  - every active `skill` has a non-null `project_id`
  - every `vault` has a non-null `project_id`
  - skill uniqueness is `(user_id, project_id, skill_key)` for
    active rows, allowing the same `skill_key` across projects
  - vault slug uniqueness is `(user_id, project_id, slug)`
  - agent_environments unique on (user_id, machine_id, agent_type)
    so concurrent `clawdi setup` runs converge on a single row
  - sessions list queries are covered by composite indexes for
    p99 stability past 10k users

Idempotency: every backfill step uses `WHERE … IS NULL` /
`ON CONFLICT DO NOTHING` / `WHERE NOT EXISTS` guards. A crash
mid-way is restartable without manual cleanup.

`PROJECT_MIGRATION_DUP_THRESHOLD_PCT` env var (default 1) gates
the duplicate-skill cleanup step — fails if the rows-to-soft-
delete ratio exceeds that percentage of total active skills,
signalling data drift that needs ops attention before the
backfill runs.

Revision ID: c1d99ac4f9e6
Revises: 672acd66fc7d
Create Date: 2026-05-01
"""

from __future__ import annotations

import os
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "c1d99ac4f9e6"
down_revision: str | Sequence[str] | None = "672acd66fc7d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()

    # ============================================================
    # 1. api_keys: scopes + environment_id binding
    # ============================================================
    op.add_column(
        "api_keys",
        sa.Column("scopes", postgresql.ARRAY(sa.String(length=64)), nullable=True),
    )
    op.add_column(
        "api_keys",
        sa.Column("environment_id", sa.UUID(), nullable=True),
    )
    op.create_index(
        op.f("ix_api_keys_environment_id"),
        "api_keys",
        ["environment_id"],
        unique=False,
    )
    op.create_foreign_key(
        "fk_api_keys_environment_id",
        "api_keys",
        "agent_environments",
        ["environment_id"],
        ["id"],
        ondelete="CASCADE",
    )

    # ============================================================
    # 2. agent_environments: clawdi serve daemon observability
    # ============================================================
    op.add_column(
        "agent_environments",
        sa.Column("last_sync_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "agent_environments",
        sa.Column("last_sync_error", sa.Text(), nullable=True),
    )
    op.add_column(
        "agent_environments",
        sa.Column("last_revision_seen", sa.Integer(), nullable=True),
    )
    op.add_column(
        "agent_environments",
        sa.Column(
            "queue_depth_high_water_since_start",
            sa.Integer(),
            server_default="0",
            nullable=False,
        ),
    )
    op.add_column(
        "agent_environments",
        sa.Column(
            "dropped_count_since_start",
            sa.Integer(),
            server_default="0",
            nullable=False,
        ),
    )
    op.add_column(
        "agent_environments",
        sa.Column(
            "sync_enabled",
            sa.Boolean(),
            server_default="false",
            nullable=False,
        ),
    )

    # ============================================================
    # 3. users: skills_revision counter (collection ETag source)
    # ============================================================
    op.add_column(
        "users",
        sa.Column(
            "skills_revision",
            sa.Integer(),
            server_default="0",
            nullable=False,
        ),
    )

    # ============================================================
    # 4. agent_environments dedup: collapse rows with the same
    #    (user_id, machine_id, agent_type) onto the most-recent
    #    row before adding the unique constraint. Pre-fix the
    #    route-layer check-then-insert in `register_environment`
    #    had no DB guard against concurrent `clawdi setup` runs
    #    creating duplicates. Naive DELETE would lose load-bearing
    #    FK refs (sessions.environment_id SET NULL, api_keys
    #    CASCADE, projects.origin_environment_id SET NULL) — remap
    #    each before the DELETE so the row goes cleanly.
    # ============================================================
    bind.execute(
        sa.text(
            """
            CREATE TEMP TABLE _env_dedup ON COMMIT DROP AS
            SELECT
                id AS loser_id,
                FIRST_VALUE(id) OVER (
                    PARTITION BY user_id, machine_id, agent_type
                    ORDER BY COALESCE(last_seen_at, created_at) DESC, id DESC
                ) AS winner_id,
                ROW_NUMBER() OVER (
                    PARTITION BY user_id, machine_id, agent_type
                    ORDER BY COALESCE(last_seen_at, created_at) DESC, id DESC
                ) AS rn
            FROM agent_environments
            """
        )
    )
    bind.execute(
        sa.text(
            """
            UPDATE sessions
            SET environment_id = d.winner_id
            FROM _env_dedup d
            WHERE sessions.environment_id = d.loser_id
              AND d.rn > 1
              AND d.winner_id <> d.loser_id
            """
        )
    )
    bind.execute(
        sa.text(
            """
            UPDATE api_keys
            SET environment_id = d.winner_id
            FROM _env_dedup d
            WHERE api_keys.environment_id = d.loser_id
              AND d.rn > 1
              AND d.winner_id <> d.loser_id
            """
        )
    )
    # Note: projects table doesn't exist yet — skipped here. The
    # project creation below uses post-dedup envs so this is
    # automatically consistent.
    bind.execute(
        sa.text(
            """
            DELETE FROM agent_environments
            WHERE id IN (
                SELECT loser_id FROM _env_dedup WHERE rn > 1
            )
            """
        )
    )
    op.create_unique_constraint(
        "uq_agent_envs_user_machine_agent",
        "agent_environments",
        ["user_id", "machine_id", "agent_type"],
    )

    # ============================================================
    # 5. CREATE TABLE projects + indices + partial unique constraint
    # ============================================================
    op.create_table(
        "projects",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("slug", sa.String(length=80), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("origin_environment_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["origin_environment_id"],
            ["agent_environments.id"],
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "slug", name="uq_projects_user_slug"),
        sa.CheckConstraint(
            "kind IN ('personal', 'environment')",
            name="ck_projects_kind_v1",
        ),
    )
    op.create_index("ix_projects_user_id", "projects", ["user_id"], unique=False)
    op.create_index(
        "ix_projects_origin_environment_id",
        "projects",
        ["origin_environment_id"],
        unique=False,
    )
    # Exactly one personal-kind project per user.
    op.create_index(
        "uq_projects_one_personal_per_user",
        "projects",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("kind = 'personal'"),
    )

    # ============================================================
    # 6. Add nullable project_id columns
    # ============================================================
    op.add_column(
        "agent_environments",
        sa.Column("default_project_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "skills",
        sa.Column("project_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "vaults",
        sa.Column("project_id", postgresql.UUID(as_uuid=True), nullable=True),
    )

    # ============================================================
    # 7. Cleanup duplicate active skills (threshold-guarded) —
    #    keep most-recent per (user_id, skill_key), soft-delete the
    #    rest. The new partial unique index further down rejects
    #    concurrent active duplicates; this migration step
    #    establishes the precondition.
    # ============================================================
    threshold_raw = os.environ.get("PROJECT_MIGRATION_DUP_THRESHOLD_PCT", "1")
    try:
        threshold_pct = float(threshold_raw)
    except ValueError:
        raise RuntimeError(
            f"PROJECT_MIGRATION_DUP_THRESHOLD_PCT={threshold_raw!r} is not a number"
        ) from None

    total_skills = bind.execute(
        sa.text("SELECT count(*) FROM skills WHERE is_active = true")
    ).scalar_one()
    if total_skills:
        # Count actual ROWS the soft-delete would deactivate
        # (SUM(c-1)), not GROUPS. Round-3 fix: pre-fix this counted
        # GROUPS, so a table with a small number of (user, key)
        # pairs each holding thousands of dup rows could slip past
        # the gate despite the migration about to soft-delete tens
        # of thousands of rows.
        dup_rows = bind.execute(
            sa.text(
                """
                SELECT COALESCE(SUM(c - 1), 0)
                FROM (
                    SELECT user_id, skill_key, count(*) AS c
                    FROM skills
                    WHERE is_active = true
                    GROUP BY user_id, skill_key
                    HAVING count(*) > 1
                ) AS dup_groups
                """
            )
        ).scalar_one()
        if dup_rows > 0 and (dup_rows / total_skills * 100) > threshold_pct:
            raise RuntimeError(
                f"skills duplicate-rows ratio {dup_rows}/{total_skills} exceeds "
                f"PROJECT_MIGRATION_DUP_THRESHOLD_PCT={threshold_pct}. Investigate "
                "before running the migration. Override the env var if intentional."
            )
        bind.execute(
            sa.text(
                """
                UPDATE skills SET is_active = false
                WHERE id IN (
                    SELECT id FROM (
                        SELECT id, ROW_NUMBER() OVER (
                            PARTITION BY user_id, skill_key
                            ORDER BY updated_at DESC, id DESC
                        ) AS rn
                        FROM skills
                        WHERE is_active = true
                    ) AS ranked
                    WHERE ranked.rn > 1
                )
                """
            )
        )

    # ============================================================
    # 8. Cleanup orphan rows (user_id no longer in users) before
    #    new FKs are created. Today's schema has no FK between
    #    agent_environments.user_id and users.id, so legacy data
    #    can carry orphans. The new projects.user_id FK + cascading
    #    constraints would fail on those rows.
    # ============================================================
    bind.execute(
        sa.text(
            """
            DELETE FROM agent_environments
            WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = agent_environments.user_id)
            """
        )
    )
    bind.execute(
        sa.text(
            """
            DELETE FROM vaults
            WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = vaults.user_id)
            """
        )
    )
    bind.execute(
        sa.text(
            """
            DELETE FROM skills
            WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = skills.user_id)
            """
        )
    )

    # ============================================================
    # 9. INSERT Personal project for every user. Belt-and-suspenders
    #    idempotency: `WHERE NOT EXISTS` checks for any existing
    #    Personal project for that user, so re-runs and partial
    #    prior states both converge.
    # ============================================================
    bind.execute(
        sa.text(
            """
            INSERT INTO projects (id, user_id, name, slug, kind)
            SELECT gen_random_uuid(), u.id, 'Personal', 'personal', 'personal'
            FROM users u
            WHERE NOT EXISTS (
                SELECT 1
                FROM projects s
                WHERE s.user_id = u.id
                  AND s.kind = 'personal'
            )
            """
        )
    )

    # ============================================================
    # 10. INSERT env-local project for every agent_environment.
    #     Slug is `env-{id-prefix}` for deterministic re-
    #     runnability — same env produces the same slug every time.
    #     Filter to envs whose owning user still exists (orphans
    #     were deleted above but the WHERE here is defensive).
    # ============================================================
    bind.execute(
        sa.text(
            """
            INSERT INTO projects (
                id, user_id, name, slug, kind, origin_environment_id
            )
            SELECT
                gen_random_uuid(),
                e.user_id,
                COALESCE(e.machine_name, 'Machine') || ' (' || e.agent_type || ')',
                'env-' || substring(e.id::text, 1, 12),
                'environment',
                e.id
            FROM agent_environments e
            WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = e.user_id)
            ON CONFLICT (user_id, slug) DO NOTHING
            """
        )
    )

    # ============================================================
    # 11. Point every agent_environment at its env-local project.
    # ============================================================
    bind.execute(
        sa.text(
            """
            UPDATE agent_environments e
            SET default_project_id = s.id
            FROM projects s
            WHERE s.origin_environment_id = e.id
              AND s.kind = 'environment'
              AND e.default_project_id IS NULL
            """
        )
    )

    # ============================================================
    # 12. Backfill skills.project_id by heuristic.
    #     - User has 1+ envs: most recently active env's local project
    #       (deterministic tiebreak: id DESC on tied last_seen_at).
    #     - User has 0 envs: user's Personal project (rare — skills
    #       uploaded but no env registered yet).
    #
    #     `file_key` paths are NOT rewritten — the row stores its
    #     own path, so existing blobs serve from their pre-
    #     migration location and only new uploads land in the
    #     project-prefixed path. Long-term cleanup of legacy paths
    #     is a separate ops task.
    # ============================================================
    bind.execute(
        sa.text(
            """
            UPDATE skills s
            SET project_id = COALESCE(
                (SELECT project_row.id
                 FROM projects project_row
                 WHERE project_row.origin_environment_id IN (
                     SELECT env.id FROM agent_environments env
                     WHERE env.user_id = s.user_id
                     ORDER BY env.last_seen_at DESC NULLS LAST, env.id DESC
                     LIMIT 1
                 )
                 AND project_row.kind = 'environment'
                 LIMIT 1),
                (SELECT id FROM projects
                 WHERE user_id = s.user_id AND kind = 'personal'
                 LIMIT 1)
            )
            WHERE s.project_id IS NULL
            """
        )
    )

    # ============================================================
    # 13. Backfill vaults.project_id to user's Personal project (vaults
    #     are not machine-bound today).
    # ============================================================
    bind.execute(
        sa.text(
            """
            UPDATE vaults v
            SET project_id = (
                SELECT id FROM projects
                WHERE user_id = v.user_id AND kind = 'personal'
                LIMIT 1
            )
            WHERE v.project_id IS NULL
            """
        )
    )

    # ============================================================
    # 14. Validate no NULLs remain in newly-required columns.
    # ============================================================
    for table, col in (
        ("agent_environments", "default_project_id"),
        ("skills", "project_id"),
        ("vaults", "project_id"),
    ):
        null_count = bind.execute(
            sa.text(f"SELECT count(*) FROM {table} WHERE {col} IS NULL")
        ).scalar_one()
        if null_count > 0:
            raise RuntimeError(
                f"{table}.{col} still has {null_count} NULL rows after backfill — "
                "investigate before this migration can complete."
            )

    # ============================================================
    # 15. SET NOT NULL + FK + per-project indexes.
    #     FKs added via NOT VALID + VALIDATE so the row scan
    #     doesn't take an exclusive lock — meta-only ADD then
    #     SHARE UPDATE EXCLUSIVE walk lets reads + writes proceed
    #     for tables that grow into the millions.
    # ============================================================
    op.alter_column("agent_environments", "default_project_id", nullable=False)
    op.alter_column("skills", "project_id", nullable=False)
    op.alter_column("vaults", "project_id", nullable=False)

    fk_specs = (
        ("fk_agent_environments_default_project_id", "agent_environments", "default_project_id"),
        ("fk_skills_project_id", "skills", "project_id"),
        ("fk_vaults_project_id", "vaults", "project_id"),
    )
    for fk_name, table, col in fk_specs:
        bind.execute(
            sa.text(
                f"""
                ALTER TABLE {table}
                ADD CONSTRAINT {fk_name}
                FOREIGN KEY ({col}) REFERENCES projects(id) ON DELETE CASCADE
                NOT VALID
                """
            )
        )
        bind.execute(sa.text(f"ALTER TABLE {table} VALIDATE CONSTRAINT {fk_name}"))

    op.create_index("ix_skills_project_id", "skills", ["project_id"], unique=False)
    op.create_index("ix_vaults_project_id", "vaults", ["project_id"], unique=False)

    # ============================================================
    # 16. New partial unique index on active skills. Soft-deleted
    #     rows from step 7 stay in the table but don't compete
    #     for the unique slot.
    # ============================================================
    op.create_index(
        "uq_skills_active_user_project_skill_key",
        "skills",
        ["user_id", "project_id", "skill_key"],
        unique=True,
        postgresql_where=sa.text("is_active = true"),
    )

    # ============================================================
    # 17. Vault slug uniqueness becomes (user_id, project_id, slug).
    #     Pre-migration `uq_vault_user_slug` was per-user; with
    #     one-env-one-project, two envs are entitled to hold the
    #     same slug independently.
    # ============================================================
    bind.execute(sa.text("ALTER TABLE vaults DROP CONSTRAINT IF EXISTS uq_vault_user_slug"))
    bind.execute(
        sa.text(
            """
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint
                    WHERE conname = 'uq_vault_user_project_slug'
                ) THEN
                    ALTER TABLE vaults
                    ADD CONSTRAINT uq_vault_user_project_slug
                    UNIQUE (user_id, project_id, slug);
                END IF;
            END$$;
            """
        )
    )

    # ============================================================
    # 18. Sessions composite indexes for list query patterns.
    #     `GET /api/sessions` filters by user_id (always) and
    #     optionally environment_id. Order is started_at DESC /
    #     updated_at DESC. Covers p99 latency past 10k users.
    #
    #     Plain CREATE INDEX (no CONCURRENTLY) so the whole
    #     migration stays inside one transaction. Pre-fix the
    #     CONCURRENTLY variant ran in autocommit_block(), which
    #     committed prior column adds + backfills BEFORE alembic
    #     stamped this revision; a failure inside the index
    #     stretch (cancel, OOM, replication lag) left the DB in
    #     a state where columns existed but alembic still saw
    #     `672acd66fc7d` — `alembic upgrade head` would then fail
    #     on duplicate columns and need manual repair. With ~2.3k
    #     prod sessions, a non-concurrent build holds the table
    #     lock for tens of milliseconds, well under the deploy
    #     restart window. Future scale can split this into a
    #     dedicated post-migration when row count makes the lock
    #     visible.
    # ============================================================
    op.create_index(
        "ix_sessions_user_env",
        "sessions",
        ["user_id", "environment_id"],
        unique=False,
        if_not_exists=True,
    )
    op.create_index(
        "ix_sessions_user_started_at",
        "sessions",
        ["user_id", sa.text("started_at DESC")],
        unique=False,
        if_not_exists=True,
    )
    op.create_index(
        "ix_sessions_user_updated_at",
        "sessions",
        ["user_id", sa.text("updated_at DESC")],
        unique=False,
        if_not_exists=True,
    )


def downgrade() -> None:
    # Reverse order of upgrade(). FKs/indices first, then columns
    # and finally the projects table itself.

    # 18. Sessions composite indexes (plain DROP — non-concurrent).
    op.drop_index("ix_sessions_user_updated_at", table_name="sessions", if_exists=True)
    op.drop_index("ix_sessions_user_started_at", table_name="sessions", if_exists=True)
    op.drop_index("ix_sessions_user_env", table_name="sessions", if_exists=True)

    # 17. Vault slug uniqueness reverts to (user_id, slug).
    op.execute("ALTER TABLE vaults DROP CONSTRAINT IF EXISTS uq_vault_user_project_slug")
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'uq_vault_user_slug'
            ) THEN
                ALTER TABLE vaults
                ADD CONSTRAINT uq_vault_user_slug UNIQUE (user_id, slug);
            END IF;
        END$$;
        """
    )

    # 16. Active-skills unique index.
    op.drop_index("uq_skills_active_user_project_skill_key", table_name="skills")

    # 15. Per-project indexes + FKs + NOT NULL → nullable.
    op.drop_index("ix_vaults_project_id", table_name="vaults")
    op.drop_index("ix_skills_project_id", table_name="skills")
    op.drop_constraint("fk_vaults_project_id", "vaults", type_="foreignkey")
    op.drop_constraint("fk_skills_project_id", "skills", type_="foreignkey")
    op.drop_constraint(
        "fk_agent_environments_default_project_id",
        "agent_environments",
        type_="foreignkey",
    )

    # 6. Drop project_id columns.
    op.drop_column("vaults", "project_id")
    op.drop_column("skills", "project_id")
    op.drop_column("agent_environments", "default_project_id")

    # 5. Drop projects table + its indexes.
    op.drop_index("uq_projects_one_personal_per_user", table_name="projects")
    op.drop_index("ix_projects_origin_environment_id", table_name="projects")
    op.drop_index("ix_projects_user_id", table_name="projects")
    op.drop_table("projects")

    # 4. Drop the agent_envs unique constraint.
    op.drop_constraint(
        "uq_agent_envs_user_machine_agent",
        "agent_environments",
        type_="unique",
    )

    # 3. users.skills_revision.
    op.drop_column("users", "skills_revision")

    # 2. agent_environments observability columns.
    op.drop_column("agent_environments", "sync_enabled")
    op.drop_column("agent_environments", "dropped_count_since_start")
    op.drop_column("agent_environments", "queue_depth_high_water_since_start")
    op.drop_column("agent_environments", "last_revision_seen")
    op.drop_column("agent_environments", "last_sync_error")
    op.drop_column("agent_environments", "last_sync_at")

    # 1. api_keys.environment_id + scopes.
    op.drop_constraint("fk_api_keys_environment_id", "api_keys", type_="foreignkey")
    op.drop_index(op.f("ix_api_keys_environment_id"), table_name="api_keys")
    op.drop_column("api_keys", "environment_id")
    op.drop_column("api_keys", "scopes")
