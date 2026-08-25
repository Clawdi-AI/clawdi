from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import Literal, Protocol
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import async_session_factory
from app.models.channel import (
    CHANNEL_PROVIDER_WHATSAPP,
    CHANNEL_STATUS_ACTIVE,
    CHANNEL_VISIBILITY_PUBLIC,
    WHATSAPP_ONBOARDING_OWNERSHIP_CUSTOM,
    WHATSAPP_ONBOARDING_STATE_ERROR,
    ChannelAccount,
    ChannelWhatsAppOnboardingSession,
)
from app.services.metrics import provider_ingress_terminal_events
from app.services.whatsapp_delivery_transport import (
    DEFAULT_WHATSAPP_SIDECAR_SOCKET_PATH,
    configured_whatsapp_sidecar_session_id,
)
from app.services.whatsapp_native_transport import (
    WhatsAppBaileysSidecarClient,
    WhatsAppBaileysSidecarConfig,
    WhatsAppBaileysSidecarService,
    WhatsAppNativeUpstreamClient,
    WhatsAppProviderEvent,
    WhatsAppProviderTransportAdapter,
    WhatsAppRejectedProviderEvent,
    WhatsAppSidecarCapabilities,
    WhatsAppSidecarError,
    WhatsAppSidecarHealth,
    WhatsAppSidecarPairingStatus,
    WhatsAppSidecarProtocolError,
)
from app.services.whatsapp_provider_bridge import (
    WhatsAppProviderAccountRetired,
    persist_whatsapp_provider_event,
    register_whatsapp_provider_transport,
    unregister_whatsapp_provider_transport,
)

log = logging.getLogger(__name__)
_UNRELEASED_STATES = (
    "generating",
    "ready",
    "scanned",
    WHATSAPP_ONBOARDING_STATE_ERROR,
)
_PROVIDER_EVENTS_WAIT_MS = 8_000
_PROVIDER_INGRESS_RETRY_INITIAL_SECONDS = 1.0
_PROVIDER_INGRESS_RETRY_MAX_SECONDS = 60.0
_PROVIDER_INGRESS_EMPTY_POLL_DELAY_SECONDS = 0.1
type _TerminalProviderEventReason = Literal[
    "invalid_schema",
    "identity_too_long",
    "payload_too_large",
    "persistence_data_error",
]


def _record_terminal_provider_event(
    account_id: UUID,
    *,
    sequence: int,
    reason: _TerminalProviderEventReason,
) -> None:
    provider_ingress_terminal_events.labels(channel="whatsapp", reason=reason).inc()
    log.error(
        "WhatsApp provider ingress terminally acknowledged account=%s sequence=%s reason=%s",
        account_id,
        sequence,
        reason,
    )


def _is_terminal_provider_data_error(exc: DBAPIError) -> bool:
    # asyncpg's SQLAlchemy adapter maps Postgres data exceptions through its
    # generic DBAPI Error. SQLSTATE 22001 is the deterministic varchar overflow
    # observed in production; other DB failures must remain retryable.
    return getattr(exc.orig, "sqlstate", None) == "22001"


class WhatsAppSidecarClient(WhatsAppNativeUpstreamClient, Protocol):
    async def aclose(self) -> None: ...

    async def service_ready(self) -> bool: ...

    async def refresh_health(self) -> bool: ...

    async def provider_events(
        self,
        *,
        limit: int = 100,
        wait_ms: int = 0,
    ) -> list[WhatsAppProviderEvent]: ...

    async def acknowledge_provider_events(self, *, through_sequence: int) -> None: ...

    async def health(self) -> WhatsAppSidecarHealth: ...

    async def capabilities(self) -> WhatsAppSidecarCapabilities: ...

    async def pairing_status(self) -> WhatsAppSidecarPairingStatus: ...

    async def pairing_qr(self) -> WhatsAppSidecarPairingStatus: ...

    async def pairing_code(self, phone_number: str) -> WhatsAppSidecarPairingStatus: ...

    async def pairing_cancel(self) -> WhatsAppSidecarPairingStatus: ...

    async def pairing_logout(self) -> WhatsAppSidecarPairingStatus: ...

    async def pairing_retry(self) -> WhatsAppSidecarPairingStatus: ...

    async def pairing_recover(self) -> WhatsAppSidecarPairingStatus: ...


class WhatsAppSidecarClients(Protocol):
    @property
    def enabled(self) -> bool: ...

    async def service_ready(self) -> bool: ...

    def session_client(self, session_id: UUID) -> WhatsAppSidecarClient | None: ...

    def session_revision(self, session_id: UUID) -> str | None: ...


SidecarClientFactory = Callable[[WhatsAppBaileysSidecarConfig], WhatsAppSidecarClient]
_active_sidecar_clients: ConfiguredWhatsAppSidecarClientPool | None = None


class ConfiguredWhatsAppSidecarClientPool:
    """Process-local HTTP pool for stateless sidecar control operations."""

    def __init__(
        self,
        api_token: str,
        *,
        base_url: str | None = None,
        unix_socket_path: str = DEFAULT_WHATSAPP_SIDECAR_SOCKET_PATH,
        timeout_seconds: float = 10.0,
        client_factory: SidecarClientFactory | None = None,
    ) -> None:
        self._api_token = api_token.strip()
        self._base_url = base_url.strip() if base_url else None
        self._unix_socket_path = None if self._base_url else unix_socket_path
        self._timeout_seconds = timeout_seconds
        self._client_factory = client_factory or WhatsAppBaileysSidecarClient
        self._uses_shared_service = client_factory is None and self.enabled
        self._shared_service: WhatsAppBaileysSidecarService | None = None
        self._service_client: WhatsAppSidecarClient | None = None
        self._clients_by_session: dict[UUID, WhatsAppSidecarClient] = {}
        self._started = False
        if self.enabled:
            self._service_config()

    @property
    def enabled(self) -> bool:
        return bool(self._api_token)

    async def start(self) -> None:
        global _active_sidecar_clients
        if self._started or _active_sidecar_clients is not None:
            raise RuntimeError("WhatsApp sidecar clients are already started")
        if self._uses_shared_service and self._shared_service is None:
            self._shared_service = WhatsAppBaileysSidecarService(self._service_config())
        self._started = True
        _active_sidecar_clients = self

    async def stop(self) -> None:
        global _active_sidecar_clients
        if _active_sidecar_clients is self:
            _active_sidecar_clients = None
        self._started = False
        clients = tuple(self._clients_by_session.values())
        self._clients_by_session.clear()
        if self._service_client is not None:
            clients = (*clients, self._service_client)
            self._service_client = None
        if clients:
            await asyncio.gather(*(client.aclose() for client in clients), return_exceptions=True)
        if self._shared_service is not None:
            await self._shared_service.aclose()
            self._shared_service = None

    async def service_ready(self) -> bool:
        if not self._started or not self.enabled:
            return False
        if self._shared_service is not None:
            try:
                return await self._shared_service.service_ready()
            except WhatsAppSidecarError:
                return False
        if self._service_client is None:
            self._service_client = self._client_factory(self._service_config())
        try:
            return await self._service_client.service_ready()
        except WhatsAppSidecarError:
            return False

    def session_client(self, session_id: UUID) -> WhatsAppSidecarClient | None:
        return self._client(session_id)

    def session_revision(self, session_id: UUID) -> str | None:
        config = self._session_config(session_id)
        return config.binding_revision if config is not None else None

    def _client(self, session_id: UUID) -> WhatsAppSidecarClient | None:
        if not self._started or not self.enabled:
            return None
        client = self._clients_by_session.get(session_id)
        if client is None:
            config = self._session_config(session_id)
            if config is None:
                return None
            client = (
                self._shared_service.session_client(session_id)
                if self._shared_service is not None
                else self._client_factory(config)
            )
            self._clients_by_session[session_id] = client
        return client

    def _session_config(self, session_id: UUID) -> WhatsAppBaileysSidecarConfig | None:
        if not self.enabled:
            return None
        return WhatsAppBaileysSidecarConfig(
            api_token=self._api_token,
            base_url=self._base_url,
            unix_socket_path=self._unix_socket_path,
            timeout_seconds=self._timeout_seconds,
            account_id=session_id,
        )

    def _service_config(self) -> WhatsAppBaileysSidecarConfig:
        return WhatsAppBaileysSidecarConfig(
            api_token=self._api_token,
            base_url=self._base_url,
            unix_socket_path=self._unix_socket_path,
            timeout_seconds=self._timeout_seconds,
        )


class ConfiguredWhatsAppSidecarRegistry(ConfiguredWhatsAppSidecarClientPool):
    """Own provider ingress and account bindings in the channel worker."""

    def __init__(
        self,
        api_token: str,
        *,
        base_url: str | None = None,
        unix_socket_path: str = DEFAULT_WHATSAPP_SIDECAR_SOCKET_PATH,
        timeout_seconds: float = 10.0,
        client_factory: SidecarClientFactory | None = None,
    ) -> None:
        super().__init__(
            api_token,
            base_url=base_url,
            unix_socket_path=unix_socket_path,
            timeout_seconds=timeout_seconds,
            client_factory=client_factory,
        )
        self._bound_managed_accounts: set[UUID] = set()
        self._managed_attach_failures: dict[UUID, str] = {}
        self._custom_session_to_account: dict[UUID, UUID] = {}
        self._custom_account_to_session: dict[UUID, UUID] = {}
        self._blocked_custom_sessions: set[UUID] = set()
        self._ingress_tasks: dict[UUID, asyncio.Task[None]] = {}
        self._custom_reconcile_lock = asyncio.Lock()

    @property
    def managed_account_ids(self) -> tuple[UUID, ...]:
        return tuple(sorted(self._bound_managed_accounts, key=str))

    def get_custom_client(self, session_id: UUID) -> WhatsAppSidecarClient | None:
        if session_id in self._blocked_custom_sessions:
            return None
        return self._client(session_id)

    def get_custom_lifecycle_client(
        self,
        session_id: UUID,
        *,
        config_revision: str,
    ) -> WhatsAppSidecarClient | None:
        """Inspect a Custom session even when normal message transport is blocked."""

        if self.custom_session_revision(session_id) != config_revision:
            return None
        return self._client(session_id)

    def get_managed_client(self, session_id: UUID) -> WhatsAppSidecarClient | None:
        return self._client(session_id)

    def managed_account_revision(self, session_id: UUID) -> str | None:
        config = self._session_config(session_id)
        return config.binding_revision if config is not None else None

    def managed_is_bound(self, account_id: UUID) -> bool:
        return account_id in self._bound_managed_accounts

    def custom_session_is_blocked(self, session_id: UUID) -> bool:
        return session_id in self._blocked_custom_sessions

    def custom_session_revision(self, session_id: UUID) -> str | None:
        config = self._session_config(session_id)
        return config.binding_revision if config is not None else None

    def custom_binding(self, account_id: UUID) -> UUID | None:
        return self._custom_account_to_session.get(account_id)

    def custom_account_for_session(self, session_id: UUID) -> UUID | None:
        return self._custom_session_to_account.get(session_id)

    async def stop(self) -> None:
        tasks = tuple(self._ingress_tasks.values())
        self._ingress_tasks.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        for account_id in (*self._bound_managed_accounts, *self._custom_account_to_session):
            unregister_whatsapp_provider_transport(account_id)
        self._bound_managed_accounts.clear()
        self._managed_attach_failures.clear()
        self._custom_session_to_account.clear()
        self._custom_account_to_session.clear()
        self._blocked_custom_sessions.clear()
        await super().stop()

    async def bind_managed_account(self, account_id: UUID, *, config_revision: str) -> bool:
        client = self._client(account_id)
        expected_revision = self.managed_account_revision(account_id)
        if client is None or expected_revision != config_revision:
            raise WhatsAppSidecarProtocolError("managed Baileys session is unavailable")
        if account_id in self._bound_managed_accounts:
            return False
        self._register_transport(account_id, client)
        self._bound_managed_accounts.add(account_id)
        return True

    async def unbind_managed_account(self, account_id: UUID) -> bool:
        if account_id not in self._bound_managed_accounts:
            return False
        await self._unbind_transport(account_id)
        self._bound_managed_accounts.remove(account_id)
        return True

    async def reconcile_managed_ownership(self, db: AsyncSession | None = None) -> None:
        if not self.enabled:
            return
        if db is None:
            async with async_session_factory() as owned_db:
                accounts = await self._managed_accounts(owned_db)
        else:
            accounts = await self._managed_accounts(db)
        desired: dict[UUID, str] = {}
        account_ids = {account.id for account in accounts}
        for account in accounts:
            config = account.config if isinstance(account.config, dict) else {}
            revision = config.get("sidecar_config_revision")
            if config.get("connection_mode") != "baileys_managed" or not isinstance(revision, str):
                self._record_managed_attach_failure(account.id, "invalid_physical_identity")
                continue
            desired[account.id] = revision
        for account_id in tuple(self._bound_managed_accounts - desired.keys()):
            await self.unbind_managed_account(account_id)
        for account_id in tuple(self._managed_attach_failures.keys() - account_ids):
            self._managed_attach_failures.pop(account_id, None)
        for account_id, revision in desired.items():
            try:
                client = self._client(account_id)
                if client is None or self.managed_account_revision(account_id) != revision:
                    raise WhatsAppSidecarProtocolError("managed Baileys session is unavailable")
                health = await client.health()
                pairing = await client.pairing_status()
                if (
                    not health.connected
                    or not health.registered
                    or health.account_lid is None
                    or pairing.status != "connected"
                    or not pairing.registered
                ):
                    raise WhatsAppSidecarProtocolError(
                        "managed Baileys physical auth is unavailable"
                    )
                await self.bind_managed_account(account_id, config_revision=revision)
                if self._managed_attach_failures.pop(account_id, None) is not None:
                    log.info("WhatsApp managed account %s attachment recovered", account_id)
            except WhatsAppSidecarError:
                if account_id in self._bound_managed_accounts:
                    await self.unbind_managed_account(account_id)
                self._record_managed_attach_failure(account_id, "physical_auth_unavailable")

    def _record_managed_attach_failure(self, account_id: UUID, reason: str) -> None:
        if self._managed_attach_failures.get(account_id) == reason:
            return
        self._managed_attach_failures[account_id] = reason
        log.error(
            "WhatsApp managed account %s is not safe to attach: %s",
            account_id,
            reason,
        )

    async def _managed_accounts(self, db: AsyncSession) -> list[ChannelAccount]:
        return list(
            (
                await db.scalars(
                    select(ChannelAccount).where(
                        ChannelAccount.provider == CHANNEL_PROVIDER_WHATSAPP,
                        ChannelAccount.visibility == CHANNEL_VISIBILITY_PUBLIC,
                        ChannelAccount.user_id.is_(None),
                        ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
                        ChannelAccount.archived_at.is_(None),
                    )
                )
            ).all()
        )

    async def bind_custom_account(
        self,
        *,
        session_id: UUID,
        account_id: UUID,
        config_revision: str,
    ) -> bool:
        async with self._custom_reconcile_lock:
            return self._bind_custom_account_unlocked(
                session_id=session_id,
                account_id=account_id,
                config_revision=config_revision,
            )

    async def prepare_custom_account_repair(
        self,
        *,
        session_id: UUID,
        account_id: UUID,
        config_revision: str,
    ) -> WhatsAppSidecarClient:
        """Detach delivery and explicitly admit one validated session for repair."""

        async with self._custom_reconcile_lock:
            if self.custom_session_revision(session_id) != config_revision:
                raise WhatsAppSidecarProtocolError("custom Baileys session revision mismatch")
            existing_account = self._custom_session_to_account.get(session_id)
            existing_session = self._custom_account_to_session.get(account_id)
            unbound = existing_account is None and existing_session is None
            bound_to_account = existing_account == account_id and existing_session == session_id
            if not unbound and not bound_to_account:
                raise WhatsAppSidecarProtocolError("custom Baileys session ownership conflict")
            if bound_to_account:
                await self._unbind_custom_account_unlocked(
                    session_id=session_id,
                    account_id=account_id,
                )
            self._blocked_custom_sessions.discard(session_id)
            client = self._client(session_id)
            if client is None:
                raise WhatsAppSidecarProtocolError("custom Baileys session is unavailable")
            return client

    def _bind_custom_account_unlocked(
        self,
        *,
        session_id: UUID,
        account_id: UUID,
        config_revision: str,
    ) -> bool:
        if session_id in self._blocked_custom_sessions:
            raise WhatsAppSidecarProtocolError("custom Baileys session is unavailable")
        if config_revision != self.custom_session_revision(session_id):
            raise WhatsAppSidecarProtocolError("custom Baileys session revision mismatch")
        existing_account = self._custom_session_to_account.get(session_id)
        existing_session = self._custom_account_to_session.get(account_id)
        if existing_account == account_id and existing_session == session_id:
            return False
        if existing_account is not None or existing_session is not None:
            raise WhatsAppSidecarProtocolError("custom Baileys session ownership conflict")
        client = self._client(session_id)
        if client is None:
            raise WhatsAppSidecarProtocolError("custom Baileys session is unavailable")
        self._register_transport(account_id, client)
        self._custom_session_to_account[session_id] = account_id
        self._custom_account_to_session[account_id] = session_id
        return True

    async def unbind_custom_account(self, *, session_id: UUID, account_id: UUID) -> bool:
        async with self._custom_reconcile_lock:
            return await self._unbind_custom_account_unlocked(
                session_id=session_id,
                account_id=account_id,
            )

    async def _unbind_custom_account_unlocked(
        self,
        *,
        session_id: UUID,
        account_id: UUID,
    ) -> bool:
        existing_account = self._custom_session_to_account.get(session_id)
        existing_session = self._custom_account_to_session.get(account_id)
        if existing_account is None and existing_session is None:
            return False
        if existing_account != account_id or existing_session != session_id:
            raise WhatsAppSidecarProtocolError("custom Baileys session ownership conflict")
        await self._unbind_transport(account_id)
        self._custom_session_to_account.pop(session_id, None)
        self._custom_account_to_session.pop(account_id, None)
        return True

    async def reconcile_custom_ownership(self, db: AsyncSession | None = None) -> None:
        if not self.enabled:
            return
        async with self._custom_reconcile_lock:
            if db is None:
                async with async_session_factory() as owned_db:
                    accounts, sessions = await self._custom_ownership_rows(owned_db)
            else:
                accounts, sessions = await self._custom_ownership_rows(db)

            owners: dict[UUID, tuple[UUID, str]] = {}
            invalid_sessions: set[UUID] = set()
            for account in accounts:
                config = account.config if isinstance(account.config, dict) else {}
                if config.get("connection_mode") != "baileys_custom":
                    continue
                session_id = configured_whatsapp_sidecar_session_id(config)
                revision = config.get("sidecar_config_revision")
                if session_id is None or not isinstance(revision, str) or session_id in owners:
                    if session_id is not None:
                        invalid_sessions.add(session_id)
                    log.error(
                        "WhatsApp Custom account %s has invalid physical identity",
                        account.id,
                    )
                    continue
                owners[session_id] = (account.id, revision)

            reservations: dict[UUID, str] = {}
            for session in sessions:
                if session.sidecar_account_id in reservations:
                    invalid_sessions.add(session.sidecar_account_id)
                reservations[session.sidecar_account_id] = session.sidecar_config_revision

            desired_sessions = set(owners) | set(reservations)
            for session_id in desired_sessions:
                owner = owners.get(session_id)
                reservation_revision = reservations.get(session_id)
                expected_revision = self.custom_session_revision(session_id)
                current_account = self._custom_session_to_account.get(session_id)
                desired_account = owner[0] if owner is not None else None
                if (
                    current_account is not None
                    and current_account != desired_account
                    and not (desired_account is None and reservation_revision is not None)
                ):
                    await self._unbind_custom_account_unlocked(
                        session_id=session_id,
                        account_id=current_account,
                    )
                    current_account = None
                client = self._client(session_id)
                if client is None or session_id in invalid_sessions:
                    await self._block_custom_session_unlocked(session_id, current_account)
                    continue
                try:
                    await client.capabilities()
                    health = await client.health()
                    pairing = await client.pairing_status()
                except WhatsAppSidecarError:
                    await self._block_custom_session_unlocked(session_id, current_account)
                    log.warning("WhatsApp Custom session %s is unavailable", session_id)
                    continue
                if (
                    expected_revision is None
                    or health.registered != pairing.registered
                    or (health.registered and health.account_lid is None)
                    or (owner is not None and owner[1] != expected_revision)
                    or (
                        reservation_revision is not None
                        and reservation_revision != expected_revision
                    )
                ):
                    await self._block_custom_session_unlocked(session_id, current_account)
                    log.error("WhatsApp Custom session %s failed identity validation", session_id)
                    continue
                if owner is not None:
                    if (
                        health.last_disconnect_reason == "remote_logged_out"
                        or not pairing.registered
                    ):
                        await self._block_custom_session_unlocked(session_id, current_account)
                        continue
                    self._blocked_custom_sessions.discard(session_id)
                    self._bind_custom_account_unlocked(
                        session_id=session_id,
                        account_id=owner[0],
                        config_revision=owner[1],
                    )
                else:
                    if health.connected and not pairing.registered:
                        await self._block_custom_session_unlocked(session_id, current_account)
                    else:
                        self._blocked_custom_sessions.discard(session_id)

    async def _custom_ownership_rows(
        self,
        db: AsyncSession,
    ) -> tuple[list[ChannelAccount], list[ChannelWhatsAppOnboardingSession]]:
        accounts = list(
            (
                await db.scalars(
                    select(ChannelAccount).where(
                        ChannelAccount.provider == CHANNEL_PROVIDER_WHATSAPP,
                        ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
                        ChannelAccount.archived_at.is_(None),
                    )
                )
            ).all()
        )
        sessions = list(
            (
                await db.scalars(
                    select(ChannelWhatsAppOnboardingSession).where(
                        ChannelWhatsAppOnboardingSession.ownership_kind
                        == WHATSAPP_ONBOARDING_OWNERSHIP_CUSTOM,
                        ChannelWhatsAppOnboardingSession.state.in_(_UNRELEASED_STATES),
                    )
                )
            ).all()
        )
        return accounts, sessions

    async def _block_custom_session_unlocked(
        self,
        session_id: UUID,
        account_id: UUID | None,
    ) -> None:
        if account_id is not None:
            await self._unbind_custom_account_unlocked(
                session_id=session_id,
                account_id=account_id,
            )
        self._blocked_custom_sessions.add(session_id)

    def _register_transport(self, account_id: UUID, client: WhatsAppSidecarClient) -> None:
        register_whatsapp_provider_transport(
            account_id,
            WhatsAppProviderTransportAdapter(client),
        )
        try:
            self._ingress_tasks[account_id] = asyncio.create_task(
                self._pump_provider_ingress(account_id, client),
                name=f"whatsapp-provider-ingress-{account_id}",
            )
        except BaseException:
            unregister_whatsapp_provider_transport(account_id)
            raise

    def _release_terminal_ingress_owner(
        self,
        account_id: UUID,
        task: asyncio.Task[None] | None,
    ) -> None:
        """Release local ownership from inside a terminal pump without awaiting itself."""

        if self._ingress_tasks.get(account_id) is not task:
            return
        self._ingress_tasks.pop(account_id, None)
        unregister_whatsapp_provider_transport(account_id)
        self._bound_managed_accounts.discard(account_id)
        session_id = self._custom_account_to_session.pop(account_id, None)
        if session_id is not None:
            self._custom_session_to_account.pop(session_id, None)

    async def _unbind_transport(self, account_id: UUID) -> None:
        task = self._ingress_tasks.pop(account_id, None)
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        unregister_whatsapp_provider_transport(account_id)

    async def _pump_provider_ingress(
        self,
        account_id: UUID,
        client: WhatsAppSidecarClient,
    ) -> None:
        retry_seconds = _PROVIDER_INGRESS_RETRY_INITIAL_SECONDS
        while True:
            try:
                events = await client.provider_events(
                    # The sidecar acknowledgement cursor is ordered. Pull one
                    # event so a terminally bad row can be acknowledged without
                    # accidentally skipping an unprocessed later row.
                    limit=1,
                    wait_ms=_PROVIDER_EVENTS_WAIT_MS,
                )
                if not events:
                    # A compatible older endpoint may ignore wait_ms and return
                    # immediately. Keep that endpoint from becoming a busy loop.
                    await asyncio.sleep(_PROVIDER_INGRESS_EMPTY_POLL_DELAY_SECONDS)
                    retry_seconds = _PROVIDER_INGRESS_RETRY_INITIAL_SECONDS
                    continue
                event = events[0]
                if isinstance(event, WhatsAppRejectedProviderEvent):
                    _record_terminal_provider_event(
                        account_id,
                        sequence=event.sequence,
                        reason=event.reason,
                    )
                else:
                    try:
                        async with async_session_factory() as db:
                            await persist_whatsapp_provider_event(
                                db,
                                account_id=account_id,
                                event=event,
                            )
                    except DBAPIError as exc:
                        if not _is_terminal_provider_data_error(exc):
                            raise
                        _record_terminal_provider_event(
                            account_id,
                            sequence=event.sequence,
                            reason="persistence_data_error",
                        )
                await client.acknowledge_provider_events(through_sequence=event.sequence)
                retry_seconds = _PROVIDER_INGRESS_RETRY_INITIAL_SECONDS
            except asyncio.CancelledError:
                raise
            except WhatsAppProviderAccountRetired:
                self._release_terminal_ingress_owner(
                    account_id,
                    asyncio.current_task(),
                )
                return
            except Exception:
                log.exception("WhatsApp provider ingress pump failed for account %s", account_id)
                await asyncio.sleep(retry_seconds)
                retry_seconds = min(
                    retry_seconds * 2,
                    _PROVIDER_INGRESS_RETRY_MAX_SECONDS,
                )


def get_active_whatsapp_sidecar_clients() -> ConfiguredWhatsAppSidecarClientPool | None:
    return _active_sidecar_clients


def get_active_whatsapp_sidecar_registry() -> ConfiguredWhatsAppSidecarRegistry | None:
    active = _active_sidecar_clients
    return active if isinstance(active, ConfiguredWhatsAppSidecarRegistry) else None
