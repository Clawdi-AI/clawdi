"""Snapshot-email-rebind path of ``_auth_via_clerk_jwt``.

When a preview environment is fronted by a Clerk instance that's distinct
from production's (e.g. a snapshot of a prod app loaded into a separate
preview deployment that uses its own Clerk app), the JWTs from that
instance carry a `sub` (clerk_id) that doesn't exist in the snapshot's
`users` table. Without this path, sign-in auto-creates a fresh empty
row and the operator sees an empty dashboard.

The rebind is gated by ``settings.enable_snapshot_email_rebind`` — an
explicit opt-in, NOT a function of `environment`. When enabled, the
auth path:
1. Tries the JWT's `email` claim. If absent and `clerk_secret_key` is
   set, calls Clerk's Backend API to fetch the verified primary email.
2. Refuses sign-in (401) if no verified email is available — fail
   closed, because creating an empty row would permanently shadow the
   real snapshot row on every future login (sub-match wins first).
3. Looks up by email. If exactly one user matches, swaps its
   `clerk_id` to the JWT's sub. If >1 match, refuses (401) — `users.email`
   is not unique and we won't gamble on which row to take over.
4. Otherwise (no match), creates a fresh row bound to the verified email.

When the flag is off, behavior is identical to the legacy path: sub
miss → fresh user, no Clerk-API call, no email matching.
"""

from __future__ import annotations

import uuid

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from sqlalchemy import select

from app.core import auth as auth_module
from app.core.auth import _auth_via_clerk_jwt
from app.core.config import settings
from app.models.user import User


def _rsa_keypair() -> tuple[str, str]:
    """Throwaway RS256 keypair for signing test JWTs."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    ).decode()
    public_pem = (
        key.public_key()
        .public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode()
    )
    return private_pem, public_pem


@pytest.fixture
def signing_key(monkeypatch):
    """Install a test RS256 key into settings.clerk_pem_public_key.

    Yields the private PEM so tests can sign JWTs that the auth path will
    accept as valid.
    """
    private_pem, public_pem = _rsa_keypair()
    monkeypatch.setattr(settings, "clerk_pem_public_key", public_pem)
    yield private_pem


def _sign(private_pem: str, sub: str, email: str | None) -> str:
    return jwt.encode(
        {"sub": sub, **({"email": email} if email else {})},
        private_pem,
        algorithm="RS256",
    )


# ---------------------------------------------------------------------------
# Rebind enabled
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_rebind_swaps_clerk_id_when_jwt_email_matches(db_session, signing_key, monkeypatch):
    monkeypatch.setattr(settings, "enable_snapshot_email_rebind", True)
    email = f"rebind_{uuid.uuid4().hex[:8]}@example.test"
    original = User(clerk_id=f"orig_{uuid.uuid4().hex[:8]}", email=email, name="Rebind")
    db_session.add(original)
    await db_session.commit()
    await db_session.refresh(original)
    original_id = original.id

    new_sub = f"new_{uuid.uuid4().hex[:8]}"
    token = _sign(signing_key, sub=new_sub, email=email)
    ctx = await _auth_via_clerk_jwt(token, db_session)

    assert ctx is not None
    assert ctx.user.id == original_id  # same row, snapshot data still attached
    assert ctx.user.clerk_id == new_sub  # rebound to new Clerk's sub

    await db_session.delete(ctx.user)
    await db_session.commit()


@pytest.mark.asyncio
async def test_rebind_falls_back_to_clerk_api_when_jwt_lacks_email(
    db_session, signing_key, monkeypatch
):
    """When the JWT carries no `email` claim, the rebind path consults the
    Clerk Backend API for the verified primary email, then runs the normal
    email-match rebind.
    """
    monkeypatch.setattr(settings, "enable_snapshot_email_rebind", True)
    monkeypatch.setattr(settings, "clerk_secret_key", "sk_test_dummy")

    email = f"clerkapi_{uuid.uuid4().hex[:8]}@example.test"
    original = User(clerk_id=f"orig_{uuid.uuid4().hex[:8]}", email=email, name="ClerkAPI")
    db_session.add(original)
    await db_session.commit()
    await db_session.refresh(original)
    original_id = original.id

    new_sub = f"new_{uuid.uuid4().hex[:8]}"
    fetched: list[str] = []

    async def fake_fetch(clerk_user_id: str):
        fetched.append(clerk_user_id)
        return email

    monkeypatch.setattr(auth_module, "_fetch_clerk_primary_email", fake_fetch)

    token = _sign(signing_key, sub=new_sub, email=None)
    ctx = await _auth_via_clerk_jwt(token, db_session)

    assert fetched == [new_sub]
    assert ctx is not None
    assert ctx.user.id == original_id
    assert ctx.user.clerk_id == new_sub

    await db_session.delete(ctx.user)
    await db_session.commit()


@pytest.mark.asyncio
async def test_rebind_with_no_email_match_creates_fresh_user(db_session, signing_key, monkeypatch):
    """Rebind enabled, JWT carries an email, but no existing row matches —
    a fresh user is created bound to that email. New sign-ups in a preview
    environment are still allowed; rebind is best-effort, not exclusive.
    """
    monkeypatch.setattr(settings, "enable_snapshot_email_rebind", True)
    new_sub = f"new_{uuid.uuid4().hex[:8]}"
    new_email = f"newuser_{uuid.uuid4().hex[:8]}@example.test"
    token = _sign(signing_key, sub=new_sub, email=new_email)
    ctx = await _auth_via_clerk_jwt(token, db_session)

    assert ctx is not None
    assert ctx.user.clerk_id == new_sub
    assert ctx.user.email == new_email

    await db_session.delete(ctx.user)
    await db_session.commit()


# ---------------------------------------------------------------------------
# Rebind enabled — fail-closed paths
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_rebind_refuses_when_no_email_anywhere(db_session, signing_key, monkeypatch):
    """If the JWT has no email AND no Clerk secret is set (or the API call
    returns nothing), the rebind path raises 401 instead of auto-creating an
    unbound empty row. That row would otherwise become a permanent identity
    squatter — every subsequent login matches it on clerk_id and the real
    snapshot row never gets considered again.
    """
    monkeypatch.setattr(settings, "enable_snapshot_email_rebind", True)
    monkeypatch.setattr(settings, "clerk_secret_key", "")  # no API fallback

    new_sub = f"new_{uuid.uuid4().hex[:8]}"
    token = _sign(signing_key, sub=new_sub, email=None)

    with pytest.raises(HTTPException) as exc:
        await _auth_via_clerk_jwt(token, db_session)
    assert exc.value.status_code == 401

    # No user row was persisted for this sub.
    leaked = (
        await db_session.execute(select(User).where(User.clerk_id == new_sub))
    ).scalar_one_or_none()
    assert leaked is None


@pytest.mark.asyncio
async def test_rebind_refuses_when_clerk_api_returns_none(db_session, signing_key, monkeypatch):
    """A transient Clerk API failure (timeout, 5xx, unverified primary) makes
    the helper return None. The rebind path must refuse — see the
    no-email-anywhere test for why.
    """
    monkeypatch.setattr(settings, "enable_snapshot_email_rebind", True)
    monkeypatch.setattr(settings, "clerk_secret_key", "sk_test_dummy")

    async def fake_fetch(clerk_user_id: str):
        return None  # simulate any failure mode

    monkeypatch.setattr(auth_module, "_fetch_clerk_primary_email", fake_fetch)

    new_sub = f"new_{uuid.uuid4().hex[:8]}"
    token = _sign(signing_key, sub=new_sub, email=None)

    with pytest.raises(HTTPException) as exc:
        await _auth_via_clerk_jwt(token, db_session)
    assert exc.value.status_code == 401

    leaked = (
        await db_session.execute(select(User).where(User.clerk_id == new_sub))
    ).scalar_one_or_none()
    assert leaked is None


@pytest.mark.asyncio
async def test_rebind_refuses_ambiguous_email_match(db_session, signing_key, monkeypatch):
    """`users.email` is not unique in the schema — production allows multiple
    rows with the same email under different clerk_ids. If a sub-miss rebind
    finds more than one candidate, refuse rather than silently picking one
    (whoever signs in first would otherwise pre-empt the other rows).
    """
    monkeypatch.setattr(settings, "enable_snapshot_email_rebind", True)
    email = f"dup_{uuid.uuid4().hex[:8]}@example.test"
    a = User(clerk_id=f"a_{uuid.uuid4().hex[:8]}", email=email, name="A")
    b = User(clerk_id=f"b_{uuid.uuid4().hex[:8]}", email=email, name="B")
    db_session.add(a)
    db_session.add(b)
    await db_session.commit()

    new_sub = f"new_{uuid.uuid4().hex[:8]}"
    token = _sign(signing_key, sub=new_sub, email=email)

    with pytest.raises(HTTPException) as exc:
        await _auth_via_clerk_jwt(token, db_session)
    assert exc.value.status_code == 401

    # Neither candidate was rebound; no new row was created.
    rows = (await db_session.execute(select(User).where(User.email == email))).scalars().all()
    assert {u.clerk_id for u in rows} == {a.clerk_id, b.clerk_id}

    await db_session.delete(a)
    await db_session.delete(b)
    await db_session.commit()


# ---------------------------------------------------------------------------
# Rebind disabled (default / production)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_rebind_disabled_creates_fresh_user_on_sub_miss(db_session, signing_key, monkeypatch):
    """Default behavior — no rebind, no email matching, no Clerk-API call.
    A sub miss creates a fresh user row, even if an existing row shares
    the email. The original row's clerk_id stays untouched.
    """
    monkeypatch.setattr(settings, "enable_snapshot_email_rebind", False)
    email = f"nopreview_{uuid.uuid4().hex[:8]}@example.test"
    existing = User(clerk_id=f"orig_{uuid.uuid4().hex[:8]}", email=email, name="Existing")
    db_session.add(existing)
    await db_session.commit()
    await db_session.refresh(existing)
    existing_id = existing.id
    existing_clerk_id = existing.clerk_id

    different_sub = f"different_{uuid.uuid4().hex[:8]}"
    token = _sign(signing_key, sub=different_sub, email=email)
    ctx = await _auth_via_clerk_jwt(token, db_session)

    assert ctx is not None
    assert ctx.user.id != existing_id  # fresh row
    assert ctx.user.clerk_id == different_sub

    refreshed = (await db_session.execute(select(User).where(User.id == existing_id))).scalar_one()
    assert refreshed.clerk_id == existing_clerk_id

    await db_session.delete(ctx.user)
    await db_session.delete(refreshed)
    await db_session.commit()


@pytest.mark.asyncio
async def test_rebind_disabled_does_not_call_clerk_api(db_session, signing_key, monkeypatch):
    """The Clerk Backend API lookup is gated on the rebind flag — even if
    `clerk_secret_key` is configured (e.g. left over from a misconfigured
    prod env), it must not fire when the flag is off.
    """
    monkeypatch.setattr(settings, "enable_snapshot_email_rebind", False)
    monkeypatch.setattr(settings, "clerk_secret_key", "sk_test_dummy")

    called = False

    async def fake_fetch(clerk_user_id: str):
        nonlocal called
        called = True
        return "should-not-be-used@example.test"

    monkeypatch.setattr(auth_module, "_fetch_clerk_primary_email", fake_fetch)

    new_sub = f"new_{uuid.uuid4().hex[:8]}"
    token = _sign(signing_key, sub=new_sub, email=None)
    ctx = await _auth_via_clerk_jwt(token, db_session)

    assert called is False
    assert ctx is not None
    assert ctx.user.clerk_id == new_sub
    assert ctx.user.email is None

    await db_session.delete(ctx.user)
    await db_session.commit()


# ---------------------------------------------------------------------------
# Helper: _fetch_clerk_primary_email
# ---------------------------------------------------------------------------


def _clerk_user_response(*, primary_id: str | None, addresses: list[dict]) -> dict:
    return {"primary_email_address_id": primary_id, "email_addresses": addresses}


@pytest.mark.asyncio
async def test_clerk_helper_returns_verified_primary(monkeypatch):
    monkeypatch.setattr(settings, "clerk_secret_key", "sk_test_dummy")

    payload = _clerk_user_response(
        primary_id="idn_1",
        addresses=[
            {
                "id": "idn_1",
                "email_address": "alice@example.test",
                "verification": {"status": "verified"},
            },
            {
                "id": "idn_2",
                "email_address": "alice+alt@example.test",
                "verification": {"status": "verified"},
            },
        ],
    )

    class FakeResp:
        status_code = 200

        def json(self):
            return payload

    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def get(self, *a, **kw):
            return FakeResp()

    monkeypatch.setattr(auth_module.httpx, "AsyncClient", FakeClient)

    got = await auth_module._fetch_clerk_primary_email("user_x")
    assert got == "alice@example.test"


@pytest.mark.asyncio
async def test_clerk_helper_refuses_unverified_primary(monkeypatch):
    monkeypatch.setattr(settings, "clerk_secret_key", "sk_test_dummy")

    payload = _clerk_user_response(
        primary_id="idn_1",
        addresses=[
            {
                "id": "idn_1",
                "email_address": "alice@example.test",
                "verification": {"status": "unverified"},
            },
        ],
    )

    class FakeResp:
        status_code = 200

        def json(self):
            return payload

    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def get(self, *a, **kw):
            return FakeResp()

    monkeypatch.setattr(auth_module.httpx, "AsyncClient", FakeClient)

    got = await auth_module._fetch_clerk_primary_email("user_x")
    assert got is None


@pytest.mark.asyncio
async def test_clerk_helper_returns_none_when_no_primary_marked(monkeypatch):
    """No primary_email_address_id — refuse to guess. Identity binding must
    not silently pick the first address.
    """
    monkeypatch.setattr(settings, "clerk_secret_key", "sk_test_dummy")

    payload = _clerk_user_response(
        primary_id=None,
        addresses=[
            {
                "id": "idn_1",
                "email_address": "alice@example.test",
                "verification": {"status": "verified"},
            },
        ],
    )

    class FakeResp:
        status_code = 200

        def json(self):
            return payload

    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def get(self, *a, **kw):
            return FakeResp()

    monkeypatch.setattr(auth_module.httpx, "AsyncClient", FakeClient)

    got = await auth_module._fetch_clerk_primary_email("user_x")
    assert got is None


@pytest.mark.asyncio
async def test_clerk_helper_returns_none_on_non_200(monkeypatch):
    monkeypatch.setattr(settings, "clerk_secret_key", "sk_test_dummy")

    class FakeResp:
        status_code = 503

        def json(self):
            return {}

    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def get(self, *a, **kw):
            return FakeResp()

    monkeypatch.setattr(auth_module.httpx, "AsyncClient", FakeClient)

    got = await auth_module._fetch_clerk_primary_email("user_x")
    assert got is None
