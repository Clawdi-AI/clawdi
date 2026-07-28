"""Strict contracts for registered database-backed application settings."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic import TypeAdapter, ValidationError

from app.services.clerk_cli_oauth_settings import (
    CLERK_CLI_OAUTH_SETTING_ADAPTER,
    CLERK_CLI_OAUTH_SETTING_KEY,
    ClerkCliOAuthSetting,
)


class AppSettingValueError(ValueError):
    """A setting key or stored value does not satisfy the registry."""


@dataclass(frozen=True, slots=True)
class AppSettingSpec[T]:
    key: str
    adapter: TypeAdapter[T]
    description: str


CLERK_CLI_OAUTH_SPEC = AppSettingSpec[ClerkCliOAuthSetting](
    key=CLERK_CLI_OAUTH_SETTING_KEY,
    adapter=CLERK_CLI_OAUTH_SETTING_ADAPTER,
    description="Global Clerk Public OAuth Application configuration for the Clawdi CLI",
)
APP_SETTING_SPECS: tuple[AppSettingSpec[Any], ...] = (CLERK_CLI_OAUTH_SPEC,)
APP_SETTING_SPEC_BY_KEY = {spec.key: spec for spec in APP_SETTING_SPECS}


def get_app_setting_spec(key: str) -> AppSettingSpec[Any]:
    spec = APP_SETTING_SPEC_BY_KEY.get(key)
    if spec is None:
        raise AppSettingValueError(f"unregistered app setting: {key}")
    return spec


def validate_app_setting_value[T](spec: AppSettingSpec[T], value: object) -> T:
    try:
        return spec.adapter.validate_python(value)
    except ValidationError as error:
        raise AppSettingValueError(f"invalid {spec.key} value") from error


def canonical_app_setting_json[T](spec: AppSettingSpec[T], value: object) -> Any:
    validated = validate_app_setting_value(spec, value)
    return spec.adapter.dump_python(validated, mode="json")
