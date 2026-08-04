"""Tests for the shared Mem0 SDK availability and construction boundary."""

from __future__ import annotations

import sys
import uuid
from types import ModuleType

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User, UserSetting
from app.services.memory_provider import (
    BuiltinProvider,
    Mem0Provider,
    get_memory_provider,
)
from app.services.memory_provider_mem0 import mem0_available
from app.services.vault_crypto import encrypt_field


class _FakeMem0Error(Exception):
    pass


class _FakeMem0NetworkError(_FakeMem0Error):
    pass


class _FakeMem0RateLimitError(_FakeMem0Error):
    pass


class _FakeMem0Module(ModuleType):
    MemoryClient: object


class _FakeMem0ExceptionsModule(ModuleType):
    MemoryError: type[Exception]
    NetworkError: type[Exception]
    RateLimitError: type[Exception]


def _install_mem0_exports(
    monkeypatch: pytest.MonkeyPatch,
    *,
    memory_client: object,
) -> None:
    mem0_module = _FakeMem0Module("mem0")
    mem0_module.MemoryClient = memory_client
    exceptions_module = _FakeMem0ExceptionsModule("mem0.exceptions")
    exceptions_module.MemoryError = _FakeMem0Error
    exceptions_module.NetworkError = _FakeMem0NetworkError
    exceptions_module.RateLimitError = _FakeMem0RateLimitError
    monkeypatch.setitem(sys.modules, "mem0", mem0_module)
    monkeypatch.setitem(sys.modules, "mem0.exceptions", exceptions_module)


async def _configure_mem0(
    db_session: AsyncSession,
    seed_user: User,
) -> None:
    db_session.add(
        UserSetting(
            user_id=seed_user.id,
            settings={
                "memory_provider": "mem0",
                "mem0_api_key": encrypt_field("mock-api-key"),
            },
        )
    )
    await db_session.commit()


@pytest.mark.asyncio
async def test_get_memory_provider_falls_back_when_mem0_module_is_missing(
    db_session: AsyncSession,
    seed_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _configure_mem0(db_session, seed_user)
    monkeypatch.setitem(sys.modules, "mem0", None)
    monkeypatch.setitem(sys.modules, "mem0.exceptions", None)

    assert mem0_available() is False
    provider = await get_memory_provider(str(seed_user.id), db_session)
    assert isinstance(provider, BuiltinProvider)


@pytest.mark.asyncio
@pytest.mark.parametrize("memory_client", [None, 42])
async def test_get_memory_provider_falls_back_when_memory_client_is_not_callable(
    db_session: AsyncSession,
    seed_user: User,
    monkeypatch: pytest.MonkeyPatch,
    memory_client: object,
) -> None:
    await _configure_mem0(db_session, seed_user)
    _install_mem0_exports(monkeypatch, memory_client=memory_client)

    assert mem0_available() is False
    provider = await get_memory_provider(str(seed_user.id), db_session)
    assert isinstance(provider, BuiltinProvider)


@pytest.mark.asyncio
async def test_get_memory_provider_falls_back_when_memory_client_export_is_missing(
    db_session: AsyncSession,
    seed_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _configure_mem0(db_session, seed_user)
    mem0_module = ModuleType("mem0")
    monkeypatch.setitem(sys.modules, "mem0", mem0_module)

    assert mem0_available() is False
    provider = await get_memory_provider(str(seed_user.id), db_session)
    assert isinstance(provider, BuiltinProvider)


@pytest.mark.asyncio
async def test_get_memory_provider_falls_back_when_constructor_is_incompatible(
    db_session: AsyncSession,
    seed_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _configure_mem0(db_session, seed_user)

    class IncompatibleMemoryClient:
        def __init__(self, required_positional: str) -> None:
            del required_positional

    _install_mem0_exports(monkeypatch, memory_client=IncompatibleMemoryClient)

    assert mem0_available() is True
    provider = await get_memory_provider(str(seed_user.id), db_session)
    assert isinstance(provider, BuiltinProvider)


@pytest.mark.asyncio
async def test_get_memory_provider_falls_back_when_constructed_client_is_incompatible(
    db_session: AsyncSession,
    seed_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _configure_mem0(db_session, seed_user)

    class IncompleteMemoryClient:
        def __init__(self, *, api_key: str) -> None:
            assert api_key == "mock-api-key"

    _install_mem0_exports(monkeypatch, memory_client=IncompleteMemoryClient)

    assert mem0_available() is True
    provider = await get_memory_provider(str(seed_user.id), db_session)
    assert isinstance(provider, BuiltinProvider)


@pytest.mark.asyncio
async def test_get_memory_provider_uses_mem0_when_exports_and_constructor_are_usable(
    db_session: AsyncSession,
    seed_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _configure_mem0(db_session, seed_user)
    constructed: list[str] = []

    class RecordingMemoryClient:
        def __init__(self, *, api_key: str) -> None:
            constructed.append(api_key)

        def add(self, messages: object, **kwargs: object) -> object:
            raise AssertionError((messages, kwargs))

        def search(self, query: str, **kwargs: object) -> object:
            raise AssertionError((query, kwargs))

        def get_all(self, **kwargs: object) -> object:
            raise AssertionError(kwargs)

        def get(self, memory_id: str) -> object:
            raise AssertionError(memory_id)

        def delete(self, memory_id: str) -> object:
            raise AssertionError(memory_id)

    _install_mem0_exports(monkeypatch, memory_client=RecordingMemoryClient)

    assert mem0_available() is True
    provider = await get_memory_provider(str(seed_user.id), db_session)
    assert isinstance(provider, Mem0Provider)
    assert constructed == ["mock-api-key"]


@pytest.mark.asyncio
async def test_get_memory_provider_uses_builtin_when_no_setting(
    db_session: AsyncSession,
    seed_user: User,
) -> None:
    provider = await get_memory_provider(str(seed_user.id), db_session)
    assert isinstance(provider, BuiltinProvider)


@pytest.mark.asyncio
async def test_get_memory_provider_handles_unknown_user_id(db_session: AsyncSession) -> None:
    provider = await get_memory_provider(str(uuid.uuid4()), db_session)
    assert isinstance(provider, BuiltinProvider)
