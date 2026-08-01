from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable, Mapping
from typing import Any
from urllib.parse import urlparse
from uuid import UUID

from app.services.whatsapp_sidecar_client import (
    DEFAULT_MAX_MEDIA_DOWNLOAD_BYTES,
    WhatsAppSidecarClient,
    WhatsAppSidecarConfig,
    WhatsAppSidecarUnavailableError,
)

log = logging.getLogger(__name__)

SidecarClientFactory = Callable[[WhatsAppSidecarConfig], WhatsAppSidecarClient]
_ACTIVE_CLIENTS: dict[UUID, WhatsAppSidecarClient] = {}


class ConfiguredWhatsAppSidecarRegistry:
    def __init__(
        self,
        raw_config: str,
        *,
        client_factory: SidecarClientFactory = WhatsAppSidecarClient,
    ) -> None:
        self._registrations = parse_whatsapp_sidecar_registrations(raw_config)
        self._client_factory = client_factory
        self._clients: dict[UUID, WhatsAppSidecarClient] = {}

    async def start(self) -> None:
        if self._clients:
            raise ValueError("WhatsApp sidecar registry is already started")
        duplicates = set(self._registrations).intersection(_ACTIVE_CLIENTS)
        if duplicates:
            raise ValueError("duplicate active WhatsApp sidecar account registration")
        try:
            for account_id, config in self._registrations.items():
                client = self._client_factory(config)
                self._clients[account_id] = client
                _ACTIVE_CLIENTS[account_id] = client
                try:
                    await client.health()
                except WhatsAppSidecarUnavailableError:
                    log.warning(
                        "WhatsApp sidecar health check failed account_id=%s",
                        account_id,
                    )
        except Exception:
            await self.stop()
            raise

    async def stop(self) -> None:
        clients = tuple(self._clients.items())
        self._clients.clear()
        for account_id, client in clients:
            if _ACTIVE_CLIENTS.get(account_id) is client:
                _ACTIVE_CLIENTS.pop(account_id, None)
        if clients:
            results = await asyncio.gather(
                *(client.close() for _account_id, client in clients),
                return_exceptions=True,
            )
            if any(isinstance(result, BaseException) for result in results):
                log.warning("One or more WhatsApp sidecar clients failed to close")


def parse_whatsapp_sidecar_registrations(raw_config: str) -> dict[UUID, WhatsAppSidecarConfig]:
    if not raw_config.strip():
        return {}
    try:
        payload = json.loads(raw_config, object_pairs_hook=_unique_object)
    except json.JSONDecodeError as exc:
        raise ValueError("channel_whatsapp_baileys_sidecars_json must be valid JSON") from exc
    if not isinstance(payload, Mapping):
        raise ValueError("channel_whatsapp_baileys_sidecars_json must be an object")

    registrations: dict[UUID, WhatsAppSidecarConfig] = {}
    base_urls: set[str] = set()
    for account_id_raw, value in payload.items():
        try:
            account_id = UUID(str(account_id_raw))
        except ValueError as exc:
            raise ValueError(f"invalid WhatsApp sidecar account id: {account_id_raw}") from exc
        config = _parse_sidecar_config(account_id=account_id, value=value)
        canonical_base_url = config.base_url.rstrip("/")
        if canonical_base_url in base_urls:
            raise ValueError("each WhatsApp sidecar base_url may be registered to only one account")
        base_urls.add(canonical_base_url)
        registrations[account_id] = config
    return registrations


def get_configured_whatsapp_sidecar_client(account_id: UUID) -> WhatsAppSidecarClient | None:
    return _ACTIVE_CLIENTS.get(account_id)


def whatsapp_sidecar_status(account_id: UUID) -> dict[str, bool | str | None]:
    client = _ACTIVE_CLIENTS.get(account_id)
    return {
        "mode": "sidecar",
        "configured": client is not None,
        "connected": client.connected if client is not None else None,
    }


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate WhatsApp sidecar config key: {key}")
        result[key] = value
    return result


def _parse_sidecar_config(*, account_id: UUID, value: Any) -> WhatsAppSidecarConfig:
    if not isinstance(value, Mapping):
        raise ValueError(f"WhatsApp sidecar config for {account_id} must be an object")
    allowed_keys = {
        "account_id",
        "base_url",
        "api_token",
        "timeout_seconds",
        "media_download_max_bytes",
    }
    unknown = set(value) - allowed_keys
    if unknown:
        raise ValueError(f"WhatsApp sidecar config for {account_id} has unknown fields")
    declared_account_id = value.get("account_id")
    if declared_account_id is not None:
        try:
            parsed_declared_id = UUID(str(declared_account_id))
        except ValueError as exc:
            raise ValueError(
                f"WhatsApp sidecar config for {account_id} has invalid account_id"
            ) from exc
        if parsed_declared_id != account_id:
            raise ValueError(f"WhatsApp sidecar config account_id mismatch for {account_id}")

    base_url = _required_str(value, "base_url", account_id=account_id)
    _validate_base_url(base_url, account_id=account_id)
    api_token = _required_str(value, "api_token", account_id=account_id)
    timeout_seconds = _optional_float(value, "timeout_seconds", account_id=account_id) or 10.0
    media_download_max_bytes = _optional_int(
        value,
        "media_download_max_bytes",
        account_id=account_id,
        maximum=100 * 1024 * 1024,
    )
    return WhatsAppSidecarConfig(
        account_id=account_id,
        base_url=base_url.rstrip("/"),
        api_token=api_token,
        timeout_seconds=timeout_seconds,
        media_download_max_bytes=(
            media_download_max_bytes
            if media_download_max_bytes is not None
            else DEFAULT_MAX_MEDIA_DOWNLOAD_BYTES
        ),
    )


def _validate_base_url(value: str, *, account_id: UUID) -> None:
    parsed = urlparse(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(f"WhatsApp sidecar config for {account_id} has invalid base_url")


def _required_str(value: Mapping[str, Any], key: str, *, account_id: UUID) -> str:
    parsed = _optional_str(value, key, account_id=account_id)
    if parsed is None:
        raise ValueError(f"WhatsApp sidecar config for {account_id} requires {key}")
    return parsed


def _optional_str(value: Mapping[str, Any], key: str, *, account_id: UUID) -> str | None:
    raw = value.get(key)
    if raw is None:
        return None
    if not isinstance(raw, str) or not raw.strip() or len(raw) > 4096:
        raise ValueError(f"WhatsApp sidecar config for {account_id} field {key} must be a string")
    return raw.strip()


def _optional_float(value: Mapping[str, Any], key: str, *, account_id: UUID) -> float | None:
    raw = value.get(key)
    if raw is None:
        return None
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise ValueError(f"WhatsApp sidecar config for {account_id} field {key} must be a number")
    parsed = float(raw)
    if parsed <= 0 or parsed > 120:
        raise ValueError(f"WhatsApp sidecar config for {account_id} field {key} must be 0-120")
    return parsed


def _optional_int(
    value: Mapping[str, Any],
    key: str,
    *,
    account_id: UUID,
    maximum: int,
) -> int | None:
    raw = value.get(key)
    if raw is None:
        return None
    if isinstance(raw, bool) or not isinstance(raw, int) or raw <= 0 or raw > maximum:
        raise ValueError(
            f"WhatsApp sidecar config for {account_id} field {key} must be 1-{maximum}"
        )
    return raw
