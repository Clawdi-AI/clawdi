from __future__ import annotations

import asyncio
import json
from uuid import UUID

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

import app.services.whatsapp_sidecar_registry as sidecar_registry_module
from app.models.channel import (
    CHANNEL_PROVIDER_WHATSAPP,
    CHANNEL_VISIBILITY_PUBLIC,
    ChannelAccount,
)
from app.models.user import User
from app.services.whatsapp_native_transport import (
    WhatsAppBaileysSidecarConfig,
    WhatsAppProviderMessageEvent,
    WhatsAppSidecarCapabilities,
    WhatsAppSidecarHealth,
    WhatsAppSidecarPairingStatus,
)
from app.services.whatsapp_provider_bridge import (
    WhatsAppProviderAccountRetired,
    unregister_whatsapp_provider_transport,
    whatsapp_provider_transport_status,
)
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


def test_parse_whatsapp_sidecar_registrations_accepts_disjoint_unix_sockets():
    first_id = UUID("11111111-1111-4111-8111-111111111111")
    second_id = UUID("22222222-2222-4222-8222-222222222222")
    registrations = parse_whatsapp_sidecar_registrations(
        json.dumps(
            {
                str(first_id): {
                    "unix_socket_path": f"/run/clawdi-whatsapp/{first_id}/sidecar.sock",
                    "api_token": "first-token",
                },
                str(second_id): {
                    "unix_socket_path": f"/run/clawdi-whatsapp/{second_id}/sidecar.sock",
                    "api_token": "second-token",
                },
            }
        )
    )

    assert registrations[first_id].base_url is None
    assert registrations[first_id].unix_socket_path == (
        f"/run/clawdi-whatsapp/{first_id}/sidecar.sock"
    )
    assert registrations[first_id].endpoint_identity != registrations[second_id].endpoint_identity


@pytest.mark.parametrize(
    "raw",
    [
        "not-json",
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
        (
            '{"00000000-0000-0000-0000-000000000777": '
            '{"base_url": "https://sidecar.test", '
            '"unix_socket_path": "/run/sidecar.sock", "api_token": "secret"}}'
        ),
        (
            '{"00000000-0000-0000-0000-000000000777": '
            '{"unix_socket_path": "relative/sidecar.sock", "api_token": "secret"}}'
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
async def test_configured_whatsapp_sidecar_registry_does_not_start_ingress_before_promotion():
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
        assert status.available is False
        assert clients[0].config.base_url == "https://sidecar.example.test"
        assert clients[0].health_checks == 1
    finally:
        await registry.stop()

    assert clients[0].closed is True
    assert whatsapp_provider_transport_status(account_id).reason == "provider-transport-unavailable"


@pytest.mark.asyncio
async def test_configured_whatsapp_sidecar_registry_keeps_unhealthy_sidecar_unbound():
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
        assert status.reason == "provider-transport-unavailable"
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


@pytest.mark.asyncio
@pytest.mark.parametrize("ownership_kind", ["managed", "custom"])
async def test_provider_ingress_terminal_exit_releases_owner_and_can_reattach_once(
    monkeypatch: pytest.MonkeyPatch,
    ownership_kind: str,
    db_session: AsyncSession,
    seed_user: User,
):
    account_id = UUID("00000000-0000-0000-0000-000000000904")
    slot_id = (
        account_id if ownership_kind == "managed" else UUID("00000000-0000-0000-0000-000000000944")
    )
    raw = json.dumps(
        {
            str(slot_id): {
                "base_url": f"https://sidecar-{ownership_kind}.example.test",
                "api_token": "secret",
            }
        }
    )
    registry = ConfiguredWhatsAppSidecarRegistry(
        raw if ownership_kind == "managed" else "",
        raw if ownership_kind == "custom" else "",
    )
    config = registry._managed.get(slot_id) or registry._custom[slot_id]
    account = ChannelAccount(
        id=account_id,
        user_id=seed_user.id,
        provider=CHANNEL_PROVIDER_WHATSAPP,
        name=f"terminal-{ownership_kind}",
        visibility=CHANNEL_VISIBILITY_PUBLIC,
        webhook_secret_hash="test-secret-hash",
        config={
            "connection_mode": f"baileys_{ownership_kind}",
            "sidecar_config_revision": config.binding_revision,
            **({"sidecar_account_id": str(slot_id)} if ownership_kind == "custom" else {}),
        },
    )
    db_session.add(account)
    await db_session.commit()
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
    acknowledgements: list[int] = []
    attempts = 0
    reattached = asyncio.Event()

    class SessionContext:
        async def __aenter__(self):
            return db_session

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
        async def provider_events(self, *, limit=100):
            return [event]

        async def acknowledge_provider_events(self, *, through_sequence):
            acknowledgements.append(through_sequence)

        async def capabilities(self):
            return WhatsAppSidecarCapabilities(pairing=frozenset({"qr"}))

        async def health(self):
            return WhatsAppSidecarHealth(status="connected", connected=True, registered=True)

        async def pairing_status(self):
            return WhatsAppSidecarPairingStatus(status="connected", registered=True)

    monkeypatch.setattr(sidecar_registry_module, "async_session_factory", lambda: SessionContext())
    monkeypatch.setattr(sidecar_registry_module, "persist_whatsapp_provider_event", retired)

    client = PumpClient()
    registry._clients_by_slot[slot_id] = client
    if ownership_kind == "managed":
        await registry.reconcile_managed_ownership(db_session)
    else:
        await registry.reconcile_custom_ownership()
    first_task = registry._ingress_tasks[account_id]
    await asyncio.wait_for(first_task, timeout=1)

    assert acknowledgements == []
    assert account_id not in registry._ingress_tasks
    assert whatsapp_provider_transport_status(account_id).available is False
    assert account_id not in registry._bound_managed_accounts
    assert account_id not in registry._custom_account_to_slot

    if ownership_kind == "managed":
        await registry.reconcile_managed_ownership(db_session)
    else:
        await registry.reconcile_custom_ownership()
    second_task = registry._ingress_tasks[account_id]
    try:
        await asyncio.wait_for(reattached.wait(), timeout=1)
        if ownership_kind == "managed":
            await registry.reconcile_managed_ownership(db_session)
        else:
            await registry.reconcile_custom_ownership()
        assert second_task is registry._ingress_tasks[account_id]
        assert second_task is not first_task
        assert attempts == 2
        assert len(registry._ingress_tasks) == 1
    finally:
        second_task.cancel()
        await asyncio.gather(second_task, return_exceptions=True)
        registry._ingress_tasks.clear()
        unregister_whatsapp_provider_transport(account_id)


@pytest.mark.asyncio
async def test_provider_ingress_retries_transient_errors(monkeypatch):
    account_id = UUID("00000000-0000-0000-0000-000000000905")
    calls = 0
    persisted = asyncio.Event()

    class SessionContext:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, exc_type, exc, traceback):
            return False

    async def transient_then_wait(_db, *, account_id, event):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("temporary database failure")
        persisted.set()

    event = WhatsAppProviderMessageEvent(
        sequence=9,
        message_id="provider-9",
        remote_jid="15550001111@s.whatsapp.net",
        remote_jid_alt=None,
        participant=None,
        participant_alt=None,
        push_name=None,
        message_timestamp=None,
        message_proto=b"\x0a\x05hello",
    )

    class PumpClient:
        async def provider_events(self, *, limit=100):
            return [event]

        async def acknowledge_provider_events(self, *, through_sequence):
            await asyncio.Future()

    monkeypatch.setattr(sidecar_registry_module, "async_session_factory", lambda: SessionContext())
    monkeypatch.setattr(
        sidecar_registry_module,
        "persist_whatsapp_provider_event",
        transient_then_wait,
    )
    registry = ConfiguredWhatsAppSidecarRegistry("")
    task = asyncio.create_task(registry._pump_provider_ingress(account_id, PumpClient()))
    try:
        await asyncio.wait_for(persisted.wait(), timeout=2)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    assert calls == 2
