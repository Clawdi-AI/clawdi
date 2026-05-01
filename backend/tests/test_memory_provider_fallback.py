"""Tests for `get_memory_provider` ImportError fallback and `mem0_available` cache."""

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
    # Defense-in-depth: pre-existing `memory_provider=mem0` settings must
    # not 500 if `mem0` becomes unimportable (e.g. operator uninstalled
    # the extra after the user saved their preference).
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
    # Happy path: stub Mem0Provider.__init__ so we don't need mem0ai installed.
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
    import builtins

    import app.services.memory_provider as mp

    monkeypatch.setattr(mp, "_mem0_available_cached", None)

    call_count = {"n": 0}
    real_import = builtins.__import__

    def counting(name, *args, **kwargs):
        if name == "mem0":
            call_count["n"] += 1
            raise ImportError("simulated for test")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", counting)

    assert mp.mem0_available() is False
    assert mp.mem0_available() is False
    assert mp.mem0_available() is False
    assert call_count["n"] == 1, "mem0_available should probe once and cache"
