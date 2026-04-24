"""ApiKey lifecycle and authentication edge cases.

Covers the security-sensitive parts of ``app.core.auth`` that the smoke
tests don't exercise: the raw key is only returned on creation, the stored
hash is never round-trippable, a revoked key authenticates with 401, and
``/api/auth/me`` reflects the auth method used.
"""

from __future__ import annotations

import hashlib

import httpx
import pytest
from httpx import ASGITransport

from app.main import app


@pytest.mark.asyncio
async def test_api_key_create_returns_raw_once_and_stores_hash(
    client: httpx.AsyncClient, db_session
):
    r = await client.post("/api/auth/keys", json={"label": "laptop"})
    assert r.status_code == 200, r.text
    body = r.json()
    raw = body["raw_key"]
    assert raw.startswith("clawdi_")
    assert body["key_prefix"] == raw[:16]

    # The listing endpoint must NEVER return the raw secret (only prefix/label).
    listing = (await client.get("/api/auth/keys")).json()
    assert listing and all("raw_key" not in k for k in listing)

    # The on-disk representation is a sha256 hash, not the raw token.
    expected_hash = hashlib.sha256(raw.encode()).hexdigest()
    from sqlalchemy import select

    from app.models.api_key import ApiKey

    rows = (await db_session.execute(select(ApiKey))).scalars().all()
    assert any(k.key_hash == expected_hash for k in rows)
    assert all(k.key_hash != raw for k in rows)


@pytest.mark.asyncio
async def test_revoked_api_key_is_rejected(db_session, seed_user):
    """A revoked key hitting the real auth path returns 401, not the user.

    Uses the raw ASGI app (no ``client`` fixture) so the real ``get_auth``
    dependency runs — the fixture would override it and short-circuit this
    test.
    """
    import secrets as _secrets
    from datetime import UTC, datetime

    from app.core.database import get_session
    from app.models.api_key import ApiKey

    raw = "clawdi_" + _secrets.token_urlsafe(24)
    api_key = ApiKey(
        user_id=seed_user.id,
        key_hash=hashlib.sha256(raw.encode()).hexdigest(),
        key_prefix=raw[:16],
        label="revoked",
        revoked_at=datetime.now(UTC),
    )
    db_session.add(api_key)
    await db_session.commit()

    async def _override_get_session():
        yield db_session

    app.dependency_overrides[get_session] = _override_get_session
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            r = await ac.get("/api/memories", headers={"Authorization": f"Bearer {raw}"})
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 401, r.text
    assert "revoked" in r.text.lower()


@pytest.mark.asyncio
async def test_me_reflects_clerk_auth(client: httpx.AsyncClient):
    body = (await client.get("/api/auth/me")).json()
    assert body["auth_type"] == "clerk"


@pytest.mark.asyncio
async def test_me_reflects_cli_auth(cli_client: httpx.AsyncClient):
    body = (await cli_client.get("/api/auth/me")).json()
    assert body["auth_type"] == "api_key"


@pytest.mark.asyncio
async def test_revoke_api_key_marks_row(client: httpx.AsyncClient):
    created = (await client.post("/api/auth/keys", json={"label": "to-revoke"})).json()
    r = await client.delete(f"/api/auth/keys/{created['id']}")
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "revoked"}

    # After revoke, the key still shows in the list but with ``revoked_at`` set.
    listing = (await client.get("/api/auth/keys")).json()
    match = next(k for k in listing if k["id"] == created["id"])
    assert match["revoked_at"] is not None


@pytest.mark.asyncio
async def test_revoke_other_users_key_is_404(client: httpx.AsyncClient, db_session, seed_user):
    """Revoking someone else's key by ID leaks 404, not 200 — no cross-tenant writes."""
    import secrets as _secrets
    import uuid as _uuid

    from app.models.api_key import ApiKey
    from app.models.user import User

    victim = User(clerk_id=f"victim_{_uuid.uuid4().hex[:8]}", email="v@x.dev", name="V")
    db_session.add(victim)
    await db_session.commit()
    await db_session.refresh(victim)

    raw = "clawdi_" + _secrets.token_urlsafe(24)
    key = ApiKey(
        user_id=victim.id,
        key_hash=hashlib.sha256(raw.encode()).hexdigest(),
        key_prefix=raw[:16],
        label="victim",
    )
    db_session.add(key)
    await db_session.commit()
    await db_session.refresh(key)

    try:
        # ``client`` authenticates as seed_user (attacker); should not touch victim's key.
        r = await client.delete(f"/api/auth/keys/{key.id}")
        assert r.status_code == 404, r.text
    finally:
        await db_session.delete(key)
        await db_session.delete(victim)
        await db_session.commit()
