from __future__ import annotations

import asyncio
import re
from datetime import UTC, datetime, timedelta
from typing import Literal, cast
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel import (
    CHANNEL_PROVIDER_WHATSAPP,
    CHANNEL_STATUS_ACTIVE,
    CHANNEL_VISIBILITY_PRIVATE,
    WHATSAPP_ONBOARDING_ACTIVE_STATES,
    WHATSAPP_ONBOARDING_OWNERSHIP_CUSTOM,
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
    ChannelWhatsAppOnboardingReadinessResponse,
    ChannelWhatsAppOnboardingSessionResponse,
    WhatsAppOnboardingState,
)
from app.services.channels import generate_webhook_secret, hash_token
from app.services.whatsapp_native_transport import (
    WhatsAppSidecarCapabilities,
    WhatsAppSidecarError,
    WhatsAppSidecarPairingStatus,
    WhatsAppSidecarProtocolError,
    WhatsAppSidecarUnavailableError,
)
from app.services.whatsapp_sidecar_registry import (
    ConfiguredWhatsAppSidecarRegistry,
    WhatsAppSidecarClient,
)

WHATSAPP_ONBOARDING_TTL = timedelta(minutes=5)
_E164_DIGITS = re.compile(r"^[1-9][0-9]{6,14}$")
_ALLOCATION_LOCK_ID = 8_071_323_912
_LOGOUT_RECOVERY_TTL_SECONDS = 10.0
_UNRELEASED_SESSION_STATES = (*WHATSAPP_ONBOARDING_ACTIVE_STATES, WHATSAPP_ONBOARDING_STATE_ERROR)
_WHATSAPP_ONBOARDING_STATES = frozenset(
    {
        WHATSAPP_ONBOARDING_STATE_GENERATING,
        WHATSAPP_ONBOARDING_STATE_READY,
        WHATSAPP_ONBOARDING_STATE_SCANNED,
        WHATSAPP_ONBOARDING_STATE_CONNECTED,
        WHATSAPP_ONBOARDING_STATE_EXPIRED,
        WHATSAPP_ONBOARDING_STATE_CANCELED,
        WHATSAPP_ONBOARDING_STATE_ERROR,
    }
)


async def whatsapp_onboarding_readiness(
    db: AsyncSession,
    *,
    registry: ConfiguredWhatsAppSidecarRegistry | None,
) -> ChannelWhatsAppOnboardingReadinessResponse:
    if registry is None or not registry.custom_slot_ids:
        return ChannelWhatsAppOnboardingReadinessResponse(
            available=False,
            manual_pairing_code_supported=False,
            reason="not_configured",
        )
    candidates = await _free_account_ids(db, registry=registry)
    if not candidates:
        return ChannelWhatsAppOnboardingReadinessResponse(
            available=False,
            manual_pairing_code_supported=False,
            reason="no_capacity",
        )
    saw_protocol_failure = False
    saw_unavailable = False
    for account_id in candidates:
        client = registry.get_custom_client(account_id)
        if client is None:
            saw_unavailable = True
            continue
        try:
            capabilities = await _pairable_sidecar(client)
        except WhatsAppSidecarProtocolError:
            saw_protocol_failure = True
            continue
        except WhatsAppSidecarError:
            saw_unavailable = True
            continue
        if capabilities is not None:
            return ChannelWhatsAppOnboardingReadinessResponse(
                available=True,
                manual_pairing_code_supported="code" in capabilities.pairing,
            )
    return ChannelWhatsAppOnboardingReadinessResponse(
        available=False,
        manual_pairing_code_supported=False,
        reason=(
            "managed_sidecar_required"
            if saw_protocol_failure and not saw_unavailable
            else "temporarily_unavailable"
        ),
    )


async def start_whatsapp_onboarding(
    db: AsyncSession,
    *,
    user_id: UUID,
    request_id: UUID,
    name: str,
    registry: ConfiguredWhatsAppSidecarRegistry | None,
) -> ChannelWhatsAppOnboardingSessionResponse:
    existing = await db.scalar(
        select(ChannelWhatsAppOnboardingSession).where(
            ChannelWhatsAppOnboardingSession.ownership_kind == WHATSAPP_ONBOARDING_OWNERSHIP_CUSTOM,
            ChannelWhatsAppOnboardingSession.user_id == user_id,
            ChannelWhatsAppOnboardingSession.request_id == request_id,
        )
    )
    if existing is not None:
        return await refresh_whatsapp_onboarding(
            db,
            user_id=user_id,
            session_id=existing.id,
            registry=registry,
        )
    if registry is None or not registry.custom_slot_ids:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="WhatsApp account connection is not configured",
        )

    await _lock_allocation(db)
    existing = await db.scalar(
        select(ChannelWhatsAppOnboardingSession).where(
            ChannelWhatsAppOnboardingSession.ownership_kind == WHATSAPP_ONBOARDING_OWNERSHIP_CUSTOM,
            ChannelWhatsAppOnboardingSession.user_id == user_id,
            ChannelWhatsAppOnboardingSession.request_id == request_id,
        )
    )
    if existing is not None:
        # Release the allocation-wide advisory lock before observing the
        # existing session through the slower sidecar lifecycle.
        await db.commit()
        return await refresh_whatsapp_onboarding(
            db,
            user_id=user_id,
            session_id=existing.id,
            registry=registry,
        )
    duplicate_name = await db.scalar(
        select(ChannelAccount.id).where(
            ChannelAccount.user_id == user_id,
            ChannelAccount.provider == CHANNEL_PROVIDER_WHATSAPP,
            ChannelAccount.name == name,
            ChannelAccount.archived_at.is_(None),
        )
    )
    if duplicate_name is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A WhatsApp account with this name already exists",
        )
    unfinished_name = await db.scalar(
        select(ChannelWhatsAppOnboardingSession.id).where(
            ChannelWhatsAppOnboardingSession.ownership_kind == WHATSAPP_ONBOARDING_OWNERSHIP_CUSTOM,
            ChannelWhatsAppOnboardingSession.user_id == user_id,
            ChannelWhatsAppOnboardingSession.name == name,
            ChannelWhatsAppOnboardingSession.state.in_(_UNRELEASED_SESSION_STATES),
        )
    )
    if unfinished_name is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A WhatsApp connection with this name is already in progress",
        )

    sidecar_account_id = await _select_free_sidecar_slot(db, registry=registry)
    if sidecar_account_id is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="No WhatsApp account connection slot is available",
        )
    sidecar_config_revision = registry.custom_slot_revision(sidecar_account_id)
    if sidecar_config_revision is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="WhatsApp account connection slot is unavailable",
        )
    now = datetime.now(UTC)
    onboarding = ChannelWhatsAppOnboardingSession(
        ownership_kind=WHATSAPP_ONBOARDING_OWNERSHIP_CUSTOM,
        sidecar_account_id=sidecar_account_id,
        sidecar_config_revision=sidecar_config_revision,
        user_id=user_id,
        request_id=request_id,
        name=name,
        state=WHATSAPP_ONBOARDING_STATE_GENERATING,
        method="qr",
        started_at=now,
        expires_at=now + WHATSAPP_ONBOARDING_TTL,
    )
    db.add(onboarding)
    await db.flush()
    await db.commit()
    onboarding = await _owned_session(db, user_id=user_id, session_id=onboarding.id)
    client = registry.get_custom_client(sidecar_account_id)
    if client is None:
        return await _mark_session_error(db, onboarding)
    try:
        capabilities = await client.capabilities()
        await client.health()
        pairing = await client.pairing_qr()
        response = await _apply_pairing_status(
            db,
            onboarding=onboarding,
            pairing=pairing,
            capabilities=capabilities,
            registry=registry,
        )
    except WhatsAppSidecarError:
        return await _mark_session_error(db, onboarding)
    await db.commit()
    return response


async def refresh_whatsapp_onboarding(
    db: AsyncSession,
    *,
    user_id: UUID,
    session_id: UUID,
    registry: ConfiguredWhatsAppSidecarRegistry | None,
) -> ChannelWhatsAppOnboardingSessionResponse:
    onboarding = await _owned_session(db, user_id=user_id, session_id=session_id)
    if onboarding.state not in WHATSAPP_ONBOARDING_ACTIVE_STATES:
        return _session_response(onboarding, manual_pairing_code_supported=False)
    if onboarding.state == WHATSAPP_ONBOARDING_STATE_CONNECTED:
        try:
            await _ensure_connected_transport(onboarding=onboarding, registry=registry)
        except WhatsAppSidecarError:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="WhatsApp account transport is temporarily unavailable",
            ) from None
        return _session_response(
            onboarding,
            manual_pairing_code_supported=False,
        )
    if datetime.now(UTC) >= onboarding.expires_at:
        return await _expire_session(db, onboarding=onboarding, registry=registry)

    if registry is None:
        return await _mark_session_error(db, onboarding)
    client = registry.get_custom_client(onboarding.sidecar_account_id)
    if client is None:
        return await _mark_session_error(db, onboarding)
    try:
        capabilities = await client.capabilities()
        await client.health()
        pairing = await client.pairing_status()
        response = await _apply_pairing_status(
            db,
            onboarding=onboarding,
            pairing=pairing,
            capabilities=capabilities,
            registry=registry,
        )
    except WhatsAppSidecarError:
        return await _mark_session_error(db, onboarding)
    await db.commit()
    return response


async def request_whatsapp_pairing_code(
    db: AsyncSession,
    *,
    user_id: UUID,
    session_id: UUID,
    phone_number: str,
    registry: ConfiguredWhatsAppSidecarRegistry | None,
) -> ChannelWhatsAppOnboardingSessionResponse:
    if _E164_DIGITS.fullmatch(phone_number) is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Phone number must use country code and digits only",
        )
    onboarding = await _owned_session(db, user_id=user_id, session_id=session_id)
    if onboarding.state not in {
        WHATSAPP_ONBOARDING_STATE_GENERATING,
        WHATSAPP_ONBOARDING_STATE_READY,
    }:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This WhatsApp connection cannot request a pairing code",
        )
    if datetime.now(UTC) >= onboarding.expires_at:
        return await _expire_session(db, onboarding=onboarding, registry=registry)
    if registry is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="WhatsApp account connection is temporarily unavailable",
        )
    client = registry.get_custom_client(onboarding.sidecar_account_id)
    if client is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="WhatsApp account connection is temporarily unavailable",
        )
    try:
        capabilities = await client.capabilities()
        await client.health()
        if "code" not in capabilities.pairing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Manual WhatsApp pairing is not supported",
            )
        pairing = await client.pairing_code(phone_number)
        onboarding.method = "code"
        response = await _apply_pairing_status(
            db,
            onboarding=onboarding,
            pairing=pairing,
            capabilities=capabilities,
            registry=registry,
        )
    except HTTPException:
        raise
    except WhatsAppSidecarError:
        return await _mark_session_error(db, onboarding)
    await db.commit()
    return response


async def cancel_whatsapp_onboarding(
    db: AsyncSession,
    *,
    user_id: UUID,
    session_id: UUID,
    registry: ConfiguredWhatsAppSidecarRegistry | None,
) -> ChannelWhatsAppOnboardingSessionResponse:
    onboarding = await _owned_session(db, user_id=user_id, session_id=session_id)
    if onboarding.state in {
        WHATSAPP_ONBOARDING_STATE_CANCELED,
        WHATSAPP_ONBOARDING_STATE_EXPIRED,
    }:
        return _session_response(onboarding, manual_pairing_code_supported=False)
    if onboarding.state == WHATSAPP_ONBOARDING_STATE_CONNECTED:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Disconnect the connected WhatsApp account instead",
        )
    client = (
        registry.get_custom_client(onboarding.sidecar_account_id) if registry is not None else None
    )
    if client is None:
        await _mark_session_error(db, onboarding)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="WhatsApp cancellation could not be confirmed",
        )
    try:
        await client.health()
        canceled = await stop_whatsapp_pairing(client)
    except WhatsAppSidecarError:
        await _mark_session_error(db, onboarding)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="WhatsApp cancellation could not be confirmed",
        ) from None
    if canceled.status != "stopped" or canceled.registered:
        await _mark_session_error(db, onboarding)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="WhatsApp cancellation could not be confirmed",
        )
    onboarding.state = WHATSAPP_ONBOARDING_STATE_CANCELED
    onboarding.completed_at = datetime.now(UTC)
    await db.commit()
    return _session_response(onboarding, manual_pairing_code_supported=False)


async def retry_whatsapp_onboarding(
    db: AsyncSession,
    *,
    user_id: UUID,
    session_id: UUID,
    registry: ConfiguredWhatsAppSidecarRegistry | None,
) -> ChannelWhatsAppOnboardingSessionResponse:
    onboarding = await _owned_session(db, user_id=user_id, session_id=session_id)
    if onboarding.state in WHATSAPP_ONBOARDING_ACTIVE_STATES:
        return await refresh_whatsapp_onboarding(
            db,
            user_id=user_id,
            session_id=session_id,
            registry=registry,
        )
    if registry is None or not registry.custom_slot_ids:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="WhatsApp account connection is not configured",
        )

    if onboarding.channel_account_id is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This WhatsApp connection cannot be retried",
        )
    if onboarding.state == WHATSAPP_ONBOARDING_STATE_ERROR:
        await _confirm_stopped(onboarding, registry=registry)
    await db.commit()

    await _lock_allocation(db)
    onboarding = await _owned_session(db, user_id=user_id, session_id=session_id)
    sidecar_account_id = await _select_free_sidecar_slot(
        db,
        registry=registry,
        exclude_session_id=onboarding.id,
        preferred_account_id=onboarding.sidecar_account_id,
    )
    if sidecar_account_id is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="No WhatsApp account connection slot is available",
        )
    sidecar_config_revision = registry.custom_slot_revision(sidecar_account_id)
    if sidecar_config_revision is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="WhatsApp account connection slot is unavailable",
        )
    now = datetime.now(UTC)
    onboarding.sidecar_account_id = sidecar_account_id
    onboarding.sidecar_config_revision = sidecar_config_revision
    onboarding.state = WHATSAPP_ONBOARDING_STATE_GENERATING
    onboarding.method = "qr"
    onboarding.started_at = now
    onboarding.expires_at = now + WHATSAPP_ONBOARDING_TTL
    onboarding.completed_at = None
    await db.commit()
    onboarding = await _owned_session(db, user_id=user_id, session_id=session_id)
    client = registry.get_custom_client(sidecar_account_id)
    if client is None:
        return await _mark_session_error(db, onboarding)
    try:
        capabilities = await client.capabilities()
        await client.health()
        pairing = await client.pairing_qr()
        response = await _apply_pairing_status(
            db,
            onboarding=onboarding,
            pairing=pairing,
            capabilities=capabilities,
            registry=registry,
        )
    except WhatsAppSidecarError:
        return await _mark_session_error(db, onboarding)
    await db.commit()
    return response


async def require_whatsapp_custom_logout_for_archive(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    registry: ConfiguredWhatsAppSidecarRegistry | None,
) -> None:
    if account.provider != CHANNEL_PROVIDER_WHATSAPP:
        return
    config = account.config if isinstance(account.config, dict) else {}
    if config.get("connection_mode") != "baileys_custom":
        return
    raw_sidecar_account_id = config.get("sidecar_account_id")
    sidecar_config_revision = config.get("sidecar_config_revision")
    try:
        sidecar_account_id = UUID(raw_sidecar_account_id)
    except (TypeError, ValueError, AttributeError):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="WhatsApp disconnect could not be confirmed",
        ) from None
    if registry is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="WhatsApp disconnect could not be confirmed",
        )
    if (
        not isinstance(sidecar_config_revision, str)
        or registry.custom_slot_revision(sidecar_account_id) != sidecar_config_revision
    ):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="WhatsApp disconnect could not be confirmed",
        )
    client = registry.get_custom_client(sidecar_account_id)
    if client is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="WhatsApp disconnect could not be confirmed",
        )
    try:
        health = await client.health()
        current = await client.pairing_status()
        if health.registered != current.registered:
            raise WhatsAppSidecarProtocolError("custom sidecar registration state drifted")
        if current.registered:
            await _ensure_connected_transport_for_account(
                account_id=account.id,
                slot_id=sidecar_account_id,
                config_revision=sidecar_config_revision,
                registry=registry,
            )
        disconnected = await stop_whatsapp_pairing(client, current=current)
    except WhatsAppSidecarError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="WhatsApp disconnect could not be confirmed",
        ) from None
    if disconnected.status != "stopped" or disconnected.registered:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="WhatsApp disconnect could not be confirmed",
        )
    if registry.custom_binding(account.id) == sidecar_account_id:
        await registry.unbind_custom_account(slot_id=sidecar_account_id, account_id=account.id)
    onboarding = await db.scalar(
        select(ChannelWhatsAppOnboardingSession).where(
            ChannelWhatsAppOnboardingSession.ownership_kind == WHATSAPP_ONBOARDING_OWNERSHIP_CUSTOM,
            ChannelWhatsAppOnboardingSession.channel_account_id == account.id,
            ChannelWhatsAppOnboardingSession.user_id == account.user_id,
            ChannelWhatsAppOnboardingSession.state == WHATSAPP_ONBOARDING_STATE_CONNECTED,
        )
    )
    if onboarding is not None:
        onboarding.state = WHATSAPP_ONBOARDING_STATE_CANCELED
        onboarding.completed_at = datetime.now(UTC)
    await db.flush()


async def expire_stale_whatsapp_onboarding_sessions(
    db: AsyncSession,
    *,
    registry: ConfiguredWhatsAppSidecarRegistry,
) -> int:
    """Stop abandoned browser sessions after their durable deadline."""

    stale_states = (
        WHATSAPP_ONBOARDING_STATE_GENERATING,
        WHATSAPP_ONBOARDING_STATE_READY,
        WHATSAPP_ONBOARDING_STATE_SCANNED,
        WHATSAPP_ONBOARDING_STATE_ERROR,
    )
    deadline = datetime.now(UTC)
    stale_ids = list(
        (
            await db.scalars(
                select(ChannelWhatsAppOnboardingSession.id).where(
                    ChannelWhatsAppOnboardingSession.ownership_kind
                    == WHATSAPP_ONBOARDING_OWNERSHIP_CUSTOM,
                    ChannelWhatsAppOnboardingSession.state.in_(stale_states),
                    ChannelWhatsAppOnboardingSession.expires_at <= deadline,
                )
            )
        ).all()
    )
    expired = 0
    for session_id in stale_ids:
        onboarding = await db.scalar(
            select(ChannelWhatsAppOnboardingSession)
            .where(
                ChannelWhatsAppOnboardingSession.id == session_id,
                ChannelWhatsAppOnboardingSession.ownership_kind
                == WHATSAPP_ONBOARDING_OWNERSHIP_CUSTOM,
                ChannelWhatsAppOnboardingSession.state.in_(stale_states),
                ChannelWhatsAppOnboardingSession.expires_at <= deadline,
            )
            .with_for_update(skip_locked=True)
        )
        if onboarding is None:
            continue
        await _expire_session(db, onboarding=onboarding, registry=registry)
        expired += 1
    return expired


async def _owned_session(
    db: AsyncSession,
    *,
    user_id: UUID,
    session_id: UUID,
) -> ChannelWhatsAppOnboardingSession:
    onboarding = await db.scalar(
        select(ChannelWhatsAppOnboardingSession)
        .where(
            ChannelWhatsAppOnboardingSession.id == session_id,
            ChannelWhatsAppOnboardingSession.ownership_kind == WHATSAPP_ONBOARDING_OWNERSHIP_CUSTOM,
            ChannelWhatsAppOnboardingSession.user_id == user_id,
        )
        .with_for_update()
    )
    if onboarding is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="connection not found")
    return onboarding


async def _lock_allocation(db: AsyncSession) -> None:
    await db.execute(
        text("SELECT pg_advisory_xact_lock(:lock_id)"),
        {"lock_id": _ALLOCATION_LOCK_ID},
    )


async def _free_account_ids(
    db: AsyncSession,
    *,
    registry: ConfiguredWhatsAppSidecarRegistry,
    exclude_session_id: UUID | None = None,
) -> list[UUID]:
    configured = {
        slot_id
        for slot_id in registry.custom_slot_ids
        if not registry.custom_slot_is_blocked(slot_id)
        and registry.get_custom_client(slot_id) is not None
    }
    if not configured:
        return []
    session_query = select(ChannelWhatsAppOnboardingSession.sidecar_account_id).where(
        ChannelWhatsAppOnboardingSession.ownership_kind == WHATSAPP_ONBOARDING_OWNERSHIP_CUSTOM,
        ChannelWhatsAppOnboardingSession.sidecar_account_id.in_(configured),
        ChannelWhatsAppOnboardingSession.state.in_(_UNRELEASED_SESSION_STATES),
    )
    if exclude_session_id is not None:
        session_query = session_query.where(
            ChannelWhatsAppOnboardingSession.id != exclude_session_id
        )
    reserved_ids = set((await db.scalars(session_query)).all())
    return sorted(configured - reserved_ids, key=str)


async def _select_free_sidecar_slot(
    db: AsyncSession,
    *,
    registry: ConfiguredWhatsAppSidecarRegistry,
    exclude_session_id: UUID | None = None,
    preferred_account_id: UUID | None = None,
) -> UUID | None:
    candidates = await _free_account_ids(
        db,
        registry=registry,
        exclude_session_id=exclude_session_id,
    )
    if preferred_account_id is not None and preferred_account_id in candidates:
        candidates.remove(preferred_account_id)
        candidates.insert(0, preferred_account_id)
    return candidates[0] if candidates else None


async def _pairable_sidecar(
    client: WhatsAppSidecarClient,
) -> WhatsAppSidecarCapabilities | None:
    capabilities = await client.capabilities()
    health = await client.health()
    pairing = await client.pairing_status()
    if health.registered != pairing.registered:
        return None
    if health.connected and not health.registered:
        return None
    if health.registered or pairing.registered:
        return None
    if health.status in {"pairing_qr", "pairing_code", "connected"}:
        return None
    if pairing.status in {"pairing_qr", "pairing_code", "connected"}:
        return None
    return capabilities


async def _apply_pairing_status(
    db: AsyncSession,
    *,
    onboarding: ChannelWhatsAppOnboardingSession,
    pairing: WhatsAppSidecarPairingStatus,
    capabilities: WhatsAppSidecarCapabilities,
    registry: ConfiguredWhatsAppSidecarRegistry,
) -> ChannelWhatsAppOnboardingSessionResponse:
    manual_supported = "code" in capabilities.pairing
    if pairing.status == "connected" and pairing.registered:
        await _finalize_connected_account(db, onboarding=onboarding, registry=registry)
        return _session_response(
            onboarding,
            manual_pairing_code_supported=manual_supported,
        )
    if pairing.registered:
        if pairing.status in {"starting", "pairing_qr", "pairing_code"}:
            onboarding.state = WHATSAPP_ONBOARDING_STATE_SCANNED
            return _session_response(
                onboarding,
                manual_pairing_code_supported=manual_supported,
            )
        return await _mark_session_error(db, onboarding)
    if (
        pairing.status == "pairing_qr"
        and pairing.qr is not None
        and pairing.qr_expires_at is not None
    ):
        onboarding.method = "qr"
        if datetime.now(UTC) >= pairing.qr_expires_at:
            onboarding.state = WHATSAPP_ONBOARDING_STATE_GENERATING
            return _session_response(
                onboarding,
                manual_pairing_code_supported=manual_supported,
            )
        onboarding.state = WHATSAPP_ONBOARDING_STATE_READY
        return _session_response(
            onboarding,
            manual_pairing_code_supported=manual_supported,
            qr=pairing.qr,
            qr_expires_at=pairing.qr_expires_at,
        )
    if pairing.status == "pairing_code" and pairing.code is not None:
        onboarding.method = "code"
        onboarding.state = WHATSAPP_ONBOARDING_STATE_READY
        return _session_response(
            onboarding,
            manual_pairing_code_supported=manual_supported,
            pairing_code=pairing.code,
        )
    if pairing.status == "starting":
        onboarding.state = WHATSAPP_ONBOARDING_STATE_GENERATING
        return _session_response(
            onboarding,
            manual_pairing_code_supported=manual_supported,
        )
    return await _mark_session_error(db, onboarding)


async def _finalize_connected_account(
    db: AsyncSession,
    *,
    onboarding: ChannelWhatsAppOnboardingSession,
    registry: ConfiguredWhatsAppSidecarRegistry,
) -> None:
    slot_id = onboarding.sidecar_account_id
    slot_revision = onboarding.sidecar_config_revision
    account_id: UUID | None = None
    newly_bound = False
    try:
        configured_revision = registry.custom_slot_revision(slot_id)
        if configured_revision != slot_revision:
            raise WhatsAppSidecarProtocolError("custom sidecar revision mismatch")
        existing = (
            await db.get(ChannelAccount, onboarding.channel_account_id)
            if onboarding.channel_account_id is not None
            else None
        )
        if existing is None and onboarding.channel_account_id is None:
            webhook_secret = generate_webhook_secret()
            existing = ChannelAccount(
                user_id=onboarding.user_id,
                provider=CHANNEL_PROVIDER_WHATSAPP,
                name=onboarding.name,
                status=CHANNEL_STATUS_ACTIVE,
                visibility=CHANNEL_VISIBILITY_PRIVATE,
                webhook_secret_hash=hash_token(webhook_secret),
                config={
                    "connection_mode": "baileys_custom",
                    "sidecar_account_id": str(slot_id),
                    "sidecar_config_revision": slot_revision,
                },
            )
            db.add(existing)
            await db.flush()
            onboarding.channel_account_id = existing.id
        elif existing is None:
            raise WhatsAppSidecarProtocolError("custom sidecar ownership conflict")
        elif (
            existing.user_id != onboarding.user_id
            or existing.provider != CHANNEL_PROVIDER_WHATSAPP
            or existing.archived_at is not None
            or not isinstance(existing.config, dict)
            or existing.config.get("connection_mode") != "baileys_custom"
            or existing.config.get("sidecar_account_id") != str(slot_id)
            or existing.config.get("sidecar_config_revision") != slot_revision
        ):
            raise WhatsAppSidecarProtocolError("custom sidecar ownership conflict")
        account_id = existing.id
        newly_bound = await registry.bind_custom_account(
            slot_id=slot_id,
            account_id=account_id,
            config_revision=slot_revision,
        )
        onboarding.state = WHATSAPP_ONBOARDING_STATE_CONNECTED
        onboarding.completed_at = datetime.now(UTC)
        await db.commit()
    except BaseException:
        try:
            await db.rollback()
        finally:
            if (
                newly_bound
                and account_id is not None
                and registry.custom_binding(account_id) == slot_id
            ):
                await registry.unbind_custom_account(
                    slot_id=slot_id,
                    account_id=account_id,
                )
        raise


async def _ensure_connected_transport(
    *,
    onboarding: ChannelWhatsAppOnboardingSession,
    registry: ConfiguredWhatsAppSidecarRegistry | None,
) -> None:
    if onboarding.channel_account_id is None:
        raise WhatsAppSidecarProtocolError("connected WhatsApp session has no account")
    await _ensure_connected_transport_for_account(
        account_id=onboarding.channel_account_id,
        slot_id=onboarding.sidecar_account_id,
        config_revision=onboarding.sidecar_config_revision,
        registry=registry,
    )


async def _ensure_connected_transport_for_account(
    *,
    account_id: UUID,
    slot_id: UUID,
    config_revision: str,
    registry: ConfiguredWhatsAppSidecarRegistry | None,
) -> None:
    if registry is None:
        raise WhatsAppSidecarProtocolError("custom Baileys registry is unavailable")
    if registry.custom_slot_revision(slot_id) != config_revision:
        raise WhatsAppSidecarProtocolError("custom Baileys slot revision mismatch")
    if registry.custom_binding(account_id) == slot_id:
        return
    client = registry.get_custom_client(slot_id)
    if client is None:
        raise WhatsAppSidecarProtocolError("custom Baileys slot is unavailable")
    health = await client.health()
    pairing = await client.pairing_status()
    if not health.registered or not pairing.registered:
        raise WhatsAppSidecarProtocolError("custom Baileys physical auth is unavailable")
    await registry.bind_custom_account(
        slot_id=slot_id,
        account_id=account_id,
        config_revision=config_revision,
    )


async def _expire_session(
    db: AsyncSession,
    *,
    onboarding: ChannelWhatsAppOnboardingSession,
    registry: ConfiguredWhatsAppSidecarRegistry | None,
) -> ChannelWhatsAppOnboardingSessionResponse:
    if registry is None:
        return await _mark_session_error(db, onboarding)
    client = registry.get_custom_client(onboarding.sidecar_account_id)
    if client is None:
        return await _mark_session_error(db, onboarding)
    try:
        await client.health()
        current = await client.pairing_status()
        if (
            onboarding.state != WHATSAPP_ONBOARDING_STATE_ERROR
            and current.status == "connected"
            and current.registered
        ):
            await _finalize_connected_account(db, onboarding=onboarding, registry=registry)
            await db.commit()
            return _session_response(
                onboarding,
                manual_pairing_code_supported=False,
            )
        canceled = await stop_whatsapp_pairing(client, current=current)
    except WhatsAppSidecarError:
        return await _mark_session_error(db, onboarding)
    if canceled.status != "stopped" or canceled.registered:
        return await _mark_session_error(db, onboarding)
    onboarding.state = WHATSAPP_ONBOARDING_STATE_EXPIRED
    onboarding.completed_at = datetime.now(UTC)
    await db.commit()
    return _session_response(onboarding, manual_pairing_code_supported=False)


async def _confirm_stopped(
    onboarding: ChannelWhatsAppOnboardingSession,
    *,
    registry: ConfiguredWhatsAppSidecarRegistry,
) -> None:
    client = registry.get_custom_client(onboarding.sidecar_account_id)
    if client is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="WhatsApp retry could not safely stop the previous connection",
        )
    try:
        await client.health()
        stopped = await stop_whatsapp_pairing(client)
    except WhatsAppSidecarError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="WhatsApp retry could not safely stop the previous connection",
        ) from None
    if stopped.status != "stopped" or stopped.registered:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="WhatsApp retry could not safely stop the previous connection",
        )


async def stop_whatsapp_pairing(
    client: WhatsAppSidecarClient,
    *,
    current: WhatsAppSidecarPairingStatus | None = None,
) -> WhatsAppSidecarPairingStatus:
    observed = current if current is not None else await client.pairing_status()
    if observed.registered:
        return await _logout_registered_pairing(client, current=observed)
    if observed.status == "stopped":
        return observed
    canceled = await client.pairing_cancel()
    if canceled.registered:
        return await _logout_registered_pairing(client, current=canceled)
    return canceled


async def _logout_registered_pairing(
    client: WhatsAppSidecarClient,
    *,
    current: WhatsAppSidecarPairingStatus,
) -> WhatsAppSidecarPairingStatus:
    if not current.registered:
        raise WhatsAppSidecarProtocolError("custom sidecar lost registered auth")
    deadline = asyncio.get_running_loop().time() + _LOGOUT_RECOVERY_TTL_SECONDS
    observed = current
    while True:
        if not observed.registered:
            return observed if observed.status == "stopped" else await client.pairing_cancel()
        if asyncio.get_running_loop().time() >= deadline:
            raise WhatsAppSidecarUnavailableError("custom sidecar did not reconnect for logout")
        if observed.status == "connected":
            try:
                return await client.pairing_logout()
            except WhatsAppSidecarUnavailableError:
                observed = await client.pairing_status()
                continue
        if observed.status in {"starting", "disconnected", "stopped"}:
            await client.pairing_retry()
        await asyncio.sleep(0.25)
        observed = await client.pairing_status()


async def _mark_session_error(
    db: AsyncSession,
    onboarding: ChannelWhatsAppOnboardingSession,
) -> ChannelWhatsAppOnboardingSessionResponse:
    session_id = onboarding.id
    user_id = onboarding.user_id
    await db.rollback()
    current = await _owned_session(db, user_id=user_id, session_id=session_id)
    if current.state in {
        WHATSAPP_ONBOARDING_STATE_CONNECTED,
        WHATSAPP_ONBOARDING_STATE_CANCELED,
        WHATSAPP_ONBOARDING_STATE_EXPIRED,
        WHATSAPP_ONBOARDING_STATE_ERROR,
    }:
        return _session_response(current, manual_pairing_code_supported=False)
    current.state = WHATSAPP_ONBOARDING_STATE_ERROR
    current.completed_at = datetime.now(UTC)
    await db.commit()
    return _session_response(current, manual_pairing_code_supported=False)


def _session_response(
    onboarding: ChannelWhatsAppOnboardingSession,
    *,
    manual_pairing_code_supported: bool,
    qr: str | None = None,
    qr_expires_at: datetime | None = None,
    pairing_code: str | None = None,
) -> ChannelWhatsAppOnboardingSessionResponse:
    if onboarding.state not in _WHATSAPP_ONBOARDING_STATES or onboarding.method not in {
        "qr",
        "code",
    }:
        raise WhatsAppSidecarProtocolError("invalid persisted WhatsApp onboarding state")
    return ChannelWhatsAppOnboardingSessionResponse(
        id=onboarding.id,
        channel_account_id=onboarding.channel_account_id,
        name=onboarding.name,
        state=cast(WhatsAppOnboardingState, onboarding.state),
        method=cast(Literal["qr", "code"], onboarding.method),
        qr=qr,
        qr_expires_at=qr_expires_at,
        pairing_code=pairing_code,
        manual_pairing_code_supported=manual_pairing_code_supported,
        started_at=onboarding.started_at,
        expires_at=onboarding.expires_at,
        completed_at=onboarding.completed_at,
    )
