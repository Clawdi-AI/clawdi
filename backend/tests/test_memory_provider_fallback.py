"""Memory provider fallback tests.

Prod observed `GET /api/memories` 500-ing with
`ModuleNotFoundError: 'mem0'` for users whose `user_settings`
carries `memory_provider == "mem0"`. The Mem0Provider class
lazy-imports `mem0` and `mem0ai` was never declared in
`pyproject.toml`, so the path was dead-on-arrival from the day
it shipped. This file pins the post-fix contract:

  - `mem0_available()` returns True iff `mem0` imports cleanly
    (drives capability flag + settings save validation).
  - `get_memory_provider` falls back to BuiltinProvider on
    ImportError instead of bubbling 500.
  - Existing user settings of `memory_provider=mem0` keep
    working post-deploy (silently degraded to builtin).
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
async def test_get_memory_provider_falls_back_to_builtin_when_mem0_missing(
    db_session: AsyncSession, seed_user: User, monkeypatch
):
    """Defense-in-depth: even if settings save validation lets a
    mem0 setting through (e.g. operator uninstalled mem0ai
    after a user already saved their preference), `/api/memories`
    must NOT 500. Falls back to builtin with a warning."""
    setting = UserSetting(
        user_id=seed_user.id,
        settings={
            "memory_provider": "mem0",
            "mem0_api_key": encrypt_field("mock-api-key"),
        },
    )
    db_session.add(setting)
    await db_session.commit()

    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "mem0":
            raise ImportError("No module named 'mem0'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    # Bust the find_spec cache for this test — `mem0_available`
    # caches the first answer, but we want fresh probing here.
    import app.services.memory_provider as mp

    monkeypatch.setattr(mp, "_mem0_available_cached", None)

    provider = await get_memory_provider(str(seed_user.id), db_session)
    assert isinstance(provider, BuiltinProvider), (
        f"expected BuiltinProvider fallback when mem0 missing, got {type(provider).__name__}"
    )


@pytest.mark.asyncio
async def test_get_memory_provider_uses_mem0_when_installed_and_configured(
    db_session: AsyncSession, seed_user: User, monkeypatch
):
    """Happy path: Mem0Provider constructable → factory returns
    it. Stub `__init__` so the test doesn't need mem0ai actually
    installed."""
    setting = UserSetting(
        user_id=seed_user.id,
        settings={
            "memory_provider": "mem0",
            "mem0_api_key": encrypt_field("mock-api-key"),
        },
    )
    db_session.add(setting)
    await db_session.commit()

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
    provider = await get_memory_provider(str(seed_user.id), db_session)
    assert isinstance(provider, BuiltinProvider)


@pytest.mark.asyncio
async def test_get_memory_provider_handles_unknown_user_id(db_session: AsyncSession):
    fake_id = str(uuid.uuid4())
    provider = await get_memory_provider(fake_id, db_session)
    assert isinstance(provider, BuiltinProvider)


@pytest.mark.asyncio
async def test_mem0_available_caches_first_probe(monkeypatch):
    """`mem0_available()` should cache its result — re-probing on
    every request unnecessarily thrashes the import system."""
    import importlib.util as _iu

    import app.services.memory_provider as mp

    # Clear cache to force fresh probe.
    monkeypatch.setattr(mp, "_mem0_available_cached", None)

    call_count = {"n": 0}
    real_find = _iu.find_spec

    def counting(name, *args, **kwargs):
        if name == "mem0":
            call_count["n"] += 1
        return real_find(name, *args, **kwargs)

    monkeypatch.setattr(_iu, "find_spec", counting)

    # First call probes; subsequent calls hit cache.
    a = mp.mem0_available()
    b = mp.mem0_available()
    c = mp.mem0_available()

    assert a == b == c
    assert call_count["n"] == 1, "mem0_available should probe once and cache"
