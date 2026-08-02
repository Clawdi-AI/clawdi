from __future__ import annotations

import asyncio
import json
from uuid import UUID

import pytest

import app.services.whatsapp_sidecar_registry as sidecar_registry_module
from app.services.whatsapp_native_transport import (
    WhatsAppBaileysSidecarConfig,
    WhatsAppProviderMessageEvent,
)
from app.services.whatsapp_provider_bridge import whatsapp_provider_transport_status
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

    async def provider_events(self, *, limit: int = 100):
        assert limit == 100
        return []

    async def acknowledge_provider_events(self, *, through_sequence: int):  # pragma: no cover
        raise AssertionError(through_sequence)


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
    assert sidecar.base_url == "http://127.0.0.1:8787"
    assert sidecar.api_token == "sidecar-token"
    assert sidecar.timeout_seconds == 2.5


@pytest.mark.parametrize(
    "raw",
    [
        "[]",
        '{"not-a-uuid": {"base_url": "http://sidecar"}}',
        '{"00000000-0000-0000-0000-000000000777": {}}',
        '{"00000000-0000-0000-0000-000000000777": {"base_url": 123}}',
        '{"00000000-0000-0000-0000-000000000777": {"base_url": "https://sidecar.test"}}',
        (
            '{"00000000-0000-0000-0000-000000000777": '
            '{"base_url": "https://sidecar.test/path", "api_token": "secret"}}'
        ),
        (
            '{"00000000-0000-0000-0000-000000000777": '
            '{"base_url": "https://user:pass@sidecar.test", "api_token": "secret"}}'
        ),
        (
            '{"00000000-0000-0000-0000-000000000777": '
            '{"base_url": "http://sidecar", "timeout_seconds": 0}}'
        ),
    ],
)
def test_parse_whatsapp_sidecar_registrations_rejects_invalid_config(raw: str):
    with pytest.raises(ValueError):
        parse_whatsapp_sidecar_registrations(raw)


def test_parse_whatsapp_sidecar_registrations_rejects_normalized_duplicate_account():
    raw = (
        '{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": '
        '{"base_url": "https://first.example.test", "api_token": "first"}, '
        '"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA": '
        '{"base_url": "https://second.example.test", "api_token": "second"}}'
    )

    with pytest.raises(ValueError, match="duplicate WhatsApp sidecar account id"):
        parse_whatsapp_sidecar_registrations(raw)


@pytest.mark.asyncio
async def test_configured_whatsapp_sidecar_registry_registers_and_closes_transport():
    account_id = UUID("00000000-0000-0000-0000-000000000888")
    raw = json.dumps(
        {str(account_id): {"base_url": "https://sidecar.example.test", "api_token": "secret"}}
    )
    clients: list[_FakeSidecarClient] = []

    def factory(config: WhatsAppBaileysSidecarConfig) -> _FakeSidecarClient:
        client = _FakeSidecarClient(config)
        clients.append(client)
        return client

    registry = ConfiguredWhatsAppSidecarRegistry(raw, client_factory=factory)
    await registry.start()
    try:
        status = whatsapp_provider_transport_status(account_id)
        assert status.available is True
        assert status.mode == "sidecar"
        assert clients[0].config.base_url == "https://sidecar.example.test"
        assert clients[0].health_checks == 1
    finally:
        await registry.stop()

    assert clients[0].closed is True
    assert whatsapp_provider_transport_status(account_id).reason == "provider-transport-unavailable"


@pytest.mark.asyncio
async def test_configured_whatsapp_sidecar_registry_keeps_unhealthy_sidecar_visible():
    account_id = UUID("00000000-0000-0000-0000-000000000999")
    raw = json.dumps(
        {
            str(account_id): {
                "base_url": "https://sidecar.example.test",
                "api_token": "secret",
            }
        }
    )
    client = _FakeSidecarClient(
        WhatsAppBaileysSidecarConfig(
            base_url="https://sidecar.example.test",
            api_token="secret",
        ),
        fail_health=True,
    )
    registry = ConfiguredWhatsAppSidecarRegistry(raw, client_factory=lambda _config: client)
    await registry.start()
    try:
        status = whatsapp_provider_transport_status(account_id)
        assert status.available is False
        assert status.mode == "sidecar"
        assert status.reason == "provider-transport-disconnected"
    finally:
        await registry.stop()

    assert client.closed is True


@pytest.mark.asyncio
async def test_configured_whatsapp_sidecar_registry_cleans_up_partial_start():
    first_id = UUID("00000000-0000-0000-0000-000000000901")
    second_id = UUID("00000000-0000-0000-0000-000000000902")
    raw = json.dumps(
        {
            str(first_id): {
                "base_url": "https://first-sidecar.example.test",
                "api_token": "first-secret",
            },
            str(second_id): {
                "base_url": "https://second-sidecar.example.test",
                "api_token": "second-secret",
            },
        }
    )
    clients: list[_FakeSidecarClient] = []

    def factory(config: WhatsAppBaileysSidecarConfig) -> _FakeSidecarClient:
        if config.base_url.startswith("https://second-"):
            raise RuntimeError("injected second client failure")
        client = _FakeSidecarClient(config)
        clients.append(client)
        return client

    registry = ConfiguredWhatsAppSidecarRegistry(raw, client_factory=factory)
    with pytest.raises(RuntimeError, match="injected second client failure"):
        await registry.start()

    assert clients[0].closed is True
    assert whatsapp_provider_transport_status(first_id).reason == "provider-transport-unavailable"
    assert whatsapp_provider_transport_status(second_id).reason == "provider-transport-unavailable"


@pytest.mark.asyncio
async def test_provider_ingress_ack_waits_until_persistence_returns(monkeypatch):
    account_id = UUID("00000000-0000-0000-0000-000000000903")
    event = WhatsAppProviderMessageEvent(
        sequence=7,
        message_id="provider-7",
        remote_jid="15550001111@s.whatsapp.net",
        remote_jid_alt=None,
        participant=None,
        participant_alt=None,
        push_name=None,
        message_timestamp=None,
        message_proto=b"\x0a\x05hello",
    )
    persistence_started = asyncio.Event()
    allow_persistence_return = asyncio.Event()
    acknowledged = asyncio.Event()
    order: list[str] = []

    class SessionContext:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, exc_type, exc, traceback):
            return False

    async def persist(_db, *, account_id, event):
        assert account_id == UUID("00000000-0000-0000-0000-000000000903")
        assert event.sequence == 7
        order.append("persistence-started")
        persistence_started.set()
        await allow_persistence_return.wait()
        order.append("persistence-returned-after-commit")

    class PumpClient:
        def __init__(self) -> None:
            self._first_poll = True

        async def provider_events(self, *, limit: int = 100):
            assert limit == 100
            if self._first_poll:
                self._first_poll = False
                return [event]
            await asyncio.Future()

        async def acknowledge_provider_events(self, *, through_sequence: int):
            assert through_sequence == 7
            order.append("acknowledged")
            acknowledged.set()

    monkeypatch.setattr(
        sidecar_registry_module,
        "async_session_factory",
        lambda: SessionContext(),
    )
    monkeypatch.setattr(sidecar_registry_module, "persist_whatsapp_provider_event", persist)
    registry = ConfiguredWhatsAppSidecarRegistry("")
    task = asyncio.create_task(registry._pump_provider_ingress(account_id, PumpClient()))
    try:
        await asyncio.wait_for(persistence_started.wait(), timeout=1)
        assert order == ["persistence-started"]
        allow_persistence_return.set()
        await asyncio.wait_for(acknowledged.wait(), timeout=1)
        assert order == [
            "persistence-started",
            "persistence-returned-after-commit",
            "acknowledged",
        ]
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
