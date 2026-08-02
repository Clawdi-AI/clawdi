from __future__ import annotations

import asyncio
import json
import logging
import math
from collections.abc import Callable, Mapping
from typing import Any
from uuid import UUID

from app.core.database import async_session_factory
from app.services.whatsapp_native_transport import (
    WhatsAppBaileysSidecarClient,
    WhatsAppBaileysSidecarConfig,
    WhatsAppProviderTransportAdapter,
    validate_whatsapp_sidecar_base_url,
)
from app.services.whatsapp_provider_bridge import (
    persist_whatsapp_provider_event,
    register_whatsapp_provider_transport,
    unregister_whatsapp_provider_transport,
)

log = logging.getLogger(__name__)

SidecarClientFactory = Callable[[WhatsAppBaileysSidecarConfig], WhatsAppBaileysSidecarClient]


class ConfiguredWhatsAppSidecarRegistry:
    """Own configured physical transports and their durable ingress pumps."""

    def __init__(
        self,
        raw_config: str,
        *,
        client_factory: SidecarClientFactory = WhatsAppBaileysSidecarClient,
    ) -> None:
        self._registrations = parse_whatsapp_sidecar_registrations(raw_config)
        self._client_factory = client_factory
        self._clients: dict[UUID, WhatsAppBaileysSidecarClient] = {}
        self._ingress_tasks: dict[UUID, asyncio.Task[None]] = {}

    async def start(self) -> None:
        if self._clients or self._ingress_tasks:
            raise RuntimeError("WhatsApp sidecar registry is already started")
        try:
            for account_id, sidecar in self._registrations.items():
                client = self._client_factory(sidecar)
                try:
                    try:
                        await client.refresh_health()
                    except Exception as exc:
                        log.warning(
                            "WhatsApp Baileys sidecar health check failed for account %s: %s",
                            account_id,
                            exc,
                        )
                    register_whatsapp_provider_transport(
                        account_id,
                        WhatsAppProviderTransportAdapter(client),
                    )
                except BaseException:
                    await client.aclose()
                    raise
                self._clients[account_id] = client
                self._ingress_tasks[account_id] = asyncio.create_task(
                    self._pump_provider_ingress(account_id, client)
                )
        except BaseException:
            await self.stop()
            raise

    async def stop(self) -> None:
        tasks = tuple(self._ingress_tasks.values())
        self._ingress_tasks.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        for account_id in tuple(self._clients):
            unregister_whatsapp_provider_transport(account_id)
        clients = tuple(self._clients.values())
        self._clients.clear()
        if clients:
            await asyncio.gather(
                *(client.aclose() for client in clients),
                return_exceptions=True,
            )

    async def _pump_provider_ingress(
        self,
        account_id: UUID,
        client: WhatsAppBaileysSidecarClient,
    ) -> None:
        while True:
            try:
                events = await client.provider_events(limit=100)
                if not events:
                    await asyncio.sleep(0.25)
                    continue
                for event in events:
                    async with async_session_factory() as db:
                        await persist_whatsapp_provider_event(
                            db,
                            account_id=account_id,
                            event=event,
                        )
                    await client.acknowledge_provider_events(
                        through_sequence=event.sequence,
                    )
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception(
                    "WhatsApp provider ingress pump failed for account %s",
                    account_id,
                )
                await asyncio.sleep(1.0)


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
        if account_id in registrations:
            raise ValueError(f"duplicate WhatsApp sidecar account id: {account_id}")
        registrations[account_id] = _parse_sidecar_config(account_id=account_id, value=value)
    return registrations


def _parse_sidecar_config(*, account_id: UUID, value: Any) -> WhatsAppBaileysSidecarConfig:
    if not isinstance(value, Mapping):
        raise ValueError(f"WhatsApp sidecar config for {account_id} must be an object")
    base_url = validate_whatsapp_sidecar_base_url(
        _required_str(value, "base_url", account_id=account_id)
    )
    return WhatsAppBaileysSidecarConfig(
        base_url=base_url,
        api_token=_required_str(value, "api_token", account_id=account_id),
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
    if not math.isfinite(number) or number <= 0:
        raise ValueError(
            f"WhatsApp sidecar config for {account_id} field {key} must be positive and finite"
        )
    return number
