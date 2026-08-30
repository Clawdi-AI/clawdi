from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import httpx
import pytest
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.core.auth import AuthContext
from app.core.config import settings
from app.models.user import User
from app.routes import connectors
from app.schemas.connector import (
    ConnectorAvailableAppResponse,
    ConnectorConnectionResponse,
    ConnectorCredentialsConnectResponse,
)
from app.services import composio


class _FakeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _FakePage[ResponseT: BaseModel](_FakeResponse):
    items: list[ResponseT]
    next_cursor: str | None = None


class _FakeToolkitMeta(_FakeResponse):
    logo: str
    description: str


class _FakeAuthField(_FakeResponse):
    name: str
    display_name: str
    description: str = ""
    type: str = "string"
    required: bool = True
    is_secret: bool = False
    default: str | None = None


class _FakeAuthFieldGroup(_FakeResponse):
    required: list[_FakeAuthField] = Field(default_factory=list)
    optional: list[_FakeAuthField] = Field(default_factory=list)


class _FakeAuthFields(_FakeResponse):
    connected_account_initiation: _FakeAuthFieldGroup


class _FakeAuthConfigDetail(_FakeResponse):
    mode: str
    name: str
    fields: _FakeAuthFields


class _FakeToolkit(_FakeResponse):
    slug: str
    name: str
    meta: _FakeToolkitMeta
    auth_schemes: list[str] | None = None
    composio_managed_auth_schemes: list[str] | None = None
    no_auth: bool | None = None
    auth_config_details: list[_FakeAuthConfigDetail] | None = None


class _FakeAuthConfigToolkit(_FakeResponse):
    slug: str


class _FakeAuthConfig(_FakeResponse):
    id: str
    auth_scheme: str | None = None
    is_composio_managed: bool | None = None
    status: Literal["ENABLED", "DISABLED"] = "ENABLED"
    toolkit: _FakeAuthConfigToolkit | None = None


class _FakeAuthConfigCreateResponse(_FakeResponse):
    auth_config: _FakeAuthConfig


class _FakeAuthConfigRetrieveResponse(_FakeResponse):
    id: str
    auth_scheme: str
    expected_input_fields: list[_FakeAuthField]


class _FakeConnectLinkResponse(_FakeResponse):
    redirect_url: str
    connected_account_id: str


class _FakeConnectedAccountResponse(_FakeResponse):
    id: str
    status: str


class _FakeDeleteResponse(_FakeResponse):
    success: bool


class _FakeTool(_FakeResponse):
    slug: str
    name: str
    description: str
    is_deprecated: bool


class _MalformedResponse(_FakeResponse):
    unexpected: str = "malformed"


class _MalformedConnectLinkResponse(_FakeResponse):
    redirect_url: str


def _field(
    name: str,
    display_name: str,
    *,
    required: bool = True,
    field_type: str = "string",
    is_secret: bool = False,
    default: str | None = None,
) -> _FakeAuthField:
    return _FakeAuthField(
        name=name,
        display_name=display_name,
        description="",
        type=field_type,
        required=required,
        is_secret=is_secret,
        default=default,
    )


def _meta(
    description: str = "PostHog is an open-source product analytics platform.",
) -> _FakeToolkitMeta:
    return _FakeToolkitMeta(
        logo="https://logos.example/posthog",
        description=description,
    )


def _posthog_list_toolkit() -> _FakeToolkit:
    return _FakeToolkit(
        slug="posthog",
        name="PostHog",
        meta=_meta(),
        auth_schemes=[],
        composio_managed_auth_schemes=[],
        no_auth=False,
    )


def _posthog_detail_toolkit() -> _FakeToolkit:
    return _FakeToolkit(
        slug="posthog",
        name="PostHog",
        meta=_meta(),
        auth_schemes=[],
        composio_managed_auth_schemes=[],
        no_auth=False,
        auth_config_details=[
            _FakeAuthConfigDetail(
                mode="API_KEY",
                name="API Key",
                fields=_FakeAuthFields(
                    connected_account_initiation=_FakeAuthFieldGroup(
                        required=[
                            _field("generic_api_key", "Generic API Key", is_secret=True),
                        ],
                        optional=[],
                    )
                ),
            )
        ],
    )


def _gmail_detail_toolkit() -> _FakeToolkit:
    return _FakeToolkit(
        slug="gmail",
        name="Gmail",
        meta=_meta("Gmail is Google's email service."),
        auth_schemes=["OAUTH2"],
        composio_managed_auth_schemes=["OAUTH2"],
        no_auth=False,
        auth_config_details=[],
    )


def _gmail_detail_toolkit_without_managed_metadata() -> _FakeToolkit:
    return _FakeToolkit(
        slug="gmail",
        name="Gmail",
        meta=_meta("Gmail is Google's email service."),
        auth_schemes=["OAUTH2"],
        no_auth=False,
        auth_config_details=[],
    )


def _twitter_detail_toolkit() -> _FakeToolkit:
    return _FakeToolkit(
        slug="twitter",
        name="Twitter",
        meta=_meta("Twitter is a social networking service."),
        auth_schemes=["OAUTH2"],
        composio_managed_auth_schemes=[],
        no_auth=False,
        auth_config_details=[],
    )


def _hackernews_detail_toolkit() -> _FakeToolkit:
    return _FakeToolkit(
        slug="hackernews",
        name="Hacker News",
        meta=_meta("Hacker News is a social news website."),
        auth_schemes=[],
        composio_managed_auth_schemes=[],
        no_auth=None,
        auth_config_details=[
            _FakeAuthConfigDetail(
                mode="NO_AUTH",
                name="No auth",
                fields=_FakeAuthFields(connected_account_initiation=_FakeAuthFieldGroup()),
            )
        ],
    )


def _search_toolkit(slug: str, name: str, description: str) -> _FakeToolkit:
    return _FakeToolkit(
        slug=slug,
        name=name,
        meta=_meta(description),
        auth_schemes=[],
        composio_managed_auth_schemes=[],
        no_auth=True,
        auth_config_details=[],
    )


class FakeToolkits:
    def __init__(
        self,
        *,
        list_toolkits: list[_FakeToolkit],
        detail_toolkits: dict[str, _FakeToolkit],
    ) -> None:
        self.list_toolkits = list_toolkits
        self.detail_toolkits = detail_toolkits

    async def list(
        self,
        *,
        managed_by: str,
        sort_by: str,
        limit: int,
        cursor: str | None = None,
    ) -> _FakePage[_FakeToolkit]:
        assert (managed_by, sort_by, limit, cursor) == ("composio", "usage", 1000, None)
        return _FakePage[_FakeToolkit](items=self.list_toolkits)

    async def retrieve(self, slug: str) -> _FakeToolkit:
        return self.detail_toolkits[slug]


class FakeAuthConfigs:
    def __init__(self, existing: list[_FakeAuthConfig] | None = None) -> None:
        self.existing = existing or []
        self.created: list[dict[str, Any]] = []
        self.listed: list[dict[str, Any]] = []
        self.last_created_id = "ac_created"

    async def list(
        self,
        *,
        is_composio_managed: bool,
        show_disabled: bool,
        limit: int,
        toolkit_slug: str | None = None,
        cursor: str | None = None,
    ) -> _FakePage[_FakeAuthConfig]:
        kwargs: dict[str, object] = {
            "is_composio_managed": is_composio_managed,
            "show_disabled": show_disabled,
            "limit": limit,
        }
        if toolkit_slug is not None:
            kwargs["toolkit_slug"] = toolkit_slug
        if cursor is not None:
            kwargs["cursor"] = cursor
        self.listed.append(kwargs)
        items = self.existing
        items = [item for item in items if bool(item.is_composio_managed) is is_composio_managed]
        return _FakePage[_FakeAuthConfig](items=items)

    async def create(
        self,
        *,
        toolkit: dict[str, str],
        auth_config: dict[str, object],
    ) -> _FakeAuthConfigCreateResponse:
        kwargs = {"toolkit": toolkit, "auth_config": auth_config}
        self.created.append(kwargs)
        self.last_created_id = f"ac_{len(self.created)}"
        return _FakeAuthConfigCreateResponse(
            auth_config=_FakeAuthConfig(
                id=self.last_created_id,
                auth_scheme=str(auth_config.get("auth_scheme", "OAUTH2")),
                is_composio_managed=auth_config["type"] == "use_composio_managed_auth",
            )
        )

    async def retrieve(self, auth_config_id: str) -> _FakeAuthConfigRetrieveResponse:
        return _FakeAuthConfigRetrieveResponse(
            id=auth_config_id,
            auth_scheme="API_KEY",
            expected_input_fields=[],
        )


class FakeLink:
    def __init__(self) -> None:
        self.created: dict[str, Any] | None = None

    async def create(
        self,
        *,
        auth_config_id: str,
        user_id: str,
        callback_url: str | None = None,
    ) -> _FakeConnectLinkResponse:
        self.created = {
            "auth_config_id": auth_config_id,
            "user_id": user_id,
        }
        if callback_url is not None:
            self.created["callback_url"] = callback_url
        return _FakeConnectLinkResponse(
            redirect_url="https://connect.composio.dev/request_123",
            connected_account_id="ca_gmail",
        )


class FakeConnectedAccounts:
    def __init__(
        self,
        *,
        create_status: str = "ACTIVE",
        retrieve_statuses: list[str] | None = None,
    ) -> None:
        self.created: dict[str, Any] | None = None
        self.create_status = create_status
        self.retrieve_statuses = list(retrieve_statuses or [])
        self.retrieve_calls: list[str] = []

    async def create(
        self,
        *,
        auth_config: dict[str, str],
        connection: dict[str, object],
    ) -> _FakeConnectedAccountResponse:
        kwargs = {"auth_config": auth_config, "connection": connection}
        self.created = kwargs
        return _FakeConnectedAccountResponse(id="ca_posthog", status=self.create_status)

    async def list(
        self,
        *,
        user_ids: list[str],
        statuses: list[str],
        limit: int,
        cursor: str | None = None,
    ) -> _FakePage[_FakeConnectedAccountResponse]:
        assert user_ids and statuses == ["ACTIVE"] and limit == 100 and cursor is None
        return _FakePage[_FakeConnectedAccountResponse](items=[])

    async def retrieve(self, connected_account_id: str) -> _FakeConnectedAccountResponse:
        self.retrieve_calls.append(connected_account_id)
        status = self.retrieve_statuses.pop(0) if self.retrieve_statuses else "ACTIVE"
        return _FakeConnectedAccountResponse(id=connected_account_id, status=status)

    async def delete(self, connected_account_id: str) -> _FakeDeleteResponse:
        assert connected_account_id
        return _FakeDeleteResponse(success=True)


class FakeTools:
    async def list(
        self,
        *,
        toolkit_slug: str,
        include_deprecated: bool,
        limit: int,
        cursor: str | None = None,
    ) -> _FakePage[_FakeTool]:
        assert toolkit_slug and include_deprecated is False and limit == 100 and cursor is None
        return _FakePage[_FakeTool](items=[])


class FakeClient:
    def __init__(
        self,
        *,
        list_toolkits: list[_FakeToolkit] | None = None,
        detail_toolkits: dict[str, _FakeToolkit] | None = None,
        auth_configs: FakeAuthConfigs | None = None,
        connected_accounts: FakeConnectedAccounts | None = None,
    ) -> None:
        if detail_toolkits is None:
            detail_toolkits = {"posthog": _posthog_detail_toolkit()}
        self.toolkits = FakeToolkits(
            list_toolkits=list_toolkits or [_posthog_list_toolkit()],
            detail_toolkits=detail_toolkits,
        )
        self.auth_configs = auth_configs or FakeAuthConfigs()
        self.link = FakeLink()
        self.connected_accounts = connected_accounts or FakeConnectedAccounts()
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
    monkeypatch.setattr(composio, "_toolkits_cache", None)
    monkeypatch.setattr(composio, "_toolkits_cache_at", None)
    monkeypatch.setattr(composio, "_custom_auth_config_index", None)
    monkeypatch.setattr(composio, "_custom_auth_config_index_at", None)
    monkeypatch.setattr(composio, "_tool_router_session_cache", {})


@pytest.mark.asyncio
async def test_connector_detail_uses_toolkit_auth_config_details(monkeypatch: pytest.MonkeyPatch):
    fake = FakeClient()
    monkeypatch.setattr(settings, "composio_api_key", "composio_test_key")
    monkeypatch.setattr(composio, "get_composio_client", lambda: fake)

    app = await composio.get_app_by_name("posthog")

    assert app is not None
    assert app.name == "posthog"
    assert app.auth_type == "api_key"


@pytest.mark.asyncio
async def test_catalog_without_auth_metadata_is_unknown_not_oauth2(
    monkeypatch: pytest.MonkeyPatch,
):
    fake = FakeClient(list_toolkits=[_posthog_list_toolkit()])
    monkeypatch.setattr(settings, "composio_api_key", "composio_test_key")
    monkeypatch.setattr(composio, "get_composio_client", lambda: fake)

    page = await composio.get_available_apps(search="posthog")

    assert page["items"][0].auth_type == "unknown"


@pytest.mark.asyncio
async def test_catalog_search_prioritizes_identity_before_description(
    monkeypatch: pytest.MonkeyPatch,
):
    fake = FakeClient(
        list_toolkits=[
            _search_toolkit("postal", "Postal", "Routes Gmail messages"),
            _search_toolkit("team-mail", "Team Gmail", "Team inbox"),
            _search_toolkit("gmail-analytics", "Mail insights", "Analytics"),
            _search_toolkit("gmail", "Gmail", "Google email"),
        ]
    )
    monkeypatch.setattr(settings, "composio_api_key", "composio_test_key")
    monkeypatch.setattr(composio, "get_composio_client", lambda: fake)

    page = await composio.get_available_apps(search="  GMAIL  ")

    assert [app.name for app in page["items"]] == [
        "gmail",
        "gmail-analytics",
        "team-mail",
        "postal",
    ]


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
    composio._tool_router_session_cache["clerk_user_123"] = composio.ComposioMcpSession(
        url="https://app.composio.dev/tool_router/v3/trs_old/mcp",
        headers={},
        expires_at=datetime.now(UTC) + timedelta(minutes=30),
    )

    result = await composio.create_connect_link(
        "clerk_user_123",
        "gmail",
        "https://cloud.example.test/connectors/gmail",
    )

    assert result.model_dump() == {
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
    assert "clerk_user_123" not in composio._tool_router_session_cache


@pytest.mark.asyncio
async def test_oauth_connect_with_missing_managed_auth_metadata_uses_managed_fallback(
    monkeypatch: pytest.MonkeyPatch,
):
    fake = FakeClient(
        list_toolkits=[_gmail_detail_toolkit_without_managed_metadata()],
        detail_toolkits={"gmail": _gmail_detail_toolkit_without_managed_metadata()},
    )
    monkeypatch.setattr(composio, "get_composio_client", lambda: fake)

    await composio.create_connect_link(
        "clerk_user_123",
        "gmail",
        "https://cloud.example.test/connectors/gmail",
    )

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
async def test_oauth_without_managed_auth_uses_existing_custom_auth_config(
    monkeypatch: pytest.MonkeyPatch,
):
    fake = FakeClient(
        list_toolkits=[_twitter_detail_toolkit()],
        detail_toolkits={"twitter": _twitter_detail_toolkit()},
        auth_configs=FakeAuthConfigs(
            existing=[
                _FakeAuthConfig(
                    id="ac_twitter_custom",
                    toolkit=_FakeAuthConfigToolkit(slug="twitter"),
                    auth_scheme="OAUTH2",
                    is_composio_managed=False,
                    status="ENABLED",
                )
            ],
        ),
    )
    monkeypatch.setattr(composio, "get_composio_client", lambda: fake)

    result = await composio.create_connect_link(
        "clerk_user_123",
        "twitter",
        "https://cloud.example.test/connectors/twitter",
    )

    assert result.model_dump() == {
        "connect_url": "https://connect.composio.dev/request_123",
        "id": "ca_gmail",
    }
    assert fake.auth_configs.created == []
    assert fake.link.created == {
        "auth_config_id": "ac_twitter_custom",
        "user_id": "clerk_user_123",
        "callback_url": "https://cloud.example.test/connectors/twitter",
    }


@pytest.mark.asyncio
async def test_connector_detail_enables_oauth_without_managed_auth_when_custom_config_exists(
    monkeypatch: pytest.MonkeyPatch,
):
    fake = FakeClient(
        list_toolkits=[_twitter_detail_toolkit()],
        detail_toolkits={"twitter": _twitter_detail_toolkit()},
        auth_configs=FakeAuthConfigs(
            existing=[
                _FakeAuthConfig(
                    id="ac_twitter_custom",
                    toolkit=_FakeAuthConfigToolkit(slug="twitter"),
                    auth_scheme="OAUTH2",
                    is_composio_managed=False,
                    status="ENABLED",
                )
            ],
        ),
    )
    monkeypatch.setattr(settings, "composio_api_key", "composio_test_key")
    monkeypatch.setattr(composio, "get_composio_client", lambda: fake)

    app = await composio.get_app_by_name("twitter")

    assert app is not None
    assert app.auth_type == "oauth2"
    assert app.connect_disabled is False
    assert app.connect_disabled_reason is None


@pytest.mark.asyncio
async def test_connector_detail_disables_oauth_without_managed_or_custom_auth(
    monkeypatch: pytest.MonkeyPatch,
):
    fake = FakeClient(
        list_toolkits=[_twitter_detail_toolkit()],
        detail_toolkits={"twitter": _twitter_detail_toolkit()},
    )
    monkeypatch.setattr(settings, "composio_api_key", "composio_test_key")
    monkeypatch.setattr(composio, "get_composio_client", lambda: fake)

    app = await composio.get_app_by_name("twitter")

    assert app is not None
    assert app.auth_type == "oauth2"
    assert app.connect_disabled is True
    assert app.connect_disabled_reason == composio.CUSTOM_OAUTH_CONFIG_REQUIRED_MESSAGE


@pytest.mark.asyncio
async def test_connector_catalog_hides_oauth_without_managed_or_custom_auth(
    monkeypatch: pytest.MonkeyPatch,
):
    fake = FakeClient(
        list_toolkits=[_twitter_detail_toolkit()],
        detail_toolkits={"twitter": _twitter_detail_toolkit()},
    )
    monkeypatch.setattr(settings, "composio_api_key", "composio_test_key")
    monkeypatch.setattr(composio, "get_composio_client", lambda: fake)

    page = await composio.get_available_apps(search="twitter")

    assert page["items"] == []
    assert page["total"] == 0
    assert fake.auth_configs.listed == [
        {"is_composio_managed": False, "show_disabled": False, "limit": 100}
    ]


@pytest.mark.asyncio
async def test_connector_catalog_shows_oauth_without_managed_auth_when_custom_config_exists(
    monkeypatch: pytest.MonkeyPatch,
):
    fake = FakeClient(
        list_toolkits=[_twitter_detail_toolkit()],
        detail_toolkits={"twitter": _twitter_detail_toolkit()},
        auth_configs=FakeAuthConfigs(
            existing=[
                _FakeAuthConfig(
                    id="ac_twitter_custom",
                    toolkit=_FakeAuthConfigToolkit(slug="twitter"),
                    auth_scheme="OAUTH2",
                    is_composio_managed=False,
                    status="ENABLED",
                )
            ],
        ),
    )
    monkeypatch.setattr(settings, "composio_api_key", "composio_test_key")
    monkeypatch.setattr(composio, "get_composio_client", lambda: fake)

    page = await composio.get_available_apps(search="twitter")

    assert page["items"][0].name == "twitter"
    assert page["items"][0].connect_disabled is False
    assert page["items"][0].connect_disabled_reason is None
    assert page["total"] == 1
    assert fake.auth_configs.listed == [
        {"is_composio_managed": False, "show_disabled": False, "limit": 100}
    ]


@pytest.mark.asyncio
async def test_oauth_without_managed_auth_requires_existing_custom_auth_config(
    monkeypatch: pytest.MonkeyPatch,
):
    fake = FakeClient(
        list_toolkits=[_twitter_detail_toolkit()],
        detail_toolkits={"twitter": _twitter_detail_toolkit()},
    )
    monkeypatch.setattr(composio, "get_composio_client", lambda: fake)

    with pytest.raises(composio.ConnectorCustomAuthConfigRequired):
        await composio.create_connect_link(
            "clerk_user_123",
            "twitter",
            "https://cloud.example.test/connectors/twitter",
        )

    assert fake.auth_configs.created == []
    assert fake.link.created is None


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

    assert result.model_dump() == {
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

    assert fields.model_dump() == {"auth_scheme": "NO_AUTH", "expected_input_fields": []}
    assert fake.auth_configs.created == []


@pytest.mark.asyncio
async def test_auth_fields_use_official_toolkit_initiation_fields(
    monkeypatch: pytest.MonkeyPatch,
):
    fake = FakeClient()
    monkeypatch.setattr(composio, "get_composio_client", lambda: fake)

    fields = await composio.get_auth_fields("posthog")

    assert fields.model_dump() == {
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
    composio._tool_router_session_cache["clerk_user_123"] = composio.ComposioMcpSession(
        url="https://app.composio.dev/tool_router/v3/trs_old/mcp",
        headers={},
        expires_at=datetime.now(UTC) + timedelta(minutes=30),
    )

    result = await composio.connect_with_credentials(
        "clerk_user_123",
        "posthog",
        {"generic_api_key": "phx_123"},
    )

    assert result.model_dump() == {"id": "ca_posthog", "status": "active", "ok": True}
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
                "val": {"status": "ACTIVE", "generic_api_key": "phx_123"},
            },
        },
    }
    assert "clerk_user_123" not in composio._tool_router_session_cache


@pytest.mark.asyncio
async def test_credentials_connect_times_out_when_composio_stays_pending(
    monkeypatch: pytest.MonkeyPatch,
):
    connected_accounts = FakeConnectedAccounts(
        create_status="INITIALIZING",
        retrieve_statuses=["INITIALIZING"],
    )
    fake = FakeClient(connected_accounts=connected_accounts)
    monkeypatch.setattr(composio, "get_composio_client", lambda: fake)

    class SteppedClock:
        def __init__(self) -> None:
            self.values = iter((0.0, 10.0, 20.0))

        def time(self) -> float:
            return next(self.values)

    sleep_calls: list[float] = []

    async def advance(seconds: float) -> None:
        sleep_calls.append(seconds)

    clock = SteppedClock()
    monkeypatch.setattr(composio.asyncio, "get_running_loop", lambda: clock)
    monkeypatch.setattr(composio.asyncio, "sleep", advance)
    composio._tool_router_session_cache["clerk_user_123"] = composio.ComposioMcpSession(
        url="https://app.composio.dev/tool_router/v3/trs_old/mcp",
        headers={},
        expires_at=datetime.now(UTC) + timedelta(minutes=30),
    )

    with pytest.raises(composio.ComposioActivationTimeoutError):
        await composio.connect_with_credentials(
            "clerk_user_123",
            "posthog",
            {"generic_api_key": "phx_123"},
        )

    assert sleep_calls == [1.0]
    assert connected_accounts.retrieve_calls == ["ca_posthog"]
    assert "clerk_user_123" not in composio._tool_router_session_cache


@pytest.mark.asyncio
async def test_connect_credentials_route_rejects_non_active_connection(
    monkeypatch: pytest.MonkeyPatch,
):
    async def fake_connect_with_credentials(
        user_id: str,
        app_name: str,
        credentials: dict[str, str],
    ):
        assert user_id == "clerk_user_123"
        assert app_name == "posthog"
        assert credentials == {"generic_api_key": "phx_123"}
        return ConnectorCredentialsConnectResponse(id="ca_posthog", status="failed", ok=False)

    monkeypatch.setattr(settings, "composio_api_key", "composio_test_key")
    monkeypatch.setattr(connectors, "connect_with_credentials", fake_connect_with_credentials)

    with pytest.raises(connectors.HTTPException) as exc_info:
        await connectors.connect_credentials(
            "posthog",
            connectors.ConnectorCredentialsConnectRequest(
                credentials={"generic_api_key": "phx_123"}
            ),
            AuthContext(user=User(clerk_id="clerk_user_123")),
        )

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "Composio returned connection status failed"


@pytest.mark.asyncio
async def test_list_connections_invalidates_tool_router_session(
    monkeypatch: pytest.MonkeyPatch,
):
    async def fake_get_connected_accounts(user_id: str):
        assert user_id == "clerk_user_123"
        return []

    monkeypatch.setattr(settings, "composio_api_key", "composio_test_key")
    monkeypatch.setattr(connectors, "get_connected_accounts", fake_get_connected_accounts)
    composio._tool_router_session_cache["clerk_user_123"] = composio.ComposioMcpSession(
        url="https://app.composio.dev/tool_router/v3/trs_old/mcp",
        headers={},
        expires_at=datetime.now(UTC) + timedelta(minutes=30),
    )

    result = await connectors.list_connections(AuthContext(user=User(clerk_id="clerk_user_123")))

    assert result == []
    assert "clerk_user_123" not in composio._tool_router_session_cache


@pytest.mark.asyncio
async def test_disconnect_invalidates_tool_router_session(monkeypatch: pytest.MonkeyPatch):
    async def fake_get_connected_accounts(user_id: str):
        assert user_id == "clerk_user_123"
        return [
            ConnectorConnectionResponse(
                id="ca_posthog",
                app_name="posthog",
                status="ACTIVE",
                created_at="2026-05-27T00:00:00Z",
            )
        ]

    async def fake_disconnect_account(connection_id: str):
        assert connection_id == "ca_posthog"
        return True

    monkeypatch.setattr(settings, "composio_api_key", "composio_test_key")
    monkeypatch.setattr(connectors, "get_connected_accounts", fake_get_connected_accounts)
    monkeypatch.setattr(connectors, "disconnect_account", fake_disconnect_account)
    composio._tool_router_session_cache["clerk_user_123"] = composio.ComposioMcpSession(
        url="https://app.composio.dev/tool_router/v3/trs_old/mcp",
        headers={},
        expires_at=datetime.now(UTC) + timedelta(minutes=30),
    )

    result = await connectors.disconnect(
        "ca_posthog",
        AuthContext(user=User(clerk_id="clerk_user_123")),
    )

    assert result.status == "disconnected"
    assert "clerk_user_123" not in composio._tool_router_session_cache


@pytest.mark.asyncio
async def test_map_composio_client_bad_request_to_safe_credential_error():
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

    async def fail_request() -> None:
        raise exc

    with pytest.raises(composio.ComposioProviderError) as exc_info:
        await composio._call_generated_sdk(
            fail_request(),
            credentials={"generic_api_key": "mb_secret_123"},
        )

    mapped = connectors._map_composio_error(exc_info.value)

    assert mapped.status_code == 400
    assert mapped.detail == "Metabase rejected API key ***"


@pytest.mark.asyncio
async def test_map_composio_client_not_found_to_connector_not_found():
    from composio_client import NotFoundError

    exc = _composio_client_status_error(
        NotFoundError,
        404,
        {"error": {"message": "Toolkit metabase not found"}},
    )

    async def fail_request() -> None:
        raise exc

    with pytest.raises(composio.ComposioProviderError) as exc_info:
        await composio._call_generated_sdk(fail_request())

    mapped = connectors._map_composio_error(exc_info.value)

    assert mapped.status_code == 404
    assert mapped.detail == "Connector not found"


def test_map_custom_oauth_config_required_to_actionable_bad_request():
    mapped = connectors._map_composio_error(
        composio.ConnectorCustomAuthConfigRequired("twitter", "OAUTH2")
    )

    assert mapped.status_code == 400
    assert mapped.detail == composio.CUSTOM_OAUTH_CONFIG_REQUIRED_MESSAGE


@pytest.mark.asyncio
async def test_catalog_rejects_malformed_sdk_page_instead_of_returning_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class MalformedToolkits(FakeToolkits):
        async def list(
            self,
            *,
            managed_by: str,
            sort_by: str,
            limit: int,
            cursor: str | None = None,
        ) -> _MalformedResponse:
            assert (managed_by, sort_by, limit, cursor) == ("composio", "usage", 1000, None)
            return _MalformedResponse()

    fake = FakeClient()
    fake.toolkits = MalformedToolkits(
        list_toolkits=[_posthog_list_toolkit()],
        detail_toolkits={"posthog": _posthog_detail_toolkit()},
    )
    monkeypatch.setattr(composio, "get_composio_client", lambda: fake)

    with pytest.raises(composio.ComposioProtocolError):
        await composio.get_available_apps()

    mapped = connectors._map_composio_error(
        composio.ComposioProtocolError("provider detail must stay private")
    )
    assert mapped.status_code == 502
    assert mapped.detail == "Composio request failed"


@pytest.mark.asyncio
async def test_connect_link_rejects_missing_provider_account_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class MalformedLink(FakeLink):
        async def create(
            self,
            *,
            auth_config_id: str,
            user_id: str,
            callback_url: str | None = None,
        ) -> _MalformedConnectLinkResponse:
            assert auth_config_id and user_id and callback_url
            return _MalformedConnectLinkResponse(
                redirect_url="https://connect.composio.dev/request_123"
            )

    fake = FakeClient(
        list_toolkits=[_gmail_detail_toolkit()],
        detail_toolkits={"gmail": _gmail_detail_toolkit()},
    )
    fake.link = MalformedLink()
    monkeypatch.setattr(composio, "get_composio_client", lambda: fake)

    with pytest.raises(composio.ComposioProtocolError):
        await composio.create_connect_link(
            "clerk_user_123",
            "gmail",
            "https://cloud.example.test/connectors/gmail",
        )


@pytest.mark.asyncio
async def test_connect_route_rejects_disabled_connector_without_oauth_link(
    monkeypatch: pytest.MonkeyPatch,
):
    async def fake_get_app_by_name(app_name: str):
        assert app_name == "twitter"
        return ConnectorAvailableAppResponse(
            name="twitter",
            display_name="Twitter",
            logo="",
            description="",
            auth_type="oauth2",
            connect_disabled=True,
            connect_disabled_reason=composio.CUSTOM_OAUTH_CONFIG_REQUIRED_MESSAGE,
        )

    async def fail_create_connect_link(*args, **kwargs):
        raise AssertionError("disabled connectors must not start the OAuth link flow")

    monkeypatch.setattr(settings, "composio_api_key", "composio_test_key")
    monkeypatch.setattr(connectors, "get_app_by_name", fake_get_app_by_name)
    monkeypatch.setattr(connectors, "create_connect_link", fail_create_connect_link)

    with pytest.raises(connectors.HTTPException) as exc_info:
        await connectors.connect_app(
            "twitter",
            None,
            AuthContext(user=User(clerk_id="clerk_user_123")),
        )

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == composio.CUSTOM_OAUTH_CONFIG_REQUIRED_MESSAGE


@pytest.mark.asyncio
async def test_connect_route_rejects_credentials_connector_before_oauth_link(
    monkeypatch: pytest.MonkeyPatch,
):
    async def fake_get_app_by_name(app_name: str):
        assert app_name == "posthog"
        return ConnectorAvailableAppResponse(
            name="posthog",
            display_name="PostHog",
            logo="",
            description="",
            auth_type="api_key",
        )

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
async def test_connect_route_maps_protocol_failure_without_oauth_link(
    monkeypatch: pytest.MonkeyPatch,
):
    async def fake_get_app_by_name(app_name: str):
        assert app_name == "posthog"
        raise composio.ComposioProtocolError("provider detail must stay private")

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
    assert exc_info.value.detail == "Composio request failed"


@pytest.mark.asyncio
async def test_connect_route_rejects_unknown_auth_type_without_oauth_link(
    monkeypatch: pytest.MonkeyPatch,
):
    async def fake_get_app_by_name(app_name: str):
        assert app_name == "posthog"
        return ConnectorAvailableAppResponse(
            name="posthog",
            display_name="PostHog",
            logo="",
            description="",
            auth_type="unknown",
        )

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


@pytest.mark.asyncio
async def test_tools_route_maps_sanitized_composio_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def invalid_tools(_app_name: str):
        raise composio.ComposioProtocolError("provider detail must stay private")

    monkeypatch.setattr(settings, "composio_api_key", "composio_test_key")
    monkeypatch.setattr(connectors, "get_app_tools", invalid_tools)

    with pytest.raises(connectors.HTTPException) as exc_info:
        await connectors.list_app_tools(
            "posthog",
            AuthContext(user=User(clerk_id="clerk_user_123")),
        )

    assert exc_info.value.status_code == 502
    assert exc_info.value.detail == "Composio request failed"


def test_composio_request_boundary_validates_complete_public_request_types():
    connected_account_request = composio._connected_account_create_request(
        auth_config_id="ac_posthog",
        user_id="user_123",
        auth_scheme="API_KEY",
        credentials={"api_key": "test-secret"},
    )
    auth_config_request = composio._auth_config_create_request(
        app_name="posthog", auth_scheme="API_KEY", managed=False
    )

    assert connected_account_request == {
        "auth_config": {"id": "ac_posthog"},
        "connection": {
            "user_id": "user_123",
            "state": {
                "auth_scheme": "API_KEY",
                "val": {"status": "ACTIVE", "api_key": "test-secret"},
            },
        },
    }
    assert auth_config_request == {
        "toolkit": {"slug": "posthog"},
        "auth_config": {
            "type": "use_custom_auth",
            "auth_scheme": "API_KEY",
            "credentials": {},
            "name": "Clawdi posthog api_key",
        },
    }


def test_composio_request_boundary_rejects_unknown_auth_scheme():
    with pytest.raises(ValidationError):
        composio._connected_account_create_request(
            auth_config_id="ac_example",
            user_id="user_123",
            auth_scheme="UNKNOWN",
            credentials={"token": "test-secret"},
        )

    with pytest.raises(ValidationError):
        composio._auth_config_create_request(
            app_name="example", auth_scheme="UNKNOWN", managed=False
        )


async def test_close_composio_client_uses_public_sdk_lifecycles(monkeypatch):
    from composio import Composio
    from composio_client import AsyncComposio

    session = composio.ComposioMcpSession(
        url="https://composio.test/mcp",
        headers={},
        expires_at=datetime.now(UTC) + timedelta(minutes=30),
    )
    started = asyncio.Event()
    stopped = asyncio.Event()

    async def pending_list(_session):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    monkeypatch.setattr(composio, "_tool_router_session_cache", {"close-user": session})
    monkeypatch.setattr(composio, "_tool_router_tools_cache", {})
    monkeypatch.setattr(composio, "_tool_router_tools_inflight", {})
    monkeypatch.setattr(composio, "list_tool_router_mcp_tools", pending_list)
    composio._client = AsyncComposio(api_key="test-key")
    composio._sdk_client = Composio(api_key="test-key")

    waiter = asyncio.create_task(composio.get_tool_router_mcp_tools("close-user"))
    await started.wait()
    load = composio._tool_router_tools_inflight["close-user"]
    await composio.close_composio_client()

    with pytest.raises(asyncio.CancelledError):
        await waiter
    assert load.cancelled()
    assert stopped.is_set()
    assert composio._tool_router_session_cache == {}
    assert composio._tool_router_tools_cache == {}
    assert composio._tool_router_tools_inflight == {}
    assert composio._client is None
    assert composio._sdk_client is None
