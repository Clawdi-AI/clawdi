"""Schemas for admin endpoints (`/v1/admin/*`).

These run behind the `X-Admin-Key` header gate (require_admin_api_key)
and are used by SaaS batch tooling + ops-side scripts. Kept in a
separate file so they don't pollute user-facing schemas.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    field_validator,
    model_validator,
)

from app.schemas.ai_provider import AiProviderAuth, AiProviderModel
from app.schemas.platform import PlatformOwner
from app.schemas.runtime import (
    HostedEgressEngine,
    HostedEgressProfiles,
    HostedRuntimeBridge,
    HostedRuntimeDesiredState,
    HostedRuntimeLiveSync,
    HostedRuntimeLocale,
    HostedRuntimeRecovery,
    HostedRuntimeSystem,
    HostedRuntimeTools,
    validate_clawdi_cli_package_spec,
    validate_hosted_runtime_bridge,
    validate_no_plaintext_tool_secrets,
)

AdminChannelProvider = Literal["telegram", "discord", "whatsapp", "imessage"]
AdminChannelVisibility = Literal["private", "public"]
AdminChannelStatus = Literal["active", "disabled"]
_SUPPORTED_HOSTED_RUNTIMES = {"hermes", "openclaw"}
_ADMIN_CLERK_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def _validate_admin_clerk_id(value: str) -> str:
    if value != value.strip() or not _ADMIN_CLERK_ID_RE.fullmatch(value):
        raise ValueError("target_clerk_id must be a stable Clerk identifier")
    return value


AdminClerkId = Annotated[
    str,
    Field(min_length=1, max_length=200),
    AfterValidator(_validate_admin_clerk_id),
]


class AdminEnvironmentCreate(BaseModel):
    """Body for `POST /v1/admin/environments`. Mirrors the
    user-facing EnvironmentCreate but takes target_clerk_id
    instead of relying on auth context to resolve the user.

    If `environment_id` is set, it is the caller-owned stable agent id.
    Otherwise this uses the legacy self-managed registration key derived from
    `(user, machine_id, agent_type)` for idempotent retries.
    """

    model_config = ConfigDict(extra="forbid")

    target_clerk_id: AdminClerkId
    environment_id: UUID | None = None
    machine_id: str
    machine_name: str
    agent_type: str
    agent_version: str | None = None
    os_name: str = "linux"


class AdminAgentCreate(BaseModel):
    """Body for `POST /v1/admin/agents`.

    Agent-first alias of `AdminEnvironmentCreate`; `agent_id` maps to the
    legacy `environment_id` field consumed by the shared handler.
    """

    model_config = ConfigDict(extra="forbid")

    target_clerk_id: AdminClerkId
    agent_id: UUID | None = None
    machine_id: str
    machine_name: str
    agent_type: str
    agent_version: str | None = None
    os_name: str = "linux"


class AdminApiKeyCreate(BaseModel):
    """Body for `POST /v1/admin/auth/keys` — mint an api_key on
    behalf of a user identified by Clerk id. The route resolves
    `target_clerk_id` to the internal `User.id` and then calls the
    existing `mint_api_key` service, preserving its env-ownership
    invariant.

    `environment_id` is optional — if set, the minted key is bound
    to that env (deploy-key semantics). If null, the key is unbound.

    `scopes` is optional — same API-permission semantics as the user-facing
    `ApiKeyCreate`: `None` means full account access (the default
    for both user-self-mint and admin-mint). Pass an explicit list
    to narrow the minted key for ops tooling that doesn't need
    everything.
    """

    model_config = ConfigDict(extra="forbid")

    target_clerk_id: AdminClerkId
    label: str
    environment_id: str | None = None
    scopes: list[str] | None = None
    managed: bool = False


class AdminRuntimeStateUpsert(BaseModel):
    """Hosted runtime desired state written by the SaaS deploy orchestrator.

    This is deployment-level state only. Native channel credentials and channel
    links are owned by `/v1/channels/*` and must not be embedded here.
    """

    model_config = ConfigDict(extra="forbid")

    target_clerk_id: str | None = None
    deployment_id: str = Field(min_length=1, max_length=200)
    instance_id: str = Field(min_length=1, max_length=200)
    generation: int = Field(ge=0)
    cli_package_spec: str = Field(min_length=1, max_length=200)
    locale: HostedRuntimeLocale
    system: HostedRuntimeSystem
    egress_engine: HostedEgressEngine | None = None
    runtimes: dict[str, HostedRuntimeDesiredState]
    bridge: HostedRuntimeBridge | None = None
    live_sync: HostedRuntimeLiveSync
    recovery: HostedRuntimeRecovery
    egress_profiles: HostedEgressProfiles | None = None
    mcp: dict[str, Any] | None = None
    tools: HostedRuntimeTools

    @field_validator("cli_package_spec")
    @classmethod
    def _validate_cli_package_spec(cls, value: str) -> str:
        return validate_clawdi_cli_package_spec(value)

    @field_validator("runtimes")
    @classmethod
    def _validate_runtimes(
        cls,
        value: dict[str, HostedRuntimeDesiredState],
    ) -> dict[str, HostedRuntimeDesiredState]:
        if not value:
            raise ValueError("runtimes cannot be empty")
        if "channels" in value:
            raise ValueError("channels are not runtime desired state")
        unknown = sorted(set(value) - _SUPPORTED_HOSTED_RUNTIMES)
        if unknown:
            raise ValueError(f"unsupported runtime desired state: {', '.join(unknown)}")
        if len(value) != 1:
            raise ValueError("runtimes must contain exactly one enabled runtime")
        return value

    @model_validator(mode="after")
    def _validate_runtime_bridge(self) -> AdminRuntimeStateUpsert:
        runtime = next(iter(self.runtimes))
        validate_hosted_runtime_bridge(runtime, self.bridge)
        return self

    @field_validator("mcp")
    @classmethod
    def _validate_tool_desired_state(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is not None:
            validate_no_plaintext_tool_secrets(value)
        return value


class AdminRuntimeStateResponse(BaseModel):
    environment_id: UUID
    deployment_id: str
    instance_id: str
    generation: int


class AdminManagedAiProviderUpsert(BaseModel):
    """Create or rotate the first-party managed AI provider for a user."""

    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    target_clerk_id: str
    base_url: str = Field(min_length=1, max_length=1000)
    api_key: SecretStr = Field(min_length=1)
    default_model: str | None = Field(default=None, max_length=300)
    models: list[AiProviderModel] | None = None
    label: str | None = Field(default=None, max_length=200)
    capabilities: dict[str, Any] | None = None


class AdminManagedAiProviderResponse(BaseModel):
    owner_user_id: UUID
    owner_clerk_id: str | None
    provider_id: str
    api_mode: str
    runtime_env_name: str
    base_url: str
    models: list[dict[str, Any]] | None = None
    has_api_key: bool


class AdminDeploymentManagedAiProviderUpsert(BaseModel):
    """Create or rotate one deployment-scoped first-party managed provider."""

    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    owner: PlatformOwner
    base_url: str = Field(min_length=1, max_length=1000)
    api_key: SecretStr = Field(min_length=1)
    default_model: str | None = Field(default=None, max_length=300)
    models: list[AiProviderModel] | None = None
    label: str | None = Field(default=None, max_length=200)
    capabilities: dict[str, Any] | None = None


class AdminDeploymentManagedAiProviderResponse(BaseModel):
    id: UUID
    owner: PlatformOwner
    owner_user_id: UUID
    owner_clerk_id: str | None
    provider_id: str
    scope: Literal["account_global"]
    type: Literal["custom_openai_compatible"]
    label: str
    api_mode: str
    auth: AiProviderAuth
    managed_by: Literal["clawdi"]
    runtime_env_name: str
    base_url: str
    capabilities: dict[str, Any] | None = None
    models: list[dict[str, Any]] | None = None
    has_api_key: bool


class AdminChannelCreate(BaseModel):
    """Create a provider bot account through the admin control plane.

    `target_clerk_id` supplies the backing user row for bookkeeping and
    private managed bots. Public bots remain admin-managed shared
    infrastructure: authenticated users can create their own links and pair
    codes, but cannot mutate provider credentials or destructive bot-level
    state through user APIs.
    """

    target_clerk_id: str
    provider: AdminChannelProvider
    name: str = Field(min_length=1, max_length=120)
    visibility: AdminChannelVisibility = "public"
    provider_token: str | None = Field(default=None, min_length=1, max_length=2000)
    config: dict[str, Any] | None = None
    secrets: dict[str, str] | None = None

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("name cannot be blank")
        return stripped

    @field_validator("secrets")
    @classmethod
    def _validate_secrets(cls, value: dict[str, str] | None) -> dict[str, str] | None:
        return _clean_channel_secret_values(value)


class AdminChannelUpdate(BaseModel):
    """Patch provider bot metadata and credentials.

    Omitted fields are left unchanged. Passing `provider_token: null` clears the
    provider token; passing `config: null` clears bot config.
    """

    name: str | None = Field(default=None, min_length=1, max_length=120)
    status: AdminChannelStatus | None = None
    visibility: AdminChannelVisibility | None = None
    provider_token: str | None = Field(default=None, min_length=1, max_length=2000)
    config: dict[str, Any] | None = None
    secrets: dict[str, str] | None = None

    @field_validator("name")
    @classmethod
    def _strip_optional_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            raise ValueError("name cannot be blank")
        return stripped

    @field_validator("secrets")
    @classmethod
    def _validate_secrets(cls, value: dict[str, str] | None) -> dict[str, str] | None:
        return _clean_channel_secret_values(value)


class AdminChannelResponse(BaseModel):
    id: UUID
    owner_user_id: UUID
    owner_clerk_id: str | None
    provider: str
    name: str
    status: str
    visibility: AdminChannelVisibility
    has_provider_token: bool
    webhook_url: str
    config: dict[str, Any] | None = None
    archived_at: datetime | None = None
    created_at: datetime
    updated_at: datetime | None = None


class AdminChannelCreatedResponse(AdminChannelResponse):
    webhook_secret: str


class AdminChannelWebhookSecretResponse(BaseModel):
    id: UUID
    webhook_secret: str


def _clean_channel_secret_values(value: dict[str, str] | None) -> dict[str, str] | None:
    if value is None:
        return None
    cleaned: dict[str, str] = {}
    for key, secret in value.items():
        name = key.strip()
        if not name or len(name) > 80 or not name.replace("_", "").isalnum():
            raise ValueError("secret names must be alphanumeric or underscore")
        if not isinstance(secret, str) or not secret:
            raise ValueError("secret values cannot be blank")
        cleaned[name] = secret
    return cleaned
