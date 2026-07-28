"""Settings secret-masking and the Clawdi MCP contract.

These cover two small-but-sharp security edges: secrets stored via PATCH
/api/settings must come back masked on GET, and the authenticated Clawdi MCP
endpoint must remain the only public MCP surface.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import pytest
from httpx import ASGITransport

from app.core.config import settings
from app.main import app


@pytest.mark.asyncio
async def test_settings_patch_masks_sensitive_keys_on_read(client: httpx.AsyncClient, monkeypatch):
    # Settings save now refuses `memory_provider=mem0` when the
    # `[mem0]` extra isn't installed (the prod-default since the
    # package was never declared). Stub `mem0_available()` so this
    # masking test can still exercise the secret-handling path.
    import app.services.memory_provider as mp

    monkeypatch.setattr(mp, "_mem0_available_cached", None)
    monkeypatch.setattr(mp, "mem0_available", lambda: True)
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


def test_clawdi_is_the_only_public_mcp_contract():
    route_methods = {
        (route.path, method)
        for route in app.routes
        for method in (getattr(route, "methods", None) or set())
    }

    for prefix in ("/v1", "/api"):
        assert (f"{prefix}/connectors/mcp-config", "GET") not in route_methods
        assert (f"{prefix}/mcp/composio", "POST") not in route_methods
        assert (f"{prefix}/mcp/clawdi", "POST") in route_methods


@pytest.mark.asyncio
async def test_clawdi_mcp_initializes_and_lists_native_tools(monkeypatch):
    from app.core.auth import AuthContext, get_auth
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

    async def no_connector_session(user_id: str):
        raise RuntimeError("connectors disabled for test")

    monkeypatch.setattr(mcp_bridge, "get_tool_router_mcp_session", no_connector_session)
    app.dependency_overrides[get_auth] = fake_auth
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
async def test_clawdi_mcp_preserves_future_composio_tool_contract(monkeypatch):
    from app.core.auth import AuthContext, get_auth
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
        "_meta": {"future": {"preserved": True}},
    }
    forwarded: list[dict] = []

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

    async def fake_forward(session: ComposioMcpSession, payload: dict):
        forwarded.append(payload)
        if payload["method"] == "tools/list":
            return {
                "jsonrpc": "2.0",
                "id": payload["id"],
                "result": {"tools": [expected_tool]},
            }
        return {"jsonrpc": "2.0", "id": payload["id"], "result": expected_result}

    monkeypatch.setattr(mcp_bridge, "get_tool_router_mcp_session", fake_composio_session)
    monkeypatch.setattr(mcp_bridge, "_forward_composio_mcp_request", fake_forward)
    monkeypatch.setattr(mcp_bridge, "_connector_tools_cache", {})
    app.dependency_overrides[get_auth] = fake_auth
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
        app.dependency_overrides.pop(get_auth, None)

    listed_tools = listed.json()["result"]["tools"]
    listed_composio_tool = next(
        tool for tool in listed_tools if tool["name"] == expected_tool["name"]
    )
    assert listed_composio_tool == expected_tool
    assert called.json() == {"jsonrpc": "2.0", "id": 11, "result": expected_result}
    assert forwarded[1] == {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": "COMPOSIO_FUTURE_META_TOOL", "arguments": expected_arguments},
    }


@pytest.mark.asyncio
async def test_clawdi_mcp_memory_search_respects_env_bound_api_key(
    db_session,
    seed_user,
    monkeypatch,
):
    from app.core.auth import AuthContext, get_auth
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

    async def no_connector_session(user_id: str):
        raise RuntimeError("connectors disabled for test")

    monkeypatch.setattr(mcp_bridge, "get_tool_router_mcp_session", no_connector_session)
    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_auth] = override_auth
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
    assert "Hermes beta runtime" not in text


@pytest.mark.asyncio
async def test_clawdi_mcp_session_search_escapes_like_wildcards(
    db_session,
    seed_user,
):
    from app.core.auth import AuthContext, get_auth
    from app.core.database import get_session
    from app.models.api_key import ApiKey
    from app.models.session import Session
    from tests.conftest import create_env_with_project

    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id="mcp-search-wildcards",
        machine_name="MCP Search Wildcards",
        agent_type="openclaw",
    )
    now = datetime.now(UTC)
    db_session.add_all(
        [
            Session(
                user_id=seed_user.id,
                environment_id=env.id,
                local_session_id="mcp-percent",
                project_path="/repo/percent",
                started_at=now,
                summary="Literal 100% rollout note",
            ),
            Session(
                user_id=seed_user.id,
                environment_id=env.id,
                local_session_id="mcp-plain",
                project_path="/repo/plain",
                started_at=now,
                summary="Plain runtime work",
            ),
        ]
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
    app.dependency_overrides[get_auth] = override_auth
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/v1/mcp/clawdi",
                json={
                    "jsonrpc": "2.0",
                    "id": 4,
                    "method": "tools/call",
                    "params": {
                        "name": "session_search",
                        "arguments": {"query": "%", "limit": 10},
                    },
                },
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    text = response.json()["result"]["content"][0]["text"]
    assert "Literal 100% rollout note" in text
    assert "Plain runtime work" not in text


@pytest.mark.asyncio
async def test_mcp_composio_bridge_sends_api_key_accept_and_parses_sse(monkeypatch):
    from app.routes import mcp_bridge
    from app.services.composio import ComposioMcpSession

    seen: dict = {}

    class FakeResponse:
        status_code = 200
        is_success = True
        headers = {"content-type": "text/event-stream"}
        text = (
            "event: message\n"
            'data: {"jsonrpc":"2.0","id":9,"result":{"tools":[{"name":"COMPOSIO_SEARCH_TOOLS",'
            '"inputSchema":{"type":"object","properties":{"query":{"type":"string"}}}}]}}\n\n'
            "event: done\n"
            "data: [DONE]\n\n"
        )

    class FakeAsyncClient:
        def __init__(self, *, timeout: float):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url: str, *, json: dict, headers: dict):
            seen["url"] = url
            seen["json"] = json
            seen["headers"] = headers
            return FakeResponse()

    monkeypatch.setattr(settings, "composio_api_key", "composio_test_key")
    monkeypatch.setattr(mcp_bridge.httpx, "AsyncClient", FakeAsyncClient)

    session = ComposioMcpSession(
        url="https://backend.composio.dev/tool_router/trs_test/mcp",
        headers={},
        expires_at=datetime.now(UTC) + timedelta(minutes=30),
    )
    result = await mcp_bridge._forward_composio_mcp_request(
        session,
        {"jsonrpc": "2.0", "id": 9, "method": "tools/list", "params": {}},
    )

    assert seen["headers"]["Accept"] == "application/json, text/event-stream"
    assert seen["headers"]["x-api-key"] == "composio_test_key"
    assert result["result"]["tools"][0]["name"] == "COMPOSIO_SEARCH_TOOLS"
    assert result["result"]["tools"][0]["inputSchema"]["properties"]["query"]["type"] == "string"


@pytest.mark.asyncio
async def test_create_tool_router_mcp_session_uses_composio_v31_api(monkeypatch):
    from app.services import composio

    requests: list[dict] = []

    class FakeResponse:
        status_code = 201
        is_success = True

        def raise_for_status(self):
            return None

        def json(self):
            return {
                "session_id": "trs_test",
                "mcp": {
                    "type": "http",
                    "url": "https://app.composio.dev/tool_router/v3/trs_test/mcp",
                    "headers": {"x-session": "trs_test"},
                },
            }

    class FakeAsyncClient:
        def __init__(self, *, timeout: float):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url: str, *, headers: dict, json: dict):
            requests.append({"url": url, "headers": headers, "json": json})
            return FakeResponse()

    monkeypatch.setattr(settings, "composio_api_key", "composio_test_key")
    monkeypatch.setattr(settings, "composio_api_base_url", "https://backend.composio.dev/")
    monkeypatch.setattr(composio.httpx, "AsyncClient", FakeAsyncClient)

    now = datetime(2026, 5, 24, tzinfo=UTC)
    session = await composio._create_tool_router_mcp_session("clerk_user_123", now=now)

    assert requests == [
        {
            "url": "https://backend.composio.dev/api/v3.1/tool_router/session",
            "headers": {"x-api-key": "composio_test_key"},
            "json": {"user_id": "clerk_user_123"},
        }
    ]
    assert session.url == "https://app.composio.dev/tool_router/v3/trs_test/mcp"
    assert session.headers == {"x-session": "trs_test"}
    assert session.expires_at == now + timedelta(minutes=30)


@pytest.mark.asyncio
async def test_clawdi_mcp_connector_tools_denied_for_scoped_api_key(
    db_session,
    seed_user,
    monkeypatch,
):
    """Scoped api keys are deliberate capability narrowing; the old
    connector config route rejected them via `require_user_auth`, and the
    MCP entrypoint must not reopen that surface: connector tools are
    neither listed nor callable."""
    from datetime import timedelta

    from app.core.auth import AuthContext, get_auth
    from app.core.database import get_session
    from app.models.api_key import ApiKey
    from app.routes import mcp_bridge
    from app.services.composio import ComposioMcpSession

    async def override_session():
        yield db_session

    async def override_auth() -> AuthContext:
        return AuthContext(
            user=seed_user,
            api_key=ApiKey(user_id=seed_user.id, scopes=["sessions:read"]),
        )

    async def fake_session(user_id: str) -> ComposioMcpSession:
        return ComposioMcpSession(
            url="https://composio.test/mcp",
            headers={},
            expires_at=datetime.now(UTC) + timedelta(minutes=30),
        )

    async def fake_forward(session, payload):
        return {
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "tools": [{"name": "COMPOSIO_DANGEROUS", "inputSchema": {"type": "object"}}]
            },
        }

    monkeypatch.setattr(mcp_bridge, "get_tool_router_mcp_session", fake_session)
    monkeypatch.setattr(mcp_bridge, "_forward_composio_mcp_request", fake_forward)
    monkeypatch.setattr(mcp_bridge, "_connector_tools_cache", {})
    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_auth] = override_auth
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
    finally:
        app.dependency_overrides.pop(get_session, None)
        app.dependency_overrides.pop(get_auth, None)

    assert listed.status_code == 200, listed.text
    tool_names = [tool["name"] for tool in listed.json()["result"]["tools"]]
    assert "COMPOSIO_DANGEROUS" not in tool_names
    assert "memory_search" in tool_names

    assert called.status_code == 200, called.text
    result = called.json()["result"]
    assert result["isError"] is True
    assert "scoped api keys" in result["content"][0]["text"]


@pytest.mark.asyncio
async def test_strict_runtime_mcp_has_cross_agent_sessions_connectors_without_memory(
    db_session,
    seed_user,
    monkeypatch,
):
    from app.core.auth import AuthContext, get_auth, is_runtime_deployment_principal
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
        file_key="sessions/strict-b.json",
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

    async def fake_forward(session, payload):
        if payload["method"] == "tools/list":
            return {
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "tools": [
                        {"name": "connector_calendar", "inputSchema": {"type": "object"}},
                        {"name": "memory_search", "inputSchema": {"type": "object"}},
                    ],
                },
            }
        return {
            "jsonrpc": "2.0",
            "id": 1,
            "result": {"content": [{"type": "text", "text": "connector ok"}]},
        }

    async def fake_messages(session, store):
        return [{"role": "user", "content": "Cross-agent session detail"}]

    monkeypatch.setattr(mcp_bridge, "get_tool_router_mcp_session", fake_session)
    monkeypatch.setattr(mcp_bridge, "_forward_composio_mcp_request", fake_forward)
    monkeypatch.setattr(mcp_bridge, "_connector_tools_cache", {})
    monkeypatch.setattr(mcp_bridge, "load_session_messages", fake_messages)
    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_auth] = override_auth
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
                    "params": {"name": "memory_search", "arguments": {"query": "x"}},
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
        app.dependency_overrides.pop(get_auth, None)

    names = [tool["name"] for tool in listed.json()["result"]["tools"]]
    assert "connector_calendar" in names
    assert "session_search" in names
    assert "session_read" in names
    assert not {"memory_search", "memory_add", "memory_extract"} & set(names)
    search_text = searched.json()["result"]["content"][0]["text"]
    assert "Alpha hosted runtime work" in search_text
    assert "Beta hosted runtime work" in search_text
    assert "Cross-agent session detail" in read.json()["result"]["content"][0]["text"]
    assert connector.json()["result"]["content"][0]["text"] == "connector ok"
    assert memory.json()["result"]["isError"] is True
    assert "not available" in memory.json()["result"]["content"][0]["text"]
    identity_only_names = {tool["name"] for tool in identity_only_listed.json()["result"]["tools"]}
    assert "session_search" in identity_only_names
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
    assert "not available" in identity_only_memory.json()["result"]["content"][0]["text"]


@pytest.mark.asyncio
async def test_clawdi_mcp_session_read_share_url_respects_env_binding(
    db_session,
    seed_user,
    monkeypatch,
):
    """An env-bound agent key must not use a share URL to owner-bypass
    into same-user sessions from other environments. Own-env sessions and
    actively link-shared sessions stay readable."""
    from app.core.auth import AuthContext, get_auth
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
    session_a = Session(
        user_id=seed_user.id,
        environment_id=env_a.id,
        local_session_id="share-a",
        started_at=now,
        summary="Env A session",
        file_key="sessions/share-a.json",
    )
    session_b = Session(
        user_id=seed_user.id,
        environment_id=env_b.id,
        local_session_id="share-b",
        started_at=now,
        summary="Env B session",
        file_key="sessions/share-b.json",
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

    async def fake_messages(session, store):
        return [{"role": "user", "content": "hello"}]

    monkeypatch.setattr(mcp_bridge, "load_session_messages", fake_messages)
    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_auth] = override_auth

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
        app.dependency_overrides.pop(get_auth, None)

    assert not own_env.get("isError"), own_env
    assert cross_env["isError"] is True, cross_env
    assert not linked.get("isError"), linked
