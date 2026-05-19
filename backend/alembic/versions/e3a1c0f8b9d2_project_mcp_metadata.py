"""project mcp metadata

Revision ID: e3a1c0f8b9d2
Revises: 91d2c0f4e8a3
Create Date: 2026-05-19 00:00:00.000000

Adds the metadata layer for Project MCP Packs:
  - top-level MCP server definitions
  - top-level MCP packs and pack entries
  - Project MCP installations
  - Project MCP credential bindings
  - Project MCP tool policies

The migration intentionally does not add hosted runtime proxy tables yet.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "e3a1c0f8b9d2"
down_revision: str | Sequence[str] | None = "91d2c0f4e8a3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _timestamps() -> list[sa.Column]:
    return [
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
    ]


def _uuid_pk() -> sa.Column:
    return sa.Column(
        "id",
        postgresql.UUID(as_uuid=True),
        primary_key=True,
        server_default=sa.text("gen_random_uuid()"),
    )


def upgrade() -> None:
    op.create_table(
        "mcp_servers",
        _uuid_pk(),
        sa.Column(
            "owner_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("slug", sa.String(120), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("visibility", sa.String(20), nullable=False, server_default="private"),
        sa.Column("source_type", sa.String(32), nullable=False, server_default="custom"),
        sa.Column("source_ref", sa.Text(), nullable=True),
        sa.Column("transport", sa.String(32), nullable=False),
        sa.Column("runtime_mode", sa.String(32), nullable=False, server_default="local"),
        sa.Column("default_command", sa.Text(), nullable=True),
        sa.Column("default_args_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("default_cwd_template", sa.Text(), nullable=True),
        sa.Column("default_url", sa.Text(), nullable=True),
        sa.Column("required_inputs_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("auth_config_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("runtime_config_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("capabilities_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("discovery_cache_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("risk_metadata_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
        sa.CheckConstraint(
            "visibility IN ('catalog', 'private')",
            name="ck_mcp_servers_visibility_v1",
        ),
        sa.CheckConstraint(
            "source_type IN ('catalog', 'custom', 'composio', 'pipedream', 'docker')",
            name="ck_mcp_servers_source_type_v1",
        ),
        sa.CheckConstraint(
            "transport IN ('stdio', 'http', 'sse', 'streamable_http')",
            name="ck_mcp_servers_transport_v1",
        ),
        sa.CheckConstraint(
            "runtime_mode IN ('local', 'remote')",
            name="ck_mcp_servers_runtime_mode_v1",
        ),
    )
    op.create_index("ix_mcp_servers_owner_user_id", "mcp_servers", ["owner_user_id"])
    op.create_index(
        "uq_mcp_servers_catalog_slug_active",
        "mcp_servers",
        ["slug"],
        unique=True,
        postgresql_where=sa.text("visibility = 'catalog' AND archived_at IS NULL"),
    )
    op.create_index(
        "uq_mcp_servers_owner_slug_active",
        "mcp_servers",
        ["owner_user_id", "slug"],
        unique=True,
        postgresql_where=sa.text("owner_user_id IS NOT NULL AND archived_at IS NULL"),
    )

    op.create_table(
        "mcp_packs",
        _uuid_pk(),
        sa.Column(
            "owner_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("slug", sa.String(120), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("visibility", sa.String(20), nullable=False, server_default="private"),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
        sa.CheckConstraint(
            "visibility IN ('catalog', 'private')",
            name="ck_mcp_packs_visibility_v1",
        ),
    )
    op.create_index("ix_mcp_packs_owner_user_id", "mcp_packs", ["owner_user_id"])
    op.create_index(
        "uq_mcp_packs_catalog_slug_active",
        "mcp_packs",
        ["slug"],
        unique=True,
        postgresql_where=sa.text("visibility = 'catalog' AND archived_at IS NULL"),
    )
    op.create_index(
        "uq_mcp_packs_owner_slug_active",
        "mcp_packs",
        ["owner_user_id", "slug"],
        unique=True,
        postgresql_where=sa.text("owner_user_id IS NOT NULL AND archived_at IS NULL"),
    )

    op.create_table(
        "mcp_pack_entries",
        _uuid_pk(),
        sa.Column(
            "pack_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("mcp_packs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "mcp_server_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("mcp_servers.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("server_alias", sa.String(120), nullable=False),
        sa.Column("default_tool_prefix", sa.String(120), nullable=True),
        sa.Column("default_enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("version_pin", sa.String(200), nullable=True),
        *_timestamps(),
    )
    op.create_index("ix_mcp_pack_entries_pack_id", "mcp_pack_entries", ["pack_id"])
    op.create_index(
        "ix_mcp_pack_entries_mcp_server_id",
        "mcp_pack_entries",
        ["mcp_server_id"],
    )
    op.create_index(
        "uq_mcp_pack_entries_pack_alias",
        "mcp_pack_entries",
        ["pack_id", "server_alias"],
        unique=True,
    )

    op.create_table(
        "project_mcp_installations",
        _uuid_pk(),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "mcp_server_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("mcp_servers.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "source_pack_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("mcp_packs.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "installed_by_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("server_alias", sa.String(120), nullable=False),
        sa.Column("tool_prefix", sa.String(120), nullable=True),
        sa.Column("version_pin", sa.String(200), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("command_override", sa.Text(), nullable=True),
        sa.Column("args_override_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("cwd_template_override", sa.Text(), nullable=True),
        sa.Column("url_override", sa.Text(), nullable=True),
        sa.Column("env_template_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("headers_template_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("auth_override_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("timeout_ms", sa.Integer(), nullable=True),
        sa.Column("startup_timeout_ms", sa.Integer(), nullable=True),
        sa.Column("restart_policy", sa.String(32), nullable=False, server_default="none"),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
        sa.CheckConstraint(
            "restart_policy IN ('none', 'on_failure')",
            name="ck_project_mcp_installations_restart_policy_v1",
        ),
    )
    op.create_index(
        "ix_project_mcp_installations_project_id",
        "project_mcp_installations",
        ["project_id"],
    )
    op.create_index(
        "ix_project_mcp_installations_mcp_server_id",
        "project_mcp_installations",
        ["mcp_server_id"],
    )
    op.create_index(
        "ix_project_mcp_installations_source_pack_id",
        "project_mcp_installations",
        ["source_pack_id"],
    )
    op.create_index(
        "ix_project_mcp_installations_installed_by_user_id",
        "project_mcp_installations",
        ["installed_by_user_id"],
    )
    op.create_index(
        "uq_project_mcp_installations_project_alias_active",
        "project_mcp_installations",
        ["project_id", "server_alias"],
        unique=True,
        postgresql_where=sa.text("archived_at IS NULL"),
    )

    op.create_table(
        "project_mcp_credential_bindings",
        _uuid_pk(),
        sa.Column(
            "installation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("project_mcp_installations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("target_kind", sa.String(32), nullable=False),
        sa.Column("target_name", sa.String(200), nullable=False),
        sa.Column("value_source", sa.String(32), nullable=False, server_default="vault"),
        sa.Column(
            "vault_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("vaults.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "vault_item_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("vault_items.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("display_vault_uri", sa.Text(), nullable=True),
        sa.Column("local_env_name", sa.String(200), nullable=True),
        sa.Column("input_id", sa.String(200), nullable=True),
        sa.Column("connector_ref", sa.String(300), nullable=True),
        sa.Column("required", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("redact_in_logs", sa.Boolean(), nullable=False, server_default="true"),
        *_timestamps(),
        sa.CheckConstraint(
            "target_kind IN ('env', 'header', 'arg', 'url', 'oauth', 'config_file')",
            name="ck_project_mcp_credential_bindings_target_kind_v1",
        ),
        sa.CheckConstraint(
            "value_source IN ('vault', 'local_env', 'input', 'connector')",
            name="ck_project_mcp_credential_bindings_value_source_v1",
        ),
    )
    op.create_index(
        "ix_project_mcp_credential_bindings_installation_id",
        "project_mcp_credential_bindings",
        ["installation_id"],
    )
    op.create_index(
        "ix_project_mcp_credential_bindings_vault_id",
        "project_mcp_credential_bindings",
        ["vault_id"],
    )
    op.create_index(
        "ix_project_mcp_credential_bindings_vault_item_id",
        "project_mcp_credential_bindings",
        ["vault_item_id"],
    )
    op.create_index(
        "uq_project_mcp_credential_bindings_target",
        "project_mcp_credential_bindings",
        ["installation_id", "target_kind", "target_name"],
        unique=True,
    )

    op.create_table(
        "project_mcp_tool_policies",
        _uuid_pk(),
        sa.Column(
            "installation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("project_mcp_installations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("tool_name", sa.String(300), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("risk_level", sa.String(32), nullable=False, server_default="unknown"),
        sa.Column("approval_policy", sa.String(32), nullable=False, server_default="default"),
        *_timestamps(),
        sa.CheckConstraint(
            "risk_level IN ('read', 'write', 'destructive', 'unknown')",
            name="ck_project_mcp_tool_policies_risk_level_v1",
        ),
        sa.CheckConstraint(
            "approval_policy IN ('default', 'always_ask', 'never_allow')",
            name="ck_project_mcp_tool_policies_approval_policy_v1",
        ),
    )
    op.create_index(
        "ix_project_mcp_tool_policies_installation_id",
        "project_mcp_tool_policies",
        ["installation_id"],
    )
    op.create_index(
        "uq_project_mcp_tool_policies_tool",
        "project_mcp_tool_policies",
        ["installation_id", "tool_name"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("uq_project_mcp_tool_policies_tool", table_name="project_mcp_tool_policies")
    op.drop_index(
        "ix_project_mcp_tool_policies_installation_id",
        table_name="project_mcp_tool_policies",
    )
    op.drop_table("project_mcp_tool_policies")

    op.drop_index(
        "uq_project_mcp_credential_bindings_target",
        table_name="project_mcp_credential_bindings",
    )
    op.drop_index(
        "ix_project_mcp_credential_bindings_vault_item_id",
        table_name="project_mcp_credential_bindings",
    )
    op.drop_index(
        "ix_project_mcp_credential_bindings_vault_id",
        table_name="project_mcp_credential_bindings",
    )
    op.drop_index(
        "ix_project_mcp_credential_bindings_installation_id",
        table_name="project_mcp_credential_bindings",
    )
    op.drop_table("project_mcp_credential_bindings")

    op.drop_index(
        "uq_project_mcp_installations_project_alias_active",
        table_name="project_mcp_installations",
    )
    op.drop_index(
        "ix_project_mcp_installations_installed_by_user_id",
        table_name="project_mcp_installations",
    )
    op.drop_index(
        "ix_project_mcp_installations_source_pack_id",
        table_name="project_mcp_installations",
    )
    op.drop_index(
        "ix_project_mcp_installations_mcp_server_id",
        table_name="project_mcp_installations",
    )
    op.drop_index(
        "ix_project_mcp_installations_project_id",
        table_name="project_mcp_installations",
    )
    op.drop_table("project_mcp_installations")

    op.drop_index("uq_mcp_pack_entries_pack_alias", table_name="mcp_pack_entries")
    op.drop_index("ix_mcp_pack_entries_mcp_server_id", table_name="mcp_pack_entries")
    op.drop_index("ix_mcp_pack_entries_pack_id", table_name="mcp_pack_entries")
    op.drop_table("mcp_pack_entries")

    op.drop_index("uq_mcp_packs_owner_slug_active", table_name="mcp_packs")
    op.drop_index("uq_mcp_packs_catalog_slug_active", table_name="mcp_packs")
    op.drop_index("ix_mcp_packs_owner_user_id", table_name="mcp_packs")
    op.drop_table("mcp_packs")

    op.drop_index("uq_mcp_servers_owner_slug_active", table_name="mcp_servers")
    op.drop_index("uq_mcp_servers_catalog_slug_active", table_name="mcp_servers")
    op.drop_index("ix_mcp_servers_owner_user_id", table_name="mcp_servers")
    op.drop_table("mcp_servers")
