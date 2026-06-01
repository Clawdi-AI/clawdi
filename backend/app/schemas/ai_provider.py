from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr
from pydantic.json_schema import SkipJsonSchema

ProviderType = Literal[
    "openai",
    "anthropic",
    "openrouter",
    "gemini",
    "mistral",
    "custom_openai_compatible",
]
ApiMode = Literal[
    "openai_chat",
    "openai_responses",
    "anthropic_messages",
    "google_generate_content",
]
AuthType = Literal["secret_ref", "api_key", "oauth_profile", "agent_profile", "none"]


class AiProviderAuth(BaseModel):
    model_config = ConfigDict(extra="ignore", hide_input_in_errors=True)

    type: AuthType
    ref: str | None = None
    source: str | None = None
    payload_ref: str | None = None
    provider: str | None = None
    tool: str | None = None
    profile: str | None = None
    value: SkipJsonSchema[SecretStr | None] = None


class AiProviderBase(BaseModel):
    type: ProviderType
    label: str | None = Field(default=None, max_length=200)
    base_url: str = Field(min_length=1, max_length=1000)
    default_model: str | None = Field(default=None, max_length=300)
    api_mode: ApiMode | None = None
    auth: AiProviderAuth
    managed_by: Literal["user", "clawdi"] = "user"
    runtime_env_name: str | None = Field(default=None, max_length=128)
    capabilities: dict[str, Any] | None = None


class AiProviderUpsert(AiProviderBase):
    provider_id: str = Field(min_length=2, max_length=80, pattern=r"^[a-z][a-z0-9._-]{1,62}$")


class AiProviderPatch(BaseModel):
    type: ProviderType | None = None
    label: str | None = Field(default=None, max_length=200)
    base_url: str | None = Field(default=None, min_length=1, max_length=1000)
    default_model: str | None = Field(default=None, max_length=300)
    api_mode: ApiMode | None = None
    auth: AiProviderAuth | None = None
    managed_by: Literal["user", "clawdi"] | None = None
    runtime_env_name: str | None = Field(default=None, max_length=128)
    capabilities: dict[str, Any] | None = None


class AiProviderResponse(AiProviderBase):
    id: str
    provider_id: str
    scope: str
    created_at: datetime
    updated_at: datetime


class AiProviderListResponse(BaseModel):
    providers: list[AiProviderResponse]


class AiProviderDeleteResponse(BaseModel):
    status: Literal["deleted"]
    provider_id: str


class AiProviderValidationResponse(BaseModel):
    valid: bool
    errors: list[str] = []
    warnings: list[str] = []


class AiProviderManagedApiKeyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    value: SecretStr
    profile: str = Field(default="default", min_length=1, max_length=120)
    runtime_env_name: str | None = Field(default=None, max_length=128)


class AiProviderAuthImportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    type: Literal["agent_profile", "oauth_profile"]
    payload: SecretStr
    profile: str = Field(default="default", min_length=1, max_length=120)
    tool: str | None = Field(default=None, max_length=80)
    provider: str | None = Field(default=None, max_length=80)


class AiProviderAuthResolveRequest(BaseModel):
    profile: str = Field(default="default", min_length=1, max_length=120)


class AiProviderAuthResolveResponse(BaseModel):
    provider_id: str
    auth_type: AuthType
    payload_ref: str
    value: str | None = None
    payload: str | None = None
    tool: str | None = None
    provider: str | None = None
    profile: str | None = None


class AiProviderOAuthStartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    provider: str = Field(min_length=1, max_length=80)
    profile: str = Field(default="default", min_length=1, max_length=120)
    redirect_uri: str | None = Field(default=None, max_length=1000)
    scope: str | None = Field(default=None, max_length=1000)


class AiProviderOAuthStartResponse(BaseModel):
    provider_id: str
    oauth_provider: str
    profile: str
    auth_url: str
    state: str
    redirect_uri: str
    expires_at: datetime


class AiProviderOAuthCompleteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    state: str = Field(min_length=1, max_length=4000)
    code: str = Field(min_length=1, max_length=4000)
    redirect_uri: str | None = Field(default=None, max_length=1000)
