"""Native account management through MCP HTTP and the pinned Composio HTTP client."""

import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from composio_client import AsyncComposio
from mcp.types import ListToolsResult

from app.services import composio
from tests.test_mcp_capability_parity import _tool_call, _tool_json


@pytest.fixture
async def account_provider(monkeypatch, seed_user):
    account = {
        "id": "account-exact",
        "toolkit": {"slug": "gmail"},
        "status": "EXPIRED",
        "created_at": "2026-09-03T00:00:00Z",
        "alias": "old",
        "is_disabled": True,
        "data": {"email": "work@example.test", "access_token": "private-token"},
        "state": {},
    }
    requests = []
    responses = {}

    def handle(request):
        requests.append(request)
        if request.url.path.endswith("/connected_accounts"):
            assert request.method == "GET"
            assert request.url.params["user_ids"] == seed_user.clerk_id
            if "connected_account_ids" not in request.url.params:
                assert request.url.params["limit"] == "100"
                return httpx.Response(200, json={"items": [account]})
            assert request.url.params["limit"] == "1"
            assert "statuses" not in request.url.params
            owned = request.url.params["connected_account_ids"] == account["id"]
            return httpx.Response(200, json={"items": [account] if owned else []})
        assert request.url.path.endswith("/connected_accounts/account-exact")
        if request.method in responses:
            return responses[request.method]
        if request.method == "PATCH":
            body = json.loads(request.content)
            assert set(body) == {"alias"}
            account["alias"] = body["alias"] or None
            return httpx.Response(
                200, json={"id": account["id"], "status": account["status"], "success": True}
            )
        if request.method == "DELETE":
            return httpx.Response(200, json={"success": True})
        assert request.method == "GET"
        return httpx.Response(200, json=account)

    cached = composio.ComposioMcpSession(
        url="https://example.test/mcp",
        headers={},
        expires_at=datetime.now(UTC) + timedelta(minutes=30),
    )
    monkeypatch.setattr(composio, "_tool_router_session_cache", {seed_user.clerk_id: cached})
    monkeypatch.setattr(
        composio,
        "_tool_router_tools_cache",
        {seed_user.clerk_id: (cached, ListToolsResult(tools=[]))},
    )
    async with AsyncComposio(
        api_key="test", http_client=httpx.AsyncClient(transport=httpx.MockTransport(handle))
    ) as sdk:
        monkeypatch.setattr(composio, "get_composio_client", lambda: sdk)
        yield account, requests, responses


@pytest.mark.parametrize("arguments", [{}, {"include_inactive": False}, {"include_inactive": True}])
async def test_mcp_account_list_management_opt_in(client, account_provider, arguments):
    account, requests, _ = account_provider
    result = await _tool_call(client, 1, "connector_account_list", arguments)
    expected = (
        [
            {
                "id": account["id"],
                "app_name": "gmail",
                "status": "EXPIRED",
                "is_disabled": True,
                "alias": "old",
                "account_display": "work@example.test",
            }
        ]
        if arguments.get("include_inactive")
        else []
    )
    assert _tool_json(result) == {"accounts": expected}
    assert len(requests) == 1
    assert requests[0].url.params.get("statuses") == (
        None if arguments.get("include_inactive") else "ACTIVE"
    )
    assert "private-token" not in json.dumps(result)


@pytest.mark.parametrize("alias", ["工作邮箱", ""])
async def test_mcp_account_alias_update_and_clear(client, account_provider, seed_user, alias):
    account, requests, _ = account_provider
    result = await _tool_call(
        client, 1, "connector_account_update", {"connection_id": account["id"], "alias": alias}
    )
    assert not result.get("isError")
    assert _tool_json(result) == {
        "id": account["id"],
        "app_name": "gmail",
        "status": "EXPIRED",
        "created_at": account["created_at"],
        "is_disabled": True,
        "alias": alias or None,
        "account_display": "work@example.test",
    }
    assert [r.method for r in requests] == ["GET", "PATCH", "GET"]
    assert "private-token" not in json.dumps(result)
    assert seed_user.clerk_id not in composio._tool_router_session_cache
    assert seed_user.clerk_id not in composio._tool_router_tools_cache


async def test_mcp_account_delete_expired_account(client, account_provider, seed_user):
    account, requests, _ = account_provider
    result = await _tool_call(
        client, 1, "connector_account_delete", {"connection_id": account["id"]}
    )
    assert not result.get("isError")
    assert _tool_json(result) == {"status": "disconnected"}
    assert [r.method for r in requests] == ["GET", "DELETE"]
    assert seed_user.clerk_id not in composio._tool_router_session_cache
    assert seed_user.clerk_id not in composio._tool_router_tools_cache


@pytest.mark.parametrize("name", ["connector_account_update", "connector_account_delete"])
async def test_mcp_account_mutations_refuse_nonowned_id(client, account_provider, seed_user, name):
    _, requests, _ = account_provider
    arguments = {"connection_id": "another-users-account"}
    if name == "connector_account_update":
        arguments["alias"] = "should not change"
    result = await _tool_call(client, 1, name, arguments)
    assert result["isError"] is True
    assert result["content"][0]["text"] == "Error: Connector not found"
    assert [r.method for r in requests] == ["GET"]
    assert seed_user.clerk_id in composio._tool_router_session_cache


async def test_mcp_account_tools_reject_invalid_arguments_before_provider(client, account_provider):
    _, requests, _ = account_provider
    invalid = [
        ("connector_account_list", {"include_inactive": "true"}),
        ("connector_account_list", {"include_inactive": 1}),
        ("connector_account_list", {"unexpected": True}),
        ("connector_account_update", {"connection_id": "account-exact"}),
        (
            "connector_account_update",
            {
                "connection_id": "account-exact",
                "alias": "ok",
                "credentials": {"token": "private-token"},
            },
        ),
        ("connector_account_delete", {"connection_id": " \t"}),
    ]
    for request_id, (name, arguments) in enumerate(invalid, start=1):
        result = await _tool_call(client, request_id, name, arguments)
        assert result["isError"] is True
        assert result["content"][0]["text"] == "Error: Invalid tool arguments"
    assert requests == []


@pytest.mark.parametrize(
    "name,method,status_code,body,error",
    [
        (
            "connector_account_update",
            "PATCH",
            409,
            {"message": "private-token"},
            "Connection conflict. Check the alias or retry shortly.",
        ),
        (
            "connector_account_delete",
            "DELETE",
            500,
            {"message": "private-token"},
            "Composio request failed",
        ),
        ("connector_account_delete", "DELETE", 200, {"success": False}, "Failed to disconnect"),
    ],
)
async def test_mcp_account_provider_failures_are_safe_and_not_retried(
    client, account_provider, seed_user, name, method, status_code, body, error
):
    account, requests, responses = account_provider
    responses[method] = httpx.Response(status_code, json=body)
    arguments = {"connection_id": account["id"]}
    if method == "PATCH":
        arguments["alias"] = "new"
    result = await _tool_call(client, 1, name, arguments)
    assert result["isError"] is True
    assert result["content"][0]["text"] == f"Error: {error}"
    assert "private-token" not in json.dumps(result)
    assert [r.method for r in requests] == ["GET", method]
    if method == "DELETE":
        assert seed_user.clerk_id not in composio._tool_router_session_cache
        assert seed_user.clerk_id not in composio._tool_router_tools_cache
