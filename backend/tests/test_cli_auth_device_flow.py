"""Retired legacy key issuance and remaining device authorization operations."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.api_key import ApiKey
from app.models.device_authorization import DeviceAuthorization


async def _seed_legacy_device(
    db: AsyncSession, label: str = "test cli", *, approved: bool = False
) -> dict:
    tag = uuid.uuid4().hex
    da = DeviceAuthorization(
        device_code=f"legacy-{tag}",
        user_code=tag[:8].upper(),
        client_label=label,
        expires_at=datetime.now(UTC) + timedelta(minutes=10),
        status="approved" if approved else "pending",
        api_key_raw="clawdi_legacy_delivery" if approved else None,
    )
    db.add(da)
    await db.commit()
    return {"device_code": da.device_code, "user_code": da.user_code}


@pytest.mark.parametrize("prefix", ["/v1", "/api"])
async def test_retired_device_and_approve_issue_no_keys(client, db_session, prefix):
    started = await _seed_legacy_device(db_session)
    before_keys = await db_session.scalar(select(func.count()).select_from(ApiKey))
    before_devices = await db_session.scalar(select(func.count()).select_from(DeviceAuthorization))
    for endpoint, body in (
        ("device", {"client_label": "old cli"}),
        ("approve", {"user_code": started["user_code"]}),
    ):
        response = await client.post(f"{prefix}/cli/auth/{endpoint}", json=body)
        assert response.status_code == 410, response.text
        assert response.json() == {
            "detail": "This sign-in method is no longer supported. Update the Clawdi CLI "
            "and run `clawdi auth login`."
        }
    assert await db_session.scalar(select(func.count()).select_from(ApiKey)) == before_keys
    assert (
        await db_session.scalar(select(func.count()).select_from(DeviceAuthorization))
        == before_devices
    )
    da = await db_session.scalar(
        select(DeviceAuthorization).where(DeviceAuthorization.device_code == started["device_code"])
    )
    assert da.status == "pending"
    assert da.api_key_raw is None


async def test_existing_approved_authorization_still_delivers_once(client, db_session):
    started = await _seed_legacy_device(db_session, approved=True)
    first = await client.post("/v1/cli/auth/poll", json={"device_code": started["device_code"]})
    assert first.status_code == 200, first.text
    assert first.json() == {"status": "approved", "api_key": "clawdi_legacy_delivery"}
    second = await client.post("/v1/cli/auth/poll", json={"device_code": started["device_code"]})
    assert second.status_code == 200, second.text
    assert second.json() == {"status": "expired", "api_key": None}
    da = await db_session.scalar(
        select(DeviceAuthorization).where(DeviceAuthorization.device_code == started["device_code"])
    )
    assert da.api_key_raw is None


@pytest.mark.asyncio
async def test_deny_short_circuits_poll(client: httpx.AsyncClient, db_session):
    started = await _seed_legacy_device(db_session)
    r = await client.post("/v1/cli/auth/deny", json={"user_code": started["user_code"]})
    assert r.status_code == 200
    r = await client.post("/v1/cli/auth/poll", json={"device_code": started["device_code"]})
    assert r.json()["status"] == "denied"


@pytest.mark.asyncio
async def test_unknown_device_code_looks_like_expired(client: httpx.AsyncClient):
    """A poller without a valid code shouldn't be able to enumerate codes;
    fold "not found" into the same response shape as "expired"."""
    r = await client.post("/v1/cli/auth/poll", json={"device_code": "not-a-real-code"})
    assert r.status_code == 200
    assert r.json()["status"] == "expired"


@pytest.mark.asyncio
async def test_approve_after_expiry_returns_410(
    client: httpx.AsyncClient, db_session: AsyncSession
):
    started = await _seed_legacy_device(db_session)
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

    r = await client.post("/v1/cli/auth/approve", json={"user_code": started["user_code"]})
    assert r.status_code == 410


@pytest.mark.asyncio
async def test_lookup_returns_status_and_label(client: httpx.AsyncClient, db_session):
    started = await _seed_legacy_device(db_session, label="Claude Code · ci-runner")
    r = await client.get("/v1/cli/auth/lookup", params={"code": started["user_code"]})
    assert r.status_code == 200
    body = r.json()
    assert body["user_code"] == started["user_code"]
    assert body["client_label"] == "Claude Code · ci-runner"
    assert body["status"] == "pending"


@pytest.mark.asyncio
async def test_real_client_ip_reads_x_forwarded_for_when_trusted(monkeypatch):
    """Round-51 P1 regression: behind a reverse proxy,
    `request.client.host` is the proxy's IP. Without forwarded-header
    support every CLI login shares one bucket and the third concurrent
    login 429s. With `trust_forwarded_for=True` we read `X-Forwarded-For`
    (first hop = real client) and `CF-Connecting-IP`.

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
async def test_poll_rate_limit_keyed_per_device_code(
    client: httpx.AsyncClient, db_session, monkeypatch
):
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
    from app.routes import cli_auth

    monkeypatch.setattr(settings, "trust_forwarded_for", True)

    flow_a = await _seed_legacy_device(db_session, label="cli a")
    flow_b = await _seed_legacy_device(db_session, label="cli b")
    monkeypatch.setattr(cli_auth, "_DEVICE_PER_IP_MAX", 3)

    # Hammer flow A's poll buckets (IP + device_code) up to
    # the cap. The post needs an XFF header so the real-IP
    # bucket keys on `1.1.1.1` not the test client's
    # connection host.
    for _ in range(3):
        r = await client.post(
            "/v1/cli/auth/poll",
            json={"device_code": flow_a["device_code"]},
            headers={"X-Forwarded-For": "1.1.1.1"},
        )
        assert r.status_code == 200, r.text

    # One more poll from ipA → 429 (its IP bucket is full).
    r_a = await client.post(
        "/v1/cli/auth/poll",
        json={"device_code": flow_a["device_code"]},
        headers={"X-Forwarded-For": "1.1.1.1"},
    )
    assert r_a.status_code == 429, r_a.text

    # B's first poll from a DIFFERENT real IP — fresh IP +
    # fresh device_code buckets. Must NOT 429. Pre-round-51
    # it would have shared A's bucket via the connection-level
    # client IP and 429'd immediately.
    r_b = await client.post(
        "/v1/cli/auth/poll",
        json={"device_code": flow_b["device_code"]},
        headers={"X-Forwarded-For": "2.2.2.2"},
    )
    assert r_b.status_code == 200, r_b.text
    assert r_b.json()["status"] == "pending"


@pytest.mark.asyncio
async def test_poll_rate_limiter_bounds_random_device_codes_by_ip(
    client: httpx.AsyncClient,
    monkeypatch,
):
    """Round-53 P1: /poll buckets on the unvalidated body
    `device_code`. The IP-keyed bucket must cap a stream of unique codes before
    per-code buckets can grow without bound.

    Pinned by sending many unique random device_codes; the
    real-IP bucket exhausts after 90, subsequent polls 429."""
    import secrets as _secrets

    from app.routes import cli_auth

    monkeypatch.setattr(settings, "trust_forwarded_for", True)
    monkeypatch.setattr(cli_auth, "_DEVICE_PER_IP_MAX", 3)

    successes = 0
    saw_429 = False
    for i in range(5):
        r = await client.post(
            "/v1/cli/auth/poll",
            json={"device_code": f"forged-{i}-{_secrets.token_urlsafe(8)}"},
            headers={"X-Forwarded-For": "192.0.2.92"},
        )
        if r.status_code == 200:
            successes += 1
        elif r.status_code == 429:
            saw_429 = True
            break

    assert successes == 3
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

    Pinned by sending a 200KB device_code: request validation must reject it
    before the route or shared limiter runs."""

    huge = "x" * 200_000
    r = await client.post("/v1/cli/auth/poll", json={"device_code": huge})

    assert r.status_code == 422, r.text
