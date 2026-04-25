"""CLI device-authorization flow.

Standard OAuth2 device-grant shape (RFC 8628). The CLI doesn't have any
credentials yet, so it can't authenticate to the API. Instead:

  1. CLI calls /device with no auth — backend returns a long secret
     `device_code` (kept on the CLI) and a short `user_code` (printed in
     terminal + put in the browser URL).
  2. The user opens the dashboard, signs in with Clerk, and approves the
     authorization. That endpoint mints an API key and stashes the raw
     value on the device_authorizations row.
  3. The CLI polls /poll with the device_code; on the first successful
     read it gets the api_key, the row is consumed, and the raw key is
     wiped from the DB.

Why this and not paste-the-key: the user authenticates once (Clerk) and never
sees an API key. Less to misplace, less to lose. Manual paste is still
available via the CLI's `--manual` flag for SSH/headless cases.
"""

import hashlib
import secrets
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_web_auth
from app.core.config import settings
from app.core.database import get_session
from app.models.api_key import ApiKey
from app.models.device_authorization import DeviceAuthorization
from app.schemas.cli_auth import (
    DeviceApproveRequest,
    DeviceDenyRequest,
    DeviceLookupResponse,
    DevicePollRequest,
    DevicePollResponse,
    DeviceStartRequest,
    DeviceStartResponse,
    DeviceTerminalResponse,
)

router = APIRouter(prefix="/api/cli/auth", tags=["cli-auth"])

# Crockford-ish alphabet, no 0/O/1/I/L — read aloud over Zoom without "is that
# an oh or a zero" detours. 32 chars → log2(32) = 5 bits/char × 8 chars = 40
# bits of user_code entropy, gated by short TTL and Clerk auth on approve.
_USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
_USER_CODE_LEN = 8
_DEVICE_TTL = timedelta(minutes=10)
_POLL_INTERVAL_SEC = 2

# Hard cap on rows in `device_authorizations` at any moment. The endpoint is
# unauthenticated by design (CLI has no key yet), so without a ceiling a bot
# loop can inflate the table indefinitely. 10 000 covers ~1 666 concurrent
# users mid-flow given the 10-min TTL — orders of magnitude above plausible
# real load. Above the cap we 429 instead of inserting; legitimate users
# retry in ≤ 10 min once expired rows clear. Proper per-IP rate limiting
# (slowapi) is a follow-up; this is the floor.
_MAX_ACTIVE_DEVICES = 10_000


def _generate_user_code() -> str:
    return "".join(secrets.choice(_USER_CODE_ALPHABET) for _ in range(_USER_CODE_LEN))


def _generate_device_code() -> str:
    return secrets.token_urlsafe(32)  # 43 chars


def _expire_if_due(da: DeviceAuthorization) -> bool:
    """Return True if `da` is past its TTL. Mutates `status` to 'expired' so
    callers don't have to remember to do it."""
    if da.expires_at < datetime.now(UTC):
        if da.status == "pending":
            da.status = "expired"
        return True
    return False


@router.post("/device", response_model=DeviceStartResponse)
async def start_device_flow(
    body: DeviceStartRequest,
    db: AsyncSession = Depends(get_session),
):
    # Bound the (unauthenticated) write surface: prune anything past TTL and
    # refuse new inserts above a hard ceiling. Cheap — both queries hit the
    # same indexed column. Worst-case growth between calls is bounded by
    # `_MAX_ACTIVE_DEVICES`, ensuring a spam loop can't fill the table or
    # exhaust the user_code namespace.
    await db.execute(
        delete(DeviceAuthorization).where(DeviceAuthorization.expires_at < datetime.now(UTC))
    )
    active = (await db.execute(select(func.count()).select_from(DeviceAuthorization))).scalar_one()
    if active >= _MAX_ACTIVE_DEVICES:
        await db.commit()
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many active authorizations — try again in a few minutes.",
        )

    # Retry on the rare user_code collision — 8 chars from a 32-char alphabet
    # makes ~1 in a trillion at typical concurrency, but the unique-index will
    # raise IntegrityError anyway and we'd rather handle it cleanly here.
    # Catch only the integrity error so a real DB failure (connection, schema
    # drift) surfaces as a 500 instead of being masked as "user_code collision".
    for _ in range(5):
        device_code = _generate_device_code()
        user_code = _generate_user_code()
        da = DeviceAuthorization(
            device_code=device_code,
            user_code=user_code,
            client_label=body.client_label,
            expires_at=datetime.now(UTC) + _DEVICE_TTL,
        )
        db.add(da)
        try:
            await db.commit()
            break
        except IntegrityError:
            await db.rollback()
    else:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Could not allocate user_code")

    return DeviceStartResponse(
        device_code=device_code,
        user_code=user_code,
        verification_uri=f"{settings.web_origin.rstrip('/')}/cli-authorize?code={user_code}",
        expires_in=int(_DEVICE_TTL.total_seconds()),
        interval=_POLL_INTERVAL_SEC,
    )


@router.post("/poll", response_model=DevicePollResponse)
async def poll_device_flow(
    body: DevicePollRequest,
    db: AsyncSession = Depends(get_session),
):
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


@router.post("/approve", response_model=DeviceTerminalResponse)
async def approve_device_flow(
    body: DeviceApproveRequest,
    auth: AuthContext = Depends(require_web_auth),
    db: AsyncSession = Depends(get_session),
):
    # Lock the row for the duration of the approve transaction. Without it a
    # double-click in the browser can drive two concurrent /approve calls,
    # both see `pending`, both mint API keys — and the user ends up with two
    # active keys mapped to the same device_code (the second one wins for
    # one-shot delivery, the first dangles forever).
    da = await _load_device_or_404(body.user_code, db, lock=True)

    if _expire_if_due(da):
        await db.commit()
        raise HTTPException(status.HTTP_410_GONE, "Authorization request expired")

    if da.status != "pending":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Authorization is already {da.status}",
        )

    raw = "clawdi_" + secrets.token_urlsafe(32)
    label = (da.client_label or "CLI device flow")[:200]
    api_key = ApiKey(
        user_id=auth.user_id,
        key_hash=hashlib.sha256(raw.encode()).hexdigest(),
        key_prefix=raw[:16],
        label=label,
    )
    db.add(api_key)
    await db.flush()  # need api_key.id for the back-reference

    da.status = "approved"
    da.user_id = auth.user_id
    da.api_key_id = api_key.id
    da.api_key_raw = raw
    await db.commit()

    return DeviceTerminalResponse(status="approved")


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
