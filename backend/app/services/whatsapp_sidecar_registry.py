from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable, Mapping
from typing import Protocol
from uuid import UUID

from pydantic import JsonValue, TypeAdapter, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import async_session_factory
from app.models.channel import (
    CHANNEL_PROVIDER_WHATSAPP,
    CHANNEL_VISIBILITY_PUBLIC,
    WHATSAPP_ONBOARDING_OWNERSHIP_CUSTOM,
    WHATSAPP_ONBOARDING_STATE_ERROR,
    ChannelAccount,
    ChannelWhatsAppOnboardingSession,
)
from app.services.whatsapp_native_transport import (
    WhatsAppBaileysSidecarClient,
    WhatsAppBaileysSidecarConfig,
    WhatsAppNativeUpstreamClient,
    WhatsAppProviderMessageEvent,
    WhatsAppProviderTransportAdapter,
    WhatsAppSidecarCapabilities,
    WhatsAppSidecarError,
    WhatsAppSidecarHealth,
    WhatsAppSidecarPairingStatus,
    WhatsAppSidecarProtocolError,
    validate_whatsapp_sidecar_base_url,
)
from app.services.whatsapp_provider_bridge import (
    persist_whatsapp_provider_event,
    register_whatsapp_provider_transport,
    unregister_whatsapp_provider_transport,
)

log = logging.getLogger(__name__)
_JSON_VALUE_ADAPTER: TypeAdapter[JsonValue] = TypeAdapter(JsonValue)


class WhatsAppSidecarClient(WhatsAppNativeUpstreamClient, Protocol):
    async def aclose(self) -> None: ...

    async def refresh_health(self) -> bool: ...

    async def provider_events(self, *, limit: int = 100) -> list[WhatsAppProviderMessageEvent]: ...

    async def acknowledge_provider_events(self, *, through_sequence: int) -> None: ...

    async def health(self) -> WhatsAppSidecarHealth: ...

    async def capabilities(self) -> WhatsAppSidecarCapabilities: ...

    async def pairing_status(self) -> WhatsAppSidecarPairingStatus: ...

    async def pairing_qr(self) -> WhatsAppSidecarPairingStatus: ...

    async def pairing_code(self, phone_number: str) -> WhatsAppSidecarPairingStatus: ...

    async def pairing_cancel(self) -> WhatsAppSidecarPairingStatus: ...

    async def pairing_logout(self) -> WhatsAppSidecarPairingStatus: ...

    async def pairing_retry(self) -> WhatsAppSidecarPairingStatus: ...


SidecarClientFactory = Callable[[WhatsAppBaileysSidecarConfig], WhatsAppSidecarClient]
_UNRELEASED_STATES = (
    "generating",
    "ready",
    "scanned",
    "connected",
    WHATSAPP_ONBOARDING_STATE_ERROR,
)
_active_registry: ConfiguredWhatsAppSidecarRegistry | None = None


class ConfiguredWhatsAppSidecarRegistry:
    """Own every configured physical Baileys client and account transport mapping.

    Managed entries are durably identified by their ChannelAccount id. Custom
    entries are static beta capacity slots which become bound to a separate,
    tenant-owned ChannelAccount only after linked-device authentication opens.
    One client owns one physical socket in both cases.
    """

    def __init__(
        self,
        managed_raw_config: str,
        custom_raw_config: str = "",
        *,
        client_factory: SidecarClientFactory = WhatsAppBaileysSidecarClient,
    ) -> None:
        self._managed = parse_whatsapp_sidecar_registrations(managed_raw_config)
        self._custom = parse_whatsapp_custom_sidecar_registrations(custom_raw_config)
        _validate_disjoint_physical_slots(self._managed, self._custom)
        self._client_factory = client_factory
        self._clients_by_slot: dict[UUID, WhatsAppSidecarClient] = {}
        self._bound_managed_accounts: set[UUID] = set()
        self._custom_slot_to_account: dict[UUID, UUID] = {}
        self._custom_account_to_slot: dict[UUID, UUID] = {}
        self._blocked_custom_slots: set[UUID] = set()
        self._ingress_tasks: dict[UUID, asyncio.Task[None]] = {}
        self._custom_reconcile_lock = asyncio.Lock()

    @property
    def custom_slot_ids(self) -> tuple[UUID, ...]:
        return tuple(sorted(self._custom, key=str))

    @property
    def managed_account_ids(self) -> tuple[UUID, ...]:
        return tuple(sorted(self._managed, key=str))

    def get_custom_client(self, slot_id: UUID) -> WhatsAppSidecarClient | None:
        if slot_id not in self._custom or slot_id in self._blocked_custom_slots:
            return None
        return self._clients_by_slot.get(slot_id)

    def get_managed_client(self, account_id: UUID) -> WhatsAppSidecarClient | None:
        if account_id not in self._managed:
            return None
        return self._clients_by_slot.get(account_id)

    def managed_account_revision(self, account_id: UUID) -> str | None:
        config = self._managed.get(account_id)
        return config.binding_revision if config is not None else None

    def managed_is_bound(self, account_id: UUID) -> bool:
        return account_id in self._bound_managed_accounts

    def custom_slot_is_blocked(self, slot_id: UUID) -> bool:
        return slot_id in self._blocked_custom_slots

    def custom_slot_revision(self, slot_id: UUID) -> str | None:
        config = self._custom.get(slot_id)
        return config.binding_revision if config is not None else None

    def custom_binding(self, account_id: UUID) -> UUID | None:
        return self._custom_account_to_slot.get(account_id)

    def custom_account_for_slot(self, slot_id: UUID) -> UUID | None:
        return self._custom_slot_to_account.get(slot_id)

    async def start(self) -> None:
        global _active_registry
        if self._clients_by_slot or self._ingress_tasks or _active_registry is not None:
            raise RuntimeError("WhatsApp sidecar registry is already started")
        try:
            for slot_id, config in {**self._managed, **self._custom}.items():
                self._clients_by_slot[slot_id] = self._client_factory(config)

            for account_id in self._managed:
                client = self._clients_by_slot[account_id]
                try:
                    await client.refresh_health()
                except Exception as exc:
                    log.warning(
                        "WhatsApp Baileys sidecar health check failed for managed account %s: %s",
                        account_id,
                        type(exc).__name__,
                    )

            if self._custom:
                await self.reconcile_custom_ownership()
            _active_registry = self
        except BaseException:
            await self.stop()
            raise

    async def stop(self) -> None:
        global _active_registry
        if _active_registry is self:
            _active_registry = None
        tasks = tuple(self._ingress_tasks.values())
        self._ingress_tasks.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        registered_accounts = (*self._managed, *self._custom_account_to_slot)
        for account_id in registered_accounts:
            unregister_whatsapp_provider_transport(account_id)
        self._custom_slot_to_account.clear()
        self._custom_account_to_slot.clear()
        self._blocked_custom_slots.clear()
        self._bound_managed_accounts.clear()
        clients = tuple(self._clients_by_slot.values())
        self._clients_by_slot.clear()
        if clients:
            await asyncio.gather(*(client.aclose() for client in clients), return_exceptions=True)

    async def bind_managed_account(self, account_id: UUID, *, config_revision: str) -> bool:
        config = self._managed.get(account_id)
        client = self._clients_by_slot.get(account_id)
        if config is None or client is None or config.binding_revision != config_revision:
            raise WhatsAppSidecarProtocolError("managed Baileys account is unavailable")
        if account_id in self._bound_managed_accounts:
            return False
        self._register_transport(account_id, client)
        self._bound_managed_accounts.add(account_id)
        return True

    async def unbind_managed_account(self, account_id: UUID) -> bool:
        if account_id not in self._bound_managed_accounts:
            return False
        task = self._ingress_tasks.pop(account_id, None)
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        unregister_whatsapp_provider_transport(account_id)
        self._bound_managed_accounts.remove(account_id)
        return True

    async def reconcile_managed_ownership(self, db: AsyncSession | None = None) -> None:
        """Attach ingress only for promoted public accounts with exact configured identity."""
        if db is None:
            async with async_session_factory() as owned_db:
                accounts = await self._managed_accounts(owned_db)
        else:
            accounts = await self._managed_accounts(db)
        desired: dict[UUID, str] = {}
        for account in accounts:
            config = account.config if isinstance(account.config, dict) else {}
            revision = config.get("sidecar_config_revision")
            if config.get("connection_mode") != "baileys_managed" or not isinstance(revision, str):
                log.error("WhatsApp managed account %s has invalid physical identity", account.id)
                continue
            desired[account.id] = revision
        for account_id in tuple(self._bound_managed_accounts - desired.keys()):
            await self.unbind_managed_account(account_id)
        for account_id, revision in desired.items():
            try:
                client = self._clients_by_slot.get(account_id)
                if client is None:
                    raise WhatsAppSidecarProtocolError("managed Baileys account is unavailable")
                health = await client.health()
                pairing = await client.pairing_status()
                if (
                    not health.connected
                    or not health.registered
                    or pairing.status != "connected"
                    or not pairing.registered
                ):
                    raise WhatsAppSidecarProtocolError(
                        "managed Baileys physical auth is unavailable"
                    )
                await self.bind_managed_account(account_id, config_revision=revision)
            except WhatsAppSidecarError:
                log.error("WhatsApp managed account %s is not safe to attach", account_id)

    async def _managed_accounts(self, db: AsyncSession) -> list[ChannelAccount]:
        return list(
            (
                await db.scalars(
                    select(ChannelAccount).where(
                        ChannelAccount.id.in_(self._managed),
                        ChannelAccount.provider == CHANNEL_PROVIDER_WHATSAPP,
                        ChannelAccount.visibility == CHANNEL_VISIBILITY_PUBLIC,
                        ChannelAccount.archived_at.is_(None),
                    )
                )
            ).all()
        )

    async def bind_custom_account(
        self,
        *,
        slot_id: UUID,
        account_id: UUID,
        config_revision: str,
    ) -> bool:
        async with self._custom_reconcile_lock:
            return self._bind_custom_account_unlocked(
                slot_id=slot_id,
                account_id=account_id,
                config_revision=config_revision,
            )

    def _bind_custom_account_unlocked(
        self,
        *,
        slot_id: UUID,
        account_id: UUID,
        config_revision: str,
    ) -> bool:
        if slot_id not in self._custom or slot_id in self._blocked_custom_slots:
            raise WhatsAppSidecarProtocolError("custom Baileys slot is unavailable")
        if config_revision != self._custom[slot_id].binding_revision:
            raise WhatsAppSidecarProtocolError("custom Baileys slot revision mismatch")
        existing_account = self._custom_slot_to_account.get(slot_id)
        existing_slot = self._custom_account_to_slot.get(account_id)
        if existing_account == account_id and existing_slot == slot_id:
            return False
        if existing_account is not None or existing_slot is not None:
            raise WhatsAppSidecarProtocolError("custom Baileys slot ownership conflict")
        client = self._clients_by_slot.get(slot_id)
        if client is None:
            raise WhatsAppSidecarProtocolError("custom Baileys slot is unavailable")
        self._register_transport(account_id, client)
        self._custom_slot_to_account[slot_id] = account_id
        self._custom_account_to_slot[account_id] = slot_id
        return True

    async def unbind_custom_account(self, *, slot_id: UUID, account_id: UUID) -> bool:
        async with self._custom_reconcile_lock:
            return await self._unbind_custom_account_unlocked(
                slot_id=slot_id,
                account_id=account_id,
            )

    async def _unbind_custom_account_unlocked(
        self,
        *,
        slot_id: UUID,
        account_id: UUID,
    ) -> bool:
        existing_account = self._custom_slot_to_account.get(slot_id)
        existing_slot = self._custom_account_to_slot.get(account_id)
        if existing_account is None and existing_slot is None:
            return False
        if existing_account != account_id or existing_slot != slot_id:
            raise WhatsAppSidecarProtocolError("custom Baileys slot ownership conflict")
        task = self._ingress_tasks.pop(account_id, None)
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        unregister_whatsapp_provider_transport(account_id)
        self._custom_slot_to_account.pop(slot_id, None)
        self._custom_account_to_slot.pop(account_id, None)
        return True

    def _register_transport(
        self,
        account_id: UUID,
        client: WhatsAppSidecarClient,
    ) -> None:
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

    async def reconcile_custom_ownership(self) -> None:
        """Rehydrate durable account mappings and fail closed on slot drift.

        Every backend process runs this reconciliation. It never creates a
        Baileys socket: each configured sidecar remains the sole physical
        owner, while this process restores its local provider adapter/pump.
        """

        async with self._custom_reconcile_lock:
            async with async_session_factory() as db:
                accounts = list(
                    (
                        await db.scalars(
                            select(ChannelAccount).where(
                                ChannelAccount.provider == CHANNEL_PROVIDER_WHATSAPP,
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

            owners: dict[UUID, tuple[UUID, str]] = {}
            drifted_slots: set[UUID] = set()
            for account in accounts:
                config = account.config if isinstance(account.config, dict) else {}
                if config.get("connection_mode") != "baileys_custom":
                    continue
                slot_id = _configured_slot_id(config)
                revision = config.get("sidecar_config_revision")
                if slot_id is None or slot_id not in self._custom or not isinstance(revision, str):
                    log.error(
                        "WhatsApp Custom account %s has missing or drifted physical slot config",
                        account.id,
                    )
                    if slot_id is not None and slot_id in self._custom:
                        drifted_slots.add(slot_id)
                    continue
                if revision != self._custom[slot_id].binding_revision or slot_id in owners:
                    drifted_slots.add(slot_id)
                    log.error("WhatsApp Custom slot %s has conflicting durable ownership", slot_id)
                    continue
                owners[slot_id] = (account.id, revision)

            reservations: dict[UUID, str] = {}
            for session in sessions:
                if session.sidecar_account_id in reservations:
                    drifted_slots.add(session.sidecar_account_id)
                    continue
                reservations[session.sidecar_account_id] = session.sidecar_config_revision

            for slot_id, client in ((slot, self._clients_by_slot[slot]) for slot in self._custom):
                owner = owners.get(slot_id)
                reservation_revision = reservations.get(slot_id)
                configured_revision = self._custom[slot_id].binding_revision
                current_account = self._custom_slot_to_account.get(slot_id)
                desired_account = owner[0] if owner is not None else None
                if (
                    current_account is not None
                    and current_account != desired_account
                    and not (desired_account is None and reservation_revision is not None)
                ):
                    await self._unbind_custom_account_unlocked(
                        slot_id=slot_id,
                        account_id=current_account,
                    )
                    current_account = None
                try:
                    await client.capabilities()
                    health = await client.health()
                    pairing = await client.pairing_status()
                except WhatsAppSidecarProtocolError:
                    await self._block_custom_slot_unlocked(slot_id, current_account)
                    log.error(
                        "WhatsApp Custom slot %s failed identity or protocol validation",
                        slot_id,
                    )
                    continue
                except WhatsAppSidecarError:
                    await self._block_custom_slot_unlocked(slot_id, current_account)
                    log.warning("WhatsApp Custom slot %s is temporarily unavailable", slot_id)
                    continue

                if health.registered != pairing.registered:
                    await self._block_custom_slot_unlocked(slot_id, current_account)
                    log.error(
                        "WhatsApp Custom slot %s reported inconsistent registration state",
                        slot_id,
                    )
                    continue
                if slot_id in drifted_slots or (
                    reservation_revision is not None and reservation_revision != configured_revision
                ):
                    await self._block_custom_slot_unlocked(slot_id, current_account)
                    log.error(
                        "WhatsApp Custom slot %s has a durable config revision mismatch",
                        slot_id,
                    )
                    continue
                if owner is not None:
                    if not pairing.registered:
                        await self._block_custom_slot_unlocked(slot_id, current_account)
                        log.error(
                            "WhatsApp Custom slot %s lost durable physical authentication",
                            slot_id,
                        )
                        continue
                    self._blocked_custom_slots.discard(slot_id)
                    self._bind_custom_account_unlocked(
                        slot_id=slot_id,
                        account_id=owner[0],
                        config_revision=owner[1],
                    )
                    continue
                if reservation_revision is not None:
                    if health.connected and not pairing.registered:
                        await self._block_custom_slot_unlocked(slot_id, current_account)
                    else:
                        self._blocked_custom_slots.discard(slot_id)
                    continue
                if pairing.registered or pairing.status != "stopped" or health.status != "stopped":
                    await self._block_custom_slot_unlocked(slot_id, current_account)
                    log.error("WhatsApp Custom slot %s has orphaned physical state", slot_id)
                    continue
                self._blocked_custom_slots.discard(slot_id)

    async def _block_custom_slot_unlocked(
        self,
        slot_id: UUID,
        account_id: UUID | None,
    ) -> None:
        if account_id is not None:
            await self._unbind_custom_account_unlocked(
                slot_id=slot_id,
                account_id=account_id,
            )
        self._blocked_custom_slots.add(slot_id)

    async def _pump_provider_ingress(
        self,
        account_id: UUID,
        client: WhatsAppSidecarClient,
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
                    await client.acknowledge_provider_events(through_sequence=event.sequence)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("WhatsApp provider ingress pump failed for account %s", account_id)
                await asyncio.sleep(1.0)


def get_active_whatsapp_sidecar_registry() -> ConfiguredWhatsAppSidecarRegistry | None:
    return _active_registry


def parse_whatsapp_sidecar_registrations(
    raw_config: str,
) -> dict[UUID, WhatsAppBaileysSidecarConfig]:
    return _parse_registrations(
        raw_config,
        setting_name="channel_whatsapp_baileys_sidecars_json",
    )


def parse_whatsapp_custom_sidecar_registrations(
    raw_config: str,
) -> dict[UUID, WhatsAppBaileysSidecarConfig]:
    return _parse_registrations(
        raw_config,
        setting_name="channel_whatsapp_custom_baileys_sidecars_json",
    )


def _parse_registrations(
    raw_config: str,
    *,
    setting_name: str,
) -> dict[UUID, WhatsAppBaileysSidecarConfig]:
    raw = raw_config.strip()
    if not raw:
        return {}
    try:
        untyped_payload: object = json.loads(
            raw,
            object_pairs_hook=_unique_object,
            parse_constant=_reject_json_constant,
        )
        payload = _JSON_VALUE_ADAPTER.validate_python(untyped_payload)
    except (json.JSONDecodeError, ValidationError, ValueError) as exc:
        raise ValueError(f"{setting_name} must be valid unique-key JSON") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"{setting_name} must be an object")

    registrations: dict[UUID, WhatsAppBaileysSidecarConfig] = {}
    origins: set[str] = set()
    for account_id_raw, value in payload.items():
        try:
            account_id = UUID(str(account_id_raw))
        except ValueError as exc:
            raise ValueError(f"invalid WhatsApp sidecar account id: {account_id_raw}") from exc
        if account_id in registrations:
            raise ValueError(f"duplicate WhatsApp sidecar account id: {account_id}")
        config = _parse_sidecar_config(account_id=account_id, value=value)
        if config.base_url in origins:
            raise ValueError("each WhatsApp sidecar base_url must be unique")
        origins.add(config.base_url)
        registrations[account_id] = config
    return registrations


def _parse_sidecar_config(*, account_id: UUID, value: JsonValue) -> WhatsAppBaileysSidecarConfig:
    if not isinstance(value, dict):
        raise ValueError(f"WhatsApp sidecar config for {account_id} must be an object")
    unknown = set(value) - {"account_id", "base_url", "api_token", "timeout_seconds"}
    if unknown:
        raise ValueError(f"WhatsApp sidecar config for {account_id} has unknown fields")
    declared_id = value.get("account_id")
    if declared_id is not None:
        try:
            parsed_declared_id = UUID(str(declared_id))
        except ValueError as exc:
            raise ValueError(
                f"WhatsApp sidecar config for {account_id} has invalid account_id"
            ) from exc
        if parsed_declared_id != account_id:
            raise ValueError(f"WhatsApp sidecar account_id mismatch for {account_id}")
    base_url = validate_whatsapp_sidecar_base_url(
        _required_str(value, "base_url", account_id=account_id)
    )
    return WhatsAppBaileysSidecarConfig(
        base_url=base_url,
        api_token=_required_str(value, "api_token", account_id=account_id),
        timeout_seconds=_optional_float(value, "timeout_seconds", account_id=account_id) or 10.0,
        account_id=account_id,
    )


def _validate_disjoint_physical_slots(
    managed: Mapping[UUID, WhatsAppBaileysSidecarConfig],
    custom: Mapping[UUID, WhatsAppBaileysSidecarConfig],
) -> None:
    if set(managed).intersection(custom):
        raise ValueError("managed and Custom WhatsApp sidecars must use disjoint slot ids")
    managed_origins = {config.base_url for config in managed.values()}
    custom_origins = {config.base_url for config in custom.values()}
    if managed_origins.intersection(custom_origins):
        raise ValueError("managed and Custom WhatsApp sidecars must use disjoint origins")


def _configured_slot_id(config: Mapping[str, JsonValue]) -> UUID | None:
    raw = config.get("sidecar_account_id")
    try:
        return UUID(raw) if isinstance(raw, str) else None
    except ValueError:
        return None


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate WhatsApp sidecar config key")
        result[key] = value
    return result


def _reject_json_constant(value: str) -> object:
    raise ValueError(f"invalid JSON constant: {value}")


def _required_str(value: Mapping[str, JsonValue], key: str, *, account_id: UUID) -> str:
    text = _optional_str(value, key, account_id=account_id)
    if text is None:
        raise ValueError(f"WhatsApp sidecar config for {account_id} requires {key}")
    return text


def _optional_str(value: Mapping[str, JsonValue], key: str, *, account_id: UUID) -> str | None:
    raw = value.get(key)
    if raw is None:
        return None
    if not isinstance(raw, str) or not raw.strip() or raw != raw.strip() or len(raw) > 4096:
        raise ValueError(f"WhatsApp sidecar config for {account_id} has invalid {key}")
    return raw


def _optional_float(value: Mapping[str, JsonValue], key: str, *, account_id: UUID) -> float | None:
    raw = value.get(key)
    if raw is None:
        return None
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise ValueError(f"WhatsApp sidecar config for {account_id} has invalid {key}")
    parsed = float(raw)
    if not 0 < parsed <= 30:
        raise ValueError(f"WhatsApp sidecar config for {account_id} has invalid {key}")
    return parsed
