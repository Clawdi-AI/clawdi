"""CLI authentication routes.

Interactive login uses Clerk OAuth device authorization. The legacy
browser-approved API-key bootstrap is retired; the device and poll endpoints
remain as 410 stubs so released CLIs receive upgrade guidance.
"""

# The module-level httpx name remains a patch seam for transport tests.
# pyright: reportUnusedImport=false
from urllib.parse import quote

import httpx  # noqa: F401 - retained as a patch seam for Clerk transport tests
from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_oauth_cli_auth
from app.core.config import settings
from app.core.database import get_session
from app.schemas.cli_auth import (
    DesktopSessionTicketResponse,
    DeviceFlowRetiredResponse,
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

_RETIRED_DEVICE_FLOW_DETAIL = (
    "This sign-in method is no longer supported. Update the Clawdi CLI and run `clawdi auth login`."
)
_DESKTOP_SESSION_TTL_SEC = 60


class _ClerkSignInToken(BaseModel):
    token: str = Field(min_length=1, max_length=8192)


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
        # Keep this registered loopback callback for Desktop's upcoming
        # authorization-code + PKCE flow.
        redirect_uri=oauth_setting.redirect_uri,
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


@router.post("/oauth/desktop-ticket", response_model=DesktopSessionTicketResponse)
async def create_desktop_session_ticket(
    response: Response,
    auth: AuthContext = Depends(require_oauth_cli_auth),
) -> DesktopSessionTicketResponse:
    """Exchange the first-party CLI identity for a one-use browser session ticket."""
    clerk_id = auth.user.clerk_id
    if not clerk_id or not settings.clerk_secret_key:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Desktop sign-in is not configured",
        )

    try:
        upstream = await get_clerk_backend_client().post(
            clerk_backend_url("sign_in_tokens"),
            headers=clerk_backend_headers(),
            json={
                "user_id": clerk_id,
                "expires_in_seconds": _DESKTOP_SESSION_TTL_SEC,
            },
        )
    except ClerkBackendTimeoutError:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Desktop sign-in is temporarily unavailable",
        ) from None
    except ClerkBackendTransportError:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "Desktop sign-in failed",
        ) from None

    if upstream.status_code >= 500:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Desktop sign-in is temporarily unavailable",
        )
    if not 200 <= upstream.status_code < 300:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Desktop sign-in failed")
    try:
        sign_in = _ClerkSignInToken.model_validate_json(upstream.content)
    except ValidationError:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Desktop sign-in failed") from None

    response.headers["Cache-Control"] = "no-store"
    return DesktopSessionTicketResponse(
        ticket=sign_in.token,
        expires_in=_DESKTOP_SESSION_TTL_SEC,
    )


@router.post(
    "/device",
    response_model=DeviceFlowRetiredResponse,
    deprecated=True,
    responses={
        status.HTTP_410_GONE: {
            "model": DeviceFlowRetiredResponse,
            "description": _RETIRED_DEVICE_FLOW_DETAIL,
        }
    },
)
async def start_device_flow():
    raise HTTPException(status.HTTP_410_GONE, _RETIRED_DEVICE_FLOW_DETAIL)


@router.post(
    "/poll",
    response_model=DeviceFlowRetiredResponse,
    deprecated=True,
    responses={
        status.HTTP_410_GONE: {
            "model": DeviceFlowRetiredResponse,
            "description": _RETIRED_DEVICE_FLOW_DETAIL,
        }
    },
)
async def poll_device_flow():
    raise HTTPException(status.HTTP_410_GONE, _RETIRED_DEVICE_FLOW_DETAIL)
