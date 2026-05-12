"""require_share_token validates an opaque token from the URL path
and returns the resolved scope_id + link_id. Used by the public
`/api/share/{token}/...` routes."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException

from app.core.auth import require_share_token
from app.models.scope_share_link import ScopeShareLink
from app.services.sharing import generate_share_token, hash_share_token


class _Result:
    def __init__(self, link):
        self._link = link

    def scalar_one_or_none(self):
        return self._link


class _FakeDb:
    def __init__(self, link=None):
        self.link = link

    async def execute(self, _statement):
        return _Result(self.link)


@pytest.mark.asyncio
async def test_require_share_token_returns_scope_for_valid_token():
    raw = generate_share_token()
    scope_id = uuid.uuid4()
    link_id = uuid.uuid4()
    link = ScopeShareLink(
        id=link_id,
        scope_id=scope_id,
        token_hash=hash_share_token(raw),
        token_prefix=raw[:8],
        created_by=uuid.uuid4(),
        resolved_owner_handle="test-user-abcd",
        created_at=datetime.now(UTC),
    )

    result = await require_share_token(token=raw, db=_FakeDb(link))
    assert result.scope_id == scope_id
    assert result.link_id == link_id


@pytest.mark.asyncio
async def test_require_share_token_rejects_unknown():
    with pytest.raises(HTTPException) as exc:
        await require_share_token(token="totally-bogus", db=_FakeDb())
    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_require_share_token_rejects_revoked():
    raw = generate_share_token()
    link = ScopeShareLink(
        id=uuid.uuid4(),
        scope_id=uuid.uuid4(),
        token_hash=hash_share_token(raw),
        token_prefix=raw[:8],
        created_by=uuid.uuid4(),
        resolved_owner_handle="test-user-abcd",
        created_at=datetime.now(UTC),
        revoked_at=datetime.now(UTC),
    )

    with pytest.raises(HTTPException) as exc:
        await require_share_token(token=raw, db=_FakeDb(link))
    assert exc.value.status_code == 410


@pytest.mark.asyncio
async def test_require_share_token_rejects_expired():
    raw = generate_share_token()
    link = ScopeShareLink(
        id=uuid.uuid4(),
        scope_id=uuid.uuid4(),
        token_hash=hash_share_token(raw),
        token_prefix=raw[:8],
        created_by=uuid.uuid4(),
        resolved_owner_handle="test-user-abcd",
        created_at=datetime.now(UTC) - timedelta(days=2),
        expires_at=datetime.now(UTC) - timedelta(days=1),
    )

    with pytest.raises(HTTPException) as exc:
        await require_share_token(token=raw, db=_FakeDb(link))
    assert exc.value.status_code == 410
