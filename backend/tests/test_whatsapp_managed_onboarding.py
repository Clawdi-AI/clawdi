from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException

from app.models.channel import (
    CHANNEL_PROVIDER_WHATSAPP,
    CHANNEL_STATUS_ACTIVE,
    CHANNEL_VISIBILITY_PUBLIC,
    WHATSAPP_ONBOARDING_OWNERSHIP_CUSTOM,
    WHATSAPP_ONBOARDING_STATE_GENERATING,
    ChannelAccount,
    ChannelWhatsAppOnboardingSession,
)
from app.services.channels import archive_channel_account
from app.services.whatsapp_device_onboarding import stop_whatsapp_pairing
from app.services.whatsapp_managed_onboarding import (
    cancel_managed_whatsapp_onboarding,
    expire_stale_managed_whatsapp_onboarding_sessions,
    get_managed_whatsapp_onboarding,
    require_managed_whatsapp_logout_for_archive,
    start_managed_whatsapp_onboarding,
)
from app.services.whatsapp_native_transport import (
    WhatsAppSidecarCapabilities,
    WhatsAppSidecarHealth,
    WhatsAppSidecarPairingStatus,
    WhatsAppSidecarProtocolError,
    WhatsAppSidecarUnavailableError,
)
from app.services.whatsapp_sidecar_registry import ConfiguredWhatsAppSidecarRegistry


class FakeManagedSidecar:
    transport_mode = "sidecar"

    def __init__(self) -> None:
        self.connected = False
        self.registered = False
        self.cancel_calls = 0
        self.logout_calls = 0
        self.stopped = False
        self.cancel_fails = False

    async def refresh_health(self) -> bool:
        return self.connected

    async def aclose(self) -> None:
        return None

    async def capabilities(self) -> WhatsAppSidecarCapabilities:
        return WhatsAppSidecarCapabilities(
            pairing=frozenset({"qr", "code", "cancel", "logout", "retry"})
        )

    async def health(self) -> WhatsAppSidecarHealth:
        status = (
            "connected" if self.connected else ("disconnected" if self.registered else "pairing_qr")
        )
        return WhatsAppSidecarHealth(
            status=status, connected=self.connected, registered=self.registered
        )

    async def pairing_qr(self) -> WhatsAppSidecarPairingStatus:
        self.stopped = False
        return await self.pairing_status()

    async def pairing_status(self) -> WhatsAppSidecarPairingStatus:
        if self.stopped:
            return WhatsAppSidecarPairingStatus(status="stopped", registered=False)
        if self.registered:
            return WhatsAppSidecarPairingStatus(
                status="connected" if self.connected else "disconnected", registered=True
            )
        return WhatsAppSidecarPairingStatus(
            status="pairing_qr",
            registered=False,
            qr="ephemeral-qr",
            qr_expires_at=datetime.now(UTC) + timedelta(seconds=30),
        )

    async def pairing_cancel(self) -> WhatsAppSidecarPairingStatus:
        self.cancel_calls += 1
        if self.registered:
            raise AssertionError("registered auth must be logged out")
        if self.cancel_fails:
            raise WhatsAppSidecarUnavailableError("injected cancel failure")
        self.stopped = True
        return WhatsAppSidecarPairingStatus(status="stopped", registered=False)

    async def pairing_retry(self) -> WhatsAppSidecarPairingStatus:
        self.connected = True
        return await self.pairing_status()

    async def pairing_logout(self) -> WhatsAppSidecarPairingStatus:
        self.logout_calls += 1
        self.connected = False
        self.registered = False
        self.stopped = True
        return WhatsAppSidecarPairingStatus(status="stopped", registered=False)

    async def provider_events(self, *, limit: int = 100):
        return []

    async def acknowledge_provider_events(self, *, through_sequence: int) -> None:
        return None

    async def relay_message(self, request):
        return request.message_id

    async def send_node(self, node) -> None:
        return None

    async def query(self, node, timeout_ms):
        return None


def _registry(account_id: UUID, fake: FakeManagedSidecar) -> ConfiguredWhatsAppSidecarRegistry:
    return ConfiguredWhatsAppSidecarRegistry(
        json.dumps(
            {
                str(account_id): {
                    "base_url": "http://127.0.0.1:43193",
                    "api_token": "fake",
                }
            }
        ),
        client_factory=lambda _config: fake,
    )


async def _start(db_session, seed_user, registry, account_id, *, request_id=None, name="Shared"):
    return await start_managed_whatsapp_onboarding(
        db_session,
        account_id=account_id,
        user_id=seed_user.id,
        request_id=request_id or uuid4(),
        name=name,
        registry=registry,
    )


@pytest.mark.asyncio
async def test_bind_failure_rolls_back_promotion_and_marks_reservation_error(
    db_session, seed_user, monkeypatch
):
    account_id = uuid4()
    fake = FakeManagedSidecar()
    registry = _registry(account_id, fake)
    await registry.start()
    try:
        started = await _start(db_session, seed_user, registry, account_id)
        fake.connected = fake.registered = True

        async def fail_bind(*_args, **_kwargs):
            raise WhatsAppSidecarProtocolError("injected bind failure")

        monkeypatch.setattr(registry, "bind_managed_account", fail_bind)
        with pytest.raises(HTTPException) as exc_info:
            await get_managed_whatsapp_onboarding(
                db_session, session_id=started.id, registry=registry
            )
        assert exc_info.value.status_code == 503
        assert await db_session.get(ChannelAccount, account_id) is None
        session = await db_session.get(ChannelWhatsAppOnboardingSession, started.id)
        assert session is not None
        assert session.state == "error"
        assert session.channel_account_id is None
        assert not registry.managed_is_bound(account_id)
    finally:
        await registry.stop()


@pytest.mark.asyncio
async def test_registered_disconnected_cancel_recovers_with_logout(db_session, seed_user):
    account_id = uuid4()
    fake = FakeManagedSidecar()
    registry = _registry(account_id, fake)
    await registry.start()
    try:
        started = await _start(db_session, seed_user, registry, account_id)
        fake.registered = True
        canceled = await cancel_managed_whatsapp_onboarding(
            db_session, session_id=started.id, registry=registry
        )
        assert canceled.state == "canceled"
        assert fake.logout_calls == 1
        assert fake.cancel_calls == 0
        assert await db_session.get(ChannelAccount, account_id) is None
    finally:
        await registry.stop()


@pytest.mark.asyncio
async def test_cancel_failure_retains_ownership_until_confirmed_retry(db_session, seed_user):
    account_id = uuid4()
    fake = FakeManagedSidecar()
    registry = _registry(account_id, fake)
    await registry.start()
    try:
        started = await _start(db_session, seed_user, registry, account_id)
        fake.cancel_fails = True
        with pytest.raises(HTTPException) as exc_info:
            await cancel_managed_whatsapp_onboarding(
                db_session, session_id=started.id, registry=registry
            )
        assert exc_info.value.status_code == 503
        session = await db_session.get(ChannelWhatsAppOnboardingSession, started.id)
        assert session.state == "error"

        fake.cancel_fails = False
        canceled = await cancel_managed_whatsapp_onboarding(
            db_session, session_id=started.id, registry=registry
        )
        assert canceled.state == "canceled"
    finally:
        await registry.stop()


@pytest.mark.asyncio
async def test_expired_managed_reservation_confirms_stop(db_session, seed_user):
    account_id = uuid4()
    fake = FakeManagedSidecar()
    registry = _registry(account_id, fake)
    await registry.start()
    try:
        started = await _start(db_session, seed_user, registry, account_id)
        session = await db_session.get(ChannelWhatsAppOnboardingSession, started.id)
        session.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await db_session.commit()
        assert (
            await expire_stale_managed_whatsapp_onboarding_sessions(db_session, registry=registry)
            == 1
        )
        await db_session.refresh(session)
        assert session.state == "expired"
        assert fake.cancel_calls == 1
    finally:
        await registry.stop()


@pytest.mark.asyncio
async def test_expired_reservation_promotes_connected_registered_sidecar(db_session, seed_user):
    account_id = uuid4()
    fake = FakeManagedSidecar()
    registry = _registry(account_id, fake)
    await registry.start()
    try:
        started = await _start(db_session, seed_user, registry, account_id)
        session = await db_session.get(ChannelWhatsAppOnboardingSession, started.id)
        session.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await db_session.commit()
        fake.connected = fake.registered = True

        assert (
            await expire_stale_managed_whatsapp_onboarding_sessions(db_session, registry=registry)
            == 0
        )
        account = await db_session.get(ChannelAccount, account_id)
        assert account is not None
        await db_session.refresh(session)
        assert session.state == "connected"
        assert fake.logout_calls == 0
        assert fake.cancel_calls == 0
    finally:
        await registry.stop()


@pytest.mark.asyncio
async def test_logout_then_archive_rollback_is_idempotent_on_retry(db_session, seed_user):
    account_id = uuid4()
    fake = FakeManagedSidecar()
    registry = _registry(account_id, fake)
    await registry.start()
    try:
        started = await _start(db_session, seed_user, registry, account_id)
        fake.connected = fake.registered = True
        await get_managed_whatsapp_onboarding(db_session, session_id=started.id, registry=registry)
        account = await db_session.get(ChannelAccount, account_id)
        await require_managed_whatsapp_logout_for_archive(account=account, registry=registry)
        assert fake.logout_calls == 1
        await archive_channel_account(db_session, account=account)
        await db_session.rollback()

        account = await db_session.get(ChannelAccount, account_id)
        assert account.archived_at is None
        await require_managed_whatsapp_logout_for_archive(account=account, registry=registry)
        assert fake.logout_calls == 1
        assert fake.cancel_calls == 0
        await archive_channel_account(db_session, account=account)
        await db_session.commit()
        assert account.archived_at is not None
    finally:
        await registry.stop()


@pytest.mark.asyncio
async def test_custom_and_managed_request_ids_are_isolated_and_duplicate_name_is_controlled(
    db_session, seed_user
):
    account_id = uuid4()
    request_id = uuid4()
    now = datetime.now(UTC)
    db_session.add(
        ChannelWhatsAppOnboardingSession(
            ownership_kind=WHATSAPP_ONBOARDING_OWNERSHIP_CUSTOM,
            sidecar_account_id=uuid4(),
            sidecar_config_revision="custom-revision",
            user_id=seed_user.id,
            request_id=request_id,
            name="Custom",
            state=WHATSAPP_ONBOARDING_STATE_GENERATING,
            method="qr",
            started_at=now,
            expires_at=now + timedelta(minutes=5),
        )
    )
    await db_session.commit()
    fake = FakeManagedSidecar()
    registry = _registry(account_id, fake)
    await registry.start()
    try:
        existing = ChannelAccount(
            user_id=seed_user.id,
            provider=CHANNEL_PROVIDER_WHATSAPP,
            name="Existing",
            status=CHANNEL_STATUS_ACTIVE,
            visibility=CHANNEL_VISIBILITY_PUBLIC,
            webhook_secret_hash="0" * 64,
            config={},
        )
        db_session.add(existing)
        await db_session.commit()
        with pytest.raises(HTTPException) as start_conflict:
            await _start(
                db_session,
                seed_user,
                registry,
                account_id,
                request_id=uuid4(),
                name="Existing",
            )
        assert start_conflict.value.status_code == 409
        started = await _start(
            db_session,
            seed_user,
            registry,
            account_id,
            request_id=request_id,
            name="Duplicate",
        )
        db_session.add(
            ChannelAccount(
                user_id=seed_user.id,
                provider=CHANNEL_PROVIDER_WHATSAPP,
                name="Duplicate",
                status=CHANNEL_STATUS_ACTIVE,
                visibility=CHANNEL_VISIBILITY_PUBLIC,
                webhook_secret_hash="0" * 64,
                config={},
            )
        )
        await db_session.commit()
        fake.connected = fake.registered = True
        with pytest.raises(HTTPException) as exc_info:
            await get_managed_whatsapp_onboarding(
                db_session, session_id=started.id, registry=registry
            )
        assert exc_info.value.status_code == 409
        assert await db_session.get(ChannelAccount, account_id) is None
        session = await db_session.get(ChannelWhatsAppOnboardingSession, started.id)
        assert session.state == "error"
    finally:
        await registry.stop()


@pytest.mark.asyncio
async def test_restart_reconciliation_fails_closed_on_revision_and_physical_drift(
    db_session, seed_user
):
    account_id = uuid4()
    fake = FakeManagedSidecar()
    registry = _registry(account_id, fake)
    revision = registry.managed_account_revision(account_id)
    account = ChannelAccount(
        id=account_id,
        user_id=seed_user.id,
        provider=CHANNEL_PROVIDER_WHATSAPP,
        name="Shared",
        status=CHANNEL_STATUS_ACTIVE,
        visibility=CHANNEL_VISIBILITY_PUBLIC,
        webhook_secret_hash="0" * 64,
        config={
            "connection_mode": "baileys_managed",
            "sidecar_config_revision": "drifted",
        },
    )
    db_session.add(account)
    await db_session.commit()
    await registry.start()
    try:
        fake.connected = fake.registered = True
        await registry.reconcile_managed_ownership(db_session)
        assert not registry.managed_is_bound(account_id)

        account.config = {
            "connection_mode": "baileys_managed",
            "sidecar_config_revision": revision,
        }
        await db_session.commit()
        fake.connected = False
        await registry.reconcile_managed_ownership(db_session)
        assert not registry.managed_is_bound(account_id)

        fake.connected = True
        await registry.reconcile_managed_ownership(db_session)
        assert registry.managed_is_bound(account_id)

        fake.connected = fake.registered = False
        await registry.reconcile_managed_ownership(db_session)
        assert not registry.managed_is_bound(account_id)

        fake.connected = fake.registered = True
        await registry.reconcile_managed_ownership(db_session)
        assert registry.managed_is_bound(account_id)
        account.config = {
            "connection_mode": "baileys_managed",
            "sidecar_config_revision": "drifted-again",
        }
        await db_session.commit()
        await registry.reconcile_managed_ownership(db_session)
        assert not registry.managed_is_bound(account_id)
    finally:
        await registry.stop()


@pytest.mark.asyncio
async def test_registered_logout_unavailable_retries_with_backoff(monkeypatch):
    fake = FakeManagedSidecar()
    fake.connected = fake.registered = True
    failures = 3
    sleeps: list[float] = []
    original_logout = fake.pairing_logout

    async def flaky_logout():
        nonlocal failures
        if failures:
            failures -= 1
            raise WhatsAppSidecarUnavailableError("injected transient failure")
        return await original_logout()

    async def record_sleep(delay: float) -> None:
        sleeps.append(delay)

    monkeypatch.setattr(fake, "pairing_logout", flaky_logout)
    monkeypatch.setattr("app.services.whatsapp_device_onboarding.asyncio.sleep", record_sleep)
    result = await stop_whatsapp_pairing(fake)
    assert result.status == "stopped"
    assert sleeps == [0.25, 0.25, 0.25]
