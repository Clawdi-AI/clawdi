"""Move Agent Plugins authority into the Clawdi catalog boundary.

Revision ID: e6a1c9f3b7d2
Revises: d3a6f8c1e9b4
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "e6a1c9f3b7d2"
down_revision: str | Sequence[str] | None = "d3a6f8c1e9b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("LOCK TABLE hosted_runtime_states IN ACCESS EXCLUSIVE MODE"))
    unsafe_legacy_state = bind.execute(
        sa.text(
            """
            SELECT EXISTS (
                SELECT 1
                FROM hosted_runtime_states
                WHERE agent_plugins IS NOT NULL
                  AND agent_plugins <> '{"schemaVersion": 1, "installations": {}}'::jsonb
            )
            """
        )
    ).scalar_one()
    if unsafe_legacy_state:
        raise RuntimeError(
            "Cannot migrate non-empty or malformed Hosted agent_plugins state automatically. "
            "Resolve the unlaunched Hosted-owned selection before moving authority to Clawdi."
        )

    op.create_table(
        "plugin_catalog_snapshots",
        sa.Column("revision", sa.String(length=40), nullable=False),
        sa.Column("schema_version", sa.SmallInteger(), nullable=False),
        sa.Column("entry_count", sa.Integer(), nullable=False),
        sa.Column("source_etag", sa.String(length=512), nullable=True),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "revision ~ '^[0-9a-f]{40}$'",
            name="ck_plugin_catalog_snapshots_revision",
        ),
        sa.CheckConstraint(
            "schema_version = 1",
            name="ck_plugin_catalog_snapshots_schema_version",
        ),
        sa.CheckConstraint("entry_count >= 0", name="ck_plugin_catalog_snapshots_entry_count"),
        sa.PrimaryKeyConstraint("revision"),
    )
    op.create_table(
        "plugin_catalog_entries",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("snapshot_revision", sa.String(length=40), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("version", sa.String(length=256), nullable=False),
        sa.Column("agent_plugins_schema", sa.String(length=200), nullable=False),
        sa.Column("source_path", sa.String(length=500), nullable=False),
        sa.Column("content_digest", sa.String(length=79), nullable=False),
        sa.Column("metadata", postgresql.JSONB(none_as_null=True), nullable=False),
        sa.Column("has_configuration", sa.Boolean(), nullable=False),
        sa.Column("compatible_runtimes", postgresql.JSONB(none_as_null=True), nullable=False),
        sa.CheckConstraint(
            "name ~ '^[a-z0-9][a-z0-9.-]{0,63}$' AND name NOT LIKE '%--%' AND name NOT LIKE '%..%'",
            name="ck_plugin_catalog_entries_name",
        ),
        sa.CheckConstraint(
            "content_digest ~ '^sha256-tree-v1:[0-9a-f]{64}$'",
            name="ck_plugin_catalog_entries_content_digest",
        ),
        sa.ForeignKeyConstraint(
            ["snapshot_revision"],
            ["plugin_catalog_snapshots.revision"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "snapshot_revision",
            "name",
            "version",
            name="uq_plugin_catalog_entries_revision_name_version",
        ),
    )
    op.create_index(
        "ix_plugin_catalog_entries_snapshot_revision",
        "plugin_catalog_entries",
        ["snapshot_revision"],
    )
    op.create_table(
        "plugin_catalog_sync_state",
        sa.Column("id", sa.SmallInteger(), nullable=False),
        sa.Column("current_revision", sa.String(length=40), nullable=True),
        sa.Column("head_etag", sa.String(length=512), nullable=True),
        sa.Column("catalog_etag", sa.String(length=512), nullable=True),
        sa.Column("failure_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("last_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_success_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("next_sync_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.String(length=200), nullable=True),
        sa.CheckConstraint("id = 1", name="ck_plugin_catalog_sync_state_singleton"),
        sa.CheckConstraint(
            "failure_count >= 0",
            name="ck_plugin_catalog_sync_state_failure_count",
        ),
        sa.ForeignKeyConstraint(
            ["current_revision"],
            ["plugin_catalog_snapshots.revision"],
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.execute(sa.text("INSERT INTO plugin_catalog_sync_state (id, failure_count) VALUES (1, 0)"))
    op.create_table(
        "agent_plugin_installations",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("environment_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("plugin_name", sa.String(length=64), nullable=False),
        sa.Column("catalog_revision", sa.String(length=40), nullable=False),
        sa.Column("version", sa.String(length=256), nullable=False),
        sa.Column("agent_plugins_schema", sa.String(length=200), nullable=False),
        sa.Column("source_path", sa.String(length=500), nullable=False),
        sa.Column("content_digest", sa.String(length=79), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "catalog_revision ~ '^[0-9a-f]{40}$'",
            name="ck_agent_plugin_installations_catalog_revision",
        ),
        sa.CheckConstraint(
            "content_digest ~ '^sha256-tree-v1:[0-9a-f]{64}$'",
            name="ck_agent_plugin_installations_content_digest",
        ),
        sa.ForeignKeyConstraint(
            ["environment_id"],
            ["agent_environments.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["catalog_revision", "plugin_name", "version"],
            [
                "plugin_catalog_entries.snapshot_revision",
                "plugin_catalog_entries.name",
                "plugin_catalog_entries.version",
            ],
            name="fk_agent_plugin_installations_catalog_entry",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "environment_id",
            "plugin_name",
            name="uq_agent_plugin_installations_environment_plugin",
        ),
    )
    op.create_index(
        "ix_agent_plugin_installations_environment_id",
        "agent_plugin_installations",
        ["environment_id"],
    )
    op.drop_column("hosted_runtime_states", "agent_plugins")


def downgrade() -> None:
    bind = op.get_bind()
    has_desired_plugins = bind.execute(
        sa.text("SELECT EXISTS (SELECT 1 FROM agent_plugin_installations)")
    ).scalar_one()
    if has_desired_plugins:
        raise RuntimeError(
            "Cannot downgrade while Clawdi-owned Agent Plugin desired state exists. "
            "The old Hosted column cannot represent this authority safely."
        )

    op.add_column(
        "hosted_runtime_states",
        sa.Column("agent_plugins", postgresql.JSONB(none_as_null=True), nullable=True),
    )
    op.drop_index(
        "ix_agent_plugin_installations_environment_id",
        table_name="agent_plugin_installations",
    )
    op.drop_table("agent_plugin_installations")
    op.drop_table("plugin_catalog_sync_state")
    op.drop_index(
        "ix_plugin_catalog_entries_snapshot_revision",
        table_name="plugin_catalog_entries",
    )
    op.drop_table("plugin_catalog_entries")
    op.drop_table("plugin_catalog_snapshots")
