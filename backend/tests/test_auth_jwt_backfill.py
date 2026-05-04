"""JWT-path email/name backfill on lazy-created users.

When the SaaS-side flow lazy-creates a user via the admin endpoint
(`_resolve_or_create_user`), email and name are unknown — admin
calls don't carry a Clerk JWT. The first time the user signs into
cloud.clawdi.ai directly, `_auth_via_clerk_jwt` should fill in the
missing identity fields from the JWT payload.

These tests pin that contract:
- email=None + JWT email → backfilled
- name=None + JWT name → backfilled
- email already set → NOT overwritten (Clerk display-name changes
  must not silently rewrite our row)
- both already set → no commit churn
"""

from __future__ import annotations

import uuid

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy import select

from app.core.auth import _auth_via_clerk_jwt
from app.core.config import settings
from app.models.user import User


def _rsa_keypair() -> tuple[str, str]:
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
    private_pem, public_pem = _rsa_keypair()
    monkeypatch.setattr(settings, "clerk_pem_public_key", public_pem)
    yield private_pem


def _sign(private_pem: str, sub: str, *, email: str | None = None, name: str | None = None) -> str:
    payload: dict = {"sub": sub}
    if email is not None:
        payload["email"] = email
    if name is not None:
        payload["name"] = name
    return jwt.encode(payload, private_pem, algorithm="RS256")


@pytest.mark.asyncio
async def test_backfill_email_on_admin_lazy_created_user(db_session, signing_key):
    """User row was lazy-created via admin path (email=None). User
    later signs into cloud.clawdi.ai with a Clerk JWT carrying email
    — backfill should fill it."""
    clerk_id = f"clerk_admin_lazy_{uuid.uuid4().hex[:12]}"

    # Pretend admin path created this — email=None.
    user = User(clerk_id=clerk_id, email=None, name=None)
    db_session.add(user)
    await db_session.commit()

    token = _sign(signing_key, clerk_id, email="real@example.com", name="Real Name")
    ctx = await _auth_via_clerk_jwt(token, db_session)

    assert ctx is not None
    assert ctx.user.email == "real@example.com"
    assert ctx.user.name == "Real Name"

    # Re-read from DB to confirm persistence (not just in-memory).
    persisted = (
        await db_session.execute(select(User).where(User.clerk_id == clerk_id))
    ).scalar_one()
    assert persisted.email == "real@example.com"
    assert persisted.name == "Real Name"


@pytest.mark.asyncio
async def test_backfill_does_not_overwrite_existing_email(db_session, signing_key):
    """User row already has email (set by previous JWT login). New
    JWT carries a DIFFERENT email — Clerk lets users rotate primary
    email. We deliberately do NOT overwrite: row email represents
    the identity we first verified, and a Clerk-side display-name
    or primary-email change shouldn't rewrite it silently. Identity
    rebind is a separate, opt-in path."""
    clerk_id = f"clerk_existing_email_{uuid.uuid4().hex[:12]}"

    user = User(clerk_id=clerk_id, email="original@example.com", name="Original")
    db_session.add(user)
    await db_session.commit()

    token = _sign(signing_key, clerk_id, email="rotated@example.com", name="New Name")
    ctx = await _auth_via_clerk_jwt(token, db_session)

    assert ctx is not None
    # Stayed at the original — backfill is one-way.
    assert ctx.user.email == "original@example.com"
    assert ctx.user.name == "Original"


@pytest.mark.asyncio
async def test_backfill_only_email_when_name_unknown(db_session, signing_key):
    """JWT carries email but no name → fill email, leave name=None."""
    clerk_id = f"clerk_email_only_{uuid.uuid4().hex[:12]}"

    user = User(clerk_id=clerk_id, email=None, name=None)
    db_session.add(user)
    await db_session.commit()

    token = _sign(signing_key, clerk_id, email="just-email@example.com")
    ctx = await _auth_via_clerk_jwt(token, db_session)

    assert ctx is not None
    assert ctx.user.email == "just-email@example.com"
    assert ctx.user.name is None  # JWT didn't carry one


@pytest.mark.asyncio
async def test_backfill_no_op_when_all_fields_set(db_session, signing_key):
    """Both email and name already populated → no commit, no churn.
    This is the 99% steady-state path."""
    clerk_id = f"clerk_steady_state_{uuid.uuid4().hex[:12]}"

    user = User(clerk_id=clerk_id, email="set@example.com", name="Set")
    db_session.add(user)
    await db_session.commit()

    token = _sign(signing_key, clerk_id, email="ignored@example.com", name="Ignored")
    ctx = await _auth_via_clerk_jwt(token, db_session)

    assert ctx is not None
    assert ctx.user.email == "set@example.com"
    assert ctx.user.name == "Set"
