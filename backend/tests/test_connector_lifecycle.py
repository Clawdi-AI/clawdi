"""Account lifecycle contracts exercised through the locked generated HTTP client."""

import json
from contextlib import asynccontextmanager

import httpx
import pytest
from composio_client import AsyncComposio

from app.core.auth import AuthContext
from app.core.config import settings
from app.models.user import User
from app.routes import connectors
from app.services import composio


def account(status="EXPIRED", scheme="OAUTH2", disabled=False):
    return {
        "id": "ca_owned",
        "alias": "Work",
        "created_at": "2026-09-08T00:00:00Z",
        "status": status,
        "is_disabled": disabled,
        "toolkit": {"slug": "example"},
        "auth_config": {"id": "ac_original"},
        "state": {"authScheme": scheme, "val": {"status": status}},
        "data": {"email": "work@example.test", "api_key": "private-old-key"},
    }


@asynccontextmanager
async def client(monkeypatch, handler):
    async with AsyncComposio(
        api_key="test", http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler))
    ) as sdk:
        monkeypatch.setattr(composio, "get_composio_client", lambda: sdk)
        monkeypatch.setattr(settings, "composio_api_key", "test")
        yield AuthContext(user=User(clerk_id="owner"))


@pytest.mark.parametrize(
    "status,url", [("INITIATED", "https://connect.composio.dev/reauth"), ("ACTIVE", None)]
)
async def test_reconnect_targets_original_account(monkeypatch, status, url):
    requests = []
    original = account()
    monkeypatch.setattr(settings, "web_origin", "https://dashboard.example.test")

    def handle(request):
        requests.append(request)
        if request.method == "GET":
            assert request.url.params["user_ids"] == "owner"
            assert request.url.params["connected_account_ids"] == original["id"]
            assert "statuses" not in request.url.params
            return httpx.Response(200, json={"items": [original]})
        assert request.url.path == "/api/v3.1/connected_accounts/ca_owned/refresh"
        assert json.loads(request.content) == {
            "redirect_url": "https://dashboard.example.test/connectors"
        }
        return httpx.Response(
            200, json={"id": original["id"], "status": status, "redirect_url": url}
        )

    async with client(monkeypatch, handle) as auth:
        result = await connectors.reconnect_connection(
            "ca_owned",
            connectors.ConnectorReconnectRequest(
                redirect_url="https://dashboard.example.test/connectors"
            ),
            auth,
        )
    assert result.model_dump() == {"id": "ca_owned", "status": status, "connect_url": url}
    assert [r.method for r in requests] == ["GET", "POST"]
    assert original["alias"] == "Work" and original["auth_config"] == {"id": "ac_original"}


@pytest.mark.parametrize(
    "owned,scheme,upstream_status,url,expected",
    [
        (False, "OAUTH2", 200, None, 404),
        (True, "API_KEY", 200, None, 400),
        (True, "BEARER_TOKEN", 200, None, 400),
        (True, "CIMD_OAUTH", 200, None, 400),
        (True, "OAUTH2", 500, None, 502),
        (True, "OAUTH2", 200, None, 502),
    ],
)
async def test_reconnect_failures_never_create_delete_or_retry(
    monkeypatch, owned, scheme, upstream_status, url, expected
):
    methods = []

    def handle(request):
        methods.append(request.method)
        if request.method == "GET":
            return httpx.Response(200, json={"items": [account(scheme=scheme)] if owned else []})
        return httpx.Response(
            upstream_status,
            json={
                "id": "ca_owned",
                "status": "EXPIRED",
                "redirect_url": url,
                "error": {"message": "private-provider-detail"},
            },
        )

    async with client(monkeypatch, handle) as auth:
        with pytest.raises(connectors.HTTPException) as exc:
            await connectors.reconnect_connection("ca_owned", None, auth)
    assert exc.value.status_code == expected
    assert "private-provider-detail" not in exc.value.detail
    assert methods == (["GET", "POST"] if owned and scheme == "OAUTH2" else ["GET"])


async def test_inactive_account_is_enabled_without_oauth(monkeypatch):
    original = account("INACTIVE", disabled=True)
    calls = []

    def handle(request):
        calls.append((request.method, request.url.path))
        if request.url.path.endswith("/connected_accounts"):
            return httpx.Response(200, json={"items": [original]})
        if request.method == "PATCH":
            assert request.url.path.endswith("/ca_owned/status")
            assert json.loads(request.content) == {"enabled": True}
            original.update(status="ACTIVE", is_disabled=False)
            return httpx.Response(200, json={"success": True})
        return httpx.Response(200, json=original)

    async with client(monkeypatch, handle) as auth:
        result = await connectors.reconnect_connection("ca_owned", None, auth)
    assert result.status == "ACTIVE" and result.connect_url is None
    assert [method for method, _ in calls] == ["GET", "PATCH", "GET"]


@pytest.mark.parametrize("status", ["ACTIVE", "EXPIRED", "FAILED"])
async def test_credentials_patch_preserves_identity_and_reports_actual_status(monkeypatch, status):
    original = account(status, "API_KEY")
    calls = []

    def handle(request):
        calls.append(request)
        if request.url.path.endswith("/connected_accounts"):
            return httpx.Response(200, json={"items": [original]})
        if request.method == "PATCH":
            assert json.loads(request.content) == {
                "connection": {
                    "state": {"authScheme": "API_KEY", "val": {"api_key": "replacement"}}
                }
            }
            return httpx.Response(200, json={"id": "ca_owned", "status": status, "success": True})
        return httpx.Response(200, json=original)

    async with client(monkeypatch, handle) as auth:
        result = await connectors.update_connection_credentials(
            "ca_owned",
            connectors.ConnectorCredentialsUpdateRequest(credentials={"api_key": "replacement"}),
            auth,
        )
    assert result.id == "ca_owned" and result.alias == "Work" and result.status == status
    assert "private-old-key" not in result.model_dump_json()
    assert [r.method for r in calls] == ["GET", "PATCH", "GET"]


async def test_reconnect_fields_use_saved_config_not_toolkit_default(monkeypatch):
    def handle(request):
        if request.url.path.endswith("/connected_accounts"):
            return httpx.Response(200, json={"items": [account(scheme="BEARER_TOKEN")]})
        assert request.url.path == "/api/v3.1/auth_configs/ac_original"
        return httpx.Response(
            200,
            json={
                "auth_scheme": "BEARER_TOKEN",
                "expected_input_fields": [{"name": "token", "required": True}],
            },
        )

    async with client(monkeypatch, handle) as auth:
        fields = await connectors.account_reconnect_fields("ca_owned", auth)
    assert fields.auth_scheme == "BEARER_TOKEN"
    assert fields.expected_input_fields[0].name == "token"


async def test_management_lists_nonactive_but_identity_availability_does_not(monkeypatch):
    accounts = [account(status) for status in ["ACTIVE", "EXPIRED", "FAILED", "INACTIVE"]]
    accounts.append(account("ACTIVE", disabled=True))

    def handle(request):
        assert request.url.params["user_ids"] == "owner"
        return httpx.Response(200, json={"items": accounts})

    async with client(monkeypatch, handle):
        all_accounts = await composio.get_all_connected_accounts("owner")
        available = await composio.get_connected_account_identities("owner")
        counts = await composio.get_connected_accounts("owner")
    assert len(all_accounts) == 5
    assert len(available) == len(counts) == 1
    assert "private-old-key" not in str(all_accounts)


@pytest.mark.parametrize("status", ["EXPIRED", "FAILED", "INACTIVE"])
async def test_delete_owned_nonactive_account(monkeypatch, status):
    methods = []

    def handle(request):
        methods.append(request.method)
        if request.method == "GET":
            assert "statuses" not in request.url.params
            return httpx.Response(200, json={"items": [account(status)]})
        assert request.method == "DELETE"
        return httpx.Response(200, json={"success": True})

    async with client(monkeypatch, handle) as auth:
        await connectors.disconnect("ca_owned", auth)
    assert methods == ["GET", "DELETE"]


@pytest.mark.parametrize("cycle", [False, True])
async def test_tools_read_beyond_500_and_reject_cursor_cycles(monkeypatch, cycle):
    calls = []

    def handle(request):
        cursor = int(request.url.params.get("cursor", "0"))
        calls.append(cursor)
        items = [
            {
                "slug": f"TOOL_{cursor}_{i}",
                "name": "Tool",
                "description": "",
                "is_deprecated": False,
            }
            for i in range(100)
        ]
        next_cursor = "1" if cycle else (str(cursor + 1) if cursor < 5 else None)
        return httpx.Response(200, json={"items": items, "next_cursor": next_cursor})

    async with client(monkeypatch, handle):
        if cycle:
            with pytest.raises(composio.ComposioProtocolError):
                await composio.get_app_tools("example")
        else:
            assert len(await composio.get_app_tools("example")) == 600
    assert len(calls) == (2 if cycle else 6)


@pytest.mark.parametrize("scheme", ["CIMD_OAUTH", "FUTURE_AUTH"])
async def test_unsupported_auth_rejected_before_any_mutation(monkeypatch, scheme):
    methods = []

    def handle(request):
        methods.append(request.method)
        assert request.url.path == "/api/v3.1/toolkits/example"
        return httpx.Response(
            200,
            json={
                "slug": "example",
                "name": "Example",
                "meta": {"logo": "", "description": ""},
                "auth_schemes": [scheme],
            },
        )

    async with client(monkeypatch, handle):
        with pytest.raises(composio.ComposioInvalidRequestError):
            await composio.connect_with_credentials("owner", "example", {"token": "secret"})
    assert methods == ["GET"]


@pytest.mark.parametrize(
    "owned,fields,upstream_status,expected",
    [
        (False, {"api_key": "replacement"}, 200, 404),
        (True, {"unrecognized": "replacement"}, 200, 400),
        (True, {"api_key": "replacement"}, 500, 502),
    ],
)
async def test_credential_failures_leave_original_account_untouched(
    monkeypatch, owned, fields, upstream_status, expected
):
    calls = []

    def handle(request):
        calls.append(request.method)
        if request.method == "GET":
            return httpx.Response(200, json={"items": [account(scheme="API_KEY")] if owned else []})
        assert json.loads(request.content) == {
            "connection": {"state": {"authScheme": "API_KEY", "val": fields}}
        }
        return httpx.Response(
            upstream_status, json={"error": {"message": "private-provider-detail"}}
        )

    async with client(monkeypatch, handle) as auth:
        with pytest.raises(connectors.HTTPException) as exc:
            await connectors.update_connection_credentials(
                "ca_owned", connectors.ConnectorCredentialsUpdateRequest(credentials=fields), auth
            )
    assert exc.value.status_code == expected
    assert "private-provider-detail" not in exc.value.detail
    assert calls == (["GET", "PATCH"] if owned and "api_key" in fields else ["GET"])


async def test_auth_config_lookup_uses_50_item_pages(monkeypatch):
    cursors = []

    def handle(request):
        assert request.url.path == "/api/v3.1/auth_configs"
        assert request.url.params["limit"] == "50"
        assert request.url.params["toolkit_slug"] == "example"
        cursor = request.url.params.get("cursor")
        cursors.append(cursor)
        config = {
            "id": "ac_existing",
            "auth_scheme": "OAUTH2",
            "is_composio_managed": False,
            "status": "ENABLED",
        }
        return httpx.Response(
            200,
            json={"items": [config] if cursor else [], "next_cursor": None if cursor else "next"},
        )

    async with client(monkeypatch, handle):
        result = await composio._find_auth_config(
            composio.get_composio_client(), "example", "OAUTH2", managed=False
        )
    assert result.id == "ac_existing"
    assert cursors == [None, "next"]


@pytest.mark.parametrize("prefix", ["/v1", "/api"])
async def test_reconnect_route_validates_callback_and_rejects_alias_changes(monkeypatch, prefix):
    from app.core.auth import require_user_auth_short_session
    from app.main import app

    monkeypatch.setattr(settings, "web_origin", "https://dashboard.example.test")
    app.dependency_overrides[require_user_auth_short_session] = lambda: AuthContext(
        user=User(clerk_id="owner")
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as web:
        for body in [{"redirect_url": "https://attacker.test"}, {"alias": "changed"}]:
            response = await web.post(f"{prefix}/connectors/ca_owned/reconnect", json=body)
            assert response.status_code == 422


def test_existing_create_boundaries_remain_compatible():
    assert connectors.ConnectRequest.model_validate({"future": True}).alias is None
    request = connectors.ConnectorCredentialsConnectRequest.model_validate(
        {"credentials": {"api_key": " "}, "future": True}
    )
    assert request.credentials == {"api_key": " "}
