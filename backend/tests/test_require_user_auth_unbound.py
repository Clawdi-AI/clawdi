"""require_user_auth_unbound rejects env-bound deploy keys while
accepting Clerk JWT and unbound CLI api_keys."""

import uuid

import pytest
from fastapi import HTTPException

from app.core.auth import AuthContext, require_user_auth_unbound
from app.models.api_key import ApiKey
from app.models.user import User


def _user() -> User:
    return User(
        id=uuid.uuid4(),
        clerk_id=f"clerk_{uuid.uuid4().hex[:8]}",
        email="test@example.com",
        name="Test User",
    )


@pytest.mark.asyncio
async def test_clerk_jwt_passes():
    # Clerk JWT path: AuthContext with api_key=None.
    seed_user = _user()
    auth = AuthContext(user=seed_user, api_key=None)
    out = await require_user_auth_unbound(auth=auth)
    assert out is auth


@pytest.mark.asyncio
async def test_unbound_api_key_passes():
    seed_user = _user()
    key = ApiKey(
        user_id=seed_user.id,
        key_hash="h" * 64,
        key_prefix="clawdi_a",
        label="unbound",
        environment_id=None,
        scopes=None,
    )
    auth = AuthContext(user=seed_user, api_key=key)
    out = await require_user_auth_unbound(auth=auth)
    assert out is auth


@pytest.mark.asyncio
async def test_env_bound_api_key_rejected():
    seed_user = _user()
    key = ApiKey(
        user_id=seed_user.id,
        key_hash="h" * 64,
        key_prefix="clawdi_e",
        label="env-bound",
        environment_id=uuid.uuid4(),
        scopes=None,
    )
    auth = AuthContext(user=seed_user, api_key=key)
    with pytest.raises(HTTPException) as exc:
        await require_user_auth_unbound(auth=auth)
    assert exc.value.status_code == 403
    assert "env-bound" in str(exc.value.detail)
