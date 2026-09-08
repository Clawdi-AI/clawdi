"""Pinned SDK error and paginated catalog failure contracts."""

from contextlib import asynccontextmanager
from datetime import UTC, datetime
from types import SimpleNamespace

import composio_client
import httpx
import pytest
from composio.client import HttpClient
from composio.core.models.tool_router import ToolRouter
from composio.core.provider._openai import OpenAIProvider
from composio.exceptions import ComposioSDKTimeoutError
from mcp.types import ListToolsResult

from app.services import composio


@pytest.mark.asyncio
@pytest.mark.parametrize("status,kind", [(401, "authentication"), (429, "status"), (503, "status")])
async def test_session_maps_real_generated_sdk_errors(monkeypatch, status, kind):
    def handle(request):
        assert request.url.path.endswith("/tool_router/session")
        return httpx.Response(status, json={"message": "provider-private-detail"})

    with HttpClient(
        provider="openai",
        api_key="test",
        max_retries=0,
        http_client=httpx.Client(transport=httpx.MockTransport(handle)),
    ) as client:
        monkeypatch.setattr(
            composio,
            "get_composio_sdk",
            lambda: SimpleNamespace(sessions=ToolRouter(client, provider=OpenAIProvider())),
        )
        with pytest.raises(composio.ComposioProviderError) as error:
            await composio._create_tool_router_mcp_session("test-user")
    assert error.value.failure.kind == kind
    assert "provider-private-detail" not in str(error.value)


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["create", "close"])
@pytest.mark.parametrize("family", ["generated", "high-level"])
async def test_high_level_sdk_boundaries_map_both_timeout_families(monkeypatch, operation, family):
    def fail(**kwargs):
        del kwargs
        if family == "generated":
            raise composio_client.APITimeoutError(
                request=httpx.Request("POST", "https://test.invalid")
            )
        raise ComposioSDKTimeoutError("private timeout detail")

    sdk = SimpleNamespace(sessions=SimpleNamespace(create=fail), client=SimpleNamespace(close=fail))
    monkeypatch.setattr(composio, "get_composio_sdk", lambda: sdk)
    monkeypatch.setattr(composio, "_sdk_client", sdk)
    monkeypatch.setattr(composio, "_client", None)
    with pytest.raises(composio.ComposioProviderError) as error:
        if operation == "create":
            await composio._create_tool_router_mcp_session("test-user")
        else:
            await composio.close_composio_client()
    assert error.value.failure.kind == "timeout"
    assert "private" not in str(error.value)


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["empty", "repeated", "endless"])
async def test_mcp_listing_rejects_broken_pagination_without_partial_catalog(monkeypatch, mode):
    calls = []
    closed = False

    class Pages:
        async def list_tools(self, *, cursor=None):
            calls.append(cursor)
            next_cursor = (
                "" if mode == "empty" else "same" if mode == "repeated" else str(len(calls))
            )
            return ListToolsResult.model_validate({"tools": [], "nextCursor": next_cursor})

    @asynccontextmanager
    async def client(_session):
        nonlocal closed
        try:
            yield Pages()
        finally:
            closed = True

    monkeypatch.setattr(composio, "_tool_router_mcp_client", client)
    session = composio.ComposioMcpSession(
        url="https://test.invalid", headers={}, expires_at=datetime.now(UTC)
    )
    with pytest.raises(composio.ComposioMcpUpstreamError, match="pagination"):
        await composio.list_tool_router_mcp_tools(session)
    assert len(calls) == {"empty": 1, "repeated": 2, "endless": 100}[mode]
    assert closed
