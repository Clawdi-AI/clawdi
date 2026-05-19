import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.project import Project  # noqa: F401 - FK target
from app.models.user import User  # noqa: F401 - FK target
from app.models.vault import Vault, VaultItem  # noqa: F401 - FK targets

MCP_SERVER_VISIBILITIES = ("catalog", "private")
MCP_SOURCE_TYPES = ("catalog", "custom", "composio", "pipedream", "docker")
MCP_TRANSPORTS = ("stdio", "http", "sse", "streamable_http")
MCP_RUNTIME_MODES = ("local", "remote")
MCP_RESTART_POLICIES = ("none", "on_failure")
MCP_BINDING_TARGET_KINDS = ("env", "header", "arg", "url", "oauth", "config_file")
MCP_BINDING_VALUE_SOURCES = ("vault", "local_env", "input", "connector")
MCP_TOOL_RISK_LEVELS = ("read", "write", "destructive", "unknown")
MCP_TOOL_APPROVAL_POLICIES = ("default", "always_ask", "never_allow")


def _values(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


class McpServer(Base, TimestampMixin):
    __tablename__ = "mcp_servers"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )
    slug: Mapped[str] = mapped_column(String(120), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    visibility: Mapped[str] = mapped_column(String(20), nullable=False, server_default="private")
    source_type: Mapped[str] = mapped_column(String(32), nullable=False, server_default="custom")
    source_ref: Mapped[str | None] = mapped_column(Text)
    transport: Mapped[str] = mapped_column(String(32), nullable=False)
    runtime_mode: Mapped[str] = mapped_column(String(32), nullable=False, server_default="local")
    default_command: Mapped[str | None] = mapped_column(Text)
    default_args_json: Mapped[list | None] = mapped_column(JSONB)
    default_cwd_template: Mapped[str | None] = mapped_column(Text)
    default_url: Mapped[str | None] = mapped_column(Text)
    required_inputs_json: Mapped[dict | None] = mapped_column(JSONB)
    auth_config_json: Mapped[dict | None] = mapped_column(JSONB)
    runtime_config_json: Mapped[dict | None] = mapped_column(JSONB)
    capabilities_json: Mapped[dict | None] = mapped_column(JSONB)
    discovery_cache_json: Mapped[dict | None] = mapped_column(JSONB)
    risk_metadata_json: Mapped[dict | None] = mapped_column(JSONB)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(
            f"visibility IN ({_values(MCP_SERVER_VISIBILITIES)})",
            name="ck_mcp_servers_visibility_v1",
        ),
        CheckConstraint(
            f"source_type IN ({_values(MCP_SOURCE_TYPES)})",
            name="ck_mcp_servers_source_type_v1",
        ),
        CheckConstraint(
            f"transport IN ({_values(MCP_TRANSPORTS)})",
            name="ck_mcp_servers_transport_v1",
        ),
        CheckConstraint(
            f"runtime_mode IN ({_values(MCP_RUNTIME_MODES)})",
            name="ck_mcp_servers_runtime_mode_v1",
        ),
        Index(
            "uq_mcp_servers_catalog_slug_active",
            "slug",
            unique=True,
            postgresql_where="visibility = 'catalog' AND archived_at IS NULL",
        ),
        Index(
            "uq_mcp_servers_owner_slug_active",
            "owner_user_id",
            "slug",
            unique=True,
            postgresql_where="owner_user_id IS NOT NULL AND archived_at IS NULL",
        ),
    )


class McpPack(Base, TimestampMixin):
    __tablename__ = "mcp_packs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )
    slug: Mapped[str] = mapped_column(String(120), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    visibility: Mapped[str] = mapped_column(String(20), nullable=False, server_default="private")
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(
            f"visibility IN ({_values(MCP_SERVER_VISIBILITIES)})",
            name="ck_mcp_packs_visibility_v1",
        ),
        Index(
            "uq_mcp_packs_catalog_slug_active",
            "slug",
            unique=True,
            postgresql_where="visibility = 'catalog' AND archived_at IS NULL",
        ),
        Index(
            "uq_mcp_packs_owner_slug_active",
            "owner_user_id",
            "slug",
            unique=True,
            postgresql_where="owner_user_id IS NOT NULL AND archived_at IS NULL",
        ),
    )


class McpPackEntry(Base, TimestampMixin):
    __tablename__ = "mcp_pack_entries"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    pack_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("mcp_packs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    mcp_server_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("mcp_servers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    server_alias: Mapped[str] = mapped_column(String(120), nullable=False)
    default_tool_prefix: Mapped[str | None] = mapped_column(String(120))
    default_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    version_pin: Mapped[str | None] = mapped_column(String(200))

    __table_args__ = (
        Index("uq_mcp_pack_entries_pack_alias", "pack_id", "server_alias", unique=True),
    )


class ProjectMcpInstallation(Base, TimestampMixin):
    __tablename__ = "project_mcp_installations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    mcp_server_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("mcp_servers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    source_pack_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("mcp_packs.id", ondelete="SET NULL"),
        index=True,
    )
    installed_by_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    server_alias: Mapped[str] = mapped_column(String(120), nullable=False)
    tool_prefix: Mapped[str | None] = mapped_column(String(120))
    version_pin: Mapped[str | None] = mapped_column(String(200))
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    command_override: Mapped[str | None] = mapped_column(Text)
    args_override_json: Mapped[list | None] = mapped_column(JSONB)
    cwd_template_override: Mapped[str | None] = mapped_column(Text)
    url_override: Mapped[str | None] = mapped_column(Text)
    env_template_json: Mapped[dict | None] = mapped_column(JSONB)
    headers_template_json: Mapped[dict | None] = mapped_column(JSONB)
    auth_override_json: Mapped[dict | None] = mapped_column(JSONB)
    timeout_ms: Mapped[int | None] = mapped_column(Integer)
    startup_timeout_ms: Mapped[int | None] = mapped_column(Integer)
    restart_policy: Mapped[str] = mapped_column(String(32), nullable=False, server_default="none")
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(
            f"restart_policy IN ({_values(MCP_RESTART_POLICIES)})",
            name="ck_project_mcp_installations_restart_policy_v1",
        ),
        Index(
            "uq_project_mcp_installations_project_alias_active",
            "project_id",
            "server_alias",
            unique=True,
            postgresql_where="archived_at IS NULL",
        ),
    )


class ProjectMcpCredentialBinding(Base, TimestampMixin):
    __tablename__ = "project_mcp_credential_bindings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    installation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("project_mcp_installations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    target_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    target_name: Mapped[str] = mapped_column(String(200), nullable=False)
    value_source: Mapped[str] = mapped_column(String(32), nullable=False, server_default="vault")
    vault_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("vaults.id", ondelete="SET NULL"),
        index=True,
    )
    vault_item_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("vault_items.id", ondelete="SET NULL"),
        index=True,
    )
    display_vault_uri: Mapped[str | None] = mapped_column(Text)
    local_env_name: Mapped[str | None] = mapped_column(String(200))
    input_id: Mapped[str | None] = mapped_column(String(200))
    connector_ref: Mapped[str | None] = mapped_column(String(300))
    required: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    redact_in_logs: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")

    __table_args__ = (
        CheckConstraint(
            f"target_kind IN ({_values(MCP_BINDING_TARGET_KINDS)})",
            name="ck_project_mcp_credential_bindings_target_kind_v1",
        ),
        CheckConstraint(
            f"value_source IN ({_values(MCP_BINDING_VALUE_SOURCES)})",
            name="ck_project_mcp_credential_bindings_value_source_v1",
        ),
        Index(
            "uq_project_mcp_credential_bindings_target",
            "installation_id",
            "target_kind",
            "target_name",
            unique=True,
        ),
    )


class ProjectMcpToolPolicy(Base, TimestampMixin):
    __tablename__ = "project_mcp_tool_policies"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    installation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("project_mcp_installations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    tool_name: Mapped[str] = mapped_column(String(300), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    risk_level: Mapped[str] = mapped_column(String(32), nullable=False, server_default="unknown")
    approval_policy: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        server_default="default",
    )

    __table_args__ = (
        CheckConstraint(
            f"risk_level IN ({_values(MCP_TOOL_RISK_LEVELS)})",
            name="ck_project_mcp_tool_policies_risk_level_v1",
        ),
        CheckConstraint(
            f"approval_policy IN ({_values(MCP_TOOL_APPROVAL_POLICIES)})",
            name="ck_project_mcp_tool_policies_approval_policy_v1",
        ),
        Index(
            "uq_project_mcp_tool_policies_tool",
            "installation_id",
            "tool_name",
            unique=True,
        ),
    )
