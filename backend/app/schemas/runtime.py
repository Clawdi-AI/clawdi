import re
from collections.abc import Mapping
from typing import Annotated, Literal, TypeGuard
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    SecretStr,
    TypeAdapter,
    field_validator,
    model_validator,
)

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

FILE_BROWSER_VERSION = "v1.5.0-stable"
FILE_BROWSER_COMMIT = "79552f8adb27c3e29934c4001660eb98f4aab5d6"
FILE_BROWSER_AMD64_SHA256 = "8d51d1718d576d22e73e1f41a5194b451d152ddab0df97697cabe839cf59524e"
FILE_BROWSER_ARM64_SHA256 = "3e18838ae33750a25da434dc6156a359968bf7935e01bdd884711f47f08ad92f"


class ProjectSkillCapabilityReport(BaseModel):
    """Current Connected Agent observation, separate from deployment generations."""

    model_config = ConfigDict(extra="forbid", strict=True)

    project_skill_reconcile_version: Literal[1]


_ENV_KEY_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_EGRESS_HEADER_NAME_PATTERN = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]+$")
_EGRESS_PROFILE_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-_.]*$")
_RUNTIME_SERVICE_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_MANAGED_ENTRY_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_AGENT_PLUGIN_NAME_PATTERN = re.compile(r"^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$")
_AGENT_PLUGIN_SECRET_SLOT_ID_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
_SECRET_REF_PATTERN = re.compile(r"^secret://\S+$")
_SHA256_PATTERN = re.compile(r"^[0-9A-Fa-f]{64}$")
_GIT_COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
_GITHUB_REPOSITORY_PATH_PATTERN = re.compile(r"^/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_SEMVER_CORE_IDENTIFIER = r"(?:0|[1-9][0-9]*)"
_SEMVER_PRERELEASE_IDENTIFIER = r"(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
_EXACT_SEMVER_PATTERN = re.compile(
    rf"^({_SEMVER_CORE_IDENTIFIER})\.({_SEMVER_CORE_IDENTIFIER})\."
    rf"({_SEMVER_CORE_IDENTIFIER})(?:-({_SEMVER_PRERELEASE_IDENTIFIER}"
    rf"(?:\.{_SEMVER_PRERELEASE_IDENTIFIER})*))?$"
)
_AGENT_PLUGIN_EXACT_SEMVER_PATTERN = re.compile(
    rf"^{_SEMVER_CORE_IDENTIFIER}\.{_SEMVER_CORE_IDENTIFIER}\."
    rf"{_SEMVER_CORE_IDENTIFIER}(?:-{_SEMVER_PRERELEASE_IDENTIFIER}"
    rf"(?:\.{_SEMVER_PRERELEASE_IDENTIFIER})*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
AGENT_PLUGINS_SCHEMA_1_0_0 = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
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
_UNMANAGED_PROVIDER_ENV_NAMES = {"CLAWDI_AI_API_KEY", "OPENAI_API_KEY"}
_MANAGED_EGRESS_PLACEHOLDER_VALUE = "clawdi-egress-placeholder"

HostedRuntimeSecretValues = dict[str, SecretStr]
_HOSTED_RUNTIME_SECRET_VALUE_LIMIT = 128
_HOSTED_RUNTIME_SECRET_TOTAL_PLAINTEXT_LIMIT = 262_144


class HostedFileBrowserAsset(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class HostedFileBrowserAssets(BaseModel):
    model_config = ConfigDict(extra="forbid")

    amd64: HostedFileBrowserAsset
    arm64: HostedFileBrowserAsset

    @model_validator(mode="after")
    def validate_pins(self) -> "HostedFileBrowserAssets":
        release = (
            f"https://github.com/gtsteffaniak/filebrowser/releases/download/{FILE_BROWSER_VERSION}"
        )
        expected = {
            "amd64": (f"{release}/linux-amd64-filebrowser", FILE_BROWSER_AMD64_SHA256),
            "arm64": (f"{release}/linux-arm64-filebrowser", FILE_BROWSER_ARM64_SHA256),
        }
        for arch, asset in (("amd64", self.amd64), ("arm64", self.arm64)):
            url, digest = expected[arch]
            if asset.url != url or asset.sha256 != digest:
                raise ValueError(f"Files {arch} artifact must match the pinned release")
        return self


class HostedFileBrowserAuth(BaseModel):
    model_config = ConfigDict(extra="forbid")

    method: Literal["jwt"]
    algorithm: Literal["HS256"]
    header: Literal["X-JWT-Assertion"]
    userIdentifier: Literal["sub"]
    groupsClaim: Literal["groups"]
    secret: str = Field(min_length=43, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    audience: str = Field(min_length=1, max_length=256)
    subject: str = Field(min_length=1, max_length=256)
    requiredGroup: str = Field(min_length=1, max_length=256)
    accessRevision: str = Field(pattern=r"^[0-9a-f]{64}$")

    @model_validator(mode="after")
    def validate_deployment_binding(self) -> "HostedFileBrowserAuth":
        audience_prefix = "clawdi-files:"
        deployment_id = self.audience.removeprefix(audience_prefix)
        if (
            not deployment_id
            or self.audience != f"{audience_prefix}{deployment_id}"
            or self.subject != f"deployment:{deployment_id}:owner"
            or self.requiredGroup != f"{self.audience}:{self.accessRevision}"
        ):
            raise ValueError("Files authentication fields must reference one deployment revision")
        return self


class HostedFileBrowserCompanion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: Literal["v1.5.0-stable"]
    commit: Literal["79552f8adb27c3e29934c4001660eb98f4aab5d6"]
    listen: Literal["0.0.0.0"]
    port: Literal[9120]
    baseURL: Literal["/"]
    healthPath: Literal["/health"]
    sourceRoot: Literal["/home/clawdi"]
    assets: HostedFileBrowserAssets
    auth: HostedFileBrowserAuth


class HostedRuntimeCompanions(BaseModel):
    model_config = ConfigDict(extra="forbid")

    filebrowser: HostedFileBrowserCompanion | None = None


def is_canonical_secret_ref(value: str) -> bool:
    return value == value.strip() and _SECRET_REF_PATTERN.fullmatch(value) is not None


def validate_hosted_runtime_secret_values(
    value: HostedRuntimeSecretValues,
) -> HostedRuntimeSecretValues:
    if len(value) > _HOSTED_RUNTIME_SECRET_VALUE_LIMIT:
        raise ValueError("secretValues must contain at most 128 entries")
    total_plaintext_size = 0
    for secret_ref, secret in value.items():
        if len(secret_ref) > 1000 or not is_canonical_secret_ref(secret_ref):
            raise ValueError("secretValues keys must be canonical secret:// references")
        plaintext = secret.get_secret_value()
        if not plaintext or len(plaintext) > 65_536:
            raise ValueError("secretValues values must be non-empty and at most 65536 characters")
        if any(ord(character) <= 0x1F or ord(character) == 0x7F for character in plaintext):
            raise ValueError("secretValues values must not contain control characters")
        total_plaintext_size += len(plaintext.encode("utf-8"))
        if total_plaintext_size > _HOSTED_RUNTIME_SECRET_TOTAL_PLAINTEXT_LIMIT:
            raise ValueError("secretValues plaintext must total at most 262144 bytes")
    return value


def validate_no_plaintext_tool_secrets(value: object, path: str = "") -> None:
    if _is_object_dict(value):
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
    elif _is_object_list(value):
        for index, child in enumerate(value):
            validate_no_plaintext_tool_secrets(child, f"{path}[{index}]")


def _is_object_dict(value: object) -> TypeGuard[dict[object, object]]:
    return isinstance(value, dict)


def _is_object_list(value: object) -> TypeGuard[list[object]]:
    return isinstance(value, list)


def _is_string_object_dict(value: object) -> TypeGuard[dict[str, object]]:
    return _is_object_dict(value) and all(isinstance(key, str) for key in value)


def parse_exact_semver(value: str) -> tuple[int, int, int, tuple[str, ...]] | None:
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


def validate_clawdi_cli_package_spec(value: object) -> str:
    if not isinstance(value, str) or not value.startswith("clawdi@"):
        raise ValueError("cli_package_spec must be clawdi@<exact-semver> without build metadata")
    version = value.removeprefix("clawdi@")
    if parse_exact_semver(version) is None:
        raise ValueError("cli_package_spec must be clawdi@<exact-semver> without build metadata")
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
        if _is_string_object_dict(value):
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
    secretRef: str = Field(min_length=1, pattern=_SECRET_REF_PATTERN.pattern)
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
    secretRef: str = Field(min_length=1, pattern=_SECRET_REF_PATTERN.pattern)
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
    secretRef: str = Field(min_length=1, pattern=_SECRET_REF_PATTERN.pattern)
    prefix: str | None = None


class HostedEgressPathReplace(_StrictHostedWireModel):
    type: Literal["secretRefPrefix"]
    secretRef: str = Field(min_length=1, pattern=_SECRET_REF_PATTERN.pattern)
    replacementSecretRef: str = Field(min_length=1, pattern=_SECRET_REF_PATTERN.pattern)
    prefix: str | None = None
    suffix: str | None = None


def _validate_egress_header_names(
    value: Mapping[str, object] | None,
) -> None:
    if value is not None and any(
        _EGRESS_HEADER_NAME_PATTERN.fullmatch(name) is None for name in value
    ):
        raise ValueError("egress header names must be canonical")


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
    passwordSecretRef: Literal["secret://runtime/hermes/dashboard-password"]
    sessionSecretRef: Literal["secret://runtime/hermes/dashboard-session-secret"]
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
    tokenRef: Literal["secret://runtime/openclaw/gateway-token"]
    deviceAuthRequired: Literal[False]
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

    model_config = ConfigDict(extra="forbid")

    kind: Literal["openai-compatible"]
    type: str = Field(min_length=1, max_length=100)
    baseUrl: str = Field(min_length=1, max_length=1000)
    apiMode: Literal["openai_responses"]
    managed_by: Literal["clawdi"]
    runtimeEnvName: Literal["OPENAI_API_KEY", "CLAWDI_AI_API_KEY"]
    apiKeySecretRef: Literal["secret://tool.codex.apiKey"]


class HostedRuntimeTools(BaseModel):
    model_config = ConfigDict(extra="allow")

    codex: HostedCodexTool

    @model_validator(mode="before")
    @classmethod
    def _validate_no_plaintext_secrets(cls, value: object) -> object:
        validate_no_plaintext_tool_secrets(value)
        return value


class HostedRuntimeStdioMcpServer(_StrictHostedWireModel):
    command: str = Field(min_length=1, max_length=200)
    args: list[str] = Field(max_length=32)

    @field_validator("command")
    @classmethod
    def _validate_command(cls, value: str) -> str:
        if value != value.strip():
            raise ValueError("MCP server command must not contain surrounding whitespace")
        return value

    @field_validator("args")
    @classmethod
    def _validate_args(cls, value: list[str]) -> list[str]:
        if any(not arg or arg != arg.strip() for arg in value):
            raise ValueError("MCP server args must be non-empty canonical strings")
        return value


class HostedRuntimeMcpSecretHeader(_StrictHostedWireModel):
    secretRef: str = Field(min_length=1, pattern=_SECRET_REF_PATTERN.pattern)
    prefix: str = Field(default="", max_length=100)


def _is_mcp_credential_header(name: str) -> bool:
    normalized = name.lower()
    if normalized in {"authorization", "proxy-authorization", "cookie"}:
        return True
    return (
        re.search(
            r"(?:^|[-_])(?:api[-_]?key|apikey|tokens?|secrets?|credentials?)(?:$|[-_])",
            normalized,
        )
        is not None
    )


class HostedRuntimeRemoteMcpServer(_StrictHostedWireModel):
    url: str = Field(min_length=1, max_length=2000)
    transport: Literal["streamable-http", "sse"]
    headers: dict[str, str | HostedRuntimeMcpSecretHeader] = Field(default_factory=dict)

    @field_validator("url")
    @classmethod
    def _validate_url(cls, value: str) -> str:
        parsed = urlsplit(value)
        if (
            parsed.scheme not in {"http", "https"}
            or parsed.hostname is None
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError(
                "remote MCP URL must be HTTP(S) without credentials, query, or fragment"
            )
        return value

    @field_validator("headers")
    @classmethod
    def _validate_headers(
        cls, value: dict[str, str | HostedRuntimeMcpSecretHeader]
    ) -> dict[str, str | HostedRuntimeMcpSecretHeader]:
        if any(_EGRESS_HEADER_NAME_PATTERN.fullmatch(name) is None for name in value):
            raise ValueError("MCP header names must be canonical")
        normalized = [name.lower() for name in value]
        if len(normalized) != len(set(normalized)):
            raise ValueError("MCP header names must be unique case-insensitively")
        if any(
            isinstance(header_value, str) and _is_mcp_credential_header(name)
            for name, header_value in value.items()
        ):
            raise ValueError("credential-bearing MCP headers must use secretRef")
        return value


HostedRuntimeMcpServer = HostedRuntimeStdioMcpServer | HostedRuntimeRemoteMcpServer


class HostedRuntimeMcp(_StrictHostedWireModel):
    servers: dict[str, HostedRuntimeMcpServer]

    @field_validator("servers")
    @classmethod
    def _validate_server_names(
        cls, value: dict[str, HostedRuntimeMcpServer]
    ) -> dict[str, HostedRuntimeMcpServer]:
        if any(_MANAGED_ENTRY_NAME_PATTERN.fullmatch(name) is None for name in value):
            raise ValueError("MCP server names must be canonical")
        return value


class PersistedHostedRuntimeMcp(HostedRuntimeMcp):
    """Strict reader for the canonical MCP document stored in runtime state.

    Dashboard projections must parse this model and deliberately copy only
    non-sensitive inventory fields. Returning the persisted document itself
    would expose remote URLs, headers, secret references, or stdio commands.
    """


def validate_hosted_runtime_mcp_desired_state(
    value: dict[str, JsonValue] | None,
) -> dict[str, JsonValue] | None:
    if value is None:
        return None
    HostedRuntimeMcp.model_validate(value)
    return value


class HostedRuntimeSkillSource(_StrictHostedWireModel):
    type: Literal["github"]
    url: str = Field(max_length=500)
    path: str = Field(max_length=500)
    commit: str = Field(pattern=_GIT_COMMIT_PATTERN.pattern)

    @field_validator("url")
    @classmethod
    def _validate_url(cls, value: str) -> str:
        try:
            parsed = urlsplit(value)
            parsed.port
        except ValueError as exc:
            raise ValueError("must be a canonical GitHub repository URL") from exc
        if (
            parsed.scheme != "https"
            or parsed.hostname != "github.com"
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or _GITHUB_REPOSITORY_PATH_PATTERN.fullmatch(parsed.path) is None
            or value != f"https://github.com{parsed.path}"
        ):
            raise ValueError("must be a canonical GitHub repository URL")
        return value

    @field_validator("path")
    @classmethod
    def _validate_path(cls, value: str) -> str:
        if value == "":
            return value
        segments = value.split("/")
        if (
            value != value.strip()
            or not segments
            or any(
                not segment
                or segment in {".", ".."}
                or "\\" in segment
                or any(ord(character) <= 0x1F or ord(character) == 0x7F for character in segment)
                for segment in segments
            )
        ):
            raise ValueError("must be a safe repository-relative directory")
        return value


class HostedRuntimeBundledSkillEntry(_StrictHostedWireModel):
    enabled: bool
    version: int = Field(ge=1)


class HostedRuntimeSourcedSkillEntry(_StrictHostedWireModel):
    enabled: bool
    source: HostedRuntimeSkillSource


HostedRuntimeSkillEntry = HostedRuntimeBundledSkillEntry | HostedRuntimeSourcedSkillEntry


class HostedRuntimeSkills(_StrictHostedWireModel):
    entries: dict[str, HostedRuntimeSkillEntry]

    @field_validator("entries")
    @classmethod
    def _validate_entry_names(
        cls, value: dict[str, HostedRuntimeSkillEntry]
    ) -> dict[str, HostedRuntimeSkillEntry]:
        if any(_MANAGED_ENTRY_NAME_PATTERN.fullmatch(name) is None for name in value):
            raise ValueError("skill entry names must be canonical")
        return value


class HostedAgentPluginInstallation(_StrictHostedWireModel):
    installationId: str = Field(min_length=1, max_length=200)
    version: str = Field(min_length=1, max_length=256)
    agentPluginsSchema: Literal["https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"]
    source: HostedRuntimeSkillSource
    contentDigest: str = Field(pattern=r"^sha256-tree-v1:[0-9a-f]{64}$")
    secretRefs: dict[str, str] = Field(max_length=128)

    @field_validator("installationId")
    @classmethod
    def _validate_installation_id(cls, value: str) -> str:
        if value != value.strip() or any(
            ord(character) <= 0x1F or ord(character) == 0x7F for character in value
        ):
            raise ValueError("installationId must be a canonical non-empty identifier")
        return value

    @field_validator("version")
    @classmethod
    def _validate_version(cls, value: str) -> str:
        if _AGENT_PLUGIN_EXACT_SEMVER_PATTERN.fullmatch(value) is None:
            raise ValueError("version must be an exact SemVer")
        return value

    @field_validator("secretRefs")
    @classmethod
    def _validate_secret_refs(cls, value: dict[str, str]) -> dict[str, str]:
        for slot_id, secret_ref in value.items():
            if _AGENT_PLUGIN_SECRET_SLOT_ID_PATTERN.fullmatch(slot_id) is None:
                raise ValueError("Agent Plugin secret slot ids must be canonical")
            if len(secret_ref) > 1000 or not is_canonical_secret_ref(secret_ref):
                raise ValueError(
                    "Agent Plugin secretRefs values must be canonical secret:// references"
                )
        return value


class HostedAgentPlugins(_StrictHostedWireModel):
    schemaVersion: Literal[1]
    installations: dict[str, HostedAgentPluginInstallation] = Field(max_length=128)

    @field_validator("installations")
    @classmethod
    def _validate_plugin_keys(
        cls,
        value: dict[str, HostedAgentPluginInstallation],
    ) -> dict[str, HostedAgentPluginInstallation]:
        if any(
            len(plugin_key) > 64 or _AGENT_PLUGIN_NAME_PATTERN.fullmatch(plugin_key) is None
            for plugin_key in value
        ):
            raise ValueError("Agent Plugin installation keys must be canonical plugin names")
        return value


class PersistedHostedRuntimeBundledSkillEntry(_StrictHostedWireModel):
    """Expand-phase reader for already-persisted enabled-only Skill intent."""

    enabled: bool
    version: int | None = Field(default=None, ge=1)


class PersistedHostedRuntimeSourcedSkillEntry(_StrictHostedWireModel):
    enabled: bool
    source: HostedRuntimeSkillSource


PersistedHostedRuntimeSkillEntry = (
    PersistedHostedRuntimeBundledSkillEntry | PersistedHostedRuntimeSourcedSkillEntry
)


class PersistedHostedRuntimeSkills(_StrictHostedWireModel):
    entries: dict[str, PersistedHostedRuntimeSkillEntry]

    @field_validator("entries")
    @classmethod
    def _validate_entry_names(
        cls, value: dict[str, PersistedHostedRuntimeSkillEntry]
    ) -> dict[str, PersistedHostedRuntimeSkillEntry]:
        if any(_MANAGED_ENTRY_NAME_PATTERN.fullmatch(name) is None for name in value):
            raise ValueError("skill entry names must be canonical")
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
    return value


class HostedRuntimeConfiguredDesiredState(_HostedRuntimeDesiredStateBase):
    providerMode: Literal["configured"]
    provider_ids: list[str] = Field(min_length=1, max_length=1)
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
_HOSTED_RUNTIME_DESIRED_STATE_ADAPTER: TypeAdapter[HostedRuntimeDesiredState] = TypeAdapter(
    HostedRuntimeDesiredState
)


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
