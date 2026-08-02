from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_user_auth
from app.core.database import get_session
from app.schemas.channel import (
    ChannelWhatsAppOnboardingCreate,
    ChannelWhatsAppOnboardingPairingCodeCreate,
    ChannelWhatsAppOnboardingReadinessResponse,
    ChannelWhatsAppOnboardingSessionResponse,
)
from app.services.whatsapp_device_onboarding import (
    cancel_whatsapp_onboarding,
    refresh_whatsapp_onboarding,
    request_whatsapp_pairing_code,
    retry_whatsapp_onboarding,
    start_whatsapp_onboarding,
    whatsapp_onboarding_readiness,
)
from app.services.whatsapp_sidecar_registry import (
    ConfiguredWhatsAppSidecarRegistry,
    get_active_whatsapp_sidecar_registry,
)

router = APIRouter(prefix="/channels/whatsapp/onboarding", tags=["channels"])


def get_whatsapp_sidecar_registry() -> ConfiguredWhatsAppSidecarRegistry | None:
    return get_active_whatsapp_sidecar_registry()


def _prevent_sensitive_caching(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store, private"
    response.headers["Pragma"] = "no-cache"


@router.get("/readiness")
async def get_whatsapp_onboarding_readiness(
    response: Response,
    _auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
    registry: ConfiguredWhatsAppSidecarRegistry | None = Depends(get_whatsapp_sidecar_registry),
) -> ChannelWhatsAppOnboardingReadinessResponse:
    _prevent_sensitive_caching(response)
    return await whatsapp_onboarding_readiness(db, registry=registry)


@router.post("/sessions", status_code=status.HTTP_201_CREATED)
async def create_whatsapp_onboarding_session(
    body: ChannelWhatsAppOnboardingCreate,
    response: Response,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
    registry: ConfiguredWhatsAppSidecarRegistry | None = Depends(get_whatsapp_sidecar_registry),
) -> ChannelWhatsAppOnboardingSessionResponse:
    _prevent_sensitive_caching(response)
    return await start_whatsapp_onboarding(
        db,
        user_id=auth.user_id,
        request_id=body.request_id,
        name=body.name,
        registry=registry,
    )


@router.get("/sessions/{session_id}")
async def get_whatsapp_onboarding_session(
    session_id: UUID,
    response: Response,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
    registry: ConfiguredWhatsAppSidecarRegistry | None = Depends(get_whatsapp_sidecar_registry),
) -> ChannelWhatsAppOnboardingSessionResponse:
    _prevent_sensitive_caching(response)
    return await refresh_whatsapp_onboarding(
        db,
        user_id=auth.user_id,
        session_id=session_id,
        registry=registry,
    )


@router.post("/sessions/{session_id}/pairing-code")
async def create_whatsapp_onboarding_pairing_code(
    session_id: UUID,
    body: ChannelWhatsAppOnboardingPairingCodeCreate,
    response: Response,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
    registry: ConfiguredWhatsAppSidecarRegistry | None = Depends(get_whatsapp_sidecar_registry),
) -> ChannelWhatsAppOnboardingSessionResponse:
    _prevent_sensitive_caching(response)
    return await request_whatsapp_pairing_code(
        db,
        user_id=auth.user_id,
        session_id=session_id,
        phone_number=body.phone_number.get_secret_value(),
        registry=registry,
    )


@router.post("/sessions/{session_id}/cancel")
async def cancel_whatsapp_onboarding_session(
    session_id: UUID,
    response: Response,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
    registry: ConfiguredWhatsAppSidecarRegistry | None = Depends(get_whatsapp_sidecar_registry),
) -> ChannelWhatsAppOnboardingSessionResponse:
    _prevent_sensitive_caching(response)
    return await cancel_whatsapp_onboarding(
        db,
        user_id=auth.user_id,
        session_id=session_id,
        registry=registry,
    )


@router.post("/sessions/{session_id}/retry")
async def retry_whatsapp_onboarding_session(
    session_id: UUID,
    response: Response,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
    registry: ConfiguredWhatsAppSidecarRegistry | None = Depends(get_whatsapp_sidecar_registry),
) -> ChannelWhatsAppOnboardingSessionResponse:
    _prevent_sensitive_caching(response)
    return await retry_whatsapp_onboarding(
        db,
        user_id=auth.user_id,
        session_id=session_id,
        registry=registry,
    )
