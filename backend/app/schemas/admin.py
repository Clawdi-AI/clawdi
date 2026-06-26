"""Schemas for admin endpoints (`/api/admin/*`).

These run behind the `X-Admin-Key` header gate (require_admin_api_key)
and are used by SaaS batch tooling + ops-side scripts. Kept in a
separate file so they don't pollute user-facing schemas.
"""

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

AdminChannelProvider = Literal["telegram", "discord", "whatsapp", "imessage"]
AdminChannelVisibility = Literal["private", "public"]
AdminChannelStatus = Literal["active", "disabled"]


class AdminEnvironmentCreate(BaseModel):
    """Body for `POST /api/admin/environments`. Mirrors the
    user-facing EnvironmentCreate but takes target_clerk_id
    instead of relying on auth context to resolve the user.

    Idempotent — re-registering the same (user, machine_id) pair
    updates `machine_name` / `agent_version` / `last_seen_at` and
    returns the existing env id.
    """

    target_clerk_id: str
    machine_id: str
    machine_name: str
    agent_type: str
    agent_version: str | None = None
    os_name: str = "linux"


class AdminApiKeyCreate(BaseModel):
    """Body for `POST /api/admin/auth/keys` — mint an api_key on
    behalf of a user identified by Clerk id. The route resolves
    `target_clerk_id` to the internal `User.id` and then calls the
    existing `mint_api_key` service, preserving the env-ownership
    invariant the service enforces.

    `environment_id` is optional — if set, the minted key is bound
    to that env (deploy-key semantics). If null, the key is unbound.

    `scopes` is optional — same API-permission semantics as the user-facing
    `ApiKeyCreate`: `None` means full account access (the default
    for both user-self-mint and admin-mint). Pass an explicit list
    to narrow the minted key for ops tooling that doesn't need
    everything.
    """

    target_clerk_id: str
    label: str
    environment_id: str | None = None
    scopes: list[str] | None = None


class AdminRuntimeStateUpsert(BaseModel):
    """Hosted runtime desired state written by the SaaS deploy orchestrator.

    This is deployment-level state only. Native channel credentials and channel
    links are owned by `/api/channels/*` and must not be embedded here.
    """

    model_config = ConfigDict(extra="forbid")

    deployment_id: str = Field(min_length=1, max_length=200)
    app_id: str | None = Field(default=None, min_length=1, max_length=200)
    instance_id: str = Field(min_length=1, max_length=200)
    generation: int = Field(ge=0)
    provider_id: str | None = Field(default=None, min_length=2, max_length=80)
    system: dict[str, Any] | None = None
    control_plane: dict[str, Any] | None = None
    clawdi_cli: dict[str, Any] | None = None
    runtimes: dict[str, Any] = Field(default_factory=dict)
    live_sync: dict[str, Any] | None = None
    recovery: dict[str, Any] | None = None
    mitm_profiles: dict[str, Any] | None = None
    mcp: dict[str, Any] | None = None
    tools: dict[str, Any] | None = None

    @field_validator("runtimes")
    @classmethod
    def _validate_runtimes(cls, value: dict[str, Any]) -> dict[str, Any]:
        if not value:
            raise ValueError("runtimes cannot be empty")
        if "channels" in value:
            raise ValueError("channels are not runtime desired state")
        return value

    @field_validator("control_plane")
    @classmethod
    def _validate_control_plane(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is not None and "apiUrl" in value:
            raise ValueError("hosted runtime controlPlane must use cloudApiUrl")
        return value

    @field_validator("mcp", "tools")
    @classmethod
    def _validate_tool_desired_state(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is not None:
            _reject_plaintext_tool_secret(value)
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
    label: str | None = Field(default=None, max_length=200)
    capabilities: dict[str, Any] | None = None


class AdminManagedAiProviderResponse(BaseModel):
    owner_user_id: UUID
    owner_clerk_id: str
    provider_id: str
    api_mode: str
    runtime_env_name: str
    base_url: str
    default_model: str | None = None
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
    owner_clerk_id: str
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


_FORBIDDEN_TOOL_SECRET_KEYS = {
    "apikey",
    "api_key",
    "authorization",
    "bearer",
    "header",
    "headers",
    "password",
    "secret",
    "secrets",
    "secretvalues",
    "token",
}


def _reject_plaintext_tool_secret(value: Any, path: str = "") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = str(key).replace("-", "_").lower()
            if normalized in _FORBIDDEN_TOOL_SECRET_KEYS:
                location = f" at {path}.{key}" if path else f" at {key}"
                raise ValueError(
                    f"mcp/tools desired state must not contain plaintext secrets{location}"
                )
            _reject_plaintext_tool_secret(child, f"{path}.{key}" if path else str(key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _reject_plaintext_tool_secret(child, f"{path}[{index}]")
