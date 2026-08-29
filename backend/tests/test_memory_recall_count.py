"""Recall counting — agent searches bump access_count; dashboard reads don't.

`access_count` was a dead column (defined, displayed, never written), so
every memory showed "Never recalled yet" forever. The signal matters: the
dashboard's keep-vs-delete judgement keys on whether agents actually use a
memory.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import pytest


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_agent_search_bumps_access_count(cli_client: httpx.AsyncClient):
    created = await cli_client.post(
        "/v1/memories",
        json={"content": "Always deploy previews before merging", "category": "decision"},
    )
    assert created.status_code == 200, created.text
    memory_id = created.json()["id"]

    # Ranked search from API-key auth = a recall.
    r = await cli_client.get("/v1/memories?q=deploy+previews")
    assert r.status_code == 200, r.text
    assert any(m["id"] == memory_id for m in r.json()["items"])

    detail = (await cli_client.get(f"/v1/memories/{memory_id}")).json()
    assert detail["access_count"] == 1

    # Second recall increments again.
    await cli_client.get("/v1/memories?q=deploy+previews")
    detail = (await cli_client.get(f"/v1/memories/{memory_id}")).json()
    assert detail["access_count"] == 2


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_mcp_search_bumps_access_count(cli_client: httpx.AsyncClient):
    created = await cli_client.post(
        "/v1/memories",
        json={"content": "MCP recalls count as agent retrievals", "category": "fact"},
    )
    memory_id = created.json()["id"]

    response = await cli_client.post(
        "/v1/mcp/clawdi",
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "memory_search",
                "arguments": {"query": "agent retrievals"},
            },
        },
    )
    assert response.status_code == 200, response.text
    assert "MCP recalls count" in response.json()["result"]["content"][0]["text"]

    detail = (await cli_client.get(f"/v1/memories/{memory_id}")).json()
    assert detail["access_count"] == 1


@pytest.mark.asyncio
async def test_dashboard_search_does_not_count_as_recall(client: httpx.AsyncClient):
    created = await client.post(
        "/v1/memories",
        json={"content": "Light theme stays the default", "category": "preference"},
    )
    assert created.status_code == 200, created.text
    memory_id = created.json()["id"]

    # JWT/browser search is a human browsing, not an agent recall.
    r = await client.get("/v1/memories?q=light+theme")
    assert r.status_code == 200, r.text

    detail = (await client.get(f"/v1/memories/{memory_id}")).json()
    assert detail["access_count"] == 0


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_oauth_cli_search_bumps_access_count(
    client: httpx.AsyncClient,
    seed_user,
):
    from app.core.auth import AuthContext, get_auth
    from app.main import app

    created = await client.post(
        "/v1/memories",
        json={"content": "OAuth agents recall ranked memories", "category": "fact"},
    )
    assert created.status_code == 200, created.text
    memory_id = created.json()["id"]

    async def _oauth_cli_auth() -> AuthContext:
        return AuthContext(
            user=seed_user,
            oauth_cli=True,
            oauth_access_expires_at=datetime.now(UTC) + timedelta(minutes=5),
        )

    previous = app.dependency_overrides.get(get_auth)
    app.dependency_overrides[get_auth] = _oauth_cli_auth
    try:
        response = await client.get("/v1/memories?q=oauth+agents+recall")
        assert response.status_code == 200, response.text
        assert any(item["id"] == memory_id for item in response.json()["items"])
    finally:
        if previous is None:
            app.dependency_overrides.pop(get_auth, None)
        else:
            app.dependency_overrides[get_auth] = previous

    detail = (await client.get(f"/v1/memories/{memory_id}")).json()
    assert detail["access_count"] == 1


@pytest.mark.asyncio
async def test_recall_counting_kill_switch(
    cli_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    """MEMORY_RECALL_COUNTING=false disables counting without a deploy."""
    from app.core.config import settings

    monkeypatch.setattr(settings, "memory_recall_counting", False)
    created = await cli_client.post(
        "/v1/memories",
        json={"content": "Kill switch memory probe", "category": "fact"},
    )
    memory_id = created.json()["id"]
    await cli_client.get("/v1/memories?q=kill+switch+probe")
    detail = (await cli_client.get(f"/v1/memories/{memory_id}")).json()
    assert detail["access_count"] == 0
