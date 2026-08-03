from __future__ import annotations

from datetime import UTC, datetime
from typing import cast
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel import (
    CHANNEL_PROVIDER_WHATSAPP,
    CHANNEL_VISIBILITY_PUBLIC,
    WHATSAPP_ONBOARDING_OWNERSHIP_PLATFORM,
    WHATSAPP_ONBOARDING_STATE_CANCELED,
    WHATSAPP_ONBOARDING_STATE_CONNECTED,
    WHATSAPP_ONBOARDING_STATE_ERROR,
    WHATSAPP_ONBOARDING_STATE_EXPIRED,
    WHATSAPP_ONBOARDING_STATE_GENERATING,
    WHATSAPP_ONBOARDING_STATE_READY,
    WHATSAPP_ONBOARDING_STATE_SCANNED,
    ChannelAccount,
    ChannelWhatsAppOnboardingSession,
)
from app.schemas.channel import (
    ChannelWhatsAppOnboardingSessionResponse,
    WhatsAppOnboardingState,
)
from app.services.channels import build_channel_account, generate_webhook_secret, hash_token
from app.services.whatsapp_device_onboarding import (
    WHATSAPP_ONBOARDING_TTL,
    stop_whatsapp_pairing,
)
from app.services.whatsapp_native_transport import (
    WhatsAppSidecarError,
    WhatsAppSidecarProtocolError,
)
from app.services.whatsapp_sidecar_registry import ConfiguredWhatsAppSidecarRegistry

_LOCK_ID = 8_071_323_913
_OWNING_STATES = ("generating", "ready", "scanned", "connected", "error")
_EXPIRABLE_STATES = ("generating", "ready", "scanned", "error")


async def start_platform_whatsapp_pairing(
    db: AsyncSession,
    *,
    account_id: UUID,
    request_id: UUID,
    name: str,
    registry: ConfiguredWhatsAppSidecarRegistry | None,
) -> ChannelWhatsAppOnboardingSessionResponse:
    if registry is None or registry.get_managed_client(account_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "configured WhatsApp account not found")
    revision = registry.managed_account_revision(account_id)
    if revision is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "WhatsApp onboarding unavailable")
    await db.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": _LOCK_ID})
    existing = await db.scalar(
        select(ChannelWhatsAppOnboardingSession).where(
            ChannelWhatsAppOnboardingSession.ownership_kind
            == WHATSAPP_ONBOARDING_OWNERSHIP_PLATFORM,
            ChannelWhatsAppOnboardingSession.request_id == request_id,
        )
    )
    if existing is not None:
        if existing.sidecar_account_id != account_id:
            raise HTTPException(status.HTTP_409_CONFLICT, "request already owns another account")
        await db.commit()
        return await get_platform_whatsapp_pairing(db, session_id=existing.id, registry=registry)
    occupied = await db.scalar(
        select(ChannelWhatsAppOnboardingSession.id).where(
            ChannelWhatsAppOnboardingSession.ownership_kind
            == WHATSAPP_ONBOARDING_OWNERSHIP_PLATFORM,
            ChannelWhatsAppOnboardingSession.sidecar_account_id == account_id,
            ChannelWhatsAppOnboardingSession.state.in_(_OWNING_STATES),
        )
    )
    if occupied is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "configured WhatsApp account is already owned"
        )
    duplicate_session_name = await db.scalar(
        select(ChannelWhatsAppOnboardingSession.id).where(
            ChannelWhatsAppOnboardingSession.ownership_kind
            == WHATSAPP_ONBOARDING_OWNERSHIP_PLATFORM,
            ChannelWhatsAppOnboardingSession.name == name,
            ChannelWhatsAppOnboardingSession.state.in_(_OWNING_STATES),
        )
    )
    if duplicate_session_name is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "WhatsApp account name already exists")
    account = await db.get(ChannelAccount, account_id)
    if account is not None:
        if not _matches(account, revision=revision):
            raise HTTPException(
                status.HTTP_409_CONFLICT, "configured WhatsApp account identity conflicts"
            )
        raise HTTPException(
            status.HTTP_409_CONFLICT, "configured WhatsApp account is already onboarded"
        )
    duplicate_name = await db.scalar(
        select(ChannelAccount.id).where(
            ChannelAccount.user_id.is_(None),
            ChannelAccount.provider == CHANNEL_PROVIDER_WHATSAPP,
            ChannelAccount.visibility == CHANNEL_VISIBILITY_PUBLIC,
            ChannelAccount.name == name,
            ChannelAccount.archived_at.is_(None),
        )
    )
    if duplicate_name is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "WhatsApp account name already exists")
    now = datetime.now(UTC)
    onboarding = ChannelWhatsAppOnboardingSession(
        ownership_kind=WHATSAPP_ONBOARDING_OWNERSHIP_PLATFORM,
        sidecar_account_id=account_id,
        sidecar_config_revision=revision,
        user_id=None,
        request_id=request_id,
        name=name,
        state=WHATSAPP_ONBOARDING_STATE_GENERATING,
        method="qr",
        started_at=now,
        expires_at=now + WHATSAPP_ONBOARDING_TTL,
    )
    db.add(onboarding)
    await db.commit()
    return await _refresh(db, onboarding=onboarding, registry=registry, start_qr=True)


async def get_platform_whatsapp_pairing(
    db: AsyncSession,
    *,
    session_id: UUID,
    registry: ConfiguredWhatsAppSidecarRegistry | None,
) -> ChannelWhatsAppOnboardingSessionResponse:
    onboarding = await _session(db, session_id)
    if onboarding.state in {
        WHATSAPP_ONBOARDING_STATE_CONNECTED,
        WHATSAPP_ONBOARDING_STATE_CANCELED,
        WHATSAPP_ONBOARDING_STATE_EXPIRED,
    }:
        return _response(onboarding)
    return await _refresh(db, onboarding=onboarding, registry=registry, start_qr=False)


async def cancel_platform_whatsapp_pairing(
    db: AsyncSession,
    *,
    session_id: UUID,
    registry: ConfiguredWhatsAppSidecarRegistry | None,
) -> ChannelWhatsAppOnboardingSessionResponse:
    onboarding = await _session(db, session_id)
    if onboarding.state == WHATSAPP_ONBOARDING_STATE_CANCELED:
        return _response(onboarding)
    if onboarding.state == WHATSAPP_ONBOARDING_STATE_CONNECTED:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "archive the connected WhatsApp account instead"
        )
    client = registry.get_managed_client(onboarding.sidecar_account_id) if registry else None
    try:
        stopped = await stop_whatsapp_pairing(client) if client is not None else None
    except WhatsAppSidecarError:
        stopped = None
    if stopped is None or stopped.status != "stopped" or stopped.registered:
        onboarding.state = WHATSAPP_ONBOARDING_STATE_ERROR
        await db.commit()
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "WhatsApp cancellation could not be confirmed"
        )
    onboarding.state = WHATSAPP_ONBOARDING_STATE_CANCELED
    onboarding.completed_at = datetime.now(UTC)
    await db.commit()
    return _response(onboarding)


async def expire_stale_platform_whatsapp_pairing_sessions(
    db: AsyncSession,
    *,
    registry: ConfiguredWhatsAppSidecarRegistry,
) -> int:
    session_ids = list(
        (
            await db.scalars(
                select(ChannelWhatsAppOnboardingSession.id).where(
                    ChannelWhatsAppOnboardingSession.ownership_kind
                    == WHATSAPP_ONBOARDING_OWNERSHIP_PLATFORM,
                    ChannelWhatsAppOnboardingSession.state.in_(_EXPIRABLE_STATES),
                    ChannelWhatsAppOnboardingSession.expires_at <= datetime.now(UTC),
                )
            )
        ).all()
    )
    expired = 0
    for session_id in session_ids:
        result = await get_platform_whatsapp_pairing(db, session_id=session_id, registry=registry)
        if result.state == WHATSAPP_ONBOARDING_STATE_EXPIRED:
            expired += 1
    return expired


async def _refresh(
    db: AsyncSession,
    *,
    onboarding: ChannelWhatsAppOnboardingSession,
    registry: ConfiguredWhatsAppSidecarRegistry | None,
    start_qr: bool,
) -> ChannelWhatsAppOnboardingSessionResponse:
    if registry is None:
        return await _error(db, onboarding)
    client = registry.get_managed_client(onboarding.sidecar_account_id)
    if client is None or (
        registry.managed_account_revision(onboarding.sidecar_account_id)
        != onboarding.sidecar_config_revision
    ):
        return await _error(db, onboarding)
    try:
        await client.capabilities()
        health = await client.health()
        pairing = await (client.pairing_qr() if start_qr else client.pairing_status())
    except WhatsAppSidecarError:
        return await _error(db, onboarding)
    if health.registered != pairing.registered:
        return await _error(db, onboarding)
    if health.connected and pairing.status == "connected" and pairing.registered:
        await _promote(db, onboarding=onboarding, registry=registry)
        return _response(onboarding)
    if pairing.status == "starting" and not pairing.registered:
        onboarding.state = WHATSAPP_ONBOARDING_STATE_GENERATING
        await db.commit()
        return _response(onboarding)
    if datetime.now(UTC) >= onboarding.expires_at:
        try:
            stopped = await stop_whatsapp_pairing(client, current=pairing)
        except WhatsAppSidecarError:
            return await _error(db, onboarding)
        if stopped.status != "stopped" or stopped.registered:
            return await _error(db, onboarding)
        onboarding.state = WHATSAPP_ONBOARDING_STATE_EXPIRED
        onboarding.completed_at = datetime.now(UTC)
        await db.commit()
        return _response(onboarding)
    if pairing.registered:
        onboarding.state = WHATSAPP_ONBOARDING_STATE_SCANNED
        await db.commit()
        return _response(onboarding)
    if (
        pairing.status == "pairing_qr"
        and pairing.qr is not None
        and pairing.qr_expires_at is not None
    ):
        onboarding.state = WHATSAPP_ONBOARDING_STATE_READY
        await db.commit()
        return _response(onboarding, qr=pairing.qr, qr_expires_at=pairing.qr_expires_at)
    return await _error(db, onboarding)


async def _promote(
    db: AsyncSession,
    *,
    onboarding: ChannelWhatsAppOnboardingSession,
    registry: ConfiguredWhatsAppSidecarRegistry,
) -> None:
    account_id = onboarding.sidecar_account_id
    session_id = onboarding.id
    newly_bound = False
    account = await db.get(ChannelAccount, onboarding.sidecar_account_id)
    try:
        if account is None:
            account = build_channel_account(
                account_id=account_id,
                owner_user_id=None,
                provider=CHANNEL_PROVIDER_WHATSAPP,
                name=onboarding.name,
                visibility=CHANNEL_VISIBILITY_PUBLIC,
                webhook_secret_hash=hash_token(generate_webhook_secret()),
                config={
                    "connection_mode": "baileys_managed",
                    "sidecar_config_revision": onboarding.sidecar_config_revision,
                },
            )
            db.add(account)
            await db.flush()
        elif not _matches(account, revision=onboarding.sidecar_config_revision):
            raise WhatsAppSidecarProtocolError("managed WhatsApp identity conflict")
        newly_bound = await registry.bind_managed_account(
            account.id, config_revision=onboarding.sidecar_config_revision
        )
        onboarding.channel_account_id = account.id
        onboarding.state = WHATSAPP_ONBOARDING_STATE_CONNECTED
        onboarding.completed_at = datetime.now(UTC)
        await db.commit()
    except BaseException as exc:
        await db.rollback()
        if newly_bound:
            await registry.unbind_managed_account(account_id)
        failed = await _session(db, session_id)
        failed.state = WHATSAPP_ONBOARDING_STATE_ERROR
        await db.commit()
        if isinstance(exc, IntegrityError):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "WhatsApp account name or identity already exists",
            ) from exc
        if isinstance(exc, WhatsAppSidecarError):
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "WhatsApp transport could not be attached",
            ) from None
        raise


def _matches(account: ChannelAccount, *, revision: str) -> bool:
    config = account.config if isinstance(account.config, dict) else {}
    return (
        account.user_id is None
        and account.provider == CHANNEL_PROVIDER_WHATSAPP
        and account.visibility == CHANNEL_VISIBILITY_PUBLIC
        and account.archived_at is None
        and config.get("connection_mode") == "baileys_managed"
        and config.get("sidecar_config_revision") == revision
    )


async def _session(db: AsyncSession, session_id: UUID) -> ChannelWhatsAppOnboardingSession:
    row = await db.scalar(
        select(ChannelWhatsAppOnboardingSession)
        .where(
            ChannelWhatsAppOnboardingSession.id == session_id,
            ChannelWhatsAppOnboardingSession.ownership_kind
            == WHATSAPP_ONBOARDING_OWNERSHIP_PLATFORM,
        )
        .with_for_update()
    )
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "onboarding not found")
    return row


async def _error(
    db: AsyncSession, row: ChannelWhatsAppOnboardingSession
) -> ChannelWhatsAppOnboardingSessionResponse:
    row.state = WHATSAPP_ONBOARDING_STATE_ERROR
    await db.commit()
    return _response(row)


def _response(
    row: ChannelWhatsAppOnboardingSession,
    *,
    qr: str | None = None,
    qr_expires_at: datetime | None = None,
) -> ChannelWhatsAppOnboardingSessionResponse:
    return ChannelWhatsAppOnboardingSessionResponse(
        id=row.id,
        channel_account_id=row.channel_account_id,
        name=row.name,
        state=cast(WhatsAppOnboardingState, row.state),
        method="qr",
        qr=qr,
        qr_expires_at=qr_expires_at,
        manual_pairing_code_supported=False,
        started_at=row.started_at,
        expires_at=row.expires_at,
        completed_at=row.completed_at,
    )
