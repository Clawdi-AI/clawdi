from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

Slug = str
JsonDict = dict[str, Any]

McpVisibility = Literal["catalog", "private"]
McpSourceType = Literal["catalog", "custom", "composio", "pipedream", "docker"]
McpTransport = Literal["stdio", "http", "sse", "streamable_http"]
McpRuntimeMode = Literal["local", "remote"]
McpRestartPolicy = Literal["none", "on_failure"]
McpBindingTargetKind = Literal["env", "header", "arg", "url", "oauth", "config_file"]
McpBindingValueSource = Literal["vault", "local_env", "input", "connector"]
McpToolRiskLevel = Literal["read", "write", "destructive", "unknown"]
McpToolApprovalPolicy = Literal["default", "always_ask", "never_allow"]

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,119}$")
ALIAS_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,119}$")


def _normalize_slug(value: str) -> str:
    normalized = value.strip().lower()
    if not SLUG_RE.fullmatch(normalized):
        raise ValueError("slug must use lowercase letters, numbers, and hyphens")
    return normalized


def _normalize_alias(value: str) -> str:
    normalized = value.strip().lower()
    if not ALIAS_RE.fullmatch(normalized):
        raise ValueError("alias must use lowercase letters, numbers, hyphens, and underscores")
    return normalized


class McpServerCreate(BaseModel):
    slug: Slug = Field(min_length=1, max_length=120)
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    visibility: McpVisibility = "private"
    source_type: McpSourceType = "custom"
    source_ref: str | None = None
    transport: McpTransport
    runtime_mode: McpRuntimeMode = "local"
    default_command: str | None = None
    default_args: list[Any] | None = None
    default_cwd_template: str | None = None
    default_url: str | None = None
    required_inputs: JsonDict | None = None
    auth_config: JsonDict | None = None
    runtime_config: JsonDict | None = None
    capabilities: JsonDict | None = None
    discovery_cache: JsonDict | None = None
    risk_metadata: JsonDict | None = None

    @field_validator("slug")
    @classmethod
    def validate_slug(cls, value: str) -> str:
        return _normalize_slug(value)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        normalized = " ".join(value.split())
        if not normalized:
            raise ValueError("name is required")
        return normalized


class McpServerUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    source_type: McpSourceType | None = None
    source_ref: str | None = None
    transport: McpTransport | None = None
    runtime_mode: McpRuntimeMode | None = None
    default_command: str | None = None
    default_args: list[Any] | None = None
    default_cwd_template: str | None = None
    default_url: str | None = None
    required_inputs: JsonDict | None = None
    auth_config: JsonDict | None = None
    runtime_config: JsonDict | None = None
    capabilities: JsonDict | None = None
    discovery_cache: JsonDict | None = None
    risk_metadata: JsonDict | None = None

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = " ".join(value.split())
        if not normalized:
            raise ValueError("name is required")
        return normalized


class McpServerResponse(BaseModel):
    id: str
    owner_user_id: str | None
    slug: str
    name: str
    description: str | None
    visibility: McpVisibility
    source_type: McpSourceType
    source_ref: str | None
    transport: McpTransport
    runtime_mode: McpRuntimeMode
    default_command: str | None
    default_args: list[Any] | None
    default_cwd_template: str | None
    default_url: str | None
    required_inputs: JsonDict | None
    auth_config: JsonDict | None
    runtime_config: JsonDict | None
    capabilities: JsonDict | None
    discovery_cache: JsonDict | None
    risk_metadata: JsonDict | None
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime


class ProjectMcpInstallationCreate(BaseModel):
    mcp_server_id: str
    source_pack_id: str | None = None
    server_alias: str | None = Field(default=None, min_length=1, max_length=120)
    tool_prefix: str | None = Field(default=None, min_length=1, max_length=120)
    version_pin: str | None = Field(default=None, max_length=200)
    enabled: bool = True
    command_override: str | None = None
    args_override: list[Any] | None = None
    cwd_template_override: str | None = None
    url_override: str | None = None
    env_template: JsonDict | None = None
    headers_template: JsonDict | None = None
    auth_override: JsonDict | None = None
    timeout_ms: int | None = Field(default=None, ge=1)
    startup_timeout_ms: int | None = Field(default=None, ge=1)
    restart_policy: McpRestartPolicy = "none"

    @field_validator("server_alias", "tool_prefix")
    @classmethod
    def validate_alias(cls, value: str | None) -> str | None:
        return _normalize_alias(value) if value is not None else None


class ProjectMcpInstallationUpdate(BaseModel):
    server_alias: str | None = Field(default=None, min_length=1, max_length=120)
    tool_prefix: str | None = Field(default=None, min_length=1, max_length=120)
    version_pin: str | None = Field(default=None, max_length=200)
    enabled: bool | None = None
    command_override: str | None = None
    args_override: list[Any] | None = None
    cwd_template_override: str | None = None
    url_override: str | None = None
    env_template: JsonDict | None = None
    headers_template: JsonDict | None = None
    auth_override: JsonDict | None = None
    timeout_ms: int | None = Field(default=None, ge=1)
    startup_timeout_ms: int | None = Field(default=None, ge=1)
    restart_policy: McpRestartPolicy | None = None

    @field_validator("server_alias", "tool_prefix")
    @classmethod
    def validate_alias(cls, value: str | None) -> str | None:
        return _normalize_alias(value) if value is not None else None


class McpPackEntryInput(BaseModel):
    mcp_server_id: str
    server_alias: str = Field(min_length=1, max_length=120)
    default_tool_prefix: str | None = Field(default=None, min_length=1, max_length=120)
    default_enabled: bool = True
    version_pin: str | None = Field(default=None, max_length=200)

    @field_validator("server_alias", "default_tool_prefix")
    @classmethod
    def validate_alias(cls, value: str | None) -> str | None:
        return _normalize_alias(value) if value is not None else None


class McpPackEntryResponse(BaseModel):
    id: str
    pack_id: str
    mcp_server_id: str
    server_alias: str
    default_tool_prefix: str | None
    default_enabled: bool
    version_pin: str | None
    created_at: datetime
    updated_at: datetime
    server: McpServerResponse


class McpPackCreate(BaseModel):
    slug: Slug = Field(min_length=1, max_length=120)
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    visibility: McpVisibility = "private"
    entries: list[McpPackEntryInput] = Field(default_factory=list)

    @field_validator("slug")
    @classmethod
    def validate_slug(cls, value: str) -> str:
        return _normalize_slug(value)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        normalized = " ".join(value.split())
        if not normalized:
            raise ValueError("name is required")
        return normalized


class McpPackUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = " ".join(value.split())
        if not normalized:
            raise ValueError("name is required")
        return normalized


class McpPackEntriesPut(BaseModel):
    entries: list[McpPackEntryInput]


class McpPackResponse(BaseModel):
    id: str
    owner_user_id: str | None
    slug: str
    name: str
    description: str | None
    visibility: McpVisibility
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime
    entries: list[McpPackEntryResponse] = Field(default_factory=list)


class ProjectMcpCredentialBindingInput(BaseModel):
    target_kind: McpBindingTargetKind
    target_name: str = Field(min_length=1, max_length=200)
    value_source: McpBindingValueSource = "vault"
    vault_id: str | None = None
    vault_item_id: str | None = None
    display_vault_uri: str | None = None
    local_env_name: str | None = Field(default=None, max_length=200)
    input_id: str | None = Field(default=None, max_length=200)
    connector_ref: str | None = Field(default=None, max_length=300)
    required: bool = True
    redact_in_logs: bool = True


class ProjectMcpCredentialBindingsPut(BaseModel):
    bindings: list[ProjectMcpCredentialBindingInput]


class ProjectMcpCredentialBindingResponse(ProjectMcpCredentialBindingInput):
    id: str
    installation_id: str
    created_at: datetime
    updated_at: datetime


class ProjectMcpToolPolicyInput(BaseModel):
    tool_name: str = Field(min_length=1, max_length=300)
    enabled: bool = True
    risk_level: McpToolRiskLevel = "unknown"
    approval_policy: McpToolApprovalPolicy = "default"


class ProjectMcpToolPoliciesPut(BaseModel):
    tools: list[ProjectMcpToolPolicyInput]


class ProjectMcpToolPolicyResponse(ProjectMcpToolPolicyInput):
    id: str
    installation_id: str
    created_at: datetime
    updated_at: datetime


class ProjectMcpInstallationResponse(BaseModel):
    id: str
    project_id: str
    mcp_server_id: str
    source_pack_id: str | None
    installed_by_user_id: str
    server_alias: str
    tool_prefix: str | None
    version_pin: str | None
    enabled: bool
    command_override: str | None
    args_override: list[Any] | None
    cwd_template_override: str | None
    url_override: str | None
    env_template: JsonDict | None
    headers_template: JsonDict | None
    auth_override: JsonDict | None
    timeout_ms: int | None
    startup_timeout_ms: int | None
    restart_policy: McpRestartPolicy
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime
    server: McpServerResponse
    bindings: list[ProjectMcpCredentialBindingResponse] = Field(default_factory=list)
    tool_policies: list[ProjectMcpToolPolicyResponse] = Field(default_factory=list)
