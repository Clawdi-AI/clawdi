from __future__ import annotations

import asyncio
from uuid import UUID

import pytest

import app.services.whatsapp_delivery_transport as delivery_transport_module
import app.services.whatsapp_sidecar_registry as sidecar_registry_module
from app.services.whatsapp_delivery_transport import resolve_whatsapp_delivery_transport
from app.services.whatsapp_native_transport import (
    WhatsAppBaileysSidecarConfig,
    WhatsAppProviderMessageEvent,
)
from app.services.whatsapp_provider_bridge import (
    WhatsAppProviderAccountRetired,
    whatsapp_provider_transport_status,
)
from app.services.whatsapp_sidecar_registry import (
    ConfiguredWhatsAppSidecarRegistry,
)


class _FakeSidecarClient:
    def __init__(self, config: WhatsAppBaileysSidecarConfig) -> None:
        self.config = config
        self.connected = False
        self.closed = False

    async def aclose(self) -> None:
        self.closed = True

    async def provider_events(self, *, limit: int = 100):
        assert limit == 100
        return []

    async def acknowledge_provider_events(self, *, through_sequence: int):
        raise AssertionError(through_sequence)

    async def relay_message(self, request):
        raise AssertionError(request)

    async def send_node(self, node):
        raise AssertionError(node)

    async def query(self, node, timeout_ms):
        raise AssertionError((node, timeout_ms))


@pytest.mark.asyncio
async def test_registry_uses_one_endpoint_for_distinct_opaque_sessions():
    first_id = UUID("00000000-0000-4000-8000-000000000888")
    second_id = UUID("00000000-0000-4000-8000-000000000889")
    clients: list[_FakeSidecarClient] = []

    def factory(config: WhatsAppBaileysSidecarConfig) -> _FakeSidecarClient:
        client = _FakeSidecarClient(config)
        clients.append(client)
        return client

    registry = ConfiguredWhatsAppSidecarRegistry("secret", client_factory=factory)
    await registry.start()
    try:
        first = registry.get_managed_client(first_id)
        second = registry.get_custom_client(second_id)

        assert first is clients[0]
        assert second is clients[1]
        assert clients[0].config.account_id == first_id
        assert clients[1].config.account_id == second_id
        assert clients[0].config.endpoint_identity == clients[1].config.endpoint_identity
        assert clients[0].config.unix_socket_path == "/run/clawdi-whatsapp/sidecar.sock"
        assert whatsapp_provider_transport_status(first_id).available is False
        assert whatsapp_provider_transport_status(second_id).available is False
    finally:
        await registry.stop()

    assert all(client.closed for client in clients)


@pytest.mark.asyncio
async def test_disabled_registry_is_inert():
    registry = ConfiguredWhatsAppSidecarRegistry("")
    await registry.start()
    try:
        assert registry.enabled is False
        assert registry.get_managed_client(UUID(int=1)) is None
        assert registry.get_custom_client(UUID(int=2)) is None
    finally:
        await registry.stop()


def test_delivery_transport_resolves_custom_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    account_id = UUID("00000000-0000-4000-8000-000000000891")
    session_id = UUID("00000000-0000-4000-8000-000000000892")
    service_config = WhatsAppBaileysSidecarConfig(
        api_token="secret",
        base_url="http://127.0.0.1:43191",
    )
    session_config = WhatsAppBaileysSidecarConfig(
        api_token="secret",
        base_url="http://127.0.0.1:43191",
        account_id=session_id,
    )
    clients: list[_FakeSidecarClient] = []

    class FakeDeliveryService:
        def session_client(self, resolved_session_id: UUID) -> _FakeSidecarClient:
            assert resolved_session_id == session_id
            client = _FakeSidecarClient(session_config)
            clients.append(client)
            return client

    monkeypatch.setattr(
        delivery_transport_module,
        "_configured_delivery_service",
        lambda: service_config,
    )
    monkeypatch.setattr(
        delivery_transport_module,
        "_delivery_sidecar_service",
        FakeDeliveryService(),
    )
    account = sidecar_registry_module.ChannelAccount(
        id=account_id,
        provider="whatsapp",
        config={
            "connection_mode": "baileys_custom",
            "sidecar_account_id": str(session_id),
            "sidecar_config_revision": session_config.binding_revision,
        },
    )

    transport = resolve_whatsapp_delivery_transport(account)

    assert transport is not None
    assert len(clients) == 1


@pytest.mark.asyncio
async def test_provider_ingress_ack_waits_until_persistence_returns(monkeypatch):
    account_id = UUID("00000000-0000-4000-8000-000000000903")
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
        assert account_id == UUID("00000000-0000-4000-8000-000000000903")
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

    monkeypatch.setattr(sidecar_registry_module, "async_session_factory", lambda: SessionContext())
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


@pytest.mark.asyncio
@pytest.mark.parametrize("ownership_kind", ["managed", "custom"])
async def test_terminal_ingress_releases_local_owner_and_can_reattach(
    monkeypatch: pytest.MonkeyPatch,
    ownership_kind: str,
) -> None:
    account_id = UUID("00000000-0000-4000-8000-000000000904")
    session_id = (
        account_id if ownership_kind == "managed" else UUID("00000000-0000-4000-8000-000000000944")
    )
    event = WhatsAppProviderMessageEvent(
        sequence=8,
        message_id="provider-8",
        remote_jid="15550001111@s.whatsapp.net",
        remote_jid_alt=None,
        participant=None,
        participant_alt=None,
        push_name=None,
        message_timestamp=None,
        message_proto=b"\x0a\x05hello",
    )
    attempts = 0
    reattached = asyncio.Event()

    class SessionContext:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, exc_type, exc, traceback):
            return False

    async def retired(_db, *, account_id, event):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise WhatsAppProviderAccountRetired
        reattached.set()
        await asyncio.Future()

    class PumpClient:
        connected = True

        async def provider_events(self, *, limit=100):
            assert limit == 100
            return [event]

        async def acknowledge_provider_events(self, *, through_sequence):
            raise AssertionError(through_sequence)

        async def relay_message(self, request):
            raise AssertionError(request)

        async def send_node(self, node):
            raise AssertionError(node)

        async def query(self, node, timeout_ms):
            raise AssertionError((node, timeout_ms))

    monkeypatch.setattr(sidecar_registry_module, "async_session_factory", lambda: SessionContext())
    monkeypatch.setattr(sidecar_registry_module, "persist_whatsapp_provider_event", retired)

    registry = ConfiguredWhatsAppSidecarRegistry("secret")
    await registry.start()
    client = PumpClient()

    def attach() -> asyncio.Task[None]:
        registry._register_transport(account_id, client)
        if ownership_kind == "managed":
            registry._bound_managed_accounts.add(account_id)
        else:
            registry._custom_session_to_account[session_id] = account_id
            registry._custom_account_to_session[account_id] = session_id
        return registry._ingress_tasks[account_id]

    try:
        first_task = attach()
        await asyncio.wait_for(first_task, timeout=1)
        assert whatsapp_provider_transport_status(account_id).available is False
        assert account_id not in registry._bound_managed_accounts
        assert account_id not in registry._custom_account_to_session

        second_task = attach()
        await asyncio.wait_for(reattached.wait(), timeout=1)
        assert second_task is registry._ingress_tasks[account_id]
        assert second_task is not first_task
        assert attempts == 2
    finally:
        await registry.stop()
