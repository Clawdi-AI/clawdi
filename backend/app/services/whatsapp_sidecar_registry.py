from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable, Mapping
from typing import Any
from uuid import UUID

from app.services.whatsapp_native_transport import (
    WhatsAppBaileysSidecarClient,
    WhatsAppBaileysSidecarConfig,
    WhatsAppNativeTransportAdapter,
)
from app.services.whatsapp_shared_runtime import (
    register_whatsapp_shared_bot_transport,
    unregister_whatsapp_shared_bot_transport,
)

log = logging.getLogger(__name__)

SidecarClientFactory = Callable[[WhatsAppBaileysSidecarConfig], WhatsAppBaileysSidecarClient]


class ConfiguredWhatsAppSidecarRegistry:
    """Register configured Baileys sidecars into the shared-bot transport seam."""

    def __init__(
        self,
        raw_config: str,
        *,
        client_factory: SidecarClientFactory = WhatsAppBaileysSidecarClient,
    ) -> None:
        self._registrations = parse_whatsapp_sidecar_registrations(raw_config)
        self._client_factory = client_factory
        self._clients: dict[UUID, WhatsAppBaileysSidecarClient] = {}

    async def start(self) -> None:
        for account_id, sidecar in self._registrations.items():
            client = self._client_factory(sidecar)
            try:
                await client.refresh_health()
            except Exception as exc:
                log.warning(
                    "WhatsApp Baileys sidecar health check failed for account %s: %s",
                    account_id,
                    exc,
                )
            register_whatsapp_shared_bot_transport(
                account_id,
                WhatsAppNativeTransportAdapter(client),
            )
            self._clients[account_id] = client

    async def stop(self) -> None:
        for account_id in tuple(self._clients):
            unregister_whatsapp_shared_bot_transport(account_id)
        clients = tuple(self._clients.values())
        self._clients.clear()
        if clients:
            await asyncio.gather(
                *(client.aclose() for client in clients),
                return_exceptions=True,
            )


def parse_whatsapp_sidecar_registrations(
    raw_config: str,
) -> dict[UUID, WhatsAppBaileysSidecarConfig]:
    raw = raw_config.strip()
    if not raw:
        return {}
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("channel_whatsapp_baileys_sidecars_json must be valid JSON") from exc
    if not isinstance(payload, Mapping):
        raise ValueError("channel_whatsapp_baileys_sidecars_json must be an object")

    registrations: dict[UUID, WhatsAppBaileysSidecarConfig] = {}
    for account_id_raw, value in payload.items():
        try:
            account_id = UUID(str(account_id_raw))
        except ValueError as exc:
            raise ValueError(f"invalid WhatsApp sidecar account id: {account_id_raw}") from exc
        registrations[account_id] = _parse_sidecar_config(account_id=account_id, value=value)
    return registrations


def _parse_sidecar_config(*, account_id: UUID, value: Any) -> WhatsAppBaileysSidecarConfig:
    if not isinstance(value, Mapping):
        raise ValueError(f"WhatsApp sidecar config for {account_id} must be an object")
    base_url = _required_str(value, "base_url", account_id=account_id)
    return WhatsAppBaileysSidecarConfig(
        base_url=base_url,
        api_token=_optional_str(value, "api_token", account_id=account_id),
        timeout_seconds=_optional_float(value, "timeout_seconds", account_id=account_id) or 10.0,
    )


def _required_str(value: Mapping[str, Any], key: str, *, account_id: UUID) -> str:
    text = _optional_str(value, key, account_id=account_id)
    if text is None:
        raise ValueError(f"WhatsApp sidecar config for {account_id} requires {key}")
    return text


def _optional_str(value: Mapping[str, Any], key: str, *, account_id: UUID) -> str | None:
    raw = value.get(key)
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise ValueError(f"WhatsApp sidecar config for {account_id} field {key} must be a string")
    text = raw.strip()
    return text or None


def _optional_float(value: Mapping[str, Any], key: str, *, account_id: UUID) -> float | None:
    raw = value.get(key)
    if raw is None:
        return None
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise ValueError(f"WhatsApp sidecar config for {account_id} field {key} must be a number")
    number = float(raw)
    if number <= 0:
        raise ValueError(f"WhatsApp sidecar config for {account_id} field {key} must be positive")
    return number
