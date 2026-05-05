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
import time
from collections import deque
from datetime import UTC, datetime, timedelta
from threading import Lock

from fastapi import APIRouter, Depends, HTTPException, Request, status
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
# retry in ≤ 10 min once expired rows clear.
_MAX_ACTIVE_DEVICES = 10_000

# Per-IP rolling-window throttle for the unauthenticated device-flow
# endpoints. Protects against a single client hammering /device or
# /poll faster than legitimate user-driven retries — without it, a
# bot loop fits inside the global table cap but still chews DB
# round-trips. In-process state, resets on restart; matches the
# pattern used in routes/internal.py.
_DEVICE_RATE_WINDOW_S = 60.0
# 90/min: a normal device-flow login is 1× POST /device + N× POST /poll
# (poll cadence is ~2s). A user who takes the full 60s before approving
# in-browser hits 1 + 30 = 31 calls inside one window. The previous 30
# cap reliably 429'd that legitimate path; the CLI surfaces 429 as a
# fatal "polling failed" and the user has to retry the whole flow.
# 90 keeps the bot-loop ceiling tight (an attacker still can't fit
# multiple full flows / second per IP) while leaving headroom for
# clock skew, network jitter, and a leisurely tab-switch.
_DEVICE_PER_IP_MAX = 90
# Hard cap on distinct buckets the limiter tracks at once. The
# /poll route buckets on `body.device_code`, which an
# unauthenticated client controls — without this cap an attacker
# could spam unique random codes and inflate
# `_device_per_ip_attempts` until OOM. Cap × per-bucket cost
# (~90 timestamps each) keeps the limiter bounded regardless of
# request rate. Legitimate concurrency: ~the number of in-flight
# device flows = ≤ `_MAX_ACTIVE_DEVICES` (10 000), so 12 000 is
# headroom for /device IP buckets + poll buckets together.
_DEVICE_RATE_MAX_BUCKETS = 12_000
_device_per_ip_attempts: dict[str, deque[float]] = {}
_device_rate_lock = Lock()


def _real_client_ip(request: Request) -> str:
    """Resolve the real CLI client IP, falling back to "unknown".

    Behind a proxy (Coolify, Cloudflare, ingress)
    `request.client.host` is the PROXY's IP — every CLI login
    then shares one bucket and the rate limiter throttles all
    users together. With `settings.trust_forwarded_for=true` we
    read the standard `X-Forwarded-For` (first hop = the
    originating client) or `CF-Connecting-IP`. Trust is gated so
    a direct-uvicorn dev setup can't be header-spoofed.
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


def _check_device_rate_limit(bucket_key: str) -> None:
    """Raise 429 if `bucket_key` has hit the cap on device-flow
    endpoints inside the rolling window. The key is the real
    client IP for `/device` (no device_code yet) and the
    device_code itself for `/poll` (each in-flight authorization
    gets its own bucket — one user's polling can't 429-out
    another). Lock-protected because the in-process deque is not
    async-safe.

    Bucket eviction:
      - **Lazy**: once a bucket's deque empties (either by
        passing the rolling window or never being filled), drop
        its dict entry. Without this an attacker spamming
        `/poll` with unique random `device_code`s every request
        would inflate the dict indefinitely — round-53 P1.
      - **Hard cap**: refuse to allocate a new bucket once the
        dict is at `_DEVICE_RATE_MAX_BUCKETS` entries. Hitting
        the cap returns 429; legitimate flows hit the lazy
        eviction path long before the cap, so this only fires
        under deliberate flooding.
    """
    now = time.monotonic()
    cutoff = now - _DEVICE_RATE_WINDOW_S
    with _device_rate_lock:
        attempts = _device_per_ip_attempts.get(bucket_key)
        if attempts is None:
            # New bucket — guard against unbounded dict growth
            # before allocating. The cap is generous (≥ legit
            # concurrency) so this only trips under flood.
            #
            # Scrub expired buckets BEFORE the cap check.
            # Without this, a flood that fills the dict to MAX
            # could leave every entry expired (60s window
            # passed) yet still in the dict — every legitimate
            # new flow then 429s permanently because lazy
            # eviction only runs AFTER successful allocation,
            # which the cap check refuses to allow.
            if len(_device_per_ip_attempts) >= _DEVICE_RATE_MAX_BUCKETS:
                _scrub_empty_buckets(cutoff)
            if len(_device_per_ip_attempts) >= _DEVICE_RATE_MAX_BUCKETS:
                raise HTTPException(
                    status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="device flow rate limit exceeded",
                    headers={"Retry-After": str(int(_DEVICE_RATE_WINDOW_S))},
                )
            attempts = deque()
            _device_per_ip_attempts[bucket_key] = attempts
        while attempts and attempts[0] < cutoff:
            attempts.popleft()
        if len(attempts) >= _DEVICE_PER_IP_MAX:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                detail="device flow rate limit exceeded",
                headers={"Retry-After": str(int(_DEVICE_RATE_WINDOW_S))},
            )
        attempts.append(now)
        # Lazy eviction lookahead: if THIS append left an empty
        # deque (impossible — we just appended) skip; else if
        # ANOTHER bucket's deque is now empty by virtue of us
        # observing time advance, scrub a small batch. Costs are
        # bounded — we only sweep when the dict has grown past
        # half the hard cap, so quiet accounts aren't paying for
        # cleanup that isn't needed.
        if len(_device_per_ip_attempts) > _DEVICE_RATE_MAX_BUCKETS // 2:
            _scrub_empty_buckets(cutoff)


def _scrub_empty_buckets(cutoff: float) -> None:
    """Drop dict entries whose deque is empty after pruning
    expired timestamps. Called under `_device_rate_lock`. Bounded
    work per call — capped at 256 entries scanned so a single
    /poll under flood doesn't pay O(N) on every hit."""
    SCAN_BUDGET = 256
    seen = 0
    keys_to_drop: list[str] = []
    for k, dq in _device_per_ip_attempts.items():
        while dq and dq[0] < cutoff:
            dq.popleft()
        if not dq:
            keys_to_drop.append(k)
        seen += 1
        if seen >= SCAN_BUDGET:
            break
    for k in keys_to_drop:
        # Re-check under lock — the deque could've grown between
        # the loop above and the delete. dict.pop with default
        # avoids KeyError on a concurrent writer.
        dq = _device_per_ip_attempts.get(k)
        if dq is not None and not dq:
            _device_per_ip_attempts.pop(k, None)


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
    request: Request,
    db: AsyncSession = Depends(get_session),
):
    # Bucket on the real client IP (proxy-aware) so concurrent
    # CLI logins behind the same Coolify/Cloudflare proxy don't
    # share a single 90/min bucket.
    _check_device_rate_limit(_real_client_ip(request))
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
    _check_device_rate_limit(f"poll-ip:{_real_client_ip(request)}")
    _check_device_rate_limit(f"poll:{body.device_code}")
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
