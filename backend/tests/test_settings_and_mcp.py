"""Settings secret-masking and the Clawdi MCP contract.

These cover two small-but-sharp security edges: secrets stored via PATCH
/api/settings must come back masked on GET, and the authenticated Clawdi MCP
endpoint must remain the only public MCP surface.
"""

from __future__ import annotations

import asyncio
import threading
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
import pytest
from fastapi.routing import iter_route_contexts
from httpx import ASGITransport
from mcp.types import ListToolsResult

from app.main import app
from app.services.composio import ComposioMcpSession


@dataclass(frozen=True, slots=True)
class _FakeMcpConfig:
    type: object
    url: str
    headers: dict[str, str | None] | None


@dataclass(frozen=True, slots=True)
class _FakeToolRouterSession:
    mcp: _FakeMcpConfig


@dataclass(frozen=True, slots=True)
class _FakeComposioSdk:
    sessions: object


def _mcp_session(user_id: str, generation: int = 1) -> ComposioMcpSession:
    return ComposioMcpSession(
        url=f"https://composio.test/{user_id}/{generation}",
        headers={"x-session": f"{user_id}-{generation}"},
        expires_at=datetime.now(UTC) + timedelta(minutes=30),
    )


def _mcp_tools(name: str) -> ListToolsResult:
    return ListToolsResult.model_validate(
        {
            "tools": [
                {
                    "name": name,
                    "inputSchema": {"type": "object"},
                    "_meta": {"cacheTest": name},
                }
            ]
        }
    )


@pytest.fixture
def tool_router_cache(monkeypatch):
    from app.services import composio

    sessions: dict[str, list[ComposioMcpSession]] = {}

    async def fake_create(user_id: str, *, now: datetime):
        assert now.tzinfo is not None
        return sessions[user_id].pop(0)

    monkeypatch.setattr(composio, "_tool_router_session_cache", {})
    monkeypatch.setattr(composio, "_tool_router_tools_cache", {})
    monkeypatch.setattr(composio, "_tool_router_tools_inflight", {})
    monkeypatch.setattr(composio, "_create_tool_router_mcp_session", fake_create)
    return composio, sessions


@pytest.mark.asyncio
async def test_settings_patch_masks_sensitive_keys_on_read(client: httpx.AsyncClient, monkeypatch):
    # Settings save now refuses `memory_provider=mem0` when the
    # `[mem0]` extra isn't installed (the prod-default since the
    # package was never declared). Stub `mem0_available()` so this
    # masking test can still exercise the secret-handling path.
    import app.services.memory_provider_mem0 as mem0_adapter

    monkeypatch.setattr(mem0_adapter, "mem0_available", lambda: True)
    import app.routes.settings as st

    monkeypatch.setattr(st, "mem0_available", lambda: True)

    r = await client.patch(
        "/v1/settings",
        json={"settings": {"memory_provider": "mem0", "mem0_api_key": "mem0_live_supersecret"}},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "updated"}

    body = (await client.get("/v1/settings")).json()
    assert body["memory_provider"] == "mem0"
    # Secret fields must be masked — the actual key value must never be returned.
    masked = body["mem0_api_key"]
    assert masked != "mem0_live_supersecret"
    # The mask sentinel defined in app.routes.settings._SECRET_MASK.
    assert masked == "••••••••"


@pytest.mark.asyncio
async def test_settings_patch_merges_rather_than_replaces(client: httpx.AsyncClient):
    await client.patch("/v1/settings", json={"settings": {"a": 1, "b": 2}})
    await client.patch("/v1/settings", json={"settings": {"b": 99}})
    body = (await client.get("/v1/settings")).json()
    # "a" must survive the second patch — PATCH semantics are merge, not replace.
    assert body["a"] == 1
    assert body["b"] == 99


@pytest.mark.asyncio
async def test_project_migration_banner_dismiss_persists(client: httpx.AsyncClient):
    """The post-migration banner dismiss flow uses the existing
    /api/settings PATCH/GET — we don't add a dedicated endpoint.
    The dashboard writes `project_migration_banner_dismissed_at`
    (ISO timestamp) when the user closes the banner; subsequent
    reads return it so the banner stays hidden across sessions /
    devices. Lock the contract here so a refactor of /api/settings
    can't accidentally drop arbitrary-key support and silently
    revive the banner forever."""
    # Initial state: key absent → banner should show client-side.
    body = (await client.get("/v1/settings")).json()
    assert "project_migration_banner_dismissed_at" not in body

    # Dashboard dismisses the banner.
    dismissed_at = "2026-04-29T08:30:00Z"
    r = await client.patch(
        "/v1/settings",
        json={"settings": {"project_migration_banner_dismissed_at": dismissed_at}},
    )
    assert r.status_code == 200, r.text

    # Subsequent reads (any device) see the dismissed timestamp.
    body = (await client.get("/v1/settings")).json()
    assert body["project_migration_banner_dismissed_at"] == dismissed_at


def test_legacy_mcp_compatibility_routes_and_schema():
    route_methods = {
        (route.path, method)
        for route in iter_route_contexts(app.routes)
        for method in (getattr(route, "methods", None) or set())
    }

    for prefix in ("/v1", "/api"):
        assert (f"{prefix}/connectors/mcp-config", "GET") in route_methods
        assert (f"{prefix}/mcp/composio", "POST") in route_methods
        assert (f"{prefix}/mcp/clawdi", "POST") in route_methods

    paths = app.openapi()["paths"]
    assert "/v1/connectors/mcp-config" in paths
    assert "/v1/mcp/composio" not in paths
    assert "/api/connectors/mcp-config" not in paths
    assert "/api/mcp/composio" not in paths


@pytest.mark.asyncio
async def test_legacy_mcp_config_preserves_cli_response_for_both_aliases(monkeypatch):
    from app.core.auth import AuthContext, get_auth_short_session
    from app.core.config import settings
    from app.models.user import User
    from app.services.composio import verify_mcp_bridge_token

    async def fake_auth() -> AuthContext:
        return AuthContext(
            user=User(
                email="mcp-config-test@clawdi.local",
                name="MCP Config Test",
                clerk_id="clerk_user_123",
            )
        )

    monkeypatch.setattr(settings, "composio_api_key", "composio_test_key")
    monkeypatch.setattr(settings, "encryption_key", "test-encryption-key-at-least-32-bytes")
    monkeypatch.setattr(settings, "public_api_url", "https://api.example.test/")
    app.dependency_overrides[get_auth_short_session] = fake_auth
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            responses = [
                await ac.get("/v1/connectors/mcp-config"),
                await ac.get("/api/connectors/mcp-config"),
            ]
    finally:
        app.dependency_overrides.clear()

    for response in responses:
        assert response.status_code == 200, response.text
        assert set(response.json()) == {"mcp_url", "mcp_token"}
        assert response.json()["mcp_url"] == "https://api.example.test/v1/mcp/composio"
        assert verify_mcp_bridge_token(response.json()["mcp_token"]) == "clerk_user_123"


@pytest.mark.asyncio
async def test_legacy_composio_bridge_rejects_missing_and_invalid_bearer_tokens(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "encryption_key", "test-encryption-key-at-least-32-bytes")
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        missing = await ac.post("/v1/mcp/composio", json={"method": "tools/list"})
        invalid = await ac.post(
            "/v1/mcp/composio",
            headers={"Authorization": "Bearer not.a.valid.jwt"},
            json={"method": "tools/list"},
        )

    assert missing.status_code == 401, missing.text
    assert missing.json() == {"detail": "Missing auth token"}
    assert invalid.status_code == 401, invalid.text
    assert invalid.json() == {"detail": "Invalid token"}


@pytest.mark.asyncio
async def test_legacy_composio_bridge_rejects_unknown_methods_without_upstream_session(monkeypatch):
    from app.core.config import settings
    from app.routes import mcp_bridge
    from app.services.composio import create_mcp_bridge_token

    async def unexpected_session(_user_id: str):
        raise AssertionError("unsupported methods must not create an upstream session")

    monkeypatch.setattr(settings, "encryption_key", "test-encryption-key-at-least-32-bytes")
    monkeypatch.setattr(mcp_bridge, "get_tool_router_mcp_session", unexpected_session)
    token = create_mcp_bridge_token("clerk_user_123")
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        responses = [
            await ac.post(
                "/v1/mcp/composio",
                headers={"Authorization": f"Bearer {token}"},
                json={"jsonrpc": "2.0", "id": rpc_id, "method": method},
            )
            for rpc_id, method in ((1, "resources/list"), (2, 42))
        ]

    for rpc_id, response in enumerate(responses, start=1):
        assert response.status_code == 200, response.text
        assert response.json() == {
            "jsonrpc": "2.0",
            "id": rpc_id,
            "error": {"code": -32601, "message": "Method not found"},
        }


@pytest.mark.asyncio
async def test_legacy_composio_aliases_bridge_tools_list_and_call(monkeypatch):
    from mcp.types import CallToolResult, ListToolsResult

    from app.core.config import settings
    from app.routes import mcp_bridge
    from app.services.composio import ComposioMcpSession, create_mcp_bridge_token

    seen: list[tuple[str, object]] = []
    session = ComposioMcpSession(
        url="https://composio.example.test/mcp",
        headers={"x-session": "secret"},
        expires_at=datetime.now(UTC) + timedelta(minutes=30),
    )

    async def fake_session(user_id: str) -> ComposioMcpSession:
        seen.append(("session", user_id))
        return session

    async def fake_list(value: ComposioMcpSession) -> ListToolsResult:
        assert value is session
        return ListToolsResult.model_validate(
            {"tools": [{"name": "COMPOSIO_SEARCH_TOOLS", "inputSchema": {"type": "object"}}]}
        )

    async def fake_call(value: ComposioMcpSession, name: str, arguments: dict) -> CallToolResult:
        assert value is session
        seen.append((name, arguments))
        return CallToolResult.model_validate(
            {"content": [{"type": "text", "text": "called"}], "isError": False}
        )

    monkeypatch.setattr(settings, "encryption_key", "test-encryption-key-at-least-32-bytes")
    monkeypatch.setattr(mcp_bridge, "get_tool_router_mcp_session", fake_session)
    monkeypatch.setattr(mcp_bridge, "list_tool_router_mcp_tools", fake_list)
    monkeypatch.setattr(mcp_bridge, "call_tool_router_mcp_tool", fake_call)
    token = create_mcp_bridge_token("clerk_user_123")
    headers = {"Authorization": f"Bearer {token}"}
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        for prefix in ("/v1", "/api"):
            listed = await ac.post(
                f"{prefix}/mcp/composio",
                headers=headers,
                json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
            )
            called = await ac.post(
                f"{prefix}/mcp/composio",
                headers=headers,
                json={
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/call",
                    "params": {"name": "COMPOSIO_SEARCH_TOOLS", "arguments": {"query": "mail"}},
                },
            )
            assert listed.status_code == 200, listed.text
            assert listed.json()["result"]["tools"][0]["name"] == "COMPOSIO_SEARCH_TOOLS"
            assert called.status_code == 200, called.text
            assert called.json()["result"]["content"] == [{"type": "text", "text": "called"}]
            assert called.json()["result"]["isError"] is False

    assert seen.count(("session", "clerk_user_123")) == 4
    assert seen.count(("COMPOSIO_SEARCH_TOOLS", {"query": "mail"})) == 2


@pytest.mark.asyncio
async def test_clawdi_mcp_initializes_and_lists_native_tools(monkeypatch):
    from app.core.auth import AuthContext, get_auth_short_session
    from app.core.database import get_session
    from app.models.user import User
    from app.routes import mcp_bridge

    async def fake_auth() -> AuthContext:
        return AuthContext(
            user=User(
                email="mcp-clawdi-test@clawdi.local",
                name="MCP Clawdi Test",
                clerk_id="clerk_mcp_clawdi",
            )
        )

    async def fake_session():
        yield None

    async def no_connector_tools(user_id: str):
        raise mcp_bridge.ComposioMcpUpstreamError("connectors disabled for test")

    monkeypatch.setattr(mcp_bridge, "get_tool_router_mcp_tools", no_connector_tools)
    app.dependency_overrides[get_auth_short_session] = fake_auth
    app.dependency_overrides[get_session] = fake_session
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            canonical_init = await ac.post(
                "/v1/mcp/clawdi",
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-06-18",
                        "capabilities": {},
                        "clientInfo": {},
                    },
                },
            )
            pinged = await ac.post(
                "/v1/mcp/clawdi",
                json={"jsonrpc": "2.0", "id": 2, "method": "ping", "params": {}},
            )
            listed = await ac.post(
                "/v1/mcp/clawdi",
                json={"jsonrpc": "2.0", "id": 3, "method": "tools/list", "params": {}},
            )
    finally:
        app.dependency_overrides.clear()

    assert canonical_init.status_code == 200, canonical_init.text
    assert canonical_init.json()["result"]["capabilities"]["tools"]["listChanged"] is False
    assert pinged.json() == {"jsonrpc": "2.0", "id": 2, "result": {}}

    assert listed.status_code == 200, listed.text
    names = {tool["name"] for tool in listed.json()["result"]["tools"]}
    assert {"memory_search", "memory_add", "memory_extract", "session_search", "session_read"} <= (
        names
    )


@pytest.mark.asyncio
async def test_clawdi_mcp_preserves_standard_composio_tool_contract(monkeypatch):
    from app.core.auth import AuthContext, get_auth_short_session
    from app.core.database import get_session
    from app.models.user import User
    from app.routes import mcp_bridge
    from app.services.composio import ComposioMcpSession

    expected_tool = {
        "name": "COMPOSIO_FUTURE_META_TOOL",
        "description": "A future schema-driven meta-tool",
        "inputSchema": {
            "type": "object",
            "properties": {
                "target": {
                    "type": "object",
                    "properties": {"id": {"type": "string"}},
                    "required": ["id"],
                }
            },
            "required": ["target"],
        },
        "outputSchema": {
            "type": "object",
            "properties": {"redirect_url": {"type": ["string", "null"]}},
        },
        "annotations": {"openWorldHint": True},
        "_meta": {"composio": {"future_contract": True}},
    }
    expected_arguments = {"target": {"id": "recipient_123"}, "preserve": [1, {"x": True}]}
    expected_result = {
        "content": [
            {
                "type": "text",
                "text": '{"status":"initiated","redirect_url":"https://connect.test/link"}',
            }
        ],
        "structuredContent": {
            "status": "initiated",
            "redirect_url": "https://connect.test/link",
        },
        "isError": False,
        "resultType": "complete",
        "_meta": {"future": {"preserved": True}},
    }
    forwarded: list[tuple[str, object]] = []

    async def fake_auth() -> AuthContext:
        return AuthContext(
            user=User(
                email="mcp-passthrough-test@clawdi.local",
                name="MCP Passthrough Test",
                clerk_id="clerk_mcp_passthrough",
            )
        )

    async def fake_db_session():
        yield None

    async def fake_composio_session(user_id: str) -> ComposioMcpSession:
        assert user_id == "clerk_mcp_passthrough"
        return ComposioMcpSession(
            url="https://composio.test/mcp",
            headers={},
            expires_at=datetime.now(UTC) + timedelta(minutes=30),
        )

    async def fake_list(session: ComposioMcpSession):
        from mcp.types import ListToolsResult

        forwarded.append(("tools/list", session))
        return ListToolsResult.model_validate({"tools": [expected_tool]})

    async def fake_connector_tools(user_id: str):
        await fake_list(await fake_composio_session(user_id))
        return [expected_tool]

    async def fake_call(session: ComposioMcpSession, name: str, arguments: dict):
        from mcp.types import CallToolResult

        forwarded.append((name, arguments))
        return CallToolResult.model_validate(expected_result)

    monkeypatch.setattr(mcp_bridge, "get_tool_router_mcp_session", fake_composio_session)
    monkeypatch.setattr(mcp_bridge, "get_tool_router_mcp_tools", fake_connector_tools)
    monkeypatch.setattr(mcp_bridge, "call_tool_router_mcp_tool", fake_call)
    app.dependency_overrides[get_auth_short_session] = fake_auth
    app.dependency_overrides[get_session] = fake_db_session
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            listed = await ac.post(
                "/v1/mcp/clawdi",
                json={"jsonrpc": "2.0", "id": 10, "method": "tools/list", "params": {}},
            )
            called = await ac.post(
                "/v1/mcp/clawdi",
                json={
                    "jsonrpc": "2.0",
                    "id": 11,
                    "method": "tools/call",
                    "params": {
                        "name": "COMPOSIO_FUTURE_META_TOOL",
                        "arguments": expected_arguments,
                    },
                },
            )
    finally:
        app.dependency_overrides.pop(get_session, None)
        app.dependency_overrides.pop(get_auth_short_session, None)

    listed_tools = listed.json()["result"]["tools"]
    listed_composio_tool = next(
        tool for tool in listed_tools if tool["name"] == expected_tool["name"]
    )
    assert listed_composio_tool == expected_tool
    assert called.json() == {"jsonrpc": "2.0", "id": 11, "result": expected_result}
    assert forwarded[1] == ("COMPOSIO_FUTURE_META_TOOL", expected_arguments)


@pytest.mark.asyncio
async def test_clawdi_mcp_memory_search_shares_account_memory_across_agents(
    db_session,
    seed_user,
    monkeypatch,
):
    from app.core.auth import AuthContext, get_auth_short_session
    from app.core.database import get_session
    from app.models.api_key import ApiKey
    from app.models.memory import Memory
    from app.models.session import Session
    from app.routes import mcp_bridge
    from tests.conftest import create_env_with_project

    env_a = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id="mcp-env-a",
        machine_name="MCP Env A",
        agent_type="openclaw",
    )
    env_b = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id="mcp-env-b",
        machine_name="MCP Env B",
        agent_type="hermes",
    )
    now = datetime.now(UTC)
    session_a = Session(
        user_id=seed_user.id,
        environment_id=env_a.id,
        local_session_id="mcp-a",
        project_path="/repo/a",
        started_at=now,
        summary="Alpha runtime work",
    )
    session_b = Session(
        user_id=seed_user.id,
        environment_id=env_b.id,
        local_session_id="mcp-b",
        project_path="/repo/b",
        started_at=now,
        summary="Beta runtime work",
    )
    db_session.add_all([session_a, session_b])
    await db_session.flush()
    db_session.add_all(
        [
            Memory(
                user_id=seed_user.id,
                content="OpenClaw alpha runtime uses backend direct MCP.",
                category="decision",
                source="session",
                source_session_id=session_a.id,
            ),
            Memory(
                user_id=seed_user.id,
                content="Hermes beta runtime uses a different MCP setup.",
                category="decision",
                source="session",
                source_session_id=session_b.id,
            ),
        ]
    )
    await db_session.commit()

    async def override_session():
        yield db_session

    async def override_auth() -> AuthContext:
        return AuthContext(
            user=seed_user,
            api_key=ApiKey(user_id=seed_user.id, environment_id=env_a.id, scopes=None),
        )

    async def no_connector_tools(user_id: str):
        raise mcp_bridge.ComposioMcpUpstreamError("connectors disabled for test")

    monkeypatch.setattr(mcp_bridge, "get_tool_router_mcp_tools", no_connector_tools)
    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_auth_short_session] = override_auth
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/v1/mcp/clawdi",
                json={
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {
                        "name": "memory_search",
                        "arguments": {"query": "runtime MCP", "limit": 10},
                    },
                },
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    text = response.json()["result"]["content"][0]["text"]
    assert "OpenClaw alpha runtime" in text
    assert "Hermes beta runtime" in text


@pytest.mark.asyncio
async def test_clawdi_mcp_session_search_uses_shared_metadata_and_body_matches(
    db_session,
    seed_user,
):
    from app.core.auth import AuthContext, get_auth_short_session
    from app.core.database import get_session
    from app.models.api_key import ApiKey
    from app.models.session import Session
    from app.services.session_search import (
        SearchableSessionMessage,
        replace_snapshot_search_index,
    )
    from tests.conftest import create_env_with_project

    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id="mcp-search-wildcards",
        machine_name="MCP Search Wildcards",
        agent_type="openclaw",
    )
    now = datetime.now(UTC)
    percent = Session(
        user_id=seed_user.id,
        environment_id=env.id,
        local_session_id="mcp-percent",
        project_path="/repo/percent",
        started_at=now,
        summary="Literal 100% rollout note",
    )
    plain = Session(
        user_id=seed_user.id,
        environment_id=env.id,
        local_session_id="mcp-plain",
        project_path="/repo/plain",
        started_at=now,
        summary="Plain runtime work",
    )
    body_hash = "a" * 64
    body = Session(
        user_id=seed_user.id,
        environment_id=env.id,
        local_session_id="mcp-body",
        project_path="/repo/body",
        started_at=now,
        summary="Unrelated title",
        content_protocol="snapshot-v1",
        content_hash=body_hash,
    )
    db_session.add_all([percent, plain, body])
    await db_session.flush()
    await replace_snapshot_search_index(
        db_session,
        body,
        body_hash,
        [
            SearchableSessionMessage(
                position=0,
                role="assistant",
                content="The visible body contains a deployment handoff phrase.",
            )
        ],
    )
    await db_session.commit()

    async def override_session():
        yield db_session

    async def override_auth() -> AuthContext:
        return AuthContext(
            user=seed_user,
            api_key=ApiKey(user_id=seed_user.id, environment_id=env.id, scopes=None),
        )

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_auth_short_session] = override_auth
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:

            async def search(query: str):
                return await ac.post(
                    "/v1/mcp/clawdi",
                    json={
                        "jsonrpc": "2.0",
                        "id": 4,
                        "method": "tools/call",
                        "params": {
                            "name": "session_search",
                            "arguments": {"query": query, "limit": 10},
                        },
                    },
                )

            wildcard_response = await search("100%")
            body_response = await search("deployment handoff phrase")
            reordered_response = await search("phrase deployment")
            typo_response = await search("deployment handof phrase")
    finally:
        app.dependency_overrides.clear()

    assert wildcard_response.status_code == 200, wildcard_response.text
    wildcard_text = wildcard_response.json()["result"]["content"][0]["text"]
    assert "Literal 100% rollout note" in wildcard_text
    assert "Plain runtime work" not in wildcard_text

    assert body_response.status_code == 200, body_response.text
    body_text = body_response.json()["result"]["content"][0]["text"]
    assert "Unrelated title" in body_text
    assert "matched assistant: The visible body contains a deployment handoff phrase." in body_text

    assert reordered_response.status_code == 200, reordered_response.text
    reordered_text = reordered_response.json()["result"]["content"][0]["text"]
    assert "Unrelated title" in reordered_text
    assert "matched assistant: The visible body contains a deployment handoff phrase." in (
        reordered_text
    )

    assert typo_response.status_code == 200, typo_response.text
    assert (
        'No sessions matched "deployment handof phrase".'
        in typo_response.json()["result"]["content"][0]["text"]
    )


@pytest.mark.asyncio
async def test_composio_mcp_client_runs_lifecycle_and_parses_json_and_sse(monkeypatch):
    import json

    import httpx2

    from app.services import composio
    from app.services.composio import ComposioMcpSession

    requests: list[tuple[str, dict | None, dict[str, str]]] = []
    client_settings: list[tuple[dict[str, str], httpx2.Timeout, bool]] = []
    clients: list[httpx2.AsyncClient] = []
    real_async_client = httpx2.AsyncClient

    async def handler(request: httpx2.Request) -> httpx2.Response:
        payload = json.loads(request.content) if request.content else None
        headers = {key.lower(): value for key, value in request.headers.items()}
        requests.append((request.method, payload, headers))
        if request.method == "DELETE":
            return httpx2.Response(200)
        assert payload is not None
        method = payload.get("method")
        if method == "server/discover":
            return httpx2.Response(
                200,
                json={
                    "jsonrpc": "2.0",
                    "id": payload["id"],
                    "error": {"code": -32601, "message": "Method not found"},
                },
            )
        if method == "initialize":
            return httpx2.Response(
                200,
                headers={"Mcp-Session-Id": "sdk-session"},
                json={
                    "jsonrpc": "2.0",
                    "id": payload["id"],
                    "result": {
                        "protocolVersion": "2025-06-18",
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "composio-test", "version": "1"},
                    },
                },
            )
        if method == "notifications/initialized":
            return httpx2.Response(202)
        if method == "tools/call":
            return httpx2.Response(
                200,
                json={
                    "jsonrpc": "2.0",
                    "id": payload["id"],
                    "result": {
                        "content": [{"type": "text", "text": "connected"}],
                        "structuredContent": {"status": "connected"},
                        "isError": False,
                        "_meta": {"composio": {"request": "complete"}},
                        "futureResultField": "not-a-standard-extension",
                    },
                },
            )
        assert method == "tools/list"
        body = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": payload["id"],
                "result": {
                    "tools": [
                        {
                            "name": "COMPOSIO_SEARCH_TOOLS",
                            "inputSchema": {"type": "object"},
                            "_meta": {"composio": {"version": 1}},
                        }
                    ]
                },
            }
        )
        return httpx2.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=f"event: message\ndata: {body}\n\n",
        )

    def fake_async_client(*, headers, timeout, follow_redirects):
        client_settings.append((headers, timeout, follow_redirects))
        client = real_async_client(
            headers=headers,
            transport=httpx2.MockTransport(handler),
            follow_redirects=follow_redirects,
        )
        clients.append(client)
        return client

    monkeypatch.setattr(composio.httpx2, "AsyncClient", fake_async_client)
    session = ComposioMcpSession(
        url="https://composio.test/mcp",
        headers={"x-api-key": "session-scoped-key"},
        expires_at=datetime.now(UTC) + timedelta(minutes=30),
    )
    result = await composio.list_tool_router_mcp_tools(session)
    called = await composio.call_tool_router_mcp_tool(session, "COMPOSIO_CONNECT", {"app": "x"})

    assert len(client_settings) == 1
    assert not clients[0].is_closed
    for headers, timeout, follow_redirects in client_settings:
        assert headers == {"x-api-key": "session-scoped-key"}
        assert timeout.connect == 30.0
        assert timeout.write == 30.0
        assert timeout.pool == 30.0
        assert timeout.read == 300.0
        assert follow_redirects is True
    methods = [payload.get("method") for _, payload, _ in requests if payload]
    assert methods.index("initialize") < methods.index("notifications/initialized")
    assert methods.index("notifications/initialized") < methods.index("tools/list")
    followups = [
        headers
        for _, payload, headers in requests
        if payload
        and payload.get("method") in {"notifications/initialized", "tools/list", "tools/call"}
    ]
    assert all(headers.get("mcp-protocol-version") == "2025-06-18" for headers in followups)
    assert all(headers.get("mcp-session-id") == "sdk-session" for headers in followups)
    assert requests[-1][0] == "DELETE"
    assert result.tools[0].name == "COMPOSIO_SEARCH_TOOLS"
    assert result.tools[0].meta == {"composio": {"version": 1}}
    serialized_call = called.model_dump(by_alias=True, exclude_none=True)
    assert serialized_call == {
        "content": [{"type": "text", "text": "connected"}],
        "structuredContent": {"status": "connected"},
        "isError": False,
        "resultType": "complete",
        "_meta": {"composio": {"request": "complete"}},
    }
    await session.retire()
    assert clients[0].is_closed


@pytest.mark.asyncio
async def test_connector_tool_cache_is_session_bound_and_user_scoped(
    monkeypatch, tool_router_cache
):
    composio, sessions = tool_router_cache
    sessions.update(
        {
            "user-a": [_mcp_session("user-a"), _mcp_session("user-a", 2)],
            "user-b": [_mcp_session("user-b")],
        }
    )
    list_calls: list[str] = []

    async def fake_list(session):
        list_calls.append(session.url)
        return _mcp_tools(session.headers["x-session"])

    monkeypatch.setattr(composio, "list_tool_router_mcp_tools", fake_list)

    first = await composio.get_tool_router_mcp_tools("user-a")
    cached = await composio.get_tool_router_mcp_tools("user-a")
    isolated = await composio.get_tool_router_mcp_tools("user-b")
    composio._tool_router_session_cache["user-a"] = sessions["user-a"].pop(0)
    refreshed = await composio.get_tool_router_mcp_tools("user-a")

    assert first is cached
    assert first[0] == {
        "name": "user-a-1",
        "inputSchema": {"type": "object"},
        "_meta": {"cacheTest": "user-a-1"},
    }
    assert [first[0]["name"], isolated[0]["name"], refreshed[0]["name"]] == [
        "user-a-1",
        "user-b-1",
        "user-a-2",
    ]
    assert list_calls == [
        "https://composio.test/user-a/1",
        "https://composio.test/user-b/1",
        "https://composio.test/user-a/2",
    ]


@pytest.mark.asyncio
async def test_connector_tool_load_is_single_flight(monkeypatch, tool_router_cache):
    composio, sessions = tool_router_cache
    sessions["single-flight"] = [_mcp_session("single-flight")]
    started = asyncio.Event()
    release = asyncio.Event()
    list_calls = 0

    async def fake_list(_session):
        nonlocal list_calls
        list_calls += 1
        started.set()
        await release.wait()
        return _mcp_tools("shared")

    monkeypatch.setattr(composio, "list_tool_router_mcp_tools", fake_list)

    first = asyncio.create_task(composio.get_tool_router_mcp_tools("single-flight"))
    await started.wait()
    load = composio._tool_router_tools_inflight["single-flight"]
    second = asyncio.create_task(composio.get_tool_router_mcp_tools("single-flight"))
    await asyncio.sleep(0)

    assert load is not first
    assert list_calls == 1
    release.set()
    first_result, second_result = await asyncio.gather(first, second)
    assert first_result is second_result


@pytest.mark.asyncio
async def test_connector_tool_load_restarts_after_inflight_invalidation(
    monkeypatch, tool_router_cache
):
    composio, sessions = tool_router_cache
    sessions["invalidation"] = [
        _mcp_session("invalidation"),
        _mcp_session("invalidation", 2),
    ]
    started = asyncio.Event()
    release = asyncio.Event()
    list_calls: list[str] = []

    async def fake_list(session):
        list_calls.append(session.url)
        if session.url.endswith("/1"):
            started.set()
            await release.wait()
        return _mcp_tools(session.headers["x-session"])

    monkeypatch.setattr(composio, "list_tool_router_mcp_tools", fake_list)

    request = asyncio.create_task(composio.get_tool_router_mcp_tools("invalidation"))
    await started.wait()
    await composio.invalidate_tool_router_mcp_session("invalidation")
    release.set()
    result = await request

    assert result[0]["name"] == "invalidation-2"
    assert list_calls == [
        "https://composio.test/invalidation/1",
        "https://composio.test/invalidation/2",
    ]
    assert composio._tool_router_tools_cache["invalidation"][1] is result


@pytest.mark.asyncio
async def test_connector_tool_load_survives_creator_cancellation(monkeypatch, tool_router_cache):
    composio, sessions = tool_router_cache
    sessions["cancellation"] = [_mcp_session("cancellation")]
    started = asyncio.Event()
    release = asyncio.Event()

    async def fake_list(_session):
        started.set()
        await release.wait()
        return _mcp_tools("survived")

    monkeypatch.setattr(composio, "list_tool_router_mcp_tools", fake_list)

    creator = asyncio.create_task(composio.get_tool_router_mcp_tools("cancellation"))
    await started.wait()
    waiter = asyncio.create_task(composio.get_tool_router_mcp_tools("cancellation"))
    await asyncio.sleep(0)
    load = composio._tool_router_tools_inflight["cancellation"]
    creator.cancel()

    with pytest.raises(asyncio.CancelledError):
        await creator
    assert not load.cancelled()
    assert not waiter.done()

    release.set()
    assert (await waiter)[0]["name"] == "survived"


@pytest.mark.asyncio
async def test_connector_tool_load_retries_after_failure(monkeypatch, tool_router_cache):
    composio, sessions = tool_router_cache
    sessions["retry"] = [_mcp_session("retry")]
    attempts = 0

    async def fake_list(_session):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise composio.ComposioMcpUpstreamError("unavailable")
        return _mcp_tools("retried")

    monkeypatch.setattr(composio, "list_tool_router_mcp_tools", fake_list)

    with pytest.raises(composio.ComposioMcpUpstreamError):
        await composio.get_tool_router_mcp_tools("retry")
    result = await composio.get_tool_router_mcp_tools("retry")

    assert result[0]["name"] == "retried"
    assert attempts == 2


@pytest.mark.asyncio
async def test_create_tool_router_mcp_session_uses_canonical_sdk_off_event_loop(monkeypatch):
    from composio.core.models.tool_router import ToolRouterMCPServerType

    from app.services import composio

    calls: list[dict] = []
    event_loop_thread = threading.get_ident()

    class FakeSessions:
        def create(self, *, user_id: str, mcp: bool) -> _FakeToolRouterSession:
            kwargs = {"user_id": user_id, "mcp": mcp}
            calls.append({"kwargs": kwargs, "thread": threading.get_ident()})
            return _FakeToolRouterSession(
                mcp=_FakeMcpConfig(
                    type=ToolRouterMCPServerType.HTTP,
                    url="https://app.composio.dev/tool_router/v3/trs_test/mcp",
                    headers={"x-api-key": "session_scoped_key", "x-session": "trs_test"},
                )
            )

    monkeypatch.setattr(
        composio,
        "get_composio_sdk",
        lambda: _FakeComposioSdk(sessions=FakeSessions()),
    )

    now = datetime(2026, 5, 24, tzinfo=UTC)
    session = await composio._create_tool_router_mcp_session("clerk_user_123", now=now)

    assert calls[0]["kwargs"] == {"user_id": "clerk_user_123", "mcp": True}
    assert calls[0]["thread"] != event_loop_thread
    assert session.url == "https://app.composio.dev/tool_router/v3/trs_test/mcp"
    assert session.headers == {
        "x-api-key": "session_scoped_key",
        "x-session": "trs_test",
    }
    assert session.expires_at == now + timedelta(minutes=30)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mcp",
    [
        _FakeMcpConfig(type="http", url="", headers={"x-api-key": "key"}),
        _FakeMcpConfig(type="http", url="https://composio.test/mcp", headers={}),
        _FakeMcpConfig(
            type="http",
            url="https://composio.test/mcp",
            headers={"x-api-key": None},
        ),
        _FakeMcpConfig(
            type="sse",
            url="https://composio.test/mcp",
            headers={"x-api-key": "key"},
        ),
    ],
)
async def test_create_tool_router_mcp_session_fails_closed_on_invalid_sdk_contract(
    monkeypatch,
    mcp,
):
    from app.services import composio

    config = mcp

    class FakeSessions:
        def create(self, *, user_id: str, mcp: bool) -> _FakeToolRouterSession:
            assert user_id and mcp is True
            return _FakeToolRouterSession(mcp=config)

    monkeypatch.setattr(
        composio,
        "get_composio_sdk",
        lambda: _FakeComposioSdk(sessions=FakeSessions()),
    )

    with pytest.raises(composio.ComposioMcpUpstreamError, match="invalid MCP configuration"):
        await composio._create_tool_router_mcp_session("clerk_user_123")


@pytest.mark.asyncio
async def test_clawdi_mcp_connector_tools_follow_scoped_key_permissions(
    db_session,
    seed_user,
    monkeypatch,
):
    """A scoped key without Connector permissions cannot list or invoke them."""
    from datetime import timedelta

    from app.core.auth import AuthContext, get_auth_short_session
    from app.core.database import get_session
    from app.models.api_key import ApiKey
    from app.routes import mcp_bridge
    from app.services.composio import ComposioMcpSession

    async def override_session():
        yield db_session

    scoped_key = ApiKey(user_id=seed_user.id, scopes=["sessions:read"])
    active_auth = {
        "value": AuthContext(
            user=seed_user,
            api_key=scoped_key,
        )
    }

    async def override_auth() -> AuthContext:
        return active_auth["value"]

    async def fake_session(user_id: str) -> ComposioMcpSession:
        return ComposioMcpSession(
            url="https://composio.test/mcp",
            headers={},
            expires_at=datetime.now(UTC) + timedelta(minutes=30),
        )

    async def fake_connector_tools(user_id: str):
        await fake_session(user_id)
        return [{"name": "COMPOSIO_DANGEROUS", "inputSchema": {"type": "object"}}]

    async def fake_call(session, name, arguments):
        from mcp.types import CallToolResult

        return CallToolResult.model_validate(
            {"content": [{"type": "text", "text": "connector allowed"}]}
        )

    monkeypatch.setattr(mcp_bridge, "get_tool_router_mcp_session", fake_session)
    monkeypatch.setattr(mcp_bridge, "get_tool_router_mcp_tools", fake_connector_tools)
    monkeypatch.setattr(mcp_bridge, "call_tool_router_mcp_tool", fake_call)
    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_auth_short_session] = override_auth
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            listed = await ac.post(
                "/v1/mcp/clawdi",
                json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
            )
            called = await ac.post(
                "/v1/mcp/clawdi",
                json={
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/call",
                    "params": {"name": "COMPOSIO_DANGEROUS", "arguments": {}},
                },
            )
            scoped_key.scopes = ["connectors:read", "connectors:invoke"]
            allowed_list = await ac.post(
                "/v1/mcp/clawdi",
                json={"jsonrpc": "2.0", "id": 3, "method": "tools/list", "params": {}},
            )
            allowed_call = await ac.post(
                "/v1/mcp/clawdi",
                json={
                    "jsonrpc": "2.0",
                    "id": 4,
                    "method": "tools/call",
                    "params": {"name": "COMPOSIO_DANGEROUS", "arguments": {}},
                },
            )
    finally:
        app.dependency_overrides.pop(get_session, None)
        app.dependency_overrides.pop(get_auth_short_session, None)

    assert listed.status_code == 200, listed.text
    tool_names = [tool["name"] for tool in listed.json()["result"]["tools"]]
    assert "COMPOSIO_DANGEROUS" not in tool_names
    assert "memory_search" not in tool_names

    assert called.status_code == 200, called.text
    result = called.json()["result"]
    assert result["isError"] is True
    assert "missing scope: connectors:invoke" in result["content"][0]["text"]
    allowed_names = [tool["name"] for tool in allowed_list.json()["result"]["tools"]]
    assert "COMPOSIO_DANGEROUS" in allowed_names
    assert allowed_call.json()["result"]["content"][0]["text"] == "connector allowed"


@pytest.mark.asyncio
async def test_strict_runtime_mcp_has_cross_agent_sessions_connectors_and_account_memory(
    db_session,
    seed_user,
    monkeypatch,
):
    from app.core.auth import (
        AuthContext,
        get_auth_short_session,
        is_runtime_deployment_principal,
    )
    from app.core.database import get_session
    from app.models.api_key import RUNTIME_DEPLOYMENT_KEY_SCOPES, ApiKey
    from app.models.session import Session
    from app.routes import mcp_bridge
    from app.services.composio import ComposioMcpSession
    from tests.conftest import create_env_with_project

    env_a = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id="strict-mcp-a",
        machine_name="Strict MCP A",
        agent_type="openclaw",
    )
    env_b = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id="strict-mcp-b",
        machine_name="Strict MCP B",
        agent_type="hermes",
    )
    now = datetime.now(UTC)
    session_b_file_key = f"sessions/strict-b-{uuid4().hex}.json"
    session_a = Session(
        user_id=seed_user.id,
        environment_id=env_a.id,
        local_session_id="strict-a",
        started_at=now,
        summary="Alpha hosted runtime work",
    )
    session_b = Session(
        user_id=seed_user.id,
        environment_id=env_b.id,
        local_session_id="strict-b",
        started_at=now,
        summary="Beta hosted runtime work",
        file_key=session_b_file_key,
    )
    db_session.add_all([session_a, session_b])
    await db_session.commit()

    runtime_key = ApiKey(
        user_id=seed_user.id,
        environment_id=env_a.id,
        runtime_deployment_id="strict-deployment",
        managed=True,
        scopes=[*RUNTIME_DEPLOYMENT_KEY_SCOPES, "future:runtime-capability"],
    )
    runtime_auth = AuthContext(user=seed_user, api_key=runtime_key)
    assert is_runtime_deployment_principal(runtime_auth)

    async def override_session():
        yield db_session

    async def override_auth() -> AuthContext:
        return runtime_auth

    async def fake_session(user_id: str) -> ComposioMcpSession:
        assert user_id == seed_user.clerk_id
        return ComposioMcpSession(
            url="https://composio.test/mcp",
            headers={},
            expires_at=datetime.now(UTC) + timedelta(minutes=30),
        )

    async def fake_connector_tools(user_id: str):
        await fake_session(user_id)
        return [
            {"name": "connector_calendar", "inputSchema": {"type": "object"}},
            {"name": "memory_search", "inputSchema": {"type": "object"}},
        ]

    async def fake_call(session, name, arguments):
        from mcp.types import CallToolResult

        return CallToolResult.model_validate(
            {"content": [{"type": "text", "text": "connector ok"}]}
        )

    monkeypatch.setattr(mcp_bridge, "get_tool_router_mcp_session", fake_session)
    monkeypatch.setattr(mcp_bridge, "get_tool_router_mcp_tools", fake_connector_tools)
    monkeypatch.setattr(mcp_bridge, "call_tool_router_mcp_tool", fake_call)
    await mcp_bridge.file_store.put(
        session_b_file_key,
        b'[{"role":"user","content":"Cross-agent session detail"}]',
        "application/json",
    )
    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_auth_short_session] = override_auth
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            listed = await ac.post(
                "/v1/mcp/clawdi",
                json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
            )
            searched = await ac.post(
                "/v1/mcp/clawdi",
                json={
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/call",
                    "params": {
                        "name": "session_search",
                        "arguments": {"query": "hosted runtime work"},
                    },
                },
            )
            read = await ac.post(
                "/v1/mcp/clawdi",
                json={
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {
                        "name": "session_read",
                        "arguments": {"reference": str(session_b.id)},
                    },
                },
            )
            connector = await ac.post(
                "/v1/mcp/clawdi",
                json={
                    "jsonrpc": "2.0",
                    "id": 4,
                    "method": "tools/call",
                    "params": {"name": "connector_calendar", "arguments": {}},
                },
            )
            memory = await ac.post(
                "/v1/mcp/clawdi",
                json={
                    "jsonrpc": "2.0",
                    "id": 5,
                    "method": "tools/call",
                    "params": {"name": "memory_search", "arguments": {"query": "xy"}},
                },
            )
            runtime_key.scopes = None
            identity_only_listed = await ac.post(
                "/v1/mcp/clawdi",
                json={"jsonrpc": "2.0", "id": 6, "method": "tools/list", "params": {}},
            )
            identity_only_session = await ac.post(
                "/v1/mcp/clawdi",
                json={
                    "jsonrpc": "2.0",
                    "id": 7,
                    "method": "tools/call",
                    "params": {
                        "name": "session_search",
                        "arguments": {"query": "hosted runtime work"},
                    },
                },
            )
            identity_only_connector = await ac.post(
                "/v1/mcp/clawdi",
                json={
                    "jsonrpc": "2.0",
                    "id": 8,
                    "method": "tools/call",
                    "params": {"name": "connector_calendar", "arguments": {}},
                },
            )
            identity_only_memory = await ac.post(
                "/v1/mcp/clawdi",
                json={
                    "jsonrpc": "2.0",
                    "id": 9,
                    "method": "tools/call",
                    "params": {"name": "memory_search", "arguments": {"query": "x"}},
                },
            )
    finally:
        app.dependency_overrides.pop(get_session, None)
        app.dependency_overrides.pop(get_auth_short_session, None)
        await mcp_bridge.file_store.delete(session_b_file_key)

    names = [tool["name"] for tool in listed.json()["result"]["tools"]]
    assert "connector_calendar" in names
    assert "session_search" in names
    assert "session_read" in names
    assert {"memory_search", "memory_add", "memory_extract"} <= set(names)
    search_text = searched.json()["result"]["content"][0]["text"]
    assert "Alpha hosted runtime work" in search_text
    assert "Beta hosted runtime work" in search_text
    assert "Cross-agent session detail" in read.json()["result"]["content"][0]["text"]
    assert connector.json()["result"]["content"][0]["text"] == "connector ok"
    assert memory.json()["result"]["content"][0]["text"] == "No memories found."
    identity_only_names = {tool["name"] for tool in identity_only_listed.json()["result"]["tools"]}
    assert "session_search" not in identity_only_names
    assert "connector_calendar" not in identity_only_names
    assert not {"memory_search", "memory_add", "memory_extract"} & identity_only_names
    assert (
        "missing scope: sessions:read"
        in identity_only_session.json()["result"]["content"][0]["text"]
    )
    assert (
        "missing scope: connectors:invoke"
        in identity_only_connector.json()["result"]["content"][0]["text"]
    )
    assert (
        "missing scope: memories:read"
        in identity_only_memory.json()["result"]["content"][0]["text"]
    )


@pytest.mark.asyncio
async def test_clawdi_mcp_session_read_share_url_respects_env_binding(
    db_session,
    seed_user,
    monkeypatch,
):
    """An env-bound agent key must not use a share URL to owner-bypass
    into same-user sessions from other environments. Own-env sessions and
    actively link-shared sessions stay readable."""
    from app.core.auth import AuthContext, get_auth_short_session
    from app.core.database import get_session
    from app.models.api_key import ApiKey
    from app.models.session import Session
    from app.models.session_permission import PERMISSION_KIND_LINK, SessionPermission
    from app.routes import mcp_bridge
    from tests.conftest import create_env_with_project

    env_a = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id="mcp-share-a",
        machine_name="Share Env A",
        agent_type="openclaw",
    )
    env_b = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id="mcp-share-b",
        machine_name="Share Env B",
        agent_type="hermes",
    )
    now = datetime.now(UTC)
    session_a_file_key = f"sessions/share-a-{uuid4().hex}.json"
    session_b_file_key = f"sessions/share-b-{uuid4().hex}.json"
    session_a = Session(
        user_id=seed_user.id,
        environment_id=env_a.id,
        local_session_id="share-a",
        started_at=now,
        summary="Env A session",
        file_key=session_a_file_key,
    )
    session_b = Session(
        user_id=seed_user.id,
        environment_id=env_b.id,
        local_session_id="share-b",
        started_at=now,
        summary="Env B session",
        file_key=session_b_file_key,
    )
    db_session.add_all([session_a, session_b])
    await db_session.commit()

    async def override_session():
        yield db_session

    async def override_auth() -> AuthContext:
        return AuthContext(
            user=seed_user,
            api_key=ApiKey(user_id=seed_user.id, environment_id=env_a.id, scopes=None),
        )

    for file_key in (session_a_file_key, session_b_file_key):
        await mcp_bridge.file_store.put(
            file_key,
            b'[{"role":"user","content":"hello"}]',
            "application/json",
        )
    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_auth_short_session] = override_auth

    async def read_share(ac, session_id):
        response = await ac.post(
            "/v1/mcp/clawdi",
            json={
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": {
                    "name": "session_read",
                    "arguments": {"reference": f"https://cloud.clawdi.ai/s/{session_id}"},
                },
            },
        )
        assert response.status_code == 200, response.text
        return response.json()["result"]

    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            own_env = await read_share(ac, session_a.id)
            cross_env = await read_share(ac, session_b.id)

            db_session.add(SessionPermission(session_id=session_b.id, kind=PERMISSION_KIND_LINK))
            await db_session.commit()
            linked = await read_share(ac, session_b.id)
    finally:
        app.dependency_overrides.pop(get_session, None)
        app.dependency_overrides.pop(get_auth_short_session, None)
        for file_key in (session_a_file_key, session_b_file_key):
            await mcp_bridge.file_store.delete(file_key)

    assert not own_env.get("isError"), own_env
    assert cross_env["isError"] is True, cross_env
    assert not linked.get("isError"), linked
