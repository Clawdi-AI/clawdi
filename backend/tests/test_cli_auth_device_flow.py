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
