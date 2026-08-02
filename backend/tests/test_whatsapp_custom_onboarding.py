from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

import app.services.whatsapp_sidecar_registry as sidecar_registry_module
from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
from app.main import app
from app.models.channel import ChannelAccount, ChannelWhatsAppOnboardingSession
from app.models.project import PROJECT_KIND_PERSONAL, Project
from app.models.user import User
from app.services.whatsapp_device_onboarding import (
    expire_stale_whatsapp_onboarding_sessions,
    start_whatsapp_onboarding,
)
from app.services.whatsapp_native_transport import (
    WhatsAppBaileysSidecarClient,
    WhatsAppBaileysSidecarConfig,
    WhatsAppProviderMessageEvent,
    WhatsAppSidecarCapabilities,
    WhatsAppSidecarHealth,
    WhatsAppSidecarPairingStatus,
    WhatsAppSidecarProtocolError,
    WhatsAppSidecarUnavailableError,
)
from app.services.whatsapp_provider_bridge import (
    get_whatsapp_provider_transport,
    relay_whatsapp_provider_payload,
    whatsapp_provider_transport_status,
)
from app.services.whatsapp_sidecar_registry import (
    ConfiguredWhatsAppSidecarRegistry,
    get_active_whatsapp_sidecar_registry,
)


class FakeCustomSidecar:
    transport_mode = "sidecar"

    def __init__(self) -> None:
        self.current = WhatsAppSidecarPairingStatus(
            status="stopped",
            registered=False,
        )
        self.start_result = WhatsAppSidecarPairingStatus(
            status="pairing_qr",
            registered=False,
            method="qr",
            qr="test-device-qr-alpha",
            qr_expires_at=datetime.now(UTC) + timedelta(seconds=60),
        )
        self.cancel_result = WhatsAppSidecarPairingStatus(
            status="stopped",
            registered=False,
        )
        self.logout_result = WhatsAppSidecarPairingStatus(
            status="stopped",
            registered=False,
        )
        self.pairing_actions = frozenset({"qr", "code", "cancel", "logout", "retry"})
        self.start_calls = 0
        self.cancel_calls = 0
        self.logout_calls = 0
        self.recover_calls = 0
        self.logout_failures_remaining = 0
        self.last_phone_number: str | None = None
        self.relay_requests = []
        self.provider_event_queue = []
        self.acknowledged_sequences: list[int] = []
        self.provider_acknowledged = asyncio.Event()
        self.service_ready_result = True
        self.health_entered: asyncio.Event | None = None
        self.health_release: asyncio.Event | None = None

    async def aclose(self) -> None:
        return None

    async def service_ready(self) -> bool:
        return self.service_ready_result

    @property
    def connected(self) -> bool:
        return self.current.status == "connected" and self.current.registered

    async def health(self) -> WhatsAppSidecarHealth:
        if self.health_entered is not None:
            self.health_entered.set()
        if self.health_release is not None:
            await self.health_release.wait()
        return WhatsAppSidecarHealth(
            status=self.current.status,
            connected=self.current.status == "connected",
            registered=self.current.registered,
        )

    async def capabilities(self) -> WhatsAppSidecarCapabilities:
        return WhatsAppSidecarCapabilities(pairing=self.pairing_actions)

    async def pairing_status(self) -> WhatsAppSidecarPairingStatus:
        return self.current

    async def pairing_qr(self) -> WhatsAppSidecarPairingStatus:
        self.start_calls += 1
        self.current = self.start_result
        return self.current

    async def pairing_code(self, phone_number: str) -> WhatsAppSidecarPairingStatus:
        self.last_phone_number = phone_number
        self.current = WhatsAppSidecarPairingStatus(
            status="pairing_code",
            registered=False,
            method="code",
            code="1234-5678",
        )
        return self.current

    async def pairing_cancel(self) -> WhatsAppSidecarPairingStatus:
        self.cancel_calls += 1
        self.current = self.cancel_result
        return self.current

    async def pairing_logout(self) -> WhatsAppSidecarPairingStatus:
        self.logout_calls += 1
        if self.logout_failures_remaining > 0:
            self.logout_failures_remaining -= 1
            raise WhatsAppSidecarUnavailableError("fake logout unavailable")
        self.current = self.logout_result
        return self.current

    async def pairing_retry(self) -> WhatsAppSidecarPairingStatus:
        self.recover_calls += 1
        if self.current.registered:
            self.current = WhatsAppSidecarPairingStatus(
                status="connected",
                registered=True,
            )
        return self.current

    async def relay_message(self, request):
        self.relay_requests.append(request)
        return request.message_id

    async def send_node(self, _node) -> None:
        return None

    async def query(self, _node, _timeout_ms):
        return None

    async def provider_events(self, *, limit: int = 100):
        return self.provider_event_queue[:limit]

    async def acknowledge_provider_events(self, *, through_sequence: int) -> None:
        self.acknowledged_sequences.append(through_sequence)
        self.provider_event_queue = [
            event for event in self.provider_event_queue if event.sequence > through_sequence
        ]
        self.provider_acknowledged.set()


@pytest_asyncio.fixture
async def custom_sidecar(
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncIterator[tuple[UUID, FakeCustomSidecar]]:
    account_id = uuid4()
    session_ids = [account_id, *(uuid4() for _ in range(32))]
    monkeypatch.setattr(
        "app.services.whatsapp_device_onboarding.uuid4",
        lambda: session_ids.pop(0),
    )
    fake = FakeCustomSidecar()
    registry = ConfiguredWhatsAppSidecarRegistry(
        "test-internal-token",
        base_url="http://127.0.0.1:43191",
        client_factory=lambda _config: fake,
    )
    await registry.start()
    try:
        yield account_id, fake
    finally:
        await registry.stop()


@asynccontextmanager
async def _client_for_user(
    db_session: AsyncSession,
    user: User,
) -> AsyncIterator[httpx.AsyncClient]:
    previous = dict(app.dependency_overrides)

    async def _override_get_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def _override_get_auth() -> AuthContext:
        return AuthContext(user=user)

    app.dependency_overrides[get_session] = _override_get_session
    app.dependency_overrides[get_auth] = _override_get_auth
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
        ) as other_client:
            yield other_client
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)


async def _create_user(db: AsyncSession, label: str) -> User:
    suffix = uuid4().hex
    user = User(
        clerk_id=f"{label}_{suffix}",
        email=f"{label}_{suffix}@clawdi.local",
        name=f"{label.title()} User",
    )
    db.add(user)
    await db.flush()
    db.add(
        Project(
            user_id=user.id,
            name="Personal",
            slug="personal",
            kind=PROJECT_KIND_PERSONAL,
        )
    )
    await db.commit()
    await db.refresh(user)
    return user


@pytest.mark.asyncio
async def test_qr_lifecycle_is_idempotent_and_finishes_only_after_connection(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    custom_sidecar: tuple[UUID, FakeCustomSidecar],
) -> None:
    sidecar_account_id, fake = custom_sidecar
    readiness = await client.get("/v1/channels/whatsapp/onboarding/readiness")
    assert readiness.status_code == 200
    assert readiness.json() == {
        "available": True,
        "manual_pairing_code_supported": True,
        "reason": None,
    }

    request_id = uuid4()
    created = await client.post(
        "/v1/channels/whatsapp/onboarding/sessions",
        json={"request_id": str(request_id), "name": "My WhatsApp"},
    )
    assert created.status_code == 201, created.text
    assert created.headers["cache-control"] == "no-store, private"
    created_body = created.json()
    session_id = created_body["id"]
    assert created_body["state"] == "ready"
    assert created_body["qr"] == "test-device-qr-alpha"
    assert created_body["channel_account_id"] is None
    assert fake.start_calls == 1
    assert (
        await db_session.scalar(
            select(ChannelAccount.id).where(ChannelAccount.user_id == seed_user.id)
        )
        is None
    )

    repeated = await client.post(
        "/v1/channels/whatsapp/onboarding/sessions",
        json={"request_id": str(request_id), "name": "A different ignored name"},
    )
    assert repeated.status_code == 201
    assert repeated.json()["id"] == session_id
    assert fake.start_calls == 1

    first_qr_expiry = datetime.fromisoformat(created_body["qr_expires_at"])
    fake.current = WhatsAppSidecarPairingStatus(
        status="pairing_qr",
        registered=False,
        method="qr",
        qr="test-device-qr-rotated",
        qr_expires_at=datetime.now(UTC) + timedelta(seconds=20),
    )
    rotated = await client.get(f"/v1/channels/whatsapp/onboarding/sessions/{session_id}")
    assert rotated.status_code == 200
    assert rotated.json()["qr"] == "test-device-qr-rotated"
    rotated_expiry = datetime.fromisoformat(rotated.json()["qr_expires_at"])
    assert rotated_expiry < first_qr_expiry

    fake.current = WhatsAppSidecarPairingStatus(
        status="starting",
        registered=True,
    )
    scanned = await client.get(f"/v1/channels/whatsapp/onboarding/sessions/{session_id}")
    assert scanned.status_code == 200
    assert scanned.json()["state"] == "scanned"
    assert scanned.json()["qr"] is None
    assert (
        await db_session.scalar(
            select(ChannelAccount.id).where(ChannelAccount.user_id == seed_user.id)
        )
        is None
    )

    fake.current = WhatsAppSidecarPairingStatus(
        status="connected",
        registered=True,
    )
    connected = await client.get(f"/v1/channels/whatsapp/onboarding/sessions/{session_id}")
    assert connected.status_code == 200, connected.text
    assert connected.json()["state"] == "connected"
    channel_account_id = UUID(connected.json()["channel_account_id"])
    assert channel_account_id != sidecar_account_id
    account = await db_session.get(ChannelAccount, channel_account_id)
    assert account is not None
    assert account.user_id == seed_user.id
    assert account.config == {
        "connection_mode": "baileys_custom",
        "sidecar_account_id": str(sidecar_account_id),
        "sidecar_config_revision": custom_sidecar_registry_revision(sidecar_account_id),
    }
    assert account.encrypted_provider_token is None
    assert account.provider_token_nonce is None
    assert get_whatsapp_provider_transport(channel_account_id) is not None
    assert whatsapp_provider_transport_status(channel_account_id).available is True
    relayed_message_id, relay_details = await relay_whatsapp_provider_payload(
        account=account,
        external_chat_id="15550001111@s.whatsapp.net",
        text="transport proof",
        provider_payload=None,
    )
    assert relayed_message_id is not None
    assert relay_details["transport"] == "baileys"
    assert fake.relay_requests[-1].jid == "15550001111@s.whatsapp.net"

    connected_again = await client.get(f"/v1/channels/whatsapp/onboarding/sessions/{session_id}")
    assert connected_again.json()["channel_account_id"] == str(channel_account_id)
    assert (
        len(
            (
                await db_session.scalars(
                    select(ChannelAccount.id).where(ChannelAccount.user_id == seed_user.id)
                )
            ).all()
        )
        == 1
    )


@pytest.mark.asyncio
async def test_session_authorization_capacity_and_cancel_are_tenant_safe(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    custom_sidecar: tuple[UUID, FakeCustomSidecar],
) -> None:
    _account_id, fake = custom_sidecar
    created = await client.post(
        "/v1/channels/whatsapp/onboarding/sessions",
        json={"request_id": str(uuid4()), "name": "Owner phone"},
    )
    assert created.status_code == 201
    session_id = created.json()["id"]

    second = await client.post(
        "/v1/channels/whatsapp/onboarding/sessions",
        json={"request_id": str(uuid4()), "name": "Second phone"},
    )
    assert second.status_code == 201
    assert second.json()["id"] != session_id

    other_user = await _create_user(db_session, "whatsapp-other")
    async with _client_for_user(db_session, other_user) as other_client:
        hidden = await other_client.get(f"/v1/channels/whatsapp/onboarding/sessions/{session_id}")
        hidden_cancel = await other_client.post(
            f"/v1/channels/whatsapp/onboarding/sessions/{session_id}/cancel"
        )
    assert hidden.status_code == 404
    assert hidden_cancel.status_code == 404

    fake.current = WhatsAppSidecarPairingStatus(
        status="starting",
        registered=True,
    )
    canceled = await client.post(f"/v1/channels/whatsapp/onboarding/sessions/{session_id}/cancel")
    assert canceled.status_code == 200
    assert canceled.json()["state"] == "canceled"
    assert fake.cancel_calls == 0
    assert fake.logout_calls == 1


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_concurrent_cross_tenant_start_allocates_isolated_sessions(
    db_session: AsyncSession,
    engine: AsyncEngine,
    seed_user: User,
    custom_sidecar: tuple[UUID, FakeCustomSidecar],
) -> None:
    _provider_session_id, fake = custom_sidecar
    other_user = await _create_user(db_session, "whatsapp-concurrent")
    registry = get_active_whatsapp_sidecar_registry()
    assert registry is not None
    sessions = async_sessionmaker(engine, expire_on_commit=False)

    async def start(user_id: UUID, name: str):
        async with sessions() as db:
            return await start_whatsapp_onboarding(
                db,
                user_id=user_id,
                request_id=uuid4(),
                name=name,
                registry=registry,
            )

    results = await asyncio.gather(
        start(seed_user.id, "Tenant A phone"),
        start(other_user.id, "Tenant B phone"),
        return_exceptions=True,
    )

    successes = [result for result in results if not isinstance(result, BaseException)]
    assert len(successes) == 2
    assert len({result.id for result in successes}) == 2
    assert fake.start_calls == 2
    await db_session.delete(other_user)
    await db_session.commit()


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_custom_bind_waits_for_in_process_ownership_reconciliation(
    db_session: AsyncSession,
    seed_user: User,
    custom_sidecar: tuple[UUID, FakeCustomSidecar],
) -> None:
    provider_session_id, fake = custom_sidecar
    registry = get_active_whatsapp_sidecar_registry()
    assert registry is not None
    revision = registry.custom_session_revision(provider_session_id)
    assert revision is not None
    account_id = uuid4()
    now = datetime.now(UTC)
    db_session.add(
        ChannelWhatsAppOnboardingSession(
            sidecar_account_id=provider_session_id,
            sidecar_config_revision=revision,
            user_id=seed_user.id,
            request_id=uuid4(),
            name="Concurrent phone",
            state="ready",
            method="qr",
            started_at=now,
            expires_at=now + timedelta(minutes=5),
        )
    )
    await db_session.commit()
    fake.health_entered = asyncio.Event()
    fake.health_release = asyncio.Event()

    reconcile = asyncio.create_task(registry.reconcile_custom_ownership())
    await asyncio.wait_for(fake.health_entered.wait(), timeout=1)
    bind = asyncio.create_task(
        registry.bind_custom_account(
            session_id=provider_session_id,
            account_id=account_id,
            config_revision=revision,
        )
    )
    await asyncio.sleep(0)
    assert bind.done() is False

    fake.health_release.set()
    await reconcile
    assert await bind is True
    assert registry.custom_binding(account_id) == provider_session_id
    assert get_whatsapp_provider_transport(account_id) is not None
    await registry.unbind_custom_account(session_id=provider_session_id, account_id=account_id)


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_backend_restart_rehydrates_durable_account_transport_and_pump(
    db_session: AsyncSession,
    seed_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider_session_id = uuid4()
    fake = FakeCustomSidecar()
    fake.current = WhatsAppSidecarPairingStatus(status="connected", registered=True)
    registry = ConfiguredWhatsAppSidecarRegistry(
        "test-internal-token",
        base_url="http://127.0.0.1:43192",
        client_factory=lambda _config: fake,
    )
    revision = registry.custom_session_revision(provider_session_id)
    assert revision is not None
    account = ChannelAccount(
        user_id=seed_user.id,
        provider="whatsapp",
        name="Restart phone",
        status="active",
        visibility="private",
        webhook_secret_hash="test-webhook-secret-hash",
        config={
            "connection_mode": "baileys_custom",
            "sidecar_account_id": str(provider_session_id),
            "sidecar_config_revision": revision,
        },
    )
    db_session.add(account)
    await db_session.flush()
    db_session.add(
        ChannelWhatsAppOnboardingSession(
            sidecar_account_id=provider_session_id,
            sidecar_config_revision=revision,
            channel_account_id=account.id,
            user_id=seed_user.id,
            request_id=uuid4(),
            name=account.name,
            state="connected",
            method="qr",
            started_at=datetime.now(UTC) - timedelta(minutes=1),
            expires_at=datetime.now(UTC) + timedelta(minutes=4),
            completed_at=datetime.now(UTC),
        )
    )
    await db_session.commit()

    persisted = asyncio.Event()
    persisted_account_ids: list[UUID] = []

    async def persist(_db, *, account_id: UUID, event: WhatsAppProviderMessageEvent) -> None:
        persisted_account_ids.append(account_id)
        assert event.sequence == 11
        persisted.set()

    monkeypatch.setattr(sidecar_registry_module, "persist_whatsapp_provider_event", persist)
    fake.provider_event_queue = [
        WhatsAppProviderMessageEvent(
            sequence=11,
            message_id="provider-restart-11",
            remote_jid="15550003333@s.whatsapp.net",
            remote_jid_alt=None,
            participant=None,
            participant_alt=None,
            push_name=None,
            message_timestamp=None,
            message_proto=b"\x0a\x07restart",
        )
    ]

    await registry.start()
    try:
        await registry.reconcile_custom_ownership()
        assert registry.custom_binding(account.id) == provider_session_id
        assert get_whatsapp_provider_transport(account.id) is not None
        assert whatsapp_provider_transport_status(account.id).available is True
        relayed_message_id, _details = await relay_whatsapp_provider_payload(
            account=account,
            external_chat_id="15550002222@s.whatsapp.net",
            text="restart proof",
            provider_payload=None,
        )
        assert relayed_message_id is not None
        assert fake.relay_requests[-1].jid == "15550002222@s.whatsapp.net"
        await asyncio.wait_for(persisted.wait(), timeout=2)
        await asyncio.wait_for(fake.provider_acknowledged.wait(), timeout=2)
        assert persisted_account_ids == [account.id]
        assert fake.acknowledged_sequences == [11]
    finally:
        await registry.stop()


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_restart_fails_closed_on_durable_session_revision_drift(
    db_session: AsyncSession,
    seed_user: User,
) -> None:
    provider_session_id = uuid4()
    fake = FakeCustomSidecar()
    fake.current = WhatsAppSidecarPairingStatus(status="connected", registered=True)
    registry = ConfiguredWhatsAppSidecarRegistry(
        "test-internal-token",
        base_url="http://127.0.0.1:43193",
        client_factory=lambda _config: fake,
    )
    account = ChannelAccount(
        user_id=seed_user.id,
        provider="whatsapp",
        name="Drifted phone",
        status="active",
        visibility="private",
        webhook_secret_hash="test-webhook-secret-hash",
        config={
            "connection_mode": "baileys_custom",
            "sidecar_account_id": str(provider_session_id),
            "sidecar_config_revision": "0" * 64,
        },
    )
    db_session.add(account)
    await db_session.flush()
    db_session.add(
        ChannelWhatsAppOnboardingSession(
            sidecar_account_id=provider_session_id,
            sidecar_config_revision="0" * 64,
            channel_account_id=account.id,
            user_id=seed_user.id,
            request_id=uuid4(),
            name=account.name,
            state="connected",
            method="qr",
            started_at=datetime.now(UTC) - timedelta(minutes=1),
            expires_at=datetime.now(UTC) + timedelta(minutes=4),
            completed_at=datetime.now(UTC),
        )
    )
    await db_session.commit()

    await registry.start()
    try:
        await registry.reconcile_custom_ownership()
        assert registry.custom_session_is_blocked(provider_session_id) is True
        assert registry.custom_binding(account.id) is None
        assert get_whatsapp_provider_transport(account.id) is None
        assert registry.get_custom_client(provider_session_id) is None
    finally:
        await registry.stop()


@pytest.mark.asyncio
async def test_connected_ingress_pump_uses_the_durable_channel_account_id(
    client: httpx.AsyncClient,
    custom_sidecar: tuple[UUID, FakeCustomSidecar],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _provider_session_id, fake = custom_sidecar
    persisted = asyncio.Event()
    persisted_account_ids: list[UUID] = []

    @asynccontextmanager
    async def fake_session_factory():
        yield object()

    async def persist(_db, *, account_id: UUID, event: WhatsAppProviderMessageEvent) -> None:
        persisted_account_ids.append(account_id)
        assert event.sequence == 7
        persisted.set()

    monkeypatch.setattr(sidecar_registry_module, "async_session_factory", fake_session_factory)
    monkeypatch.setattr(sidecar_registry_module, "persist_whatsapp_provider_event", persist)
    created = await client.post(
        "/v1/channels/whatsapp/onboarding/sessions",
        json={"request_id": str(uuid4()), "name": "Ingress phone"},
    )
    session_id = created.json()["id"]
    fake.provider_event_queue = [
        WhatsAppProviderMessageEvent(
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
    ]
    fake.current = WhatsAppSidecarPairingStatus(status="connected", registered=True)

    connected = await client.get(f"/v1/channels/whatsapp/onboarding/sessions/{session_id}")
    durable_account_id = UUID(connected.json()["channel_account_id"])
    await asyncio.wait_for(persisted.wait(), timeout=2)
    await asyncio.wait_for(fake.provider_acknowledged.wait(), timeout=2)

    assert persisted_account_ids == [durable_account_id]
    assert fake.acknowledged_sequences == [7]


@pytest.mark.asyncio
async def test_connected_finalize_commit_failure_leaks_neither_account_nor_transport(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    custom_sidecar: tuple[UUID, FakeCustomSidecar],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider_session_id, fake = custom_sidecar
    seed_user_id = seed_user.id
    created = await client.post(
        "/v1/channels/whatsapp/onboarding/sessions",
        json={"request_id": str(uuid4()), "name": "Rollback phone"},
    )
    session_id = UUID(created.json()["id"])
    fake.current = WhatsAppSidecarPairingStatus(status="connected", registered=True)
    real_commit = db_session.commit
    failures_remaining = 1

    async def fail_connected_commit() -> None:
        nonlocal failures_remaining
        if failures_remaining > 0:
            failures_remaining -= 1
            raise RuntimeError("injected connected commit failure")
        await real_commit()

    monkeypatch.setattr(db_session, "commit", fail_connected_commit)
    with pytest.raises(RuntimeError, match="injected connected commit failure"):
        await client.get(f"/v1/channels/whatsapp/onboarding/sessions/{session_id}")
    monkeypatch.setattr(db_session, "commit", real_commit)

    assert (
        await db_session.scalar(
            select(ChannelAccount.id).where(
                ChannelAccount.user_id == seed_user_id,
                ChannelAccount.name == "Rollback phone",
            )
        )
        is None
    )
    registry = get_active_whatsapp_sidecar_registry()
    assert registry is not None
    assert registry.custom_account_for_session(provider_session_id) is None
    row = await db_session.get(ChannelWhatsAppOnboardingSession, session_id)
    assert row is not None
    assert row.channel_account_id is None
    await db_session.refresh(seed_user)
    canceled_again = await client.post(
        f"/v1/channels/whatsapp/onboarding/sessions/{session_id}/cancel"
    )
    assert canceled_again.status_code == 200
    assert fake.logout_calls == 1


@pytest.mark.asyncio
async def test_expiry_finishes_a_socket_that_opened_at_the_deadline(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    custom_sidecar: tuple[UUID, FakeCustomSidecar],
) -> None:
    _sidecar_account_id, fake = custom_sidecar
    created = await client.post(
        "/v1/channels/whatsapp/onboarding/sessions",
        json={"request_id": str(uuid4()), "name": "Deadline phone"},
    )
    session_id = UUID(created.json()["id"])
    onboarding = await db_session.get(ChannelWhatsAppOnboardingSession, session_id)
    assert onboarding is not None
    onboarding.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    await db_session.commit()
    fake.current = WhatsAppSidecarPairingStatus(
        status="connected",
        registered=True,
    )

    refreshed = await client.get(f"/v1/channels/whatsapp/onboarding/sessions/{session_id}")

    assert refreshed.status_code == 200
    assert refreshed.json()["state"] == "connected"
    assert refreshed.json()["channel_account_id"] is not None
    assert fake.cancel_calls == 0
    assert fake.logout_calls == 0
    account = await db_session.get(ChannelAccount, UUID(refreshed.json()["channel_account_id"]))
    assert account is not None
    assert account.user_id == seed_user.id


@pytest.mark.asyncio
async def test_cancel_recovers_a_stopped_registered_socket_before_logout(
    client: httpx.AsyncClient,
    custom_sidecar: tuple[UUID, FakeCustomSidecar],
) -> None:
    _sidecar_account_id, fake = custom_sidecar
    created = await client.post(
        "/v1/channels/whatsapp/onboarding/sessions",
        json={"request_id": str(uuid4()), "name": "Scanned then stopped"},
    )
    session_id = created.json()["id"]
    fake.current = WhatsAppSidecarPairingStatus(
        status="stopped",
        registered=True,
    )
    fake.logout_failures_remaining = 1

    canceled = await client.post(f"/v1/channels/whatsapp/onboarding/sessions/{session_id}/cancel")

    assert canceled.status_code == 200
    assert canceled.json()["state"] == "canceled"
    assert fake.recover_calls == 1
    assert fake.logout_calls == 2


@pytest.mark.asyncio
async def test_manual_pairing_code_validates_without_persisting_sensitive_values(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    custom_sidecar: tuple[UUID, FakeCustomSidecar],
) -> None:
    _account_id, fake = custom_sidecar
    created = await client.post(
        "/v1/channels/whatsapp/onboarding/sessions",
        json={"request_id": str(uuid4()), "name": "Code account"},
    )
    session_id = created.json()["id"]

    invalid_phone = "+1 (415) 555-0123"
    invalid = await client.post(
        f"/v1/channels/whatsapp/onboarding/sessions/{session_id}/pairing-code",
        json={"phone_number": invalid_phone},
    )
    assert invalid.status_code == 422
    assert invalid.headers["cache-control"] == "no-store, private"
    assert invalid_phone not in invalid.text
    assert "4155550123" not in invalid.text

    invalid_type = await client.post(
        f"/v1/channels/whatsapp/onboarding/sessions/{session_id}/pairing-code",
        json={"phone_number": 14155550123},
    )
    assert invalid_type.status_code == 422
    assert "14155550123" not in invalid_type.text
    assert invalid_type.headers["cache-control"] == "no-store, private"

    phone_number = "14155550123"
    requested = await client.post(
        f"/v1/channels/whatsapp/onboarding/sessions/{session_id}/pairing-code",
        json={"phone_number": phone_number},
    )
    assert requested.status_code == 200, requested.text
    assert requested.headers["cache-control"] == "no-store, private"
    assert requested.json()["method"] == "code"
    assert requested.json()["pairing_code"] == "1234-5678"
    assert fake.last_phone_number == phone_number

    row = await db_session.get(ChannelWhatsAppOnboardingSession, UUID(session_id))
    assert row is not None
    persisted = " ".join(
        str(value)
        for value in (
            row.id,
            row.sidecar_account_id,
            row.channel_account_id,
            row.user_id,
            row.request_id,
            row.name,
            row.state,
            row.method,
            row.started_at,
            row.expires_at,
            row.completed_at,
        )
    )
    assert phone_number not in persisted
    assert "1234-5678" not in persisted
    assert "test-device-qr" not in persisted


@pytest.mark.asyncio
async def test_expiry_retry_and_confirmed_logout_before_archive(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    custom_sidecar: tuple[UUID, FakeCustomSidecar],
) -> None:
    sidecar_account_id, fake = custom_sidecar
    created = await client.post(
        "/v1/channels/whatsapp/onboarding/sessions",
        json={"request_id": str(uuid4()), "name": "Retry phone"},
    )
    session_id = UUID(created.json()["id"])
    onboarding = await db_session.get(ChannelWhatsAppOnboardingSession, session_id)
    assert onboarding is not None
    onboarding.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    await db_session.commit()

    expired = await client.get(f"/v1/channels/whatsapp/onboarding/sessions/{session_id}")
    assert expired.status_code == 200
    assert expired.json()["state"] == "expired"
    assert fake.cancel_calls == 1

    fake.current = WhatsAppSidecarPairingStatus(status="stopped", registered=False)
    retried = await client.post(f"/v1/channels/whatsapp/onboarding/sessions/{session_id}/retry")
    assert retried.status_code == 200
    assert retried.json()["state"] == "ready"
    assert fake.start_calls == 2

    fake.current = WhatsAppSidecarPairingStatus(status="connected", registered=True)
    connected = await client.get(f"/v1/channels/whatsapp/onboarding/sessions/{session_id}")
    assert connected.json()["state"] == "connected"
    channel_account_id = UUID(connected.json()["channel_account_id"])
    assert channel_account_id != sidecar_account_id
    fake.current = WhatsAppSidecarPairingStatus(status="stopped", registered=True)
    fake.logout_failures_remaining = 1
    deleted = await client.delete(f"/v1/channels/{channel_account_id}")
    assert deleted.status_code == 204, deleted.text
    assert fake.recover_calls == 1
    assert fake.logout_calls == 2
    account = await db_session.get(ChannelAccount, channel_account_id)
    assert account is not None
    assert account.archived_at is not None
    await db_session.refresh(onboarding)
    assert onboarding.state == "canceled"

    released = await client.get("/v1/channels/whatsapp/onboarding/readiness")
    assert released.json()["available"] is True
    replacement_owner = await _create_user(db_session, "whatsapp-replacement")
    async with _client_for_user(db_session, replacement_owner) as replacement_client:
        replacement = await replacement_client.post(
            "/v1/channels/whatsapp/onboarding/sessions",
            json={"request_id": str(uuid4()), "name": "Replacement phone"},
        )
    assert replacement.status_code == 201
    assert replacement.json()["state"] == "ready"
    assert fake.start_calls == 3


@pytest.mark.asyncio
async def test_failed_physical_logout_never_archives_or_unregisters_transport(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    custom_sidecar: tuple[UUID, FakeCustomSidecar],
) -> None:
    provider_session_id, fake = custom_sidecar
    created = await client.post(
        "/v1/channels/whatsapp/onboarding/sessions",
        json={"request_id": str(uuid4()), "name": "Logout guard phone"},
    )
    session_id = created.json()["id"]
    fake.current = WhatsAppSidecarPairingStatus(status="connected", registered=True)
    connected = await client.get(f"/v1/channels/whatsapp/onboarding/sessions/{session_id}")
    account_id = UUID(connected.json()["channel_account_id"])
    fake.logout_result = WhatsAppSidecarPairingStatus(
        status="connected",
        registered=True,
    )

    failed = await client.delete(f"/v1/channels/{account_id}")

    assert failed.status_code == 503
    account = await db_session.get(ChannelAccount, account_id)
    assert account is not None
    assert account.archived_at is None
    registry = get_active_whatsapp_sidecar_registry()
    assert registry is not None
    assert registry.custom_binding(account_id) == provider_session_id
    assert get_whatsapp_provider_transport(account_id) is not None

    fake.logout_result = WhatsAppSidecarPairingStatus(status="stopped", registered=False)
    deleted = await client.delete(f"/v1/channels/{account_id}")
    assert deleted.status_code == 204
    await db_session.refresh(account)
    assert account.archived_at is not None
    assert registry.custom_binding(account_id) is None
    assert get_whatsapp_provider_transport(account_id) is None


@pytest.mark.asyncio
async def test_failed_cancel_does_not_release_socket_ownership(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    custom_sidecar: tuple[UUID, FakeCustomSidecar],
) -> None:
    _sidecar_account_id, fake = custom_sidecar
    created = await client.post(
        "/v1/channels/whatsapp/onboarding/sessions",
        json={"request_id": str(uuid4()), "name": "Unsafe cancel"},
    )
    session_id = created.json()["id"]
    fake.cancel_result = WhatsAppSidecarPairingStatus(
        status="connected",
        registered=True,
    )
    fake.logout_result = fake.cancel_result
    failed = await client.post(f"/v1/channels/whatsapp/onboarding/sessions/{session_id}/cancel")
    assert failed.status_code == 503
    row = await db_session.get(ChannelWhatsAppOnboardingSession, UUID(session_id))
    assert row is not None
    assert row.state == "error"
    await db_session.refresh(seed_user)

    readiness = await client.get("/v1/channels/whatsapp/onboarding/readiness")
    assert readiness.json()["available"] is True
    assert row.channel_account_id is None
    assert (
        await db_session.scalar(
            select(ChannelAccount.id).where(
                ChannelAccount.user_id == seed_user.id,
                ChannelAccount.name == "Unsafe cancel",
            )
        )
        is None
    )

    fake.logout_result = WhatsAppSidecarPairingStatus(status="stopped", registered=False)
    row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    await db_session.commit()
    registry = get_active_whatsapp_sidecar_registry()
    assert registry is not None
    assert await expire_stale_whatsapp_onboarding_sessions(db_session, registry=registry) == 1
    await db_session.refresh(row)
    assert row.state == "expired"

    released = await client.get("/v1/channels/whatsapp/onboarding/readiness")
    assert released.json()["available"] is True


@pytest.mark.asyncio
async def test_sidecar_client_accepts_only_the_pinned_narrow_pairing_contract() -> None:
    account_id = uuid4()
    phone_number = "14155550123"
    api_token = "test-internal-token"
    session_prefix = f"/v1/sessions/{account_id}"
    seen_paths: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == f"Bearer {api_token}"
        seen_paths.append(request.url.path)
        if request.url.path == "/v1/health":
            return httpx.Response(
                200,
                json={
                    "schemaVersion": "clawdi.whatsapp.sidecar-health.v1",
                    "ready": True,
                    "activeSessions": 1,
                    "advertisedRelease": {
                        "packageName": "@whiskeysockets/baileys",
                        "packageVersion": "7.0.0-rc14",
                        "sourceCommit": "7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a",
                        "version": [2, 3000, 1043857760],
                    },
                },
            )
        if request.url.path == f"{session_prefix}/health":
            return httpx.Response(
                200,
                json={
                    "sessionId": str(account_id),
                    "status": "stopped",
                    "connected": False,
                    "registered": False,
                    "advertisedRelease": {
                        "packageName": "@whiskeysockets/baileys",
                        "packageVersion": "7.0.0-rc14",
                        "sourceCommit": "7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a",
                        "version": [2, 3000, 1043857760],
                    },
                },
            )
        if request.url.path == "/v1/capabilities":
            return httpx.Response(
                200,
                json={
                    "schemaVersion": "clawdi.whatsapp.sidecar-capabilities.v1",
                    "pairing": ["qr", "code", "cancel", "logout", "retry"],
                    "rawProviderAccess": False,
                },
            )
        if request.url.path == f"{session_prefix}/pairing/retry":
            return httpx.Response(200, json={"status": "starting", "registered": True})
        assert request.url.path == f"{session_prefix}/pairing/code"
        assert json.loads(request.content) == {"phoneNumber": phone_number}
        return httpx.Response(
            200,
            json={
                "status": "pairing_code",
                "registered": False,
                "method": "code",
                "code": "1234-5678",
            },
        )

    config = WhatsAppBaileysSidecarConfig(
        account_id=account_id,
        base_url="http://127.0.0.1:43191",
        api_token=api_token,
    )
    assert api_token not in repr(config)
    async with httpx.AsyncClient(
        base_url=config.base_url,
        transport=httpx.MockTransport(handler),
    ) as http_client:
        sidecar = WhatsAppBaileysSidecarClient(config, http_client=http_client)
        assert await sidecar.service_ready() is True
        assert (await sidecar.health()).registered is False
        assert "code" in (await sidecar.capabilities()).pairing
        pairing = await sidecar.pairing_code(phone_number)
        await sidecar.pairing_retry()

    assert pairing.code == "1234-5678"
    assert pairing.method == "code"
    assert seen_paths == [
        "/v1/health",
        f"{session_prefix}/health",
        "/v1/capabilities",
        f"{session_prefix}/pairing/code",
        f"{session_prefix}/pairing/retry",
    ]


@pytest.mark.asyncio
async def test_readiness_probes_the_global_service_without_creating_a_session(
    client: httpx.AsyncClient,
    custom_sidecar: tuple[UUID, FakeCustomSidecar],
) -> None:
    _session_id, fake = custom_sidecar
    fake.service_ready_result = False

    readiness = await client.get("/v1/channels/whatsapp/onboarding/readiness")

    assert readiness.status_code == 200
    assert readiness.json() == {
        "available": False,
        "manual_pairing_code_supported": False,
        "reason": "temporarily_unavailable",
    }


@pytest.mark.asyncio
async def test_sidecar_client_fails_closed_on_identity_and_capability_drift() -> None:
    account_id = uuid4()
    responses = [
        {
            "sessionId": str(account_id),
            "status": "stopped",
            "connected": False,
            "registered": False,
            "advertisedRelease": {
                "packageName": "@whiskeysockets/baileys",
                "packageVersion": "7.0.0-rc14",
                "sourceCommit": "unexpected",
                "version": [2, 3000, 1035194821],
            },
        },
        {
            "schemaVersion": "clawdi.whatsapp.sidecar-capabilities.v1",
            "pairing": ["qr", "cancel", "logout"],
            "rawProviderAccess": True,
        },
    ]

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=responses.pop(0))

    config = WhatsAppBaileysSidecarConfig(
        account_id=account_id,
        base_url="http://127.0.0.1:43191",
        api_token="test-internal-token",
    )
    async with httpx.AsyncClient(
        base_url=config.base_url,
        transport=httpx.MockTransport(handler),
    ) as http_client:
        sidecar = WhatsAppBaileysSidecarClient(config, http_client=http_client)
        with pytest.raises(WhatsAppSidecarProtocolError):
            await sidecar.health()
        with pytest.raises(WhatsAppSidecarProtocolError):
            await sidecar.capabilities()


def custom_sidecar_registry_revision(session_id: UUID) -> str:
    registry = get_active_whatsapp_sidecar_registry()
    assert registry is not None
    revision = registry.custom_session_revision(session_id)
    assert revision is not None
    return revision
