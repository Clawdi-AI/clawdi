"""Memory provider fallback tests.

After PR #66 deployed to a venv without `mem0ai`, every
`GET /api/memories` for a user whose `user_settings.settings`
carries `memory_provider == "mem0"` 500'd with
`ModuleNotFoundError: 'mem0'`. The provider factory now catches
the ImportError and falls back to BuiltinProvider so a stale
setting (or an opt-in optional dep that wasn't installed in this
deployment) doesn't 500 every memory request.

This file pins the fallback behavior. Two cases:
  1. `memory_provider=mem0` set + decryptable api_key + mem0ai
     installed → returns Mem0Provider (happy path).
  2. `memory_provider=mem0` set + decryptable api_key + mem0ai
     NOT installed → returns BuiltinProvider, logs a warning.
"""

from __future__ import annotations

import builtins
import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User, UserSetting
from app.services.memory_provider import (
    BuiltinProvider,
    Mem0Provider,
    get_memory_provider,
)
from app.services.vault_crypto import encrypt_field


@pytest.mark.asyncio
async def test_get_memory_provider_falls_back_to_builtin_when_mem0ai_missing(
    db_session: AsyncSession, seed_user: User, monkeypatch
):
    """Round-r66-postship P1: prod observed
    `ModuleNotFoundError: 'mem0'` 500-ing every /api/memories
    request for users with stale `memory_provider=mem0` in
    user_settings. Falls back to builtin on ImportError instead
    of crashing the request.
    """
    setting = UserSetting(
        user_id=seed_user.id,
        settings={
            "memory_provider": "mem0",
            "mem0_api_key": encrypt_field("mock-api-key"),
        },
    )
    db_session.add(setting)
    await db_session.commit()

    # Simulate `mem0ai` not installed: monkeypatch __import__ to
    # raise ImportError on `from mem0 import MemoryClient`. This
    # is what Mem0Provider.__init__ does internally; the factory
    # must catch it.
    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "mem0":
            raise ImportError("No module named 'mem0'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)

    provider = await get_memory_provider(str(seed_user.id), db_session)

    assert isinstance(provider, BuiltinProvider), (
        f"expected BuiltinProvider fallback when mem0 missing, got {type(provider).__name__}"
    )


@pytest.mark.asyncio
async def test_get_memory_provider_uses_mem0_when_installed_and_configured(
    db_session: AsyncSession, seed_user: User, monkeypatch
):
    """Happy path: settings request mem0, mem0 imports cleanly,
    factory returns Mem0Provider. Locks the contract that the
    fallback ONLY fires on ImportError (not silently overriding
    a working mem0 setup)."""
    setting = UserSetting(
        user_id=seed_user.id,
        settings={
            "memory_provider": "mem0",
            "mem0_api_key": encrypt_field("mock-api-key"),
        },
    )
    db_session.add(setting)
    await db_session.commit()

    # Stub `Mem0Provider.__init__` so the test doesn't actually
    # need mem0ai installed at test time. The factory's fallback
    # logic is gated on ImportError, not on mem0ai being present
    # in CI's venv — letting Mem0Provider be constructable
    # exercises the success path.
    constructed: list = []

    def fake_init(self, api_key):
        constructed.append(api_key)

    monkeypatch.setattr(Mem0Provider, "__init__", fake_init)

    provider = await get_memory_provider(str(seed_user.id), db_session)

    assert isinstance(provider, Mem0Provider)
    assert constructed == ["mock-api-key"]


@pytest.mark.asyncio
async def test_get_memory_provider_uses_builtin_when_no_setting(
    db_session: AsyncSession, seed_user: User
):
    """No setting row, no mem0 preference → builtin, no
    fallback path involved. Sanity check the default."""
    # Note: don't insert any UserSetting row — the lookup hits
    # the empty path.
    provider = await get_memory_provider(str(seed_user.id), db_session)
    assert isinstance(provider, BuiltinProvider)


@pytest.mark.asyncio
async def test_get_memory_provider_handles_unknown_user_id(db_session: AsyncSession):
    """A user_id with no row in either users or user_settings
    should not crash — the factory just looks up settings.
    Returns builtin (no setting → default path)."""
    fake_id = str(uuid.uuid4())
    provider = await get_memory_provider(fake_id, db_session)
    assert isinstance(provider, BuiltinProvider)
