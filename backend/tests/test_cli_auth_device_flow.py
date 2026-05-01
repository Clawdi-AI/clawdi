"""Device authorization flow.

Covers the four end states a poll can land in (pending → approved+consumed,
denied, expired) and verifies that an unauthenticated /poll never leaks
whether a device_code exists by treating "missing" the same as "expired".
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.device_authorization import DeviceAuthorization


async def _start(client: httpx.AsyncClient, label: str = "test cli") -> dict:
    r = await client.post("/api/cli/auth/device", json={"client_label": label})
    assert r.status_code == 200, r.text
    return r.json()


@pytest.mark.asyncio
async def test_device_start_returns_codes_and_verification_uri(client: httpx.AsyncClient):
    body = await _start(client)
    assert body["device_code"] and len(body["device_code"]) >= 32
    # Crockford-ish alphabet, 8 chars, all uppercase.
    assert len(body["user_code"]) == 8
    assert body["user_code"].isupper()
    assert body["user_code"] == body["user_code"].strip()
    assert body["verification_uri"].startswith(settings.web_origin)
    assert body["user_code"] in body["verification_uri"]
    assert body["expires_in"] > 0
    assert body["interval"] >= 1


@pytest.mark.asyncio
async def test_pending_then_approve_then_one_shot_poll(client: httpx.AsyncClient):
    started = await _start(client)

    # First poll while pending.
    r = await client.post("/api/cli/auth/poll", json={"device_code": started["device_code"]})
    assert r.status_code == 200
    assert r.json()["status"] == "pending"

    # Approve as the dashboard user. The fixture's `client` runs as a Clerk-
    # auth'd seed_user via dependency override.
    r = await client.post("/api/cli/auth/approve", json={"user_code": started["user_code"]})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "approved"

    # First post-approve poll returns the api key.
    r = await client.post("/api/cli/auth/poll", json={"device_code": started["device_code"]})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "approved"
    assert body["api_key"] and body["api_key"].startswith("clawdi_")

    # Second poll must NOT return the api key — one-shot delivery.
    r = await client.post("/api/cli/auth/poll", json={"device_code": started["device_code"]})
    assert r.status_code == 200
    assert r.json()["status"] == "expired"
    assert r.json().get("api_key") is None


@pytest.mark.asyncio
async def test_deny_short_circuits_poll(client: httpx.AsyncClient):
    started = await _start(client)
    r = await client.post("/api/cli/auth/deny", json={"user_code": started["user_code"]})
    assert r.status_code == 200
    r = await client.post("/api/cli/auth/poll", json={"device_code": started["device_code"]})
    assert r.json()["status"] == "denied"


@pytest.mark.asyncio
async def test_unknown_device_code_looks_like_expired(client: httpx.AsyncClient):
    """A poller without a valid code shouldn't be able to enumerate codes;
    fold "not found" into the same response shape as "expired"."""
    r = await client.post("/api/cli/auth/poll", json={"device_code": "not-a-real-code"})
    assert r.status_code == 200
    assert r.json()["status"] == "expired"


@pytest.mark.asyncio
async def test_approve_after_expiry_returns_410(
    client: httpx.AsyncClient, db_session: AsyncSession
):
    started = await _start(client)
    # Backdate the row so the next call sees it as expired.
    da = (
        await db_session.execute(
            select(DeviceAuthorization).where(
                DeviceAuthorization.device_code == started["device_code"]
            )
        )
    ).scalar_one()
    da.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    await db_session.commit()

    r = await client.post("/api/cli/auth/approve", json={"user_code": started["user_code"]})
    assert r.status_code == 410


@pytest.mark.asyncio
async def test_lookup_returns_status_and_label(client: httpx.AsyncClient):
    started = await _start(client, label="Claude Code · ci-runner")
    r = await client.get("/api/cli/auth/lookup", params={"code": started["user_code"]})
    assert r.status_code == 200
    body = r.json()
    assert body["user_code"] == started["user_code"]
    assert body["client_label"] == "Claude Code · ci-runner"
    assert body["status"] == "pending"


@pytest.mark.asyncio
async def test_device_start_prunes_expired_rows(
    client: httpx.AsyncClient, db_session: AsyncSession
):
    """Each /device call should garbage-collect rows past their TTL.
    Bounds the unauthenticated table from inflating indefinitely under spam.

    The test DB is shared across the suite and not rolled back per-test, so
    use a unique tag prefix to identify our planted rows and assert about
    only those.
    """
    import uuid as uuid_mod

    tag = uuid_mod.uuid4().hex[:8]
    for i in range(3):
        db_session.add(
            DeviceAuthorization(
                device_code=f"prune-{tag}-{i}",
                user_code=f"X{tag.upper()}{i}",  # 8 chars, alphabet-safe
                expires_at=datetime.now(UTC) - timedelta(hours=1),
            )
        )
    await db_session.commit()

    before = (
        await db_session.execute(
            select(DeviceAuthorization).where(
                DeviceAuthorization.device_code.like(f"prune-{tag}-%")
            )
        )
    ).all()
    assert len(before) == 3

    # /device sweep should clear all rows whose expires_at has passed —
    # including ours, regardless of any concurrent test data.
    await _start(client)

    after = (
        await db_session.execute(
            select(DeviceAuthorization).where(
                DeviceAuthorization.device_code.like(f"prune-{tag}-%")
            )
        )
    ).all()
    assert len(after) == 0


@pytest.mark.asyncio
async def test_real_client_ip_reads_x_forwarded_for_when_trusted(monkeypatch):
    """Round-51 P1 regression: behind a Coolify/Cloudflare proxy
    `request.client.host` is the proxy's IP. Without forwarded-
    header support every CLI login shares one bucket and the
    third concurrent login 429s. With `trust_forwarded_for=True`
    we read `X-Forwarded-For` (first hop = real client) and
    `CF-Connecting-IP`.

    Trust is gated so a direct-uvicorn dev/production setup
    can't be header-spoofed; the default (False) ignores
    forwarded headers entirely."""
    from types import SimpleNamespace

    from app.routes.cli_auth import _real_client_ip

    def make_request(headers: dict[str, str], client_host: str | None = "10.0.0.1"):
        return SimpleNamespace(
            headers=headers,
            client=SimpleNamespace(host=client_host) if client_host else None,
        )

    # Default: trust off → ignores forwarded headers, returns
    # the connection's own IP.
    monkeypatch.setattr(settings, "trust_forwarded_for", False)
    req = make_request({"x-forwarded-for": "1.2.3.4, 10.0.0.2"})
    assert _real_client_ip(req) == "10.0.0.1"

    # Trust on: prefer XFF first hop.
    monkeypatch.setattr(settings, "trust_forwarded_for", True)
    req = make_request({"x-forwarded-for": "1.2.3.4, 10.0.0.2"})
    assert _real_client_ip(req) == "1.2.3.4"

    # XFF first hop with whitespace is stripped.
    req = make_request({"x-forwarded-for": "  1.2.3.4  , 10.0.0.2"})
    assert _real_client_ip(req) == "1.2.3.4"

    # No XFF → fall back to CF-Connecting-IP.
    req = make_request({"cf-connecting-ip": "5.6.7.8"})
    assert _real_client_ip(req) == "5.6.7.8"

    # Missing both → connection IP fallback.
    req = make_request({})
    assert _real_client_ip(req) == "10.0.0.1"

    # No client at all → "unknown" sentinel.
    req = make_request({}, client_host=None)
    assert _real_client_ip(req) == "unknown"


@pytest.mark.asyncio
async def test_poll_rate_limit_keyed_per_device_code(client: httpx.AsyncClient, monkeypatch):
    """Round-51 + round-53 contract: /poll uses TWO buckets —
    per-real-IP (caps a flood of random codes from one IP) AND
    per-device_code (each in-flight auth gets its own budget).
    Behind a proxy with `trust_forwarded_for=True`, real IPs
    differ between users so a sibling user's poll isn't 429'd
    by another user's flow.

    Pinned by:
      - exhausting flow A's IP+device_code buckets at ipA,
      - confirming flow B's first poll from a DIFFERENT real
        IP still returns 200 `pending`.
    """
    from app.routes.cli_auth import (
        _DEVICE_PER_IP_MAX,
        _device_per_ip_attempts,
        _device_rate_lock,
    )

    monkeypatch.setattr(settings, "trust_forwarded_for", True)
    # Reset shared state so other tests' attempts don't bleed in.
    with _device_rate_lock:
        _device_per_ip_attempts.clear()

    flow_a = await _start(client, label="cli a")
    flow_b = await _start(client, label="cli b")

    # Hammer flow A's poll buckets (IP + device_code) up to
    # the cap. The post needs an XFF header so the real-IP
    # bucket keys on `1.1.1.1` not the test client's
    # connection host.
    for _ in range(_DEVICE_PER_IP_MAX):
        r = await client.post(
            "/api/cli/auth/poll",
            json={"device_code": flow_a["device_code"]},
            headers={"X-Forwarded-For": "1.1.1.1"},
        )
        assert r.status_code == 200, r.text

    # One more poll from ipA → 429 (its IP bucket is full).
    r_a = await client.post(
        "/api/cli/auth/poll",
        json={"device_code": flow_a["device_code"]},
        headers={"X-Forwarded-For": "1.1.1.1"},
    )
    assert r_a.status_code == 429, r_a.text

    # B's first poll from a DIFFERENT real IP — fresh IP +
    # fresh device_code buckets. Must NOT 429. Pre-round-51
    # it would have shared A's bucket via the connection-level
    # client IP and 429'd immediately.
    r_b = await client.post(
        "/api/cli/auth/poll",
        json={"device_code": flow_b["device_code"]},
        headers={"X-Forwarded-For": "2.2.2.2"},
    )
    assert r_b.status_code == 200, r_b.text
    assert r_b.json()["status"] == "pending"


@pytest.mark.asyncio
async def test_poll_rate_limiter_evicts_unbounded_random_device_codes(
    client: httpx.AsyncClient,
):
    """Round-53 P1: /poll buckets on the unvalidated body
    `device_code`. Pre-fix an attacker could send a stream of
    unique random codes and each one allocated a fresh deque in
    `_device_per_ip_attempts` that was never evicted —
    backend memory grew without bound. Now:
      - lazy eviction drops empty deques on every check, AND
      - the IP-keyed `poll-ip:` bucket caps the per-IP burst
        at 90/min regardless of how many random codes the
        attacker cycles through.

    Pinned by sending many unique random device_codes; the
    real-IP bucket exhausts after 90, subsequent polls 429."""
    import secrets as _secrets

    from app.routes.cli_auth import (
        _DEVICE_PER_IP_MAX,
        _device_per_ip_attempts,
        _device_rate_lock,
    )

    with _device_rate_lock:
        _device_per_ip_attempts.clear()

    successes = 0
    saw_429 = False
    for i in range(200):
        r = await client.post(
            "/api/cli/auth/poll",
            json={"device_code": f"forged-{i}-{_secrets.token_urlsafe(8)}"},
        )
        if r.status_code == 200:
            successes += 1
        elif r.status_code == 429:
            saw_429 = True
            break

    # IP bucket caps the per-IP burst at 90/min — at most
    # that many successes go through before 429.
    assert successes <= _DEVICE_PER_IP_MAX
    # 429 must fire — otherwise the limiter is broken.
    assert saw_429


@pytest.mark.asyncio
async def test_poll_rejects_oversized_device_code(client: httpx.AsyncClient):
    """Round-r4 P1: /poll's device_code was used as a rate-limit
    dict key without a length cap. An attacker could push very
    large unique strings through to the limiter, and the 90/min
    IP cap would still permit gigabytes of resident memory.
    Schema-level max_length=128 rejects oversize codes at
    request validation (422) before the limiter or DB sees them.

    Pinned by sending a 200KB device_code: the request must
    422-reject and the limiter dict must remain unchanged."""
    from app.routes.cli_auth import (
        _device_per_ip_attempts,
        _device_rate_lock,
    )

    with _device_rate_lock:
        _device_per_ip_attempts.clear()
        before_keys = set(_device_per_ip_attempts.keys())

    huge = "x" * 200_000
    r = await client.post("/api/cli/auth/poll", json={"device_code": huge})

    # Pydantic constraint violation surfaces as 422.
    assert r.status_code == 422, r.text

    with _device_rate_lock:
        # The huge code must NEVER have entered the limiter dict.
        after_keys = set(_device_per_ip_attempts.keys())
        # Allow the IP-only key the limiter populates lazily
        # for any caller (it stays bounded), but no per-code
        # entry derived from the rejected payload.
        for k in after_keys - before_keys:
            assert "x" * 100 not in k, f"oversize code leaked into limiter: {k[:80]}..."


@pytest.mark.asyncio
async def test_poll_rate_limit_hard_cap_429s_when_buckets_full_in_window(
    client: httpx.AsyncClient,
):
    """Round-r5 P1: the hard `_DEVICE_RATE_MAX_BUCKETS` cap MUST
    refuse a new bucket allocation when the dict is full of
    in-window timestamps that the scrub pass can't free. Pre-fix
    a regression that drops the second `len(...) >=
    MAX` re-check after `_scrub_empty_buckets` would let
    allocation proceed past the cap and OOM under flood;
    symmetric, a regression that flips the cutoff sign would
    refuse legitimate flows after the dict aged into the in-
    window range.

    Pinned by:
      1. fill `_device_per_ip_attempts` to MAX with deques
         carrying fresh (in-window) timestamps;
      2. assert the next /poll returns 429 with Retry-After;
      3. expire all timestamps (advance the in-process
         monotonic-clock proxy by re-stamping cutoff), assert a
         fresh /poll succeeds.
    """
    import time as _time
    from collections import deque as _deque

    from app.routes.cli_auth import (
        _DEVICE_RATE_MAX_BUCKETS,
        _device_per_ip_attempts,
        _device_rate_lock,
    )

    now = _time.monotonic()

    with _device_rate_lock:
        _device_per_ip_attempts.clear()
        # Fill to the cap with deques each holding an in-window
        # timestamp so scrub can't free them.
        for i in range(_DEVICE_RATE_MAX_BUCKETS):
            dq: _deque = _deque()
            dq.append(now)
            _device_per_ip_attempts[f"forged-bucket-{i}"] = dq

    # 1) full + in-window → next /poll must 429.
    r = await client.post(
        "/api/cli/auth/poll",
        json={"device_code": "fresh-attacker-code"},
    )
    assert r.status_code == 429, r.text
    assert "Retry-After" in r.headers
    assert int(r.headers["Retry-After"]) > 0

    # 2) age every bucket past the rolling window (replace each
    # timestamp with one well outside the cutoff). Now the
    # scrub pass can free them and a legitimate flow must
    # succeed.
    with _device_rate_lock:
        old = now - 9999.0
        for k, dq in _device_per_ip_attempts.items():
            dq.clear()
            dq.append(old)

    # /poll for an unknown device_code returns 200 with status
    # "expired" by design (don't leak existence); the relevant
    # assertion is "no longer 429".
    r2 = await client.post(
        "/api/cli/auth/poll",
        json={"device_code": "post-aged-flow"},
    )
    assert r2.status_code != 429, (r2.status_code, r2.text)

    with _device_rate_lock:
        _device_per_ip_attempts.clear()
