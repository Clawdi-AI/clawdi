"""Tests for /api/capabilities and the mem0 settings save guard."""

from __future__ import annotations

import httpx
import pytest

import app.services.memory_provider as mp


@pytest.mark.asyncio
async def test_capabilities_includes_builtin_always(client: httpx.AsyncClient):
    r = await client.get("/api/capabilities")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "memory_providers" in body
    assert "builtin" in body["memory_providers"], (
        "BuiltinProvider must always be available — it's the default."
    )


def _patch_mem0_available(monkeypatch, *, available: bool) -> None:
    # `routes/settings.py` and `routes/capabilities.py` bind
    # `mem0_available` at import time, so patching `mp` alone
    # leaves their references pointing at the original.
    import app.routes.capabilities as cap
    import app.routes.settings as st

    monkeypatch.setattr(mp, "_mem0_available_cached", None)
    for mod in (mp, cap, st):
        monkeypatch.setattr(mod, "mem0_available", lambda: available)


@pytest.mark.asyncio
async def test_capabilities_excludes_mem0_when_unavailable(client: httpx.AsyncClient, monkeypatch):
    _patch_mem0_available(monkeypatch, available=False)
    r = await client.get("/api/capabilities")
    assert r.status_code == 200, r.text
    assert "mem0" not in r.json()["memory_providers"]


@pytest.mark.asyncio
async def test_capabilities_includes_mem0_when_available(client: httpx.AsyncClient, monkeypatch):
    _patch_mem0_available(monkeypatch, available=True)
    r = await client.get("/api/capabilities")
    assert r.status_code == 200, r.text
    assert "mem0" in r.json()["memory_providers"]


@pytest.mark.asyncio
async def test_capabilities_requires_auth():
    # Unauth probes shouldn't fingerprint the deployment.
    from httpx import ASGITransport

    from app.main import app

    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as raw:
        r = await raw.get("/api/capabilities")
        assert r.status_code in (401, 403), r.text


@pytest.mark.asyncio
async def test_settings_refuses_mem0_when_unavailable(client: httpx.AsyncClient, monkeypatch):
    _patch_mem0_available(monkeypatch, available=False)
    r = await client.patch("/api/settings", json={"settings": {"memory_provider": "mem0"}})
    assert r.status_code == 400, r.text
    assert r.json().get("detail", {}).get("code") == "memory_provider_unavailable"


@pytest.mark.asyncio
async def test_settings_accepts_mem0_when_available(client: httpx.AsyncClient, monkeypatch):
    _patch_mem0_available(monkeypatch, available=True)
    r = await client.patch("/api/settings", json={"settings": {"memory_provider": "mem0"}})
    assert r.status_code == 200, r.text
