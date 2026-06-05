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
    XTraceProvider,
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
async def test_get_memory_provider_uses_xtrace_when_configured(
    db_session: AsyncSession, seed_user: User, monkeypatch
):
    setting = UserSetting(
        user_id=seed_user.id,
        settings={"memory_provider": "xtrace"},
    )
    db_session.add(setting)
    await db_session.commit()

    import app.services.memory_provider as mp

    monkeypatch.setattr(mp, "xtrace_memory_configured", lambda: True)

    provider = await get_memory_provider(str(seed_user.id), db_session)
    assert isinstance(provider, XTraceProvider)


@pytest.mark.asyncio
async def test_xtrace_provider_search_uses_remote_memory_search(
    db_session: AsyncSession, seed_user: User, monkeypatch
):
    import app.services.memory_provider as mp

    calls: list[dict] = []

    class FakeXTraceClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, **kwargs):
            calls.append({"url": str(url), **kwargs})
            import httpx

            request = httpx.Request("POST", str(url))
            return httpx.Response(
                200,
                request=request,
                json={
                    "object": "list",
                    "data": [
                        {
                            "id": "mem_remote",
                            "object": "memory",
                            "type": "fact",
                            "text": "User prefers XTrace remote recall for memory search.",
                            "user_id": str(seed_user.id),
                            "agent_id": None,
                            "conv_id": None,
                            "app_id": "clawdi-cloud",
                            "metadata": {"source_type": "session"},
                            "categories": ["preference"],
                            "score": 0.91,
                            "created_at": "2026-06-05T22:41:44Z",
                            "updated_at": "2026-06-05T22:41:44Z",
                            "details": {
                                "fact_type": "preference",
                                "status": "active",
                                "supersedes": None,
                                "source_role": "user",
                                "episode_id": None,
                                "artifact_id": None,
                                "artifact_ids": [],
                                "source_event_ids": [],
                            },
                        }
                    ],
                    "has_more": False,
                    "next_cursor": None,
                },
            )

    monkeypatch.setattr(mp.settings, "xtrace_api_key", "xtk_test")
    monkeypatch.setattr(mp.settings, "xtrace_org_id", "org_test")
    monkeypatch.setattr(mp.settings, "xtrace_memory_base_url", "https://xtrace.test")
    monkeypatch.setattr(mp.settings, "xtrace_memory_app_id", "clawdi-cloud")
    monkeypatch.setattr(mp.httpx, "AsyncClient", FakeXTraceClient)

    provider = XTraceProvider(db_session)
    results = await provider.search(str(seed_user.id), "remote recall", limit=3)

    assert calls[0]["url"] == "https://xtrace.test/v1/memories/search"
    assert calls[0]["headers"]["Authorization"] == "Bearer xtk_test"
    assert calls[0]["headers"]["X-Org-Id"] == "org_test"
    assert calls[0]["json"] == {
        "query": "remote recall",
        "user_id": str(seed_user.id),
        "app_id": "clawdi-cloud",
        "limit": 3,
    }
    assert results == [
        {
            "id": "mem_remote",
            "content": "User prefers XTrace remote recall for memory search.",
            "category": "preference",
            "source": "xtrace",
            "tags": ["xtrace", "xtrace:fact"],
            "access_count": 0,
            "created_at": "2026-06-05T22:41:44Z",
            "source_session_id": None,
            "xtrace": {
                "memory_id": "mem_remote",
                "type": "fact",
                "status": "active",
                "operation": None,
                "source_type": "session",
                "source_key": None,
                "local_session_id": None,
                "skill_key": None,
                "supersedes": [],
                "superseded_by": None,
                "timeline": [
                    {
                        "operation": "add",
                        "content": "User prefers XTrace remote recall for memory search.",
                        "memory_id": "mem_remote",
                        "status": "active",
                        "at": "2026-06-05T22:41:44Z",
                    }
                ],
            },
        }
    ]


@pytest.mark.asyncio
async def test_xtrace_provider_search_falls_back_to_builtin_on_remote_failure(
    db_session: AsyncSession, seed_user: User, monkeypatch
):
    import app.services.memory_provider as mp

    class BrokenXTraceClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, **kwargs):
            raise RuntimeError("xtrace unavailable")

    monkeypatch.setattr(mp.settings, "xtrace_api_key", "xtk_test")
    monkeypatch.setattr(mp.settings, "xtrace_org_id", "org_test")
    monkeypatch.setattr(mp.httpx, "AsyncClient", BrokenXTraceClient)

    provider = XTraceProvider(db_session)
    await provider.add(
        str(seed_user.id),
        "User prefers local fallback when XTrace search is unavailable.",
        category="preference",
    )

    results = await provider.search(str(seed_user.id), "local fallback", limit=5)

    assert len(results) == 1
    assert results[0]["content"] == "User prefers local fallback when XTrace search is unavailable."
    assert results[0]["source"] == "manual"


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
