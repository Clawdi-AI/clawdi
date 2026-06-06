"""Recall counting — agent searches bump access_count; dashboard reads don't.

`access_count` was a dead column (defined, displayed, never written), so
every memory showed "Never recalled yet" forever. The signal matters: the
dashboard's keep-vs-delete judgement keys on whether agents actually use a
memory.
"""

from __future__ import annotations

import httpx
import pytest


@pytest.mark.asyncio
async def test_agent_search_bumps_access_count(cli_client: httpx.AsyncClient):
    created = await cli_client.post(
        "/api/memories",
        json={"content": "Always deploy previews before merging", "category": "decision"},
    )
    assert created.status_code == 200, created.text
    memory_id = created.json()["id"]

    # Ranked search from API-key auth = a recall.
    r = await cli_client.get("/api/memories?q=deploy+previews")
    assert r.status_code == 200, r.text
    assert any(m["id"] == memory_id for m in r.json()["items"])

    detail = (await cli_client.get(f"/api/memories/{memory_id}")).json()
    assert detail["access_count"] == 1

    # Second recall increments again.
    await cli_client.get("/api/memories?q=deploy+previews")
    detail = (await cli_client.get(f"/api/memories/{memory_id}")).json()
    assert detail["access_count"] == 2


@pytest.mark.asyncio
async def test_dashboard_search_does_not_count_as_recall(client: httpx.AsyncClient):
    created = await client.post(
        "/api/memories",
        json={"content": "Light theme stays the default", "category": "preference"},
    )
    assert created.status_code == 200, created.text
    memory_id = created.json()["id"]

    # JWT/browser search is a human browsing, not an agent recall.
    r = await client.get("/api/memories?q=light+theme")
    assert r.status_code == 200, r.text

    detail = (await client.get(f"/api/memories/{memory_id}")).json()
    assert detail["access_count"] == 0


@pytest.mark.asyncio
async def test_recall_counting_kill_switch(
    cli_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    """MEMORY_RECALL_COUNTING=false disables counting without a deploy."""
    from app.core.config import settings

    monkeypatch.setattr(settings, "memory_recall_counting", False)
    created = await cli_client.post(
        "/api/memories",
        json={"content": "Kill switch memory probe", "category": "fact"},
    )
    memory_id = created.json()["id"]
    await cli_client.get("/api/memories?q=kill+switch+probe")
    detail = (await cli_client.get(f"/api/memories/{memory_id}")).json()
    assert detail["access_count"] == 0
