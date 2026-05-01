"""Capabilities endpoint tests.

`/api/capabilities` exposes deployment-wide feature flags that
the dashboard uses to hide UI for unavailable optional
integrations. Pinned to keep the contract stable across
changes — adding a new feature is fine, breaking an existing
flag's name or shape is not.
"""

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


@pytest.mark.asyncio
async def test_capabilities_excludes_mem0_when_unavailable(client: httpx.AsyncClient, monkeypatch):
    """When the [mem0] extra isn't installed, `/api/capabilities`
    must NOT include `mem0`. Pre-fix the dashboard happily showed
    the option for users on a backend that couldn't honor it."""
    monkeypatch.setattr(mp, "_mem0_available_cached", None)
    monkeypatch.setattr(mp, "mem0_available", lambda: False)
    # `routes/settings.py` and `routes/capabilities.py` import
    # `mem0_available` as a bound name; the rebind in `mp` alone
    # leaves their references pointing at the original. Patch
    # those modules' bound names too.
    import app.routes.capabilities as cap
    import app.routes.settings as st

    monkeypatch.setattr(cap, "mem0_available", lambda: False)
    monkeypatch.setattr(st, "mem0_available", lambda: False)

    r = await client.get("/api/capabilities")
    assert r.status_code == 200, r.text
    assert "mem0" not in r.json()["memory_providers"]


@pytest.mark.asyncio
async def test_capabilities_includes_mem0_when_available(client: httpx.AsyncClient, monkeypatch):
    monkeypatch.setattr(mp, "_mem0_available_cached", None)
    monkeypatch.setattr(mp, "mem0_available", lambda: True)
    import app.routes.capabilities as cap
    import app.routes.settings as st

    monkeypatch.setattr(cap, "mem0_available", lambda: True)
    monkeypatch.setattr(st, "mem0_available", lambda: True)

    r = await client.get("/api/capabilities")
    assert r.status_code == 200, r.text
    assert "mem0" in r.json()["memory_providers"]


@pytest.mark.asyncio
async def test_capabilities_requires_auth():
    """Unauth probes shouldn't fingerprint the deployment.
    Spin up a fresh client without auth to verify."""
    from httpx import ASGITransport

    from app.main import app

    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as raw:
        r = await raw.get("/api/capabilities")
        # 401 (no auth) or 403 (CLI key not allowed); never 200.
        assert r.status_code in (401, 403), r.text


@pytest.mark.asyncio
async def test_settings_refuses_mem0_when_unavailable(client: httpx.AsyncClient, monkeypatch):
    """Settings save endpoint must refuse `memory_provider=mem0`
    when the backend can't honor it. Pre-fix the dashboard would
    save the value, then `/api/memories` 500'd for that user
    every time. Failing closed at write time gives an actionable
    400 instead of a silent landmine."""
    monkeypatch.setattr(mp, "_mem0_available_cached", None)
    monkeypatch.setattr(mp, "mem0_available", lambda: False)
    # `routes/settings.py` and `routes/capabilities.py` import
    # `mem0_available` as a bound name; the rebind in `mp` alone
    # leaves their references pointing at the original. Patch
    # those modules' bound names too.
    import app.routes.capabilities as cap
    import app.routes.settings as st

    monkeypatch.setattr(cap, "mem0_available", lambda: False)
    monkeypatch.setattr(st, "mem0_available", lambda: False)

    r = await client.patch("/api/settings", json={"settings": {"memory_provider": "mem0"}})
    assert r.status_code == 400, r.text
    detail = r.json().get("detail", {})
    assert detail.get("code") == "memory_provider_unavailable"


@pytest.mark.asyncio
async def test_settings_accepts_mem0_when_available(client: httpx.AsyncClient, monkeypatch):
    monkeypatch.setattr(mp, "_mem0_available_cached", None)
    monkeypatch.setattr(mp, "mem0_available", lambda: True)
    import app.routes.capabilities as cap
    import app.routes.settings as st

    monkeypatch.setattr(cap, "mem0_available", lambda: True)
    monkeypatch.setattr(st, "mem0_available", lambda: True)

    r = await client.patch("/api/settings", json={"settings": {"memory_provider": "mem0"}})
    assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_settings_accepts_builtin_regardless(client: httpx.AsyncClient):
    """The builtin path doesn't depend on the optional extra,
    so it's always allowed."""
    r = await client.patch("/api/settings", json={"settings": {"memory_provider": "builtin"}})
    assert r.status_code == 200, r.text
