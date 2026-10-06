"""CLI authentication routes.

Interactive login uses Clerk OAuth Authorization Code + PKCE. The legacy
browser-approved API-key bootstrap is retired: /device and /approve return
410 with upgrade guidance. /poll, /lookup and /deny remain available for
existing authorizations to expire or be consumed without issuing new keys.
"""

# The module-level httpx name remains a patch seam for transport tests.
# pyright: reportUnusedImport=false
from datetime import UTC, datetime, timedelta
from urllib.parse import quote

import httpx  # noqa: F401 - retained as a patch seam for Clerk transport tests
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_oauth_cli_auth, require_web_auth
from app.core.config import settings
from app.core.database import get_session
from app.models.device_authorization import DeviceAuthorization
from app.schemas.cli_auth import (
    DesktopSessionTicketResponse,
    DeviceApproveRequest,
    DeviceDenyRequest,
    DeviceFlowRetiredResponse,
    DeviceLookupResponse,
    DevicePollRequest,
    DevicePollResponse,
    DeviceStartResponse,
    DeviceTerminalResponse,
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
from app.services.distributed_state import SharedRateLimitExceeded, consume_shared_rate_limit

router = APIRouter(prefix="/cli/auth", tags=["cli-auth"])

_RETIRED_DEVICE_FLOW_DETAIL = (
    "This sign-in method is no longer supported. Update the Clawdi CLI and run `clawdi auth login`."
)
_DESKTOP_SESSION_TTL_SEC = 60


class _ClerkSignInToken(BaseModel):
    token: str = Field(min_length=1, max_length=8192)


# Keep the shared rolling-window throttle for unauthenticated legacy polls.
_DEVICE_RATE_WINDOW_S = 60.0
_DEVICE_PER_IP_MAX = 90
# Bound shared limiter state even when callers submit random device codes.
_DEVICE_RATE_MAX_BUCKETS = 32_000
_DEVICE_RATE_NAMESPACE = "cli-device-flow"


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


def _real_client_ip(request: Request) -> str:
    """Resolve the real CLI client IP, falling back to "unknown".

    Behind a reverse proxy or ingress, `request.client.host` is
    the proxy's IP — every CLI login then shares one bucket and
    the rate limiter throttles all users together. With
    `settings.trust_forwarded_for=true` we read the standard
    `X-Forwarded-For` (first hop = the originating client) or
    `CF-Connecting-IP`. Trust is gated so a direct-uvicorn dev
    setup can't be header-spoofed.
    """
    if settings.trust_forwarded_for:
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            # `X-Forwarded-For: client, proxy1, proxy2` — the
            # first entry is the original client.
            first = fwd.split(",", 1)[0].strip()
            if first:
                return first
        cf = request.headers.get("cf-connecting-ip")
        if cf:
            return cf.strip()
    return request.client.host if request.client else "unknown"


async def _check_device_rate_limit(bucket_key: str) -> None:
    """Raise 429 if `bucket_key` has hit the legacy bootstrap cap on
    endpoints inside the rolling window. The key is the real
    client IP for `/device` (no device_code yet) and the
    device_code itself for `/poll` (each in-flight authorization gets its own
    bucket, so one user's polling cannot 429 another). The shared service uses
    an exact sliding window, hashes untrusted keys before persistence, expires
    idle buckets, and enforces the namespace-wide bucket bound atomically.
    """
    try:
        await consume_shared_rate_limit(
            namespace=_DEVICE_RATE_NAMESPACE,
            key=bucket_key,
            limit=_DEVICE_PER_IP_MAX,
            window=timedelta(seconds=_DEVICE_RATE_WINDOW_S),
            max_buckets=_DEVICE_RATE_MAX_BUCKETS,
        )
    except SharedRateLimitExceeded as error:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            detail="device flow rate limit exceeded",
            headers={"Retry-After": str(error.retry_after_seconds)},
        ) from error


def _expire_if_due(da: DeviceAuthorization) -> bool:
    """Return True if `da` is past its TTL. Mutates `status` to 'expired' so
    callers don't have to remember to do it."""
    if da.expires_at < datetime.now(UTC):
        if da.status == "pending":
            da.status = "expired"
        return True
    return False


@router.post(
    "/device",
    response_model=DeviceStartResponse,
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


@router.post("/poll", response_model=DevicePollResponse)
async def poll_device_flow(
    body: DevicePollRequest,
    request: Request,
    db: AsyncSession = Depends(get_session),
):
    # Two buckets, both must pass:
    #
    # 1. IP bucket. A flood of unique random device_codes from
    #    one IP would otherwise allocate a fresh bucket per
    #    request and bypass throttling (round-53 P1: each new
    #    device_code spawns a new dict entry). This 90/min
    #    per-real-IP budget caps the burst even if every
    #    incoming code is unique. Behind a proxy `_real_client_ip`
    #    reads X-Forwarded-For so legitimate users behind a
    #    shared NAT each get their own budget.
    # 2. device_code bucket. Each in-flight authorization gets
    #    its own 90/min budget so a legitimate user polling at
    #    2s cadence (~30 polls per 60s window) never collides
    #    with another flow that shares the same client IP.
    await _check_device_rate_limit(f"poll-ip:{_real_client_ip(request)}")
    await _check_device_rate_limit(f"poll:{body.device_code}")
    # `with_for_update()` is what makes one-shot delivery actually one-shot.
    # Two CLIs accidentally polling the same device_code would otherwise both
    # read `approved` + `api_key_raw` under READ COMMITTED isolation and both
    # commit the consume — both clients walk away thinking they got the only
    # key. The row lock serializes the read+update so the second poller sees
    # the cleared row and falls through to "expired".
    da = (
        await db.execute(
            select(DeviceAuthorization)
            .where(DeviceAuthorization.device_code == body.device_code)
            .with_for_update()
        )
    ).scalar_one_or_none()

    # Don't tell an unauthenticated caller whether a device_code "exists" vs
    # "expired" — fold both into the same response.
    if not da:
        return DevicePollResponse(status="expired")

    if _expire_if_due(da):
        await db.commit()
        return DevicePollResponse(status="expired")

    if da.status == "denied":
        return DevicePollResponse(status="denied")

    if da.status == "pending":
        return DevicePollResponse(status="pending")

    if da.status == "approved":
        # One-shot delivery. Capture the raw key, blank the row, and flag the
        # status so a second poll behaves as if the authorization expired.
        api_key = da.api_key_raw
        if not api_key:
            return DevicePollResponse(status="expired")
        da.api_key_raw = None
        da.status = "consumed"
        await db.commit()
        return DevicePollResponse(status="approved", api_key=api_key)

    # `consumed` and any future statuses → expired from the CLI's perspective.
    return DevicePollResponse(status="expired")


async def _load_device_or_404(
    user_code: str, db: AsyncSession, *, lock: bool = False
) -> DeviceAuthorization:
    """Look up a device authorization by user_code.

    `lock=True` takes a row-level lock for read+modify use sites (approve,
    deny). The lookup endpoint stays lockless because it's a pure read and
    locking would hold the row across the round-trip to the React UI.
    """
    stmt = select(DeviceAuthorization).where(DeviceAuthorization.user_code == user_code.upper())
    if lock:
        stmt = stmt.with_for_update()
    da = (await db.execute(stmt)).scalar_one_or_none()
    if not da:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Authorization request not found")
    return da


@router.get("/lookup", response_model=DeviceLookupResponse)
async def lookup_device_flow(
    code: str,
    auth: AuthContext = Depends(require_web_auth),
    db: AsyncSession = Depends(get_session),
):
    """Web dashboard reads this to render the approve screen."""
    _ = auth  # require_web_auth gates access; the Clerk identity isn't used here.
    da = await _load_device_or_404(code, db)
    if _expire_if_due(da):
        await db.commit()
    return DeviceLookupResponse(
        user_code=da.user_code,
        client_label=da.client_label,
        status=da.status,
        expires_at=da.expires_at,
    )


@router.post(
    "/approve",
    response_model=DeviceTerminalResponse,
    deprecated=True,
    responses={
        status.HTTP_410_GONE: {
            "model": DeviceFlowRetiredResponse,
            "description": _RETIRED_DEVICE_FLOW_DETAIL,
        }
    },
)
async def approve_device_flow(
    body: DeviceApproveRequest,
    auth: AuthContext = Depends(require_web_auth),
):
    raise HTTPException(status.HTTP_410_GONE, _RETIRED_DEVICE_FLOW_DETAIL)


@router.post("/deny", response_model=DeviceTerminalResponse)
async def deny_device_flow(
    body: DeviceDenyRequest,
    auth: AuthContext = Depends(require_web_auth),
    db: AsyncSession = Depends(get_session),
):
    _ = auth
    da = await _load_device_or_404(body.user_code, db, lock=True)

    if _expire_if_due(da):
        await db.commit()
        raise HTTPException(status.HTTP_410_GONE, "Authorization request expired")

    if da.status != "pending":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Authorization is already {da.status}",
        )

    da.status = "denied"
    await db.commit()
    return DeviceTerminalResponse(status="denied")
