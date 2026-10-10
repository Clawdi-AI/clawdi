"""CLI authentication routes."""

from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_oauth_cli_auth
from app.core.config import settings
from app.core.database import get_session
from app.schemas.cli_auth import (
    DesktopSessionRequest,
    DesktopSessionRevokeRequest,
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


_DESKTOP_SESSION_TTL_SEC = 60


class _ClerkSignInToken(BaseModel):
    model_config = ConfigDict(hide_input_in_errors=True)

    token: str = Field(min_length=1, max_length=8192, repr=False)


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
    body: DesktopSessionRequest | None = None,
    auth: AuthContext = Depends(require_oauth_cli_auth),
) -> DesktopSessionTicketResponse:
    """Exchange the first-party CLI identity for a one-use browser session ticket."""
    clerk_id = auth.user.clerk_id
    if not clerk_id or not settings.clerk_secret_key:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Desktop sign-in is not configured",
        )

    response.headers["Cache-Control"] = "no-store"
    if body is not None:
        current = (
            await _desktop_clerk_session(body.session_id) if body.user_id == clerk_id else None
        )
        valid = current is not None and current.user_id == clerk_id and current.status == "active"
        return DesktopSessionTicketResponse(
            status="signed-in" if valid else "sign-out",
            expires_in=0,
            clerk_user_id=clerk_id,
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
        status="ticket",
        ticket=sign_in.token,
        expires_in=_DESKTOP_SESSION_TTL_SEC,
        clerk_user_id=clerk_id,
    )


class _ClerkSession(BaseModel):
    model_config = ConfigDict(hide_input_in_errors=True)

    user_id: str
    status: str


async def _desktop_clerk_session(session_id: str) -> _ClerkSession | None:
    try:
        upstream = await get_clerk_backend_client().get(
            clerk_backend_url(f"sessions/{quote(session_id, safe='')}"),
            headers=clerk_backend_headers(),
        )
    except (ClerkBackendTimeoutError, ClerkBackendTransportError):
        raise HTTPException(503, "Desktop session is temporarily unavailable") from None
    if upstream.status_code == 404:
        return None
    if upstream.status_code >= 500:
        raise HTTPException(503, "Desktop session is temporarily unavailable")
    if upstream.status_code != 200:
        raise HTTPException(502, "Desktop session verification failed")
    try:
        return _ClerkSession.model_validate_json(upstream.content)
    except ValidationError:
        raise HTTPException(502, "Desktop session verification failed") from None


@router.post("/oauth/desktop-session/revoke", response_model=OAuthRevokeResponse)
async def revoke_desktop_session(
    body: DesktopSessionRevokeRequest,
    response: Response,
    auth: AuthContext = Depends(require_oauth_cli_auth),
) -> OAuthRevokeResponse:
    """Revoke only a Clerk session owned by the authenticated CLI account."""
    response.headers["Cache-Control"] = "no-store"
    if not settings.clerk_secret_key:
        raise HTTPException(503, "Desktop sign-out is not configured")
    current = await _desktop_clerk_session(body.session_id)
    if current is None:
        return OAuthRevokeResponse(status="revoked")
    if current.user_id != auth.user.clerk_id:
        raise HTTPException(403, "Desktop session belongs to another account")
    if current.status != "active":
        return OAuthRevokeResponse(status="revoked")
    try:
        upstream = await get_clerk_backend_client().post(
            clerk_backend_url(f"sessions/{quote(body.session_id, safe='')}/revoke"),
            headers=clerk_backend_headers(),
        )
    except (ClerkBackendTimeoutError, ClerkBackendTransportError):
        raise HTTPException(503, "Desktop sign-out is temporarily unavailable") from None
    if upstream.status_code >= 500:
        raise HTTPException(503, "Desktop sign-out is temporarily unavailable")
    if not 200 <= upstream.status_code < 300:
        raise HTTPException(502, "Desktop sign-out failed")
    return OAuthRevokeResponse(status="revoked")
