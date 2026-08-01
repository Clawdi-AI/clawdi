from __future__ import annotations

import re
from typing import Any

from fastapi import HTTPException, status

from app.models.channel import (
    CHANNEL_PROVIDER_DISCORD,
    CHANNEL_PROVIDER_IMESSAGE,
    ChannelAccount,
)
from app.services.url_security import (
    UnsafeOutboundUrlError,
    validate_channel_http_url,
    validate_channel_websocket_url,
)

_DISCORD_SNOWFLAKE_PATTERN = re.compile(r"^[0-9]{17,20}$")
_DISCORD_PUBLIC_KEY_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")
_DISCORD_MAX_SNOWFLAKE = (1 << 64) - 1


def discord_interactions_config_error(config: dict[str, Any] | None) -> str | None:
    """Return the first missing/invalid HTTP-interactions requirement."""
    values = config if isinstance(config, dict) else {}
    application_id = values.get("application_id")
    if not isinstance(application_id, str) or not valid_discord_application_id(application_id):
        return "Discord application_id must be a valid numeric application ID."
    public_key = values.get("public_key")
    if not isinstance(public_key, str) or _DISCORD_PUBLIC_KEY_PATTERN.fullmatch(public_key) is None:
        return "Discord public_key must be a 64-character hexadecimal interactions public key."
    return None


def discord_public_account_is_eligible(account: ChannelAccount) -> bool:
    config = account.config if isinstance(account.config, dict) else {}
    return bool(
        account.encrypted_provider_token
        and account.provider_token_nonce
        and discord_interactions_config_error(account.config) is None
        and config.get("discord_interactions_configured") is True
    )


def validate_required_discord_interactions_config(config: dict[str, Any] | None) -> None:
    detail = discord_interactions_config_error(config)
    if detail is not None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


def valid_discord_application_id(value: str) -> bool:
    return bool(
        value == value.strip()
        and _DISCORD_SNOWFLAKE_PATTERN.fullmatch(value)
        and int(value, 10) <= _DISCORD_MAX_SNOWFLAKE
    )


async def validate_channel_account_config_urls(
    *,
    provider: str,
    config: dict[str, Any] | None,
) -> None:
    if not isinstance(config, dict):
        return
    if provider == CHANNEL_PROVIDER_DISCORD:
        await _validate_optional_http_config(config, "api_base_url", "discord api_base_url")
        await _validate_optional_websocket_config(config, "gateway_url", "discord gateway_url")
    if provider == CHANNEL_PROVIDER_IMESSAGE:
        await _validate_optional_http_config(config, "server_url", "imessage server_url")


async def _validate_optional_http_config(
    config: dict[str, Any],
    key: str,
    label: str,
) -> None:
    value = _optional_url_config(config, key, label)
    if value is None:
        return
    try:
        await validate_channel_http_url(value, label=label)
    except UnsafeOutboundUrlError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc


async def _validate_optional_websocket_config(
    config: dict[str, Any],
    key: str,
    label: str,
) -> None:
    value = _optional_url_config(config, key, label)
    if value is None:
        return
    try:
        await validate_channel_websocket_url(value, label=label)
    except UnsafeOutboundUrlError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc


def _optional_url_config(config: dict[str, Any], key: str, label: str) -> str | None:
    if key not in config or config[key] is None:
        return None
    value = config[key]
    if not isinstance(value, str) or not value.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{label} must be a non-empty URL string",
        )
    return value.strip()
