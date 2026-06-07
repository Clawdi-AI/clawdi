from __future__ import annotations

import json
from uuid import UUID

import pytest

from app.services.whatsapp_native_transport import WhatsAppBaileysSidecarConfig
from app.services.whatsapp_shared_runtime import whatsapp_shared_bot_transport_status
from app.services.whatsapp_sidecar_registry import (
    ConfiguredWhatsAppSidecarRegistry,
    parse_whatsapp_sidecar_registrations,
)


class _FakeSidecarClient:
    transport_mode = "sidecar"

    def __init__(
        self,
        config: WhatsAppBaileysSidecarConfig,
        *,
        connected_after_health: bool = True,
        fail_health: bool = False,
    ) -> None:
        self.config = config
        self.connected = False
        self.closed = False
        self.health_checks = 0
        self._connected_after_health = connected_after_health
        self._fail_health = fail_health

    async def refresh_health(self) -> bool:
        self.health_checks += 1
        if self._fail_health:
            raise RuntimeError("sidecar down")
        self.connected = self._connected_after_health
        return self.connected

    async def aclose(self) -> None:
        self.closed = True

    async def relay_message(self, request):  # pragma: no cover - adapter protocol only
        raise AssertionError(request)

    async def send_node(self, node):  # pragma: no cover - adapter protocol only
        raise AssertionError(node)

    async def query(self, node, timeout_ms):  # pragma: no cover - adapter protocol only
        raise AssertionError((node, timeout_ms))


def test_parse_whatsapp_sidecar_registrations_accepts_account_map():
    account_id = UUID("00000000-0000-0000-0000-000000000777")

    registrations = parse_whatsapp_sidecar_registrations(
        json.dumps(
            {
                str(account_id): {
                    "base_url": "http://127.0.0.1:8787/",
                    "api_token": "sidecar-token",
                    "timeout_seconds": 2.5,
                }
            }
        )
    )

    assert len(registrations) == 1
    sidecar = registrations[account_id]
    assert sidecar.base_url == "http://127.0.0.1:8787/"
    assert sidecar.api_token == "sidecar-token"
    assert sidecar.timeout_seconds == 2.5


@pytest.mark.parametrize(
    "raw",
    [
        "[]",
        '{"not-a-uuid": {"base_url": "http://sidecar"}}',
        '{"00000000-0000-0000-0000-000000000777": {}}',
        '{"00000000-0000-0000-0000-000000000777": {"base_url": 123}}',
        (
            '{"00000000-0000-0000-0000-000000000777": '
            '{"base_url": "http://sidecar", "timeout_seconds": 0}}'
        ),
    ],
)
def test_parse_whatsapp_sidecar_registrations_rejects_invalid_config(raw: str):
    with pytest.raises(ValueError):
        parse_whatsapp_sidecar_registrations(raw)


@pytest.mark.asyncio
async def test_configured_whatsapp_sidecar_registry_registers_and_closes_transport():
    account_id = UUID("00000000-0000-0000-0000-000000000888")
    raw = json.dumps({str(account_id): {"base_url": "http://sidecar.local", "api_token": "secret"}})
    clients: list[_FakeSidecarClient] = []

    def factory(config: WhatsAppBaileysSidecarConfig) -> _FakeSidecarClient:
        client = _FakeSidecarClient(config)
        clients.append(client)
        return client

    registry = ConfiguredWhatsAppSidecarRegistry(raw, client_factory=factory)
    await registry.start()
    try:
        status = whatsapp_shared_bot_transport_status(account_id)
        assert status.available is True
        assert status.mode == "sidecar"
        assert clients[0].config.base_url == "http://sidecar.local"
        assert clients[0].health_checks == 1
    finally:
        await registry.stop()

    assert clients[0].closed is True
    assert (
        whatsapp_shared_bot_transport_status(account_id).reason
        == "shared-bot-transport-unavailable"
    )


@pytest.mark.asyncio
async def test_configured_whatsapp_sidecar_registry_keeps_unhealthy_sidecar_visible():
    account_id = UUID("00000000-0000-0000-0000-000000000999")
    raw = json.dumps({str(account_id): {"base_url": "http://sidecar.local"}})
    client = _FakeSidecarClient(
        WhatsAppBaileysSidecarConfig(base_url="http://sidecar.local"),
        fail_health=True,
    )
    registry = ConfiguredWhatsAppSidecarRegistry(raw, client_factory=lambda _config: client)
    await registry.start()
    try:
        status = whatsapp_shared_bot_transport_status(account_id)
        assert status.available is False
        assert status.mode == "sidecar"
        assert status.reason == "shared-bot-transport-disconnected"
    finally:
        await registry.stop()

    assert client.closed is True
