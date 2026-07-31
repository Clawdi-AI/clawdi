from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    RootModel,
    SecretStr,
    field_validator,
    model_validator,
)
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
CredentialMaterialState = Literal["available", "referenced", "not_required", "missing"]
VerificationState = Literal["not_tested", "verified", "failed"]
ConnectionErrorCategory = Literal[
    "validation",
    "credential",
    "ssrf",
    "dns",
    "timeout",
    "tls",
    "network",
    "authentication",
    "authorization",
    "rate_limit",
    "redirect",
    "endpoint",
    "protocol_model",
    "upstream",
]
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
    max_input_tokens: int | SkipJsonSchema[None] = Field(default=None, gt=0)
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
                    "max_input_tokens",
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


class AiProviderRuntimeCompatibility(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    openclaw: bool
    hermes: bool
    codex: bool


class AiProviderReadiness(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    credential_material: CredentialMaterialState
    runtime_compatibility: AiProviderRuntimeCompatibility
    deployable: bool
    endpoint_reachability: VerificationState = "not_tested"
    inference_verification: VerificationState = "not_tested"


class AiProviderConsumer(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    environment_id: UUID
    runtime: Literal["codex", "hermes", "openclaw"]


class AiProviderResponse(AiProviderBase):
    id: str
    provider_id: str
    scope: str
    auth: AiProviderAuth
    usable: bool = Field(
        description=(
            "Whether the provider has the credential material required for runtime use. "
            "This does not validate the credential or test endpoint connectivity."
        )
    )
    readiness: AiProviderReadiness | None = Field(
        default=None,
        description="Structured readiness dimensions used for Hosted runtime admission.",
    )
    consumer: AiProviderConsumer | None = Field(
        default=None,
        description=(
            "Non-secret hosted runtime claim for single-consumer credentials; omitted when "
            "the connection is unclaimed."
        ),
    )
    created_at: datetime
    updated_at: datetime


class AiProviderListResponse(BaseModel):
    providers: list[AiProviderResponse]


class AiProviderDeleteResponse(BaseModel):
    status: Literal["deleted"]
    provider_id: str
    remote_revoke_status: Literal["pending", "not_required"] = "not_required"


class AiProviderValidationResponse(BaseModel):
    valid: bool
    errors: list[str] = []
    warnings: list[str] = []


class AiProviderManagedApiKeyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    value: SecretStr
    runtime_env_name: str | None = Field(default=None, max_length=128)

    @field_validator("value")
    @classmethod
    def _reject_blank_value(cls, value: SecretStr) -> SecretStr:
        if not value.get_secret_value().strip():
            raise ValueError("credential cannot be blank")
        return value


class AiProviderApiKeyAcceptCredential(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    type: Literal["api_key"]
    value: SecretStr

    @field_validator("value")
    @classmethod
    def _reject_blank_value(cls, value: SecretStr) -> SecretStr:
        if not value.get_secret_value().strip():
            raise ValueError("credential cannot be blank")
        return value


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

    @field_validator("payload")
    @classmethod
    def _reject_blank_payload(cls, value: SecretStr) -> SecretStr:
        if not value.get_secret_value().strip():
            raise ValueError("credential payload cannot be blank")
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
    model_config = ConfigDict(extra="forbid")

    profile: str = Field(default="default", min_length=1, max_length=120)
    environment_id: UUID | None = None
    consumer_runtime: Literal["codex", "hermes", "openclaw"] | None = None

    @model_validator(mode="after")
    def _validate_consumer_identity(self) -> "AiProviderAuthResolveRequest":
        if (self.environment_id is None) != (self.consumer_runtime is None):
            raise ValueError("environment_id and consumer_runtime must be provided together")
        return self


class AiProviderAuthResolveResponse(BaseModel):
    provider_id: str
    auth_type: AuthType
    value: str | None = None
    payload: str | None = None
    tool: str | None = None
    provider: str | None = None
    profile: str | None = None
    credential_revision: str | None = None


class AiProviderOAuthStartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    provider: str = Field(min_length=1, max_length=80)
    redirect_uri: str | None = Field(default=None, max_length=1000)


class AiProviderOAuthAcceptCredential(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    type: Literal["oauth"]
    provider: str = Field(min_length=1, max_length=80)
    flow: Literal["device_code"] = "device_code"


class AiProviderAcceptRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    provider: AiProviderUpsert
    credential: Annotated[
        AiProviderApiKeyAcceptCredential | AiProviderOAuthAcceptCredential,
        Field(discriminator="type"),
    ]
    replace: bool = False


class AiProviderConnectionTestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    provider: AiProviderUpsert
    credential: AiProviderApiKeyAcceptCredential
    model: str | None = Field(default=None, min_length=1, max_length=300)


class AiProviderConnectionError(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    category: ConnectionErrorCategory
    code: str
    message: str
    retryable: bool


class AiProviderConnectionTestResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    ok: bool
    readiness: AiProviderReadiness
    error: AiProviderConnectionError | None = None


class AiProviderSavedConnectionTestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    model: str | None = Field(default=None, min_length=1, max_length=300)


class AiProviderOAuthStartResponse(BaseModel):
    flow: Literal["authorization_code"] = "authorization_code"
    flow_id: UUID
    provider_id: str
    oauth_provider: str
    profile: str
    auth_url: str
    state: str
    redirect_uri: str
    expires_at: datetime


class AiProviderOAuthDeviceStartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    provider: str = Field(min_length=1, max_length=80)


class AiProviderOAuthDeviceStartResponse(BaseModel):
    flow: Literal["device_code"] = "device_code"
    flow_id: UUID
    provider_id: str
    oauth_provider: str
    profile: str
    verification_url: str
    user_code: str
    state: str
    expires_at: datetime
    poll_interval_seconds: int = Field(ge=1, le=30)


class AiProviderReadyAcceptResponse(BaseModel):
    status: Literal["ready"]
    provider: AiProviderResponse


class AiProviderOAuthPendingAcceptResponse(BaseModel):
    status: Literal["pending"]
    provider: AiProviderResponse
    authorization: AiProviderOAuthDeviceStartResponse


type AiProviderAcceptResponse = Annotated[
    AiProviderReadyAcceptResponse | AiProviderOAuthPendingAcceptResponse,
    Field(discriminator="status"),
]


class AiProviderOAuthDevicePollRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    state: str = Field(min_length=1, max_length=8000)


class AiProviderOAuthDevicePendingResponse(BaseModel):
    status: Literal["pending"]
    retry_after_seconds: int = Field(ge=1, le=30)


class AiProviderOAuthDeviceReadyResponse(BaseModel):
    status: Literal["ready"]
    provider: AiProviderResponse


type AiProviderOAuthDevicePollResponse = Annotated[
    AiProviderOAuthDevicePendingResponse | AiProviderOAuthDeviceReadyResponse,
    Field(discriminator="status"),
]


class AiProviderOAuthCompleteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    state: str = Field(min_length=1, max_length=4000)
    code: str = Field(min_length=1, max_length=4000)
    redirect_uri: str | None = Field(default=None, max_length=1000)
