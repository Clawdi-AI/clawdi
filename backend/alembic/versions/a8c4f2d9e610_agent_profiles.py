"""Add profile identity without rewriting existing session content.

Revision ID: a8c4f2d9e610
Revises: b2c7e9a1d5f3
"""

import sqlalchemy as sa

from alembic import op

revision = "a8c4f2d9e610"
down_revision = "b2c7e9a1d5f3"
branch_labels = None
depends_on = None


def _unique_index(name: str, table: str, columns: list[str], where: str | None = None) -> None:
    # A failed concurrent build can leave an invalid index behind. Retry safely.
    valid = (
        op.get_bind()
        .execute(
            sa.text("SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass(:name)"),
            {"name": name},
        )
        .scalar_one_or_none()
    )
    with op.get_context().autocommit_block():
        if valid is False:
            op.drop_index(name, table_name=table, postgresql_concurrently=True)
        op.create_index(
            name,
            table,
            columns,
            unique=True,
            if_not_exists=True,
            postgresql_concurrently=True,
            postgresql_where=sa.text(where) if where else None,
        )


def upgrade() -> None:
    # These DDL steps survive the autocommit boundary and are retryable.
    op.execute("""CREATE TABLE IF NOT EXISTS agent_profiles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        environment_id uuid NOT NULL REFERENCES agent_environments(id) ON DELETE CASCADE,
        profile_key varchar(64) NOT NULL,
        upstream_key varchar(64) NOT NULL,
        is_default boolean NOT NULL,
        display_name varchar(120),
        state varchar(20) NOT NULL DEFAULT 'active',
        first_seen_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        removed_at timestamptz,
        project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
        CONSTRAINT uq_agent_profiles_environment_key UNIQUE (environment_id, profile_key),
        CONSTRAINT ck_agent_profiles_state CHECK (state IN ('active', 'removed')),
        CONSTRAINT ck_agent_profiles_default_key CHECK (is_default = (profile_key = ''))
    )""")
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_profiles_default "
        "ON agent_profiles (environment_id) WHERE is_default"
    )
    op.execute("""INSERT INTO agent_profiles (environment_id, profile_key, upstream_key, is_default)
        SELECT id, '', '', true FROM agent_environments
        ON CONFLICT (environment_id, profile_key) DO NOTHING""")
    for table in ("sessions", "session_sync_suppressions"):
        op.execute(
            f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS "
            "origin_profile_key varchar(64) NOT NULL DEFAULT ''"
        )
    _unique_index(
        "uq_sessions_user_origin_profile_local",
        "sessions",
        ["user_id", "origin_environment_id", "origin_profile_key", "local_session_id"],
    )
    _unique_index(
        "uq_session_sync_suppressions_origin_profile",
        "session_sync_suppressions",
        ["user_id", "origin_environment_id", "origin_profile_key", "local_session_id"],
        "origin_environment_id IS NOT NULL",
    )
    op.execute("""DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'sessions'::regclass
            AND conname = 'uq_sessions_user_origin_profile_local') THEN
            ALTER TABLE sessions ADD CONSTRAINT uq_sessions_user_origin_profile_local
                UNIQUE USING INDEX uq_sessions_user_origin_profile_local;
        END IF;
    END $$""")
    op.execute("ALTER TABLE sessions DROP CONSTRAINT IF EXISTS uq_sessions_user_origin_local")
    with op.get_context().autocommit_block():
        op.execute("DROP INDEX CONCURRENTLY IF EXISTS uq_session_sync_suppressions_origin")


def downgrade() -> None:
    # Fail on cross-profile collisions instead of deleting or merging data.
    _unique_index(
        "uq_sessions_user_origin_local",
        "sessions",
        ["user_id", "origin_environment_id", "local_session_id"],
    )
    _unique_index(
        "uq_session_sync_suppressions_origin",
        "session_sync_suppressions",
        ["user_id", "origin_environment_id", "local_session_id"],
        "origin_environment_id IS NOT NULL",
    )
    op.execute(
        "ALTER TABLE sessions ADD CONSTRAINT uq_sessions_user_origin_local "
        "UNIQUE USING INDEX uq_sessions_user_origin_local"
    )
    op.drop_constraint("uq_sessions_user_origin_profile_local", "sessions", type_="unique")
    op.drop_index(
        "uq_session_sync_suppressions_origin_profile", table_name="session_sync_suppressions"
    )
    for table in ("sessions", "session_sync_suppressions"):
        op.drop_column(table, "origin_profile_key")
    op.drop_table("agent_profiles")
