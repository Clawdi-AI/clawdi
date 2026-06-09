from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status

from app.models.channel import (
    CHANNEL_PROVIDER_DISCORD,
    CHANNEL_PROVIDER_IMESSAGE,
    CHANNEL_PROVIDER_WHATSAPP,
)
from app.services.url_security import (
    UnsafeOutboundUrlError,
    validate_channel_http_url,
    validate_channel_websocket_url,
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
    if provider == CHANNEL_PROVIDER_WHATSAPP:
        await _validate_optional_http_config(
            config,
            "graph_api_base_url",
            "whatsapp graph_api_base_url",
        )
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
