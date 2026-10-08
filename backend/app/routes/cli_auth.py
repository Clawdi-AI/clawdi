"""CLI authentication routes."""

from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_oauth_cli_auth
from app.core.config import settings
from app.core.database import get_session
from app.schemas.cli_auth import (
    DesktopSessionTicketResponse,
    OAuthConfigResponse,
    OAuthRevokeRequest,
    OAuthRevokeResponse,
)
from app.services.app_setting_registry import CLERK_CLI_OAUTH_SPEC
from app.services.app_settings import AppSettingUnavailable, resolve_app_setting
from app.services.clerk_backend import (
    ClerkBackendTimeoutError,
    ClerkBackendTransportError,
    clerk_backend_headers,
    clerk_backend_url,
    get_clerk_backend_client,
)
from app.services.clerk_cli_oauth_settings import ClerkCliOAuthSetting

router = APIRouter(prefix="/cli/auth", tags=["cli-auth"])

_RETIRED_DESKTOP_TICKET_DETAIL = (
    "Desktop sign-in tickets are no longer supported. Update Clawdi Desktop and open "
    "https://cloud.clawdi.ai in your browser."
)


async def _oauth_setting_or_503(db: AsyncSession) -> ClerkCliOAuthSetting:
    try:
        oauth_setting = await resolve_app_setting(db, CLERK_CLI_OAUTH_SPEC)
    except AppSettingUnavailable as error:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "OAuth CLI authentication is not configured",
        ) from error
    if not oauth_setting.enabled:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "OAuth CLI authentication is not configured",
        )
    return oauth_setting


async def _oauth_public_config_or_503(db: AsyncSession) -> OAuthConfigResponse:
    oauth_setting = await _oauth_setting_or_503(db)
    return OAuthConfigResponse(
        issuer=oauth_setting.issuer,
        client_id=oauth_setting.client_id,
        audience=oauth_setting.audience,
        authorized_parties=oauth_setting.authorized_parties,
    )


@router.get("/oauth/config", response_model=OAuthConfigResponse)
async def get_oauth_config(db: AsyncSession = Depends(get_session)) -> OAuthConfigResponse:
    """Return only the Public OAuth App values needed by the local CLI."""
    return await _oauth_public_config_or_503(db)


@router.post("/oauth/revoke", response_model=OAuthRevokeResponse)
async def revoke_oauth_refresh_grant(
    body: OAuthRevokeRequest,
    auth: AuthContext = Depends(require_oauth_cli_auth),
    db: AsyncSession = Depends(get_session),
) -> OAuthRevokeResponse:
    """Revoke a Clerk OAuth refresh grant without logging or returning it.

    Clerk's Backend API identifies the OAuth application in the path and
    accepts the refresh token as `token`. JWT access tokens are self-contained
    and remain valid until their normal expiry; this only prevents refreshes.
    """
    _ = auth
    oauth_setting = await _oauth_setting_or_503(db)
    application_id = oauth_setting.application_id
    secret_key = settings.clerk_secret_key
    if not application_id or not secret_key:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "OAuth CLI revocation is not configured",
        )

    escaped_application_id = quote(application_id, safe="")
    url = clerk_backend_url(f"oauth_applications/{escaped_application_id}/revoke_token")
    headers = clerk_backend_headers()
    try:
        response = await get_clerk_backend_client().post(
            url,
            headers=headers,
            json={"token": body.refresh_token.get_secret_value()},
        )
    except ClerkBackendTimeoutError:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "OAuth CLI revocation is temporarily unavailable",
        ) from None
    except ClerkBackendTransportError:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "OAuth CLI revocation failed",
        ) from None

    if response.status_code >= 500:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "OAuth CLI revocation is temporarily unavailable",
        )
    if not 200 <= response.status_code < 300:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "OAuth CLI revocation failed")
    return OAuthRevokeResponse(status="revoked")


# Keep upgrade guidance for Desktop beta.1–7 until beta.8 is released.
@router.post(
    "/oauth/desktop-ticket",
    response_model=DesktopSessionTicketResponse,
    deprecated=True,
    responses={
        status.HTTP_410_GONE: {
            "description": _RETIRED_DESKTOP_TICKET_DETAIL,
        }
    },
)
async def create_desktop_session_ticket():
    raise HTTPException(status.HTTP_410_GONE, _RETIRED_DESKTOP_TICKET_DETAIL)
