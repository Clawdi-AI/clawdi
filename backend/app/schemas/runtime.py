import re
from typing import Annotated, Literal
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator, model_validator

HostedRuntimeLanguage = Literal[
    "en",
    "zh-CN",
    "zh-TW",
    "ja",
    "ko",
    "es",
    "fr",
    "de",
    "pt",
]
HostedRuntimeName = Literal["openclaw", "hermes"]

_ENV_KEY_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_EGRESS_HEADER_NAME_PATTERN = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]+$")
_EGRESS_PROFILE_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-_.]*$")
_RUNTIME_SERVICE_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_SHA256_PATTERN = re.compile(r"^[0-9A-Fa-f]{64}$")
_SEMVER_CORE_IDENTIFIER = r"(?:0|[1-9][0-9]*)"
_SEMVER_PRERELEASE_IDENTIFIER = r"(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
_EXACT_SEMVER_PATTERN = re.compile(
    rf"^({_SEMVER_CORE_IDENTIFIER})\.({_SEMVER_CORE_IDENTIFIER})\."
    rf"({_SEMVER_CORE_IDENTIFIER})(?:-({_SEMVER_PRERELEASE_IDENTIFIER}"
    rf"(?:\.{_SEMVER_PRERELEASE_IDENTIFIER})*))?$"
)
_AGENT_V2_MANIFEST_MINIMUM_CLI_VERSION = "0.12.10-beta.57"
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
_UNMANAGED_PROVIDER_ENV_NAMES = {"CLAWDI_MANAGED_OPENAI_API_KEY", "OPENAI_API_KEY"}
_MANAGED_EGRESS_PLACEHOLDER_VALUE = "clawdi-egress-placeholder"


def validate_no_plaintext_tool_secrets(value: object, path: str = "") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = str(key).replace("-", "_").lower()
            if normalized in _FORBIDDEN_TOOL_SECRET_KEYS:
                location = f" at {path}.{key}" if path else f" at {key}"
                raise ValueError(
                    f"mcp/tools desired state must not contain plaintext secrets{location}"
                )
            validate_no_plaintext_tool_secrets(
                child,
                f"{path}.{key}" if path else str(key),
            )
    elif isinstance(value, list):
        for index, child in enumerate(value):
            validate_no_plaintext_tool_secrets(child, f"{path}[{index}]")


def _parse_exact_semver(value: str) -> tuple[int, int, int, tuple[str, ...]] | None:
    match = _EXACT_SEMVER_PATTERN.fullmatch(value)
    if match is None:
        return None
    major, minor, patch, prerelease = match.groups()
    return (
        int(major),
        int(minor),
        int(patch),
        tuple(prerelease.split(".")) if prerelease else (),
    )


def _compare_exact_semver(left: str, right: str) -> int:
    parsed_left = _parse_exact_semver(left)
    parsed_right = _parse_exact_semver(right)
    if parsed_left is None or parsed_right is None:
        raise ValueError("invalid exact semver comparison")
    for left_part, right_part in zip(parsed_left[:3], parsed_right[:3], strict=True):
        if left_part != right_part:
            return -1 if left_part < right_part else 1
    left_prerelease = parsed_left[3]
    right_prerelease = parsed_right[3]
    if not left_prerelease and not right_prerelease:
        return 0
    if not left_prerelease:
        return 1
    if not right_prerelease:
        return -1
    for index in range(max(len(left_prerelease), len(right_prerelease))):
        if index >= len(left_prerelease):
            return -1
        if index >= len(right_prerelease):
            return 1
        left_identifier = left_prerelease[index]
        right_identifier = right_prerelease[index]
        if left_identifier == right_identifier:
            continue
        left_numeric = re.fullmatch(r"0|[1-9][0-9]*", left_identifier)
        right_numeric = re.fullmatch(r"0|[1-9][0-9]*", right_identifier)
        if left_numeric is not None and right_numeric is not None:
            return -1 if int(left_identifier) < int(right_identifier) else 1
        if left_numeric is not None:
            return -1
        if right_numeric is not None:
            return 1
        return -1 if left_identifier < right_identifier else 1
    return 0


def validate_clawdi_cli_package_spec(value: object) -> str:
    if not isinstance(value, str) or not value.startswith("clawdi@"):
        raise ValueError("cli_package_spec must be clawdi@<exact-semver> without build metadata")
    version = value.removeprefix("clawdi@")
    if _parse_exact_semver(version) is None:
        raise ValueError("cli_package_spec must be clawdi@<exact-semver> without build metadata")
    if _compare_exact_semver(version, _AGENT_V2_MANIFEST_MINIMUM_CLI_VERSION) < 0:
        raise ValueError(
            f"cli_package_spec minimum is clawdi@{_AGENT_V2_MANIFEST_MINIMUM_CLI_VERSION}"
        )
    return value


def _validate_http_origin(value: str) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("must be an HTTP(S) URL origin") from exc
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("must be an HTTP(S) URL origin")
    host = parsed.hostname
    if ":" in host:
        host = f"[{host}]"
    default_port = 80 if parsed.scheme == "http" else 443
    canonical = f"{parsed.scheme}://{host}"
    if port is not None and port != default_port:
        canonical = f"{canonical}:{port}"
    if value != canonical:
        raise ValueError("must be an HTTP(S) URL origin")
    return value


def _validate_absolute_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
        parsed.port
    except ValueError as exc:
        raise ValueError("must be an absolute URL") from exc
    if not parsed.scheme or not parsed.netloc:
        raise ValueError("must be an absolute URL")
    return value


def _is_safe_egress_host(host: str) -> bool:
    if not host or len(host) > 253 or host.startswith(".") or host.endswith("."):
        return False
    return not any(char in "@?#/\\ %" or ord(char) < 0x20 or ord(char) == 0x7F for char in host)


def _validate_hosted_egress_engine_url(value: str) -> str:
    _validate_absolute_url(value)
    parsed = urlsplit(value)
    if parsed.scheme != "https":
        raise ValueError("Hosted egress engine URL must use https")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Hosted egress engine URL must not include credentials")
    if parsed.hostname is None or not _is_safe_egress_host(parsed.hostname.lower()):
        raise ValueError("Hosted egress engine URL must use a safe hostname")
    return value


class _StrictHostedWireModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    @model_validator(mode="before")
    @classmethod
    def _reject_explicit_null_fields(cls, value: object) -> object:
        if isinstance(value, dict):
            null_fields = sorted(key for key, field_value in value.items() if field_value is None)
            if null_fields:
                raise ValueError(f"explicit null is not supported for: {', '.join(null_fields)}")
        return value


class HostedEgressEngine(_StrictHostedWireModel):
    type: Literal["mitmproxy"]
    version: str = Field(min_length=1)
    url: str = Field(min_length=1)
    sha256: str = Field(pattern=_SHA256_PATTERN.pattern)

    @field_validator("url")
    @classmethod
    def _validate_url(cls, value: str) -> str:
        return _validate_hosted_egress_engine_url(value)


class HostedEgressHeaderExistsMatcher(_StrictHostedWireModel):
    type: Literal["exists"]


class HostedEgressHeaderEqualsMatcher(_StrictHostedWireModel):
    type: Literal["equals"]
    value: str
    prefix: str | None = None


class HostedEgressHeaderSecretRefEqualsMatcher(_StrictHostedWireModel):
    type: Literal["secretRefEquals"]
    secretRef: str = Field(min_length=1, pattern=r"^secret://")
    prefix: str | None = None


HostedEgressHeaderMatcher = Annotated[
    HostedEgressHeaderExistsMatcher
    | HostedEgressHeaderEqualsMatcher
    | HostedEgressHeaderSecretRefEqualsMatcher,
    Field(discriminator="type"),
]


class HostedEgressPathEqualsMatcher(_StrictHostedWireModel):
    type: Literal["equals"]
    value: str = Field(min_length=1)


class HostedEgressPathPrefixMatcher(_StrictHostedWireModel):
    type: Literal["prefix"]
    value: str = Field(min_length=1)


class HostedEgressPathSecretRefMatcher(_StrictHostedWireModel):
    type: Literal["secretRefEquals", "secretRefPrefix"]
    secretRef: str = Field(min_length=1, pattern=r"^secret://")
    prefix: str | None = None
    suffix: str | None = None


HostedEgressPathMatcher = Annotated[
    HostedEgressPathEqualsMatcher
    | HostedEgressPathPrefixMatcher
    | HostedEgressPathSecretRefMatcher,
    Field(discriminator="type"),
]


class HostedEgressHeaderSecretRefSetter(_StrictHostedWireModel):
    type: Literal["secretRef"]
    secretRef: str = Field(min_length=1, pattern=r"^secret://")
    prefix: str | None = None


class HostedEgressPathReplace(_StrictHostedWireModel):
    type: Literal["secretRefPrefix"]
    secretRef: str = Field(min_length=1, pattern=r"^secret://")
    replacementSecretRef: str = Field(min_length=1, pattern=r"^secret://")
    prefix: str | None = None
    suffix: str | None = None


def _validate_egress_header_names(
    value: dict[str, object] | None,
) -> dict[str, object] | None:
    if value is not None and any(
        _EGRESS_HEADER_NAME_PATTERN.fullmatch(name) is None for name in value
    ):
        raise ValueError("egress header names must be canonical")
    return value


class HostedEgressProfileMatch(_StrictHostedWireModel):
    scheme: Literal["http", "https", "ws", "wss"] | None = None
    host: str = Field(min_length=1)
    pathPrefix: str | None = Field(default=None, min_length=1)
    path: HostedEgressPathMatcher | None = None
    headers: dict[str, HostedEgressHeaderMatcher] | None = None
    query: dict[str, HostedEgressHeaderMatcher] | None = None

    @field_validator("pathPrefix")
    @classmethod
    def _validate_path_prefix(cls, value: str | None) -> str | None:
        if value is not None and not value.startswith("/"):
            raise ValueError("pathPrefix must start with /")
        return value

    @field_validator("headers")
    @classmethod
    def _validate_headers(
        cls,
        value: dict[str, HostedEgressHeaderMatcher] | None,
    ) -> dict[str, HostedEgressHeaderMatcher] | None:
        _validate_egress_header_names(value)
        return value

    @field_validator("query")
    @classmethod
    def _validate_query_names(
        cls,
        value: dict[str, HostedEgressHeaderMatcher] | None,
    ) -> dict[str, HostedEgressHeaderMatcher] | None:
        if value is not None and any(not name for name in value):
            raise ValueError("egress query names must be non-empty")
        return value


class HostedEgressProfileRewrite(_StrictHostedWireModel):
    upstreamBaseUrl: str | None = Field(default=None, min_length=1)
    preservePath: bool | None = None
    pathReplace: HostedEgressPathReplace | None = None
    setHeaders: dict[str, str | HostedEgressHeaderSecretRefSetter] | None = None

    @field_validator("upstreamBaseUrl")
    @classmethod
    def _validate_upstream_base_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        _validate_absolute_url(value)
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https", "ws", "wss"}:
            raise ValueError("upstreamBaseUrl must use http, https, ws, or wss")
        if parsed.username is not None or parsed.password is not None:
            raise ValueError("upstreamBaseUrl must not include credentials")
        if parsed.hostname is None or not _is_safe_egress_host(parsed.hostname.lower()):
            raise ValueError("upstreamBaseUrl must use a safe host")
        return value

    @field_validator("setHeaders")
    @classmethod
    def _validate_set_headers(
        cls,
        value: dict[str, str | HostedEgressHeaderSecretRefSetter] | None,
    ) -> dict[str, str | HostedEgressHeaderSecretRefSetter] | None:
        _validate_egress_header_names(value)
        return value


class HostedEgressProfileLogging(_StrictHostedWireModel):
    redactHeaders: list[str] | None = None
    redactUrlPatterns: list[str] | None = None

    @field_validator("redactHeaders")
    @classmethod
    def _validate_redact_headers(cls, value: list[str] | None) -> list[str] | None:
        if value is not None and any(
            _EGRESS_HEADER_NAME_PATTERN.fullmatch(name) is None for name in value
        ):
            raise ValueError("redactHeaders must contain canonical header names")
        return value

    @field_validator("redactUrlPatterns")
    @classmethod
    def _validate_redact_url_patterns(cls, value: list[str] | None) -> list[str] | None:
        if value is not None and any(not pattern for pattern in value):
            raise ValueError("redactUrlPatterns must contain non-empty strings")
        return value


class HostedEgressProfile(_StrictHostedWireModel):
    id: str = Field(min_length=1, pattern=_EGRESS_PROFILE_ID_PATTERN.pattern)
    enabled: bool | None = None
    kind: Literal["http", "websocket", "provider", "passthrough", "deny"]
    match: HostedEgressProfileMatch
    rewrite: HostedEgressProfileRewrite | None = None
    logging: HostedEgressProfileLogging | None = None
    priority: int | None = None
    owner: str | None = Field(default=None, min_length=1)
    description: str | None = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def _validate_rewrite(self) -> "HostedEgressProfile":
        if self.kind in {"http", "websocket"} and (
            self.rewrite is None or self.rewrite.upstreamBaseUrl is None
        ):
            raise ValueError(f"{self.kind} profiles require rewrite.upstreamBaseUrl")
        if self.kind in {"deny", "passthrough"} and self.rewrite is not None:
            raise ValueError(f"{self.kind} profiles must not include rewrite rules")
        return self


class HostedEgressProfiles(_StrictHostedWireModel):
    profiles: list[HostedEgressProfile] | None = None


class HostedHermesDashboardActivation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: Literal[True]
    capability: Literal["hermes-basic-auth-v1"]


class HostedHermesDashboardAuth(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["password"]
    provider: Literal["basic"]
    username: str = Field(min_length=1, max_length=128)
    passwordSecretRef: Literal["env://HERMES_DASHBOARD_BASIC_AUTH_PASSWORD"]
    sessionSecretRef: Literal["env://HERMES_DASHBOARD_BASIC_AUTH_SECRET"]
    sessionTtlSeconds: int = Field(default=43_200, ge=60, le=604_800)
    publicUrl: str = Field(min_length=1)
    activation: HostedHermesDashboardActivation

    @field_validator("publicUrl")
    @classmethod
    def _validate_https_url(cls, value: str) -> str:
        try:
            parsed = urlsplit(value)
            parsed.port
        except ValueError as exc:
            raise ValueError("must be an HTTPS URL") from exc
        if (
            parsed.scheme != "https"
            or parsed.hostname is None
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("must be an HTTPS URL without credentials, query, or fragment")
        return value


class HostedOpenClawGatewayActivation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: Literal[True]
    capability: Literal["openclaw-native-auth-v1"]


class HostedOpenClawGatewayAuth(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["token"]
    tokenRef: Literal["env://OPENCLAW_GATEWAY_TOKEN"]
    deviceAuthRequired: Literal[True]
    activation: HostedOpenClawGatewayActivation


class HostedRuntimeSystem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    openclawControlUiAllowedOrigins: list[str] | None = None
    openclawControlUiBasePath: str | None = None
    openclawGatewayAuth: HostedOpenClawGatewayAuth | None = None
    hermesDashboardAuth: HostedHermesDashboardAuth | None = None

    @field_validator("openclawControlUiAllowedOrigins")
    @classmethod
    def _validate_allowed_origins(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        return [_validate_http_origin(origin) for origin in value]

    @field_validator("openclawControlUiBasePath")
    @classmethod
    def _validate_base_path(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not re.fullmatch(r"/(?:[^/?#]+(?:/[^/?#]+)*)?", value):
            raise ValueError("must be an absolute URL path without query or fragment")
        return value


class HostedRuntimeInstall(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: Literal["official"]


class HostedRuntimeRunSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    command: str | None = Field(default=None, min_length=1)
    args: list[str] | None = None
    env: dict[str, str] | None = None
    secretEnv: dict[str, str] | None = None
    cwd: str | None = Field(default=None, min_length=1)
    prependPath: list[str] | None = None

    @field_validator("args")
    @classmethod
    def _validate_args(cls, value: list[str] | None) -> list[str] | None:
        if value is not None and any(not arg for arg in value):
            raise ValueError("run args must contain non-empty strings")
        return value

    @field_validator("env", "secretEnv")
    @classmethod
    def _validate_env_keys(cls, value: dict[str, str] | None) -> dict[str, str] | None:
        if value is None:
            return None
        if any(_ENV_KEY_PATTERN.fullmatch(key) is None for key in value):
            raise ValueError("environment variable names must be canonical")
        return value

    @field_validator("secretEnv")
    @classmethod
    def _validate_secret_env_values(
        cls,
        value: dict[str, str] | None,
    ) -> dict[str, str] | None:
        if value is not None and any(not secret_ref for secret_ref in value.values()):
            raise ValueError("secretEnv values must be non-empty strings")
        return value

    @field_validator("prependPath")
    @classmethod
    def _validate_prepend_path(cls, value: list[str] | None) -> list[str] | None:
        if value is not None and any(not path for path in value):
            raise ValueError("prependPath values must be non-empty strings")
        return value


class HostedRuntimePrimaryModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider_id: str = Field(min_length=1, max_length=80)
    model: str = Field(min_length=1, max_length=300)

    @field_validator("provider_id", "model")
    @classmethod
    def _validate_canonical_values(cls, value: str) -> str:
        if value != value.strip():
            raise ValueError("primary_model values must not contain surrounding whitespace")
        return value


class HostedCodexTool(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: Literal[True]
    provider_id: str = Field(min_length=1, max_length=80)
    primary_model: HostedRuntimePrimaryModel

    @model_validator(mode="after")
    def _validate_primary_model_provider(self) -> "HostedCodexTool":
        if self.primary_model.provider_id != self.provider_id:
            raise ValueError("Codex tool primary_model.provider_id must match provider_id")
        return self


class HostedCodexProviderProjection(BaseModel):
    """Typed Cloud-owned provider projection for the fixed Hosted Codex tool."""

    model_config = ConfigDict(extra="allow")

    kind: Literal["openai-compatible"]
    baseUrl: str = Field(min_length=1, max_length=1000)
    apiMode: Literal["openai_responses"]
    managed_by: Literal["clawdi"]
    runtimeEnvName: Literal["OPENAI_API_KEY"]
    apiKeySecretRef: Literal["tool.codex.apiKey"]


class HostedRuntimeTools(BaseModel):
    model_config = ConfigDict(extra="allow")

    codex: HostedCodexTool

    @model_validator(mode="before")
    @classmethod
    def _validate_no_plaintext_secrets(cls, value: object) -> object:
        validate_no_plaintext_tool_secrets(value)
        return value


class _HostedRuntimeDesiredStateBase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: Literal[True]
    install: HostedRuntimeInstall
    run: HostedRuntimeRunSettings | None = None
    services: dict[str, HostedRuntimeRunSettings] | None = None

    @field_validator("services")
    @classmethod
    def _validate_service_names(
        cls,
        value: dict[str, HostedRuntimeRunSettings] | None,
    ) -> dict[str, HostedRuntimeRunSettings] | None:
        if value is None:
            return None
        if any(
            service == "main" or _RUNTIME_SERVICE_NAME_PATTERN.fullmatch(service) is None
            for service in value
        ):
            raise ValueError("runtime service names must be canonical")
        return value


def _validate_runtime_provider_ids(value: list[str]) -> list[str]:
    if any(
        not provider_id or provider_id != provider_id.strip() or len(provider_id) > 80
        for provider_id in value
    ):
        raise ValueError(
            "provider_ids must contain canonical non-empty strings up to 80 characters"
        )
    if len(set(value)) != len(value):
        raise ValueError("provider_ids must not contain duplicates")
    return value


class HostedRuntimeConfiguredDesiredState(_HostedRuntimeDesiredStateBase):
    providerMode: Literal["configured"]
    provider_ids: list[str] = Field(min_length=1)
    primary_model: HostedRuntimePrimaryModel

    @field_validator("provider_ids")
    @classmethod
    def _validate_provider_ids(cls, value: list[str]) -> list[str]:
        return _validate_runtime_provider_ids(value)

    @model_validator(mode="after")
    def _validate_primary_model_provider(self) -> "HostedRuntimeConfiguredDesiredState":
        if self.primary_model.provider_id not in self.provider_ids:
            raise ValueError("primary_model.provider_id must be present in provider_ids")
        return self


class HostedRuntimeUnmanagedDesiredState(_HostedRuntimeDesiredStateBase):
    providerMode: Literal["unmanaged"]
    provider_ids: list[str] = Field(max_length=0)

    @model_validator(mode="after")
    def _validate_no_runtime_provider_inputs(self) -> "HostedRuntimeUnmanagedDesiredState":
        settings = [("run", self.run)]
        settings.extend(
            (f"services.{name}", service) for name, service in (self.services or {}).items()
        )
        for location, run_settings in settings:
            if run_settings is None:
                continue
            env = run_settings.env or {}
            secret_env = run_settings.secretEnv or {}
            forbidden_names = sorted(
                _UNMANAGED_PROVIDER_ENV_NAMES.intersection({*env, *secret_env})
            )
            if forbidden_names:
                raise ValueError(
                    f"unmanaged {location} must not include provider env: "
                    f"{', '.join(forbidden_names)}"
                )
            if any(value == _MANAGED_EGRESS_PLACEHOLDER_VALUE for value in env.values()):
                raise ValueError(f"unmanaged {location} must not include provider placeholder env")
            for secret_ref in (*env.values(), *secret_env.values()):
                normalized = secret_ref.removeprefix("secret://")
                if normalized.startswith("provider."):
                    raise ValueError(f"unmanaged {location} must not include provider secret refs")
        return self


HostedRuntimeDesiredState = Annotated[
    HostedRuntimeConfiguredDesiredState | HostedRuntimeUnmanagedDesiredState,
    Field(discriminator="providerMode"),
]
_HOSTED_RUNTIME_DESIRED_STATE_ADAPTER = TypeAdapter(HostedRuntimeDesiredState)


def validate_hosted_runtime_desired_state(value: object) -> HostedRuntimeDesiredState:
    return _HOSTED_RUNTIME_DESIRED_STATE_ADAPTER.validate_python(value)


class HostedRuntimeLocale(BaseModel):
    model_config = ConfigDict(extra="forbid")

    language: HostedRuntimeLanguage
    timezone: str = Field(min_length=1, max_length=255)

    @field_validator("timezone")
    @classmethod
    def _validate_timezone(cls, value: str) -> str:
        if value != value.strip():
            raise ValueError("timezone must not contain surrounding whitespace")
        try:
            ZoneInfo(value)
        except (ValueError, ZoneInfoNotFoundError) as exc:
            raise ValueError("timezone must be a valid IANA timezone") from exc
        return value


class HostedRuntimeLiveSyncAgent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    agentType: Literal["openclaw", "hermes", "codex"]
    environmentId: str = Field(min_length=1, max_length=200)

    @field_validator("environmentId")
    @classmethod
    def _validate_environment_id(cls, value: str) -> str:
        if value != value.strip():
            raise ValueError("environmentId must not contain surrounding whitespace")
        return value


class HostedRuntimeLiveSync(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool
    agents: list[HostedRuntimeLiveSyncAgent]

    @model_validator(mode="after")
    def _validate_agents(self) -> "HostedRuntimeLiveSync":
        identities = [(agent.agentType, agent.environmentId) for agent in self.agents]
        if len(set(identities)) != len(identities):
            raise ValueError("live_sync agents must not contain duplicates")
        if self.enabled != bool(self.agents):
            raise ValueError("live_sync.enabled must match whether agents are configured")
        return self


class HostedRuntimeRecovery(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cacheManifest: bool
    allowOfflineBoot: bool
