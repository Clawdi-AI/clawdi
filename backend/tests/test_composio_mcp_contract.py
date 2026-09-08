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


@pytest.mark.asyncio
@pytest.mark.parametrize("base_url", ["", "https://composio.test"])
async def test_session_sdk_bounds_transport_without_retries(monkeypatch, base_url):
    monkeypatch.setattr(composio, "_sdk_client", None)
    monkeypatch.setattr(composio.settings, "composio_api_key", "test-key")
    monkeypatch.setattr(composio.settings, "composio_api_base_url", base_url)
    sdk = composio.get_composio_sdk()
    try:
        assert sdk.client.timeout == 5.0
        assert sdk.client.max_retries == 0
    finally:
        sdk.client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel", [False, True])
async def test_late_session_creation_never_publishes_after_timeout_or_cancellation(
    monkeypatch, cancel
):
    import asyncio
    import threading

    started = asyncio.Event()
    finished = asyncio.Event()
    release = threading.Event()
    loop = asyncio.get_running_loop()
    attempts = 0

    def create(**kwargs):
        nonlocal attempts
        attempts += 1
        loop.call_soon_threadsafe(started.set)
        try:
            assert release.wait(2)
            return SimpleNamespace(
                mcp=SimpleNamespace(
                    type="http", url="https://composio.test/mcp", headers={"x-api-key": "test"}
                )
            )
        finally:
            loop.call_soon_threadsafe(finished.set)

    monkeypatch.setattr(composio, "_TOOL_ROUTER_SESSION_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(composio, "_tool_router_session_cache", {})
    monkeypatch.setattr(composio, "_tool_router_session_creations", {})
    monkeypatch.setattr(
        composio,
        "get_composio_sdk",
        lambda: SimpleNamespace(sessions=SimpleNamespace(create=create)),
    )
    task = asyncio.create_task(composio.get_tool_router_mcp_session("cold-user"))
    try:
        await asyncio.wait_for(started.wait(), 1)
        if cancel:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            with pytest.raises(composio.ComposioProviderError) as error:
                await asyncio.wait_for(task, 1)
            assert error.value.failure.kind == "timeout"
        assert not composio._tool_router_session_cache
        assert not composio._tool_router_session_creations
    finally:
        release.set()
        await asyncio.wait_for(finished.wait(), 1)
        await asyncio.gather(task, return_exceptions=True)
    assert attempts == 1
    assert not composio._tool_router_session_cache
    assert not composio._tool_router_session_creations
