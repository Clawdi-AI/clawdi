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
InputModality = Literal["text", "image", "video", "audio"]


class AiProviderModelCost(BaseModel):
    model_config = ConfigDict(extra="ignore", hide_input_in_errors=True)

    input: float = Field(ge=0)
    output: float = Field(ge=0)
    cache_read: float | None = Field(default=None, ge=0)
    cache_write: float | None = Field(default=None, ge=0)


class AiProviderAuth(BaseModel):
    model_config = ConfigDict(extra="ignore", hide_input_in_errors=True)

    type: AuthType
    ref: str | None = None
    source: str | None = None
    provider: str | None = None
    tool: str | None = None
    profile: str | None = None
    value: SkipJsonSchema[SecretStr | None] = None


class AiProviderModel(BaseModel):
    model_config = ConfigDict(extra="ignore", hide_input_in_errors=True)

    id: str = Field(min_length=1, max_length=300)
    label: str | None = Field(default=None, max_length=300)
    alias: str | None = Field(default=None, max_length=300)
    api_mode: ApiMode | None = None
    input_modalities: list[InputModality] | None = None
    supports_vision: bool | None = None
    supports_tools: bool | None = None
    supports_reasoning: bool | None = None
    context_window: int | None = Field(default=None, ge=0)
    max_tokens: int | None = Field(default=None, ge=0)
    cost: AiProviderModelCost | None = None
    capabilities: dict[str, Any] | None = None


class AiProviderBase(BaseModel):
    type: ProviderType
    label: str | None = Field(default=None, max_length=200)
    base_url: str = Field(min_length=1, max_length=1000)
    api_mode: ApiMode | None = None
    auth: AiProviderAuth
    managed_by: Literal["user", "clawdi"] = "user"
    runtime_env_name: str | None = Field(default=None, max_length=128)
    capabilities: dict[str, Any] | None = None
    models: list[AiProviderModel] | None = None


class AiProviderUpsert(AiProviderBase):
    provider_id: str = Field(min_length=2, max_length=80, pattern=r"^[a-z][a-z0-9._-]{1,62}$")


class AiProviderPatch(BaseModel):
    type: ProviderType | None = None
    label: str | None = Field(default=None, max_length=200)
    base_url: str | None = Field(default=None, min_length=1, max_length=1000)
    api_mode: ApiMode | None = None
    auth: AiProviderAuth | None = None
    managed_by: Literal["user", "clawdi"] | None = None
    runtime_env_name: str | None = Field(default=None, max_length=128)
    capabilities: dict[str, Any] | None = None
    models: list[AiProviderModel] | None = None


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
    value: str | None = None
    payload: str | None = None
    tool: str | None = None
    provider: str | None = None
    profile: str | None = None


class AiProviderOAuthStartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    provider: str = Field(min_length=1, max_length=80)
    redirect_uri: str | None = Field(default=None, max_length=1000)


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
