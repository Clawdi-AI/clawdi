import re
from typing import Literal
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

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
_RUNTIME_SERVICE_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")


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


class HostedRuntimeSystem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user: str = Field(min_length=1, max_length=200)
    home: str = Field(min_length=1, max_length=1000)
    workspace: str = Field(min_length=1, max_length=1000)
    persistentPaths: list[str] = Field(min_length=1)
    openclawControlUiAllowedOrigins: list[str] | None = None

    @field_validator("openclawControlUiAllowedOrigins")
    @classmethod
    def _validate_allowed_origins(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        return [_validate_http_origin(origin) for origin in value]

    @field_validator("persistentPaths")
    @classmethod
    def _validate_persistent_paths(cls, value: list[str]) -> list[str]:
        if any(not path for path in value):
            raise ValueError("persistentPaths values must be non-empty strings")
        return value


class HostedRuntimePaths(BaseModel):
    model_config = ConfigDict(extra="forbid")

    home: str = Field(min_length=1, max_length=1000)
    workspace: str = Field(min_length=1, max_length=1000)


class HostedRuntimeInstall(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: Literal["official"]
    channel: str | None = Field(default=None, min_length=1)
    args: list[str] | None = None

    @field_validator("args")
    @classmethod
    def _validate_args(cls, value: list[str] | None) -> list[str] | None:
        if value is not None and any(not arg for arg in value):
            raise ValueError("install args must contain non-empty strings")
        return value


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


class HostedRuntimeDesiredState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: Literal[True]
    provider_ids: list[str] = Field(min_length=1)
    primary_model: HostedRuntimePrimaryModel
    install: HostedRuntimeInstall | None = None
    run: HostedRuntimeRunSettings | None = None
    services: dict[str, HostedRuntimeRunSettings] | None = None
    paths: HostedRuntimePaths

    @field_validator("provider_ids")
    @classmethod
    def _validate_provider_ids(cls, value: list[str]) -> list[str]:
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

    @model_validator(mode="after")
    def _validate_primary_model_provider(self) -> "HostedRuntimeDesiredState":
        if self.primary_model.provider_id not in self.provider_ids:
            raise ValueError("primary_model.provider_id must be present in provider_ids")
        return self


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
