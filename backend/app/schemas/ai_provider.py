from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, RootModel, SecretStr, model_validator
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
AuthProfile = Annotated[
    str,
    Field(min_length=1, max_length=120, pattern=r"^[a-z][a-z0-9._-]{0,119}$"),
]
EnvSecretRef = Annotated[
    str,
    Field(min_length=5, max_length=132, pattern=r"^env:[A-Z][A-Z0-9_]{0,127}$"),
]
VaultSecretRef = Annotated[
    str,
    Field(min_length=9, max_length=1000, pattern=r"^clawdi://.*$"),
]
SecretRef = Annotated[
    str,
    Field(
        min_length=5,
        max_length=1000,
        pattern=r"^(env:[A-Z][A-Z0-9_]{0,127}|clawdi://.*)$",
    ),
]


def _reject_explicit_nulls(value: Any, fields: frozenset[str]) -> Any:
    if isinstance(value, dict):
        null_fields = sorted(field for field in fields if field in value and value[field] is None)
        if null_fields:
            raise ValueError(f"fields cannot be null: {', '.join(null_fields)}")
    return value


def _reject_normal_upsert_oauth(value: Any) -> Any:
    if isinstance(value, dict):
        auth = value.get("auth")
        if isinstance(auth, dict) and auth.get("type") == "oauth_profile":
            raise ValueError("oauth_profile auth is not supported; use Codex OAuth connect")
    return value


class AiProviderModelCost(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True, strict=True)

    input: float = Field(ge=0)
    output: float = Field(ge=0)
    cache_read: float | SkipJsonSchema[None] = Field(default=None, ge=0)
    cache_write: float | SkipJsonSchema[None] = Field(default=None, ge=0)

    @model_validator(mode="before")
    @classmethod
    def _reject_null_optional_fields(cls, value: Any) -> Any:
        return _reject_explicit_nulls(value, frozenset({"cache_read", "cache_write"}))


class _AiProviderAuthVariant(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    @model_validator(mode="before")
    @classmethod
    def _redact_rejected_plaintext_value(cls, value: Any) -> Any:
        if isinstance(value, dict) and isinstance(value.get("value"), str):
            sanitized = dict(value)
            sanitized["value"] = SecretStr(value["value"])
            return sanitized
        return value

    def persistence_fields(self) -> tuple[str | None, dict[str, str] | None]:
        raise NotImplementedError


class AiProviderSecretRefAuth(_AiProviderAuthVariant):
    type: Literal["secret_ref"]
    ref: SecretRef

    def persistence_fields(self) -> tuple[str, None]:
        return self.ref, None


class _AiProviderApiKeyAuth(_AiProviderAuthVariant):
    type: Literal["api_key"]
    source: Literal["env", "vault", "managed"]
    profile: AuthProfile | None = None

    def _metadata(self) -> dict[str, str]:
        metadata = {"source": self.source}
        if self.profile is not None:
            metadata["profile"] = self.profile
        return metadata


class AiProviderEnvApiKeyAuth(_AiProviderApiKeyAuth):
    source: Literal["env"]
    ref: EnvSecretRef

    def persistence_fields(self) -> tuple[str, dict[str, str]]:
        return self.ref, self._metadata()


class AiProviderVaultApiKeyAuth(_AiProviderApiKeyAuth):
    source: Literal["vault"]
    ref: VaultSecretRef

    def persistence_fields(self) -> tuple[str, dict[str, str]]:
        return self.ref, self._metadata()


class AiProviderManagedApiKeyAuth(_AiProviderApiKeyAuth):
    source: Literal["managed"]

    def persistence_fields(self) -> tuple[None, dict[str, str]]:
        return None, self._metadata()


type AiProviderApiKeyAuth = Annotated[
    AiProviderEnvApiKeyAuth | AiProviderVaultApiKeyAuth | AiProviderManagedApiKeyAuth,
    Field(discriminator="source"),
]


class AiProviderOAuthProfileAuth(_AiProviderAuthVariant):
    type: Literal["oauth_profile"]
    provider: AuthProfile
    profile: AuthProfile

    def persistence_fields(self) -> tuple[None, dict[str, str]]:
        return None, {"provider": self.provider, "profile": self.profile}


class AiProviderAgentProfileAuth(_AiProviderAuthVariant):
    type: Literal["agent_profile"]
    tool: AuthProfile
    profile: AuthProfile

    def persistence_fields(self) -> tuple[None, dict[str, str]]:
        return None, {"tool": self.tool, "profile": self.profile}


class AiProviderNoneAuth(_AiProviderAuthVariant):
    type: Literal["none"]

    def persistence_fields(self) -> tuple[None, None]:
        return None, None


type AiProviderUpsertAuth = Annotated[
    AiProviderSecretRefAuth
    | AiProviderApiKeyAuth
    | AiProviderAgentProfileAuth
    | AiProviderNoneAuth,
    Field(discriminator="type"),
]
type AiProviderAuth = Annotated[
    AiProviderSecretRefAuth
    | AiProviderApiKeyAuth
    | AiProviderOAuthProfileAuth
    | AiProviderAgentProfileAuth
    | AiProviderNoneAuth,
    Field(discriminator="type"),
]


def ai_provider_auth_from_persistence(
    auth_type: str,
    auth_ref: str | None,
    auth_metadata: dict | None,
) -> AiProviderAuth:
    metadata = auth_metadata or {}
    if auth_type == "secret_ref":
        return AiProviderSecretRefAuth.model_validate({"type": auth_type, "ref": auth_ref})
    if auth_type == "api_key":
        source = metadata.get("source")
        payload = {
            "type": auth_type,
            "source": source,
            "profile": metadata.get("profile"),
        }
        if source != "managed":
            payload["ref"] = auth_ref
        if payload["profile"] is None:
            del payload["profile"]
        if source == "env":
            return AiProviderEnvApiKeyAuth.model_validate(payload)
        if source == "vault":
            return AiProviderVaultApiKeyAuth.model_validate(payload)
        if source == "managed":
            return AiProviderManagedApiKeyAuth.model_validate(payload)
        raise ValueError("unsupported persisted api_key source")
    if auth_type == "oauth_profile":
        return AiProviderOAuthProfileAuth.model_validate(
            {
                "type": auth_type,
                "provider": metadata.get("provider"),
                "profile": metadata.get("profile"),
            }
        )
    if auth_type == "agent_profile":
        return AiProviderAgentProfileAuth.model_validate(
            {
                "type": auth_type,
                "tool": metadata.get("tool"),
                "profile": metadata.get("profile"),
            }
        )
    if auth_type == "none":
        return AiProviderNoneAuth(type="none")
    raise ValueError("unsupported persisted AI provider auth type")


class AiProviderModelCapabilities(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True, strict=True)

    chat: bool | SkipJsonSchema[None] = None
    responses: bool | SkipJsonSchema[None] = None
    tools: bool | SkipJsonSchema[None] = None
    vision: bool | SkipJsonSchema[None] = None
    embeddings: bool | SkipJsonSchema[None] = None
    image_generation: bool | SkipJsonSchema[None] = None

    @model_validator(mode="before")
    @classmethod
    def _reject_null_optional_fields(cls, value: Any) -> Any:
        return _reject_explicit_nulls(
            value,
            frozenset(
                {
                    "chat",
                    "responses",
                    "tools",
                    "vision",
                    "embeddings",
                    "image_generation",
                }
            ),
        )


class AiProviderModel(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True, strict=True)

    id: str = Field(min_length=1, max_length=300)
    label: str | SkipJsonSchema[None] = Field(default=None, min_length=1, max_length=300)
    alias: str | SkipJsonSchema[None] = Field(default=None, min_length=1, max_length=300)
    api_mode: ApiMode | SkipJsonSchema[None] = None
    input_modalities: list[InputModality] | SkipJsonSchema[None] = None
    supports_vision: bool | SkipJsonSchema[None] = None
    supports_tools: bool | SkipJsonSchema[None] = None
    supports_reasoning: bool | SkipJsonSchema[None] = None
    context_window: int | SkipJsonSchema[None] = Field(default=None, gt=0)
    max_tokens: int | SkipJsonSchema[None] = Field(default=None, gt=0)
    cost: AiProviderModelCost | SkipJsonSchema[None] = None
    capabilities: AiProviderModelCapabilities | SkipJsonSchema[None] = None

    @model_validator(mode="before")
    @classmethod
    def _reject_null_optional_fields(cls, value: Any) -> Any:
        return _reject_explicit_nulls(
            value,
            frozenset(
                {
                    "label",
                    "alias",
                    "api_mode",
                    "input_modalities",
                    "supports_vision",
                    "supports_tools",
                    "supports_reasoning",
                    "context_window",
                    "max_tokens",
                    "cost",
                    "capabilities",
                }
            ),
        )


class AiProviderBase(BaseModel):
    type: ProviderType
    label: str | None = Field(default=None, max_length=200)
    base_url: str = Field(min_length=1, max_length=1000)
    api_mode: ApiMode | None = None
    managed_by: Literal["user", "clawdi"] = "user"
    runtime_env_name: str | None = Field(default=None, max_length=128)
    capabilities: dict[str, Any] | None = None
    models: list[AiProviderModel] | None = None


class AiProviderUpsert(AiProviderBase):
    provider_id: str = Field(min_length=2, max_length=80, pattern=r"^[a-z][a-z0-9._-]{1,62}$")
    auth: AiProviderUpsertAuth

    @model_validator(mode="before")
    @classmethod
    def _reject_unsupported_oauth_profile(cls, value: Any) -> Any:
        return _reject_normal_upsert_oauth(value)


class AiProviderPatch(BaseModel):
    type: ProviderType | None = None
    label: str | None = Field(default=None, max_length=200)
    base_url: str | None = Field(default=None, min_length=1, max_length=1000)
    api_mode: ApiMode | None = None
    auth: AiProviderUpsertAuth | None = None
    managed_by: Literal["user", "clawdi"] | None = None
    runtime_env_name: str | None = Field(default=None, max_length=128)
    capabilities: dict[str, Any] | None = None
    models: list[AiProviderModel] | None = None

    @model_validator(mode="before")
    @classmethod
    def _reject_unsupported_oauth_profile(cls, value: Any) -> Any:
        return _reject_normal_upsert_oauth(value)


class AiProviderResponse(AiProviderBase):
    id: str
    provider_id: str
    scope: str
    auth: AiProviderAuth
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


class _AiProviderAuthImportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    payload: SecretStr
    profile: AuthProfile = "default"

    @model_validator(mode="before")
    @classmethod
    def _redact_payload_before_validation(cls, value: Any) -> Any:
        if isinstance(value, dict) and isinstance(value.get("payload"), str):
            sanitized = dict(value)
            sanitized["payload"] = SecretStr(value["payload"])
            return sanitized
        return value


class AiProviderAgentProfileAuthImportRequest(_AiProviderAuthImportRequest):
    type: Literal["agent_profile"]
    tool: AuthProfile


class AiProviderOAuthProfileAuthImportRequest(_AiProviderAuthImportRequest):
    type: Literal["oauth_profile"]
    provider: AuthProfile


class AiProviderAuthImportRequest(
    RootModel[
        Annotated[
            AiProviderAgentProfileAuthImportRequest | AiProviderOAuthProfileAuthImportRequest,
            Field(discriminator="type"),
        ]
    ]
):
    pass


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
