from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from pydantic import ValidationError

from app.core.auth import AuthContext
from app.core.config import settings
from app.models.user import User
from app.routes import connectors
from app.schemas.connector import ConnectorAvailableAppResponse
from app.services import composio


def _field(
    name: str,
    display_name: str,
    *,
    required: bool = True,
    field_type: str = "string",
    is_secret: bool = False,
    default: str | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        name=name,
        display_name=display_name,
        description="",
        type=field_type,
        required=required,
        is_secret=is_secret,
        default=default,
    )


def _meta(description: str = "PostHog is an open-source product analytics platform."):
    return SimpleNamespace(
        logo="https://logos.example/posthog",
        description=description,
    )


def _posthog_list_toolkit() -> SimpleNamespace:
    return SimpleNamespace(
        slug="posthog",
        name="PostHog",
        meta=_meta(),
        auth_schemes=[],
        composio_managed_auth_schemes=[],
        no_auth=False,
    )


def _posthog_detail_toolkit() -> SimpleNamespace:
    return SimpleNamespace(
        slug="posthog",
        name="PostHog",
        meta=_meta(),
        auth_schemes=[],
        composio_managed_auth_schemes=[],
        no_auth=False,
        auth_config_details=[
            SimpleNamespace(
                mode="API_KEY",
                name="API Key",
                fields=SimpleNamespace(
                    connected_account_initiation=SimpleNamespace(
                        required=[
                            _field("generic_api_key", "Generic API Key", is_secret=True),
                        ],
                        optional=[],
                    )
                ),
            )
        ],
    )


def _gmail_detail_toolkit() -> SimpleNamespace:
    return SimpleNamespace(
        slug="gmail",
        name="Gmail",
        meta=_meta("Gmail is Google's email service."),
        auth_schemes=["OAUTH2"],
        composio_managed_auth_schemes=["OAUTH2"],
        no_auth=False,
        auth_config_details=[],
    )


def _hackernews_detail_toolkit() -> SimpleNamespace:
    return SimpleNamespace(
        slug="hackernews",
        name="Hacker News",
        meta=_meta("Hacker News is a social news website."),
        auth_schemes=[],
        composio_managed_auth_schemes=[],
        no_auth=True,
        auth_config_details=[],
    )


class FakeToolkits:
    def __init__(self, *, list_toolkits: list[Any], detail_toolkits: dict[str, Any]):
        self.list_toolkits = list_toolkits
        self.detail_toolkits = detail_toolkits

    async def list(self, **kwargs):
        return SimpleNamespace(items=self.list_toolkits, next_cursor=None)

    async def retrieve(self, slug: str):
        return self.detail_toolkits[slug]


class FakeAuthConfigs:
    def __init__(self, existing: list[Any] | None = None):
        self.existing = existing or []
        self.created: list[dict[str, Any]] = []
        self.last_created_id = "ac_created"

    async def list(self, **kwargs):
        return SimpleNamespace(items=self.existing, next_cursor=None)

    async def create(self, **kwargs):
        self.created.append(kwargs)
        auth_config = kwargs["auth_config"]
        self.last_created_id = f"ac_{len(self.created)}"
        return SimpleNamespace(
            auth_config=SimpleNamespace(
                id=self.last_created_id,
                auth_scheme=auth_config.get("auth_scheme", "OAUTH2"),
                is_composio_managed=auth_config["type"] == "use_composio_managed_auth",
            )
        )

    async def retrieve(self, auth_config_id: str):
        return SimpleNamespace(
            id=auth_config_id,
            auth_scheme="API_KEY",
            expected_input_fields=[],
        )


class FakeLink:
    def __init__(self):
        self.created: dict[str, Any] | None = None

    async def create(
        self,
        *,
        auth_config_id: str,
        user_id: str,
        callback_url: str | None = None,
    ):
        self.created = {
            "auth_config_id": auth_config_id,
            "user_id": user_id,
        }
        if callback_url is not None:
            self.created["callback_url"] = callback_url
        return SimpleNamespace(
            redirect_url="https://connect.composio.dev/request_123",
            connected_account_id="ca_gmail",
        )


class FakeConnectedAccounts:
    def __init__(self):
        self.created: dict[str, Any] | None = None

    async def create(self, **kwargs):
        self.created = kwargs
        return SimpleNamespace(id="ca_posthog", status="ACTIVE")

    async def list(self, **kwargs):
        return SimpleNamespace(items=[], next_cursor=None)

    async def retrieve(self, connected_account_id: str):
        return SimpleNamespace(id=connected_account_id, status="ACTIVE")

    async def delete(self, connected_account_id: str):
        return SimpleNamespace(success=True)


class FakeTools:
    async def list(self, **kwargs):
        return SimpleNamespace(items=[], next_cursor=None)


class FakeClient:
    def __init__(
        self,
        *,
        list_toolkits: list[Any] | None = None,
        detail_toolkits: dict[str, Any] | None = None,
        auth_configs: FakeAuthConfigs | None = None,
    ):
        if detail_toolkits is None:
            detail_toolkits = {"posthog": _posthog_detail_toolkit()}
        self.toolkits = FakeToolkits(
            list_toolkits=list_toolkits or [_posthog_list_toolkit()],
            detail_toolkits=detail_toolkits,
        )
        self.auth_configs = auth_configs or FakeAuthConfigs()
        self.link = FakeLink()
        self.connected_accounts = FakeConnectedAccounts()
        self.tools = FakeTools()


def _composio_client_status_error(
    cls: type[Exception],
    status_code: int,
    body: dict[str, Any],
) -> Exception:
    request = httpx.Request("POST", "https://backend.composio.dev/api/v3.1/connected_accounts")
    response = httpx.Response(status_code, json=body, request=request)
    return cls(f"Error code: {status_code} - {body}", response=response, body=body)


@pytest.fixture(autouse=True)
def _reset_composio_app_cache(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(composio, "_apps_cache", None)
    monkeypatch.setattr(composio, "_apps_cache_at", None)


@pytest.mark.asyncio
async def test_connector_detail_uses_toolkit_auth_config_details(monkeypatch: pytest.MonkeyPatch):
    fake = FakeClient()
    monkeypatch.setattr(settings, "composio_api_key", "composio_test_key")
    monkeypatch.setattr(composio, "get_composio_client", lambda: fake)

    app = await composio.get_app_by_name("posthog")

    assert app is not None
    assert app["name"] == "posthog"
    assert app["auth_type"] == "api_key"


@pytest.mark.asyncio
async def test_catalog_without_auth_metadata_is_unknown_not_oauth2(
    monkeypatch: pytest.MonkeyPatch,
):
    fake = FakeClient(list_toolkits=[_posthog_list_toolkit()])
    monkeypatch.setattr(settings, "composio_api_key", "composio_test_key")
    monkeypatch.setattr(composio, "get_composio_client", lambda: fake)

    page = await composio.get_available_apps(search="posthog")

    assert page["items"][0]["auth_type"] == "unknown"


@pytest.mark.asyncio
async def test_connector_detail_requires_explicit_toolkit_auth_metadata(
    monkeypatch: pytest.MonkeyPatch,
):
    fake = FakeClient(detail_toolkits={"posthog": _posthog_list_toolkit()})
    monkeypatch.setattr(settings, "composio_api_key", "composio_test_key")
    monkeypatch.setattr(composio, "get_composio_client", lambda: fake)

    with pytest.raises(composio.ConnectorAuthMetadataError):
        await composio.get_app_by_name("posthog")


@pytest.mark.asyncio
async def test_connector_detail_does_not_fallback_to_catalog_when_retrieve_fails(
    monkeypatch: pytest.MonkeyPatch,
):
    fake = FakeClient(list_toolkits=[_posthog_list_toolkit()], detail_toolkits={})
    monkeypatch.setattr(settings, "composio_api_key", "composio_test_key")
    monkeypatch.setattr(composio, "get_composio_client", lambda: fake)

    with pytest.raises(KeyError):
        await composio.get_app_by_name("posthog")


def test_connector_available_app_response_requires_auth_type():
    with pytest.raises(ValidationError):
        ConnectorAvailableAppResponse.model_validate(
            {
                "name": "posthog",
                "display_name": "PostHog",
                "logo": "",
                "description": "",
            }
        )


@pytest.mark.asyncio
async def test_oauth_connect_uses_managed_auth_config_and_link(monkeypatch: pytest.MonkeyPatch):
    fake = FakeClient(
        list_toolkits=[_gmail_detail_toolkit()],
        detail_toolkits={"gmail": _gmail_detail_toolkit()},
    )
    monkeypatch.setattr(composio, "get_composio_client", lambda: fake)

    result = await composio.create_connect_link(
        "clerk_user_123",
        "gmail",
        "https://cloud.example.test/connectors/gmail",
    )

    assert result == {
        "connect_url": "https://connect.composio.dev/request_123",
        "id": "ca_gmail",
    }
    assert fake.auth_configs.created == [
        {
            "toolkit": {"slug": "gmail"},
            "auth_config": {
                "type": "use_composio_managed_auth",
                "name": "Clawdi gmail managed",
            },
        }
    ]
    assert fake.link.created == {
        "auth_config_id": "ac_1",
        "user_id": "clerk_user_123",
        "callback_url": "https://cloud.example.test/connectors/gmail",
    }


@pytest.mark.asyncio
async def test_no_auth_connect_does_not_create_auth_config_or_connected_account(
    monkeypatch: pytest.MonkeyPatch,
):
    fake = FakeClient(
        list_toolkits=[_hackernews_detail_toolkit()],
        detail_toolkits={"hackernews": _hackernews_detail_toolkit()},
    )
    monkeypatch.setattr(composio, "get_composio_client", lambda: fake)

    result = await composio.create_connect_link(
        "clerk_user_123",
        "hackernews",
        "https://cloud.example.test/connectors/hackernews",
    )

    assert result == {
        "connect_url": "https://cloud.example.test/connectors/hackernews",
        "id": "",
    }
    assert fake.auth_configs.created == []
    assert fake.connected_accounts.created is None
    assert fake.link.created is None


@pytest.mark.asyncio
async def test_no_auth_fields_are_empty_without_auth_config(monkeypatch: pytest.MonkeyPatch):
    fake = FakeClient(
        list_toolkits=[_hackernews_detail_toolkit()],
        detail_toolkits={"hackernews": _hackernews_detail_toolkit()},
    )
    monkeypatch.setattr(composio, "get_composio_client", lambda: fake)

    fields = await composio.get_auth_fields("hackernews")

    assert fields == {"auth_scheme": "NO_AUTH", "expected_input_fields": []}
    assert fake.auth_configs.created == []


@pytest.mark.asyncio
async def test_auth_fields_use_official_toolkit_initiation_fields(
    monkeypatch: pytest.MonkeyPatch,
):
    fake = FakeClient()
    monkeypatch.setattr(composio, "get_composio_client", lambda: fake)

    fields = await composio.get_auth_fields("posthog")

    assert fields == {
        "auth_scheme": "API_KEY",
        "expected_input_fields": [
            {
                "name": "generic_api_key",
                "display_name": "Generic API Key",
                "description": "",
                "type": "string",
                "required": True,
                "is_secret": True,
                "expected_from_customer": True,
                "default": None,
            },
        ],
    }


@pytest.mark.asyncio
async def test_credentials_connect_uses_custom_auth_config_and_connected_account_create(
    monkeypatch: pytest.MonkeyPatch,
):
    fake = FakeClient()
    monkeypatch.setattr(composio, "get_composio_client", lambda: fake)

    result = await composio.connect_with_credentials(
        "clerk_user_123",
        "posthog",
        {"generic_api_key": "phx_123"},
    )

    assert result == {"id": "ca_posthog", "status": "active", "ok": True}
    assert fake.auth_configs.created == [
        {
            "toolkit": {"slug": "posthog"},
            "auth_config": {
                "type": "use_custom_auth",
                "auth_scheme": "API_KEY",
                "credentials": {},
                "name": "Clawdi posthog api_key",
            },
        }
    ]
    assert fake.connected_accounts.created == {
        "auth_config": {"id": "ac_1"},
        "connection": {
            "user_id": "clerk_user_123",
            "state": {
                "auth_scheme": "API_KEY",
                "val": {"generic_api_key": "phx_123"},
            },
        },
        "validate_credentials": True,
    }


def test_map_composio_client_bad_request_to_safe_credential_error():
    from composio_client import BadRequestError

    exc = _composio_client_status_error(
        BadRequestError,
        400,
        {
            "error": {
                "message": "Metabase rejected API key mb_secret_123",
                "code": 10400,
            }
        },
    )

    mapped = connectors._map_composio_error(
        exc,
        scrub={"generic_api_key": "mb_secret_123"},
    )

    assert mapped.status_code == 400
    assert mapped.detail == "Metabase rejected API key ***"


def test_map_composio_client_not_found_to_connector_not_found():
    from composio_client import NotFoundError

    exc = _composio_client_status_error(
        NotFoundError,
        404,
        {"error": {"message": "Toolkit metabase not found"}},
    )

    mapped = connectors._map_composio_error(exc)

    assert mapped.status_code == 404
    assert mapped.detail == "Connector not found"


@pytest.mark.asyncio
async def test_connect_route_rejects_credentials_connector_before_oauth_link(
    monkeypatch: pytest.MonkeyPatch,
):
    async def fake_get_app_by_name(app_name: str):
        assert app_name == "posthog"
        return {"name": "posthog", "auth_type": "api_key"}

    async def fail_create_connect_link(*args, **kwargs):
        raise AssertionError("credential connectors must not start the OAuth link flow")

    monkeypatch.setattr(settings, "composio_api_key", "composio_test_key")
    monkeypatch.setattr(connectors, "get_app_by_name", fake_get_app_by_name)
    monkeypatch.setattr(connectors, "create_connect_link", fail_create_connect_link)

    with pytest.raises(connectors.HTTPException) as exc_info:
        await connectors.connect_app(
            "posthog",
            None,
            AuthContext(user=User(clerk_id="clerk_user_123")),
        )

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "Connector requires credentials"


@pytest.mark.asyncio
async def test_connect_route_rejects_missing_auth_type_without_oauth_link(
    monkeypatch: pytest.MonkeyPatch,
):
    async def fake_get_app_by_name(app_name: str):
        assert app_name == "posthog"
        return {"name": "posthog"}

    async def fail_create_connect_link(*args, **kwargs):
        raise AssertionError("missing auth metadata must not start the OAuth link flow")

    monkeypatch.setattr(settings, "composio_api_key", "composio_test_key")
    monkeypatch.setattr(connectors, "get_app_by_name", fake_get_app_by_name)
    monkeypatch.setattr(connectors, "create_connect_link", fail_create_connect_link)

    with pytest.raises(connectors.HTTPException) as exc_info:
        await connectors.connect_app(
            "posthog",
            None,
            AuthContext(user=User(clerk_id="clerk_user_123")),
        )

    assert exc_info.value.status_code == 502
    assert exc_info.value.detail == "Connector auth metadata unavailable"


@pytest.mark.asyncio
async def test_connect_route_rejects_unknown_auth_type_without_oauth_link(
    monkeypatch: pytest.MonkeyPatch,
):
    async def fake_get_app_by_name(app_name: str):
        assert app_name == "posthog"
        return {"name": "posthog", "auth_type": "unknown"}

    async def fail_create_connect_link(*args, **kwargs):
        raise AssertionError("unknown auth metadata must not start the OAuth link flow")

    monkeypatch.setattr(settings, "composio_api_key", "composio_test_key")
    monkeypatch.setattr(connectors, "get_app_by_name", fake_get_app_by_name)
    monkeypatch.setattr(connectors, "create_connect_link", fail_create_connect_link)

    with pytest.raises(connectors.HTTPException) as exc_info:
        await connectors.connect_app(
            "posthog",
            None,
            AuthContext(user=User(clerk_id="clerk_user_123")),
        )

    assert exc_info.value.status_code == 502
    assert exc_info.value.detail == "Connector auth metadata unavailable"
