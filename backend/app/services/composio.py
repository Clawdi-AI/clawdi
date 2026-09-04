"""Composio integration service for connector management and the MCP bridge.

Connector auth uses Composio's current auth-config model:

- OAuth / redirect flows with Composio-managed credentials create or reuse a
  managed auth config, then create a Connect Link for the authenticated Clerk
  user id.
- OAuth / redirect flows without Composio-managed credentials require an
  existing custom auth config in Composio, created with the app's own OAuth
  developer credentials.
- API-key / bearer / basic flows create or reuse a custom auth config, then
  create a connected account with user-supplied credentials.
- No-auth toolkits do not create auth configs or connected accounts; Composio
  exposes their tools directly.

Imports stay lazy so health checks and tests do not import the Composio SDK
unless a connector path actually needs it.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import AsyncGenerator, Awaitable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Literal, TypedDict

import composio_client
import httpx2
import jwt
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.exceptions import MCPError
from mcp.types import CallToolResult, ListToolsResult
from pydantic import BaseModel, ConfigDict, Field, JsonValue, TypeAdapter, ValidationError

from app.core.config import settings
from app.schemas.connector import (
    ConnectorAuthFieldResponse,
    ConnectorAuthFieldsResponse,
    ConnectorAvailableAppResponse,
    ConnectorConnectionResponse,
    ConnectorConnectResponse,
    ConnectorCredentialsConnectResponse,
    ConnectorToolResponse,
)

if TYPE_CHECKING:
    from composio import Composio
    from composio.core.provider._openai import OpenAITool, OpenAIToolCollection
    from composio.exceptions import ComposioError as HighLevelComposioError
    from composio_client import AsyncComposio
    from composio_client.types import AuthConfigCreateParams, ConnectedAccountCreateParams

logger = logging.getLogger(__name__)
type JsonObject = dict[str, JsonValue]
_JSON_OBJECT_ADAPTER: TypeAdapter[JsonObject] = TypeAdapter(dict[str, JsonValue])
_COMPOSIO_STATUSES = {
    "INITIALIZING",
    "INITIATED",
    "ACTIVE",
    "FAILED",
    "EXPIRED",
    "INACTIVE",
    "REVOKED",
}
type ComposioStatus = Literal[
    "INITIALIZING",
    "INITIATED",
    "ACTIVE",
    "FAILED",
    "EXPIRED",
    "INACTIVE",
    "REVOKED",
]


class _ComposioWireModel(BaseModel):
    """Strict first-party subset of one pinned SDK response model."""

    model_config = ConfigDict(extra="ignore", strict=True)


class _PageCursor(_ComposioWireModel):
    next_cursor: str | None = None


class _ToolkitMeta(_ComposioWireModel):
    logo: str
    description: str


class _AuthField(_ComposioWireModel):
    name: str = Field(min_length=1)
    display_name: str = ""
    description: str = ""
    type: str = "string"
    required: bool = False
    is_secret: bool = False
    expected_from_customer: bool = True
    default: str | None = None


class _AuthFieldGroup(_ComposioWireModel):
    required: list[_AuthField] = Field(default_factory=list)
    optional: list[_AuthField] = Field(default_factory=list)


class _AuthFieldCollections(_ComposioWireModel):
    connected_account_initiation: _AuthFieldGroup


class _AuthConfigDetail(_ComposioWireModel):
    mode: str = Field(min_length=1)
    fields: _AuthFieldCollections


class _Toolkit(_ComposioWireModel):
    slug: str = Field(min_length=1)
    name: str = Field(min_length=1)
    meta: _ToolkitMeta
    auth_schemes: list[str] | None = None
    composio_managed_auth_schemes: list[str] | None = None
    no_auth: bool | None = None
    auth_config_details: list[_AuthConfigDetail] | None = None


class _ToolkitPage(_PageCursor):
    items: list[_Toolkit]


class _ConnectedAccountToolkit(_ComposioWireModel):
    slug: str = Field(min_length=1)


class _ConnectedAccount(_ComposioWireModel):
    id: str = Field(min_length=1)
    created_at: str = Field(min_length=1)
    status: ComposioStatus
    toolkit: _ConnectedAccountToolkit
    alias: str | None = None
    word_id: str | None = None
    data: JsonObject = Field(default_factory=dict)
    state: JsonObject = Field(default_factory=dict)


class _ConnectedAccountPage(_PageCursor):
    items: list[_ConnectedAccount]


class _ConnectedAccountCreateResponse(_ComposioWireModel):
    id: str = Field(min_length=1)
    status: ComposioStatus


class _ConnectedAccountStatusResponse(_ComposioWireModel):
    status: ComposioStatus


class _ConnectedAccountDeleteResponse(_ComposioWireModel):
    success: bool


class ConnectorAccountIdentity(BaseModel):
    """Credential-free identity projection for Agent-side account selection."""

    id: str
    app_name: str
    status: ComposioStatus
    account_display: str | None = None
    organization_display: str | None = None
    tenant_display: str | None = None


class _ConnectLinkResponse(_ComposioWireModel):
    redirect_url: str = Field(min_length=1)
    connected_account_id: str = Field(min_length=1)


class _AuthConfigToolkit(_ComposioWireModel):
    slug: str = Field(min_length=1)


class _AuthConfig(_ComposioWireModel):
    id: str = Field(min_length=1)
    auth_scheme: str | None = None
    is_composio_managed: bool | None = None
    status: Literal["ENABLED", "DISABLED"] = "ENABLED"
    toolkit: _AuthConfigToolkit | None = None


class _AuthConfigPage(_PageCursor):
    items: list[_AuthConfig]


class _AuthConfigCreateResponse(_ComposioWireModel):
    auth_config: _AuthConfig


class _AuthConfigRetrieveResponse(_ComposioWireModel):
    auth_scheme: str | None = None
    expected_input_fields: list[_AuthField] | None = None


class _Tool(_ComposioWireModel):
    slug: str = Field(min_length=1)
    name: str = Field(min_length=1)
    description: str
    is_deprecated: bool


class _ToolPage(_PageCursor):
    items: list[_Tool]


class _ToolRouterMcpConfig(_ComposioWireModel):
    model_config = ConfigDict(extra="ignore", from_attributes=True, strict=True)

    type: Literal["http"]
    url: str = Field(min_length=1, pattern=r".*\S.*")
    headers: dict[str, str] = Field(min_length=1)


def _normalize_sdk_response[WireModelT: _ComposioWireModel](
    response: object,
    model: type[WireModelT],
) -> WireModelT:
    """Validate a generated Pydantic response before it enters Clawdi domain code."""

    if not isinstance(response, BaseModel):
        raise ComposioProtocolError("Composio returned an invalid response")
    try:
        return model.model_validate(response.model_dump(mode="python"))
    except ValidationError:
        raise ComposioProtocolError("Composio returned an invalid response") from None


class ConnectorAppPage(TypedDict):
    items: list[ConnectorAvailableAppResponse]
    total: int
    page: int
    page_size: int


_client: AsyncComposio | None = None
_sdk_client: Composio[OpenAITool, OpenAIToolCollection] | None = None
_tool_router_session_cache: dict[str, ComposioMcpSession] = {}
_tool_router_tools_cache: dict[str, tuple[ComposioMcpSession, list[JsonObject]]] = {}
_tool_router_tools_inflight: dict[str, asyncio.Task[list[JsonObject]]] = {}

_REDIRECT_AUTH_TYPES = {"oauth", "oauth1", "oauth2", "dcr_oauth", "composio_link"}
_INSTANT_AUTH_TYPES = {"none", "no_auth"}
_ACTIVE_OR_PENDING_STATUSES = {"INITIALIZING", "INITIATED"}
_TERMINAL_STATUSES = _COMPOSIO_STATUSES - _ACTIVE_OR_PENDING_STATUSES
_COMPOSIO_METADATA_CACHE_TTL = timedelta(minutes=5)
CUSTOM_OAUTH_CONFIG_REQUIRED_MESSAGE = (
    "This Connector needs additional OAuth configuration before it can be connected. "
    "Contact support to continue."
)


class ComposioRouteError(RuntimeError):
    """Base class for sanitized connector failures that routes may map."""


class ConnectorAuthMetadataError(ComposioRouteError):
    """Raised when Composio does not return enough metadata to choose an auth flow."""


class ComposioConfigurationError(ComposioRouteError):
    """Raised when the server-side Composio integration is not configured."""


class ComposioMcpUpstreamError(RuntimeError):
    """Sanitized failure from the server-side Composio MCP client."""


class ComposioProtocolError(ComposioRouteError):
    """Raised when a pinned Composio SDK response violates its public contract."""


class ConnectorCustomAuthConfigRequired(ComposioRouteError):
    """Raised when an OAuth toolkit requires a preconfigured custom auth config."""

    def __init__(self, app_name: str, auth_scheme: str) -> None:
        super().__init__(CUSTOM_OAUTH_CONFIG_REQUIRED_MESSAGE)
        self.app_name = app_name
        self.auth_scheme = auth_scheme


type ComposioFailureKind = Literal[
    "authentication",
    "configuration",
    "not_found",
    "timeout",
    "connection",
    "invalid_request",
    "metadata",
    "protocol",
    "validation",
    "status",
    "unknown",
]


@dataclass(frozen=True, slots=True)
class ComposioFailure:
    """Sanitized first-party view of both pinned Composio SDK error families."""

    kind: ComposioFailureKind
    status_code: int | None = None
    message: str | None = None


class ComposioProviderError(ComposioRouteError):
    """Sanitized error translated at a pinned Composio SDK call boundary."""

    def __init__(self, failure: ComposioFailure) -> None:
        super().__init__("Composio request failed")
        self.failure = failure


class ComposioInvalidRequestError(ComposioRouteError):
    """First-party invalid connector operation, safe to expose as a 400."""


class ComposioActivationTimeoutError(ComposioRouteError):
    """Composio did not leave its pending activation states before the deadline."""


def normalize_composio_failure(
    exc: ComposioRouteError,
) -> ComposioFailure:
    """Return the sanitized failure carried by a first-party adapter error."""

    if isinstance(exc, ConnectorAuthMetadataError):
        return ComposioFailure("metadata", message="Connector auth metadata unavailable")
    if isinstance(exc, ComposioConfigurationError):
        return ComposioFailure("configuration")
    if isinstance(exc, ComposioProtocolError):
        return ComposioFailure("protocol")
    if isinstance(exc, ConnectorCustomAuthConfigRequired):
        return ComposioFailure("invalid_request", message=CUSTOM_OAUTH_CONFIG_REQUIRED_MESSAGE)
    if isinstance(exc, ComposioInvalidRequestError):
        return ComposioFailure("invalid_request", message=str(exc))
    if isinstance(exc, ComposioActivationTimeoutError):
        return ComposioFailure("timeout")
    if isinstance(exc, ComposioProviderError):
        return exc.failure
    raise RuntimeError(f"Unregistered Composio route error: {type(exc).__name__}")


async def _call_generated_sdk[ResponseT](
    operation: Awaitable[ResponseT],
    *,
    credentials: dict[str, str] | None = None,
) -> ResponseT:
    """Translate only the generated SDK's documented base error family."""

    try:
        return await operation
    except composio_client.ComposioError as exc:
        raise ComposioProviderError(_generated_sdk_failure(exc, credentials=credentials)) from exc


def _generated_sdk_failure(
    exc: composio_client.ComposioError,
    *,
    credentials: dict[str, str] | None,
) -> ComposioFailure:
    if isinstance(exc, composio_client.AuthenticationError):
        return ComposioFailure("authentication")
    if isinstance(exc, composio_client.NotFoundError):
        return ComposioFailure("not_found")
    if isinstance(exc, composio_client.APITimeoutError):
        return ComposioFailure("timeout")
    if isinstance(exc, composio_client.APIConnectionError):
        return ComposioFailure("connection")
    if isinstance(exc, composio_client.APIStatusError):
        kind: ComposioFailureKind = (
            "validation" if credentials is not None and exc.status_code in {400, 422} else "status"
        )
        return ComposioFailure(
            kind,
            status_code=exc.status_code,
            message=_safe_composio_message(
                body=exc.body,
                fallback="",
                credentials=credentials,
            ),
        )
    return ComposioFailure("protocol")


def _safe_composio_message(
    *,
    body: object,
    fallback: str,
    credentials: dict[str, str] | None,
) -> str:
    try:
        body_object = _JSON_OBJECT_ADAPTER.validate_python(body)
    except ValidationError:
        return fallback
    error = body_object.get("error")
    if isinstance(error, dict):
        message = error.get("message") or error.get("detail")
    elif isinstance(error, str):
        message = error
    else:
        message = body_object.get("message") or body_object.get("detail")
    return _bounded_scrubbed_message(message, credentials) if isinstance(message, str) else fallback


def _bounded_scrubbed_message(
    message: str,
    credentials: dict[str, str] | None,
) -> str:
    safe = message
    for value in (credentials or {}).values():
        secret = value.strip()
        if len(secret) >= 4:
            safe = safe.replace(secret, "***")
    return " ".join(safe.split())[:500]


class _ComposioMcpSessionRetired(RuntimeError):
    pass


@dataclass(eq=False)
class ComposioMcpSession:
    """User-scoped MCP configuration and its reusable HTTP connection pool."""

    url: str
    headers: dict[str, str]
    expires_at: datetime
    _http_client: httpx2.AsyncClient | None = field(default=None, init=False, repr=False)
    _active_http_leases: int = field(default=0, init=False, repr=False)
    _retired: bool = field(default=False, init=False, repr=False)

    @asynccontextmanager
    async def lease_http_client(self) -> AsyncGenerator[httpx2.AsyncClient, None]:
        if self._retired:
            raise _ComposioMcpSessionRetired
        if self._http_client is None:
            self._http_client = httpx2.AsyncClient(
                headers=self.headers,
                timeout=httpx2.Timeout(30.0, read=300.0),
                follow_redirects=True,
            )
        self._active_http_leases += 1
        try:
            yield self._http_client
        finally:
            self._active_http_leases -= 1
            if self._retired and self._active_http_leases == 0:
                await self._close_http_client()

    async def retire(self) -> None:
        self._retired = True
        if self._active_http_leases == 0:
            await self._close_http_client()

    async def _close_http_client(self) -> None:
        client = self._http_client
        self._http_client = None
        if client is not None:
            await client.aclose()


_MCP_OPERATION_ERRORS = (
    MCPError,
    _ComposioMcpSessionRetired,
    httpx2.HTTPError,
    OSError,
    TimeoutError,
    ValidationError,
)


def get_composio_client() -> AsyncComposio:
    """Return the shared generated async Composio client."""
    global _client
    if _client is None:
        if not settings.composio_api_key:
            raise ComposioConfigurationError("Composio is not configured")
        from composio_client import AsyncComposio

        if settings.composio_api_base_url:
            _client = AsyncComposio(
                api_key=settings.composio_api_key,
                base_url=settings.composio_api_base_url.rstrip("/"),
            )
        else:
            _client = AsyncComposio(api_key=settings.composio_api_key)
    return _client


def get_composio_sdk() -> Composio[OpenAITool, OpenAIToolCollection]:
    """Return the shared high-level Composio SDK client."""
    global _sdk_client
    if _sdk_client is None:
        if not settings.composio_api_key:
            raise ComposioConfigurationError("Composio is not configured")
        from composio import Composio

        if settings.composio_api_base_url:
            _sdk_client = Composio(
                api_key=settings.composio_api_key,
                base_url=settings.composio_api_base_url.rstrip("/"),
            )
        else:
            _sdk_client = Composio(api_key=settings.composio_api_key)
    return _sdk_client


async def close_composio_client() -> None:
    """Close the shared Composio HTTP clients on ASGI shutdown."""
    global _client, _sdk_client
    pending_tools = tuple(_tool_router_tools_inflight.values())
    _tool_router_tools_inflight.clear()
    for task in pending_tools:
        task.cancel()
    if pending_tools:
        await asyncio.gather(*pending_tools, return_exceptions=True)
    sessions = tuple(_tool_router_session_cache.values())
    _tool_router_session_cache.clear()
    _tool_router_tools_cache.clear()
    if sessions:
        await asyncio.gather(*(session.retire() for session in sessions))
    if _client is not None:
        await _call_generated_sdk(_client.close())
        _client = None
    if _sdk_client is not None:
        from composio import exceptions as composio_exceptions

        try:
            await asyncio.to_thread(_sdk_client.client.close)
        except composio_exceptions.ComposioError as exc:
            raise ComposioProviderError(_high_level_sdk_failure(exc)) from exc
        _sdk_client = None


def _jwt_signing_key() -> str:
    key = settings.encryption_key
    if not key:
        raise RuntimeError(
            "ENCRYPTION_KEY is not configured. Generate a 32-byte hex value and "
            "set it in backend/.env; it must be distinct from VAULT_ENCRYPTION_KEY."
        )
    return key


def create_mcp_bridge_token(user_id: str) -> str:
    """Create the short-lived credential used by legacy CLI MCP config."""
    payload = {
        "sub": "mcp",
        "user_id": user_id,
        "exp": datetime.now(UTC) + timedelta(days=30),
    }
    return jwt.encode(payload, _jwt_signing_key(), algorithm="HS256")


def verify_mcp_bridge_token(token: str) -> str:
    """Verify a legacy MCP bridge credential and return its user id."""
    payload = jwt.decode(token, _jwt_signing_key(), algorithms=["HS256"])
    if payload.get("sub") != "mcp" or not isinstance(payload.get("user_id"), str):
        raise ValueError("Invalid MCP bridge token")
    return payload["user_id"]


async def get_tool_router_mcp_session(user_id: str) -> ComposioMcpSession:
    """Return a user-scoped Composio Tool Router MCP session.

    The agent must never receive the Composio project API key. We create the
    Composio session server-side, cache its MCP URL briefly, and forward
    JSON-RPC through the authenticated Clawdi MCP endpoint.
    """
    now = datetime.now(UTC)
    cached = _tool_router_session_cache.get(user_id)
    if cached and cached.expires_at > now:
        return cached
    if cached is not None:
        await cached.retire()

    session = await _create_tool_router_mcp_session(user_id, now=now)
    _tool_router_session_cache[user_id] = session
    return session


async def invalidate_tool_router_mcp_session(user_id: str) -> None:
    """Drop a user's cached Tool Router session and schemas after connection changes."""
    session = _tool_router_session_cache.pop(user_id, None)
    _tool_router_tools_cache.pop(user_id, None)
    if session is not None:
        await session.retire()


async def get_tool_router_mcp_tools(user_id: str) -> list[JsonObject]:
    """Return session-bound tools through a cancellation-safe per-user load."""
    task = _tool_router_tools_inflight.get(user_id)
    if task is None:
        task = asyncio.create_task(_load_tool_router_mcp_tools(user_id))
        _tool_router_tools_inflight[user_id] = task
        task.add_done_callback(
            lambda completed: _finish_tool_router_mcp_tools_load(user_id, completed)
        )
    return await asyncio.shield(task)


async def _load_tool_router_mcp_tools(user_id: str) -> list[JsonObject]:
    while True:
        session = await get_tool_router_mcp_session(user_id)
        cached = _tool_router_tools_cache.get(user_id)
        if cached and cached[0] is session:
            return cached[1]

        result = await list_tool_router_mcp_tools(session)
        if _tool_router_session_cache.get(user_id) is not session:
            continue

        serialized = _JSON_OBJECT_ADAPTER.validate_json(
            result.model_dump_json(by_alias=True, exclude_none=True)
        )
        raw_tools = serialized.get("tools")
        tools = (
            [tool for tool in raw_tools if isinstance(tool, dict)]
            if isinstance(raw_tools, list)
            else []
        )
        _tool_router_tools_cache[user_id] = (session, tools)
        return tools


def _finish_tool_router_mcp_tools_load(user_id: str, task: asyncio.Task[list[JsonObject]]) -> None:
    if _tool_router_tools_inflight.get(user_id) is task:
        _tool_router_tools_inflight.pop(user_id, None)
    if not task.cancelled():
        task.exception()


async def list_tool_router_mcp_tools(session: ComposioMcpSession) -> ListToolsResult:
    """List tools through a fully initialized, operation-scoped MCP client."""
    try:
        async with _tool_router_mcp_client(session) as client:
            response = await client.list_tools()
            return _normalize_mcp_response(response, ListToolsResult)
    except _MCP_OPERATION_ERRORS as exc:
        logger.warning(
            "Composio MCP operation failed: operation=list_tools error_type=%s",
            type(exc).__name__,
        )
        raise ComposioMcpUpstreamError("Composio MCP operation failed") from None


async def call_tool_router_mcp_tool(
    session: ComposioMcpSession, name: str, arguments: JsonObject
) -> CallToolResult:
    """Call a tool through a fully initialized, operation-scoped MCP client."""
    try:
        async with _tool_router_mcp_client(session) as client:
            response = await client.call_tool(name, arguments)
            return _normalize_mcp_response(response, CallToolResult)
    except _MCP_OPERATION_ERRORS as exc:
        logger.warning(
            "Composio MCP operation failed: operation=call_tool error_type=%s",
            type(exc).__name__,
        )
        raise ComposioMcpUpstreamError("Composio MCP operation failed") from None


def _normalize_mcp_response[WireModelT: BaseModel](
    response: object,
    model: type[WireModelT],
) -> WireModelT:
    if not isinstance(response, BaseModel):
        raise ComposioMcpUpstreamError("Composio MCP returned an invalid response")
    try:
        return model.model_validate(response.model_dump(mode="python"))
    except ValidationError:
        raise ComposioMcpUpstreamError("Composio MCP returned an invalid response") from None


@asynccontextmanager
async def _tool_router_mcp_client(
    session: ComposioMcpSession,
) -> AsyncGenerator[Client, None]:
    # Keep Composio credentials on this server-owned HTTP client. These are
    # the MCP SDK's documented settings for a caller-provided HTTP client.
    # The SDK leaves caller-provided clients open; the session lease owns it.
    async with session.lease_http_client() as http_client:
        transport = streamable_http_client(session.url, http_client=http_client)
        async with Client(transport) as client:
            yield client


async def _create_tool_router_mcp_session(
    user_id: str, *, now: datetime | None = None
) -> ComposioMcpSession:
    from composio import exceptions as composio_exceptions

    sdk = get_composio_sdk()
    try:
        session = await asyncio.to_thread(sdk.sessions.create, user_id=user_id, mcp=True)
    except composio_exceptions.ComposioError as exc:
        raise ComposioProviderError(_high_level_sdk_failure(exc)) from exc
    try:
        mcp = _ToolRouterMcpConfig.model_validate(session.mcp)
    except ValidationError:
        raise ComposioMcpUpstreamError(
            "Composio session returned invalid MCP configuration"
        ) from None

    issued_at = now or datetime.now(UTC)
    return ComposioMcpSession(
        url=mcp.url,
        headers=mcp.headers,
        expires_at=issued_at + timedelta(minutes=30),
    )


def _high_level_sdk_failure(exc: HighLevelComposioError) -> ComposioFailure:
    from composio import exceptions as composio_exceptions

    if isinstance(exc, composio_exceptions.NotFoundError):
        return ComposioFailure("not_found")
    if isinstance(exc, composio_exceptions.ComposioSDKTimeoutError):
        return ComposioFailure("timeout")
    if isinstance(exc, composio_exceptions.ValidationError):
        return ComposioFailure(
            "validation",
            message=_bounded_scrubbed_message(exc.message, None),
        )
    if isinstance(exc, composio_exceptions.HTTPError):
        return ComposioFailure(
            "status",
            status_code=exc.status_code,
            message=_bounded_scrubbed_message(exc.message, None),
        )
    return ComposioFailure("protocol")


async def get_connected_accounts(user_id: str) -> list[ConnectorConnectionResponse]:
    """List active connected accounts for a Composio user."""
    accounts = await _get_active_connected_accounts(user_id)
    return [_serialize_connected_account(account) for account in accounts]


async def get_connected_account_identities(user_id: str) -> list[ConnectorAccountIdentity]:
    """List safe account and tenant labels without exposing provider payloads."""
    accounts = await _get_active_connected_accounts(user_id)
    return [_serialize_connected_account_identity(account) for account in accounts]


async def _get_active_connected_accounts(user_id: str) -> list[_ConnectedAccount]:
    client = get_composio_client()
    accounts: list[_ConnectedAccount] = []
    cursor: str | None = None

    while True:
        if cursor:
            raw_response = await _call_generated_sdk(
                client.connected_accounts.list(
                    user_ids=[user_id],
                    statuses=["ACTIVE"],
                    limit=100,
                    cursor=cursor,
                )
            )
        else:
            raw_response = await _call_generated_sdk(
                client.connected_accounts.list(
                    user_ids=[user_id],
                    statuses=["ACTIVE"],
                    limit=100,
                )
            )
        response = _normalize_sdk_response(raw_response, _ConnectedAccountPage)
        accounts.extend(response.items)
        cursor = response.next_cursor
        if not cursor:
            break
    return accounts


def _serialize_connected_account(account: _ConnectedAccount) -> ConnectorConnectionResponse:
    return ConnectorConnectionResponse(
        id=account.id,
        app_name=account.toolkit.slug,
        status=account.status,
        created_at=account.created_at,
        account_display=_account_display_label(account),
    )


def _serialize_connected_account_identity(account: _ConnectedAccount) -> ConnectorAccountIdentity:
    state_value = _json_object(account.state.get("val"))
    authed_user = _json_object(state_value.get("authed_user") or state_value.get("authedUser"))
    containers = (account.data, state_value, authed_user)
    return ConnectorAccountIdentity(
        id=account.id,
        app_name=account.toolkit.slug,
        status=account.status,
        account_display=_account_display_label(account),
        organization_display=_first_identity_label(
            containers,
            (
                "organization",
                "organization_name",
                "organizationName",
                "org_name",
                "orgName",
                "workspace",
                "workspace_name",
                "workspaceName",
                "team",
                "team_name",
                "teamName",
            ),
        ),
        tenant_display=_first_identity_label(
            containers,
            ("tenant", "tenant_name", "tenantName"),
        ),
    )


def _account_display_label(account: _ConnectedAccount) -> str | None:
    """Best-effort user-facing label for a Composio connected account."""
    for value in (account.alias, account.word_id):
        if value is not None and value.strip():
            return value.strip()

    state_value = _json_object(account.state.get("val"))
    authed_user = _json_object(state_value.get("authed_user") or state_value.get("authedUser"))
    containers = (account.data, state_value, authed_user)
    for container in containers:
        for key in ("connectionLabel", "connection_label", "label", "email", "username"):
            value = container.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


def _first_identity_label(
    containers: tuple[JsonObject, ...],
    keys: tuple[str, ...],
) -> str | None:
    for container in containers:
        for key in keys:
            label = _identity_label(container.get(key))
            if label is not None:
                return label
    return None


def _identity_label(value: JsonValue | None) -> str | None:
    if isinstance(value, str):
        label = value.strip()
        return label[:200] if label else None
    if isinstance(value, dict):
        for key in ("display_name", "displayName", "name", "slug", "id"):
            nested = value.get(key)
            if isinstance(nested, str) and nested.strip():
                return nested.strip()[:200]
    return None


def _json_object(value: JsonValue | None) -> JsonObject:
    return value if isinstance(value, dict) else {}


async def create_connect_link(
    entity_id: str, app_name: str, redirect_url: str | None = None
) -> ConnectorConnectResponse:
    """Create a Composio Connect Link for an OAuth connector."""
    client = get_composio_client()
    toolkit = await _get_toolkit_detail(app_name)
    auth_type = _primary_auth_type(toolkit)

    if auth_type in _INSTANT_AUTH_TYPES:
        return ConnectorConnectResponse(
            connect_url=redirect_url or settings.web_origin or "/connectors",
            id="",
        )

    if auth_type not in _REDIRECT_AUTH_TYPES:
        raise ComposioInvalidRequestError("Connector requires credentials")

    auth_config = await _get_redirect_auth_config(
        client=client,
        toolkit=toolkit,
        app_name=app_name,
        auth_type=auth_type,
    )
    if redirect_url:
        raw_result = await _call_generated_sdk(
            client.link.create(
                auth_config_id=auth_config.id,
                user_id=entity_id,
                callback_url=redirect_url,
            )
        )
    else:
        raw_result = await _call_generated_sdk(
            client.link.create(
                auth_config_id=auth_config.id,
                user_id=entity_id,
            )
        )
    result = _normalize_sdk_response(raw_result, _ConnectLinkResponse)
    await invalidate_tool_router_mcp_session(entity_id)
    return ConnectorConnectResponse(
        connect_url=result.redirect_url,
        id=result.connected_account_id,
    )


async def get_auth_fields(app_name: str) -> ConnectorAuthFieldsResponse:
    """Return credential fields for a non-OAuth connector."""
    toolkit = await _get_toolkit_detail(app_name)
    auth_type = _primary_auth_type(toolkit)
    auth_scheme = _auth_type_to_composio_scheme(auth_type)
    if auth_type in _INSTANT_AUTH_TYPES:
        return ConnectorAuthFieldsResponse(
            auth_scheme=auth_scheme,
            expected_input_fields=[],
        )

    detail_fields = _auth_fields_from_toolkit_detail(toolkit, auth_scheme)
    if detail_fields:
        return ConnectorAuthFieldsResponse(
            auth_scheme=auth_scheme,
            expected_input_fields=detail_fields,
        )

    client = get_composio_client()
    auth_config = await _get_or_create_auth_config(
        client=client,
        app_name=app_name,
        auth_type=auth_type,
        managed=False,
    )
    retrieved = await _call_generated_sdk(client.auth_configs.retrieve(auth_config.id))
    response = _normalize_sdk_response(retrieved, _AuthConfigRetrieveResponse)
    fields = [_serialize_auth_field(field) for field in response.expected_input_fields or []]
    return ConnectorAuthFieldsResponse(
        auth_scheme=_str_or_none(response.auth_scheme) or auth_scheme,
        expected_input_fields=fields,
    )


async def connect_with_credentials(
    user_id: str, app_name: str, credentials: dict[str, str]
) -> ConnectorCredentialsConnectResponse:
    """Create a connected account with user-supplied credentials."""
    client = get_composio_client()
    toolkit = await _get_toolkit_detail(app_name)
    auth_type = _primary_auth_type(toolkit)
    if auth_type in _REDIRECT_AUTH_TYPES:
        raise ComposioInvalidRequestError("Connector uses redirect auth")
    if auth_type in _INSTANT_AUTH_TYPES:
        raise ComposioInvalidRequestError("Connector does not require credentials")
    return await _create_non_oauth_connection(
        client=client,
        user_id=user_id,
        app_name=app_name,
        auth_type=auth_type,
        credentials=credentials,
    )


async def _create_non_oauth_connection(
    *,
    client: AsyncComposio,
    user_id: str,
    app_name: str,
    auth_type: str,
    credentials: dict[str, str],
) -> ConnectorCredentialsConnectResponse:
    auth_scheme = _auth_type_to_composio_scheme(auth_type)
    auth_config = await _get_or_create_auth_config(
        client=client,
        app_name=app_name,
        auth_type=auth_type,
        managed=False,
    )
    request = _connected_account_create_request(
        auth_config_id=auth_config.id,
        user_id=user_id,
        auth_scheme=auth_scheme,
        credentials=credentials,
    )
    raw_result = await _call_generated_sdk(
        client.connected_accounts.create(**request),
        credentials=credentials,
    )
    result = _normalize_sdk_response(raw_result, _ConnectedAccountCreateResponse)
    account_id = result.id
    status = result.status
    try:
        if status in _ACTIVE_OR_PENDING_STATUSES:
            status = await _wait_for_connection_status(client, account_id, status)
    finally:
        await invalidate_tool_router_mcp_session(user_id)
    if status in _ACTIVE_OR_PENDING_STATUSES:
        raise ComposioActivationTimeoutError("Composio did not activate the connection in time")
    return ConnectorCredentialsConnectResponse(
        id=account_id,
        status=status.lower(),
        ok=status == "ACTIVE",
    )


async def _wait_for_connection_status(
    client: AsyncComposio,
    connected_account_id: str,
    initial_status: str,
) -> str:
    status = initial_status
    deadline = asyncio.get_running_loop().time() + 15.0
    while status in _ACTIVE_OR_PENDING_STATUSES and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(1.0)
        raw_account = await _call_generated_sdk(
            client.connected_accounts.retrieve(connected_account_id)
        )
        account = _normalize_sdk_response(raw_account, _ConnectedAccountStatusResponse)
        status = account.status
    return status


async def disconnect_account(connected_account_id: str) -> bool:
    """Disconnect/revoke a connected account."""
    client = get_composio_client()
    raw_response = await _call_generated_sdk(client.connected_accounts.delete(connected_account_id))
    response = _normalize_sdk_response(raw_response, _ConnectedAccountDeleteResponse)
    return response.success


async def get_app_tools(app_name: str) -> list[ConnectorToolResponse]:
    """List available tools/actions for a specific Composio toolkit."""
    client = get_composio_client()
    tools: list[_Tool] = []
    cursor: str | None = None

    while True:
        if cursor:
            raw_response = await _call_generated_sdk(
                client.tools.list(
                    toolkit_slug=app_name,
                    include_deprecated=False,
                    limit=100,
                    cursor=cursor,
                )
            )
        else:
            raw_response = await _call_generated_sdk(
                client.tools.list(
                    toolkit_slug=app_name,
                    include_deprecated=False,
                    limit=100,
                )
            )
        response = _normalize_sdk_response(raw_response, _ToolPage)
        tools.extend(response.items)
        cursor = response.next_cursor
        if not cursor or len(tools) >= 500:
            break

    return [_serialize_tool(tool) for tool in tools]


def _serialize_tool(tool: _Tool) -> ConnectorToolResponse:
    return ConnectorToolResponse(
        name=tool.slug,
        display_name=tool.name,
        description=tool.description[:300],
        is_deprecated=tool.is_deprecated,
    )


async def _get_or_create_auth_config(
    *,
    client: AsyncComposio,
    app_name: str,
    auth_type: str,
    managed: bool,
) -> _AuthConfig:
    auth_scheme = _auth_type_to_composio_scheme(auth_type)
    existing = await _find_auth_config(client, app_name, auth_scheme, managed=managed)
    if existing is not None:
        return existing

    request = _auth_config_create_request(
        app_name=app_name,
        auth_scheme=auth_scheme,
        managed=managed,
    )
    raw_created = await _call_generated_sdk(client.auth_configs.create(**request))
    created = _normalize_sdk_response(raw_created, _AuthConfigCreateResponse)
    return created.auth_config


def _connected_account_create_request(
    *,
    auth_config_id: str,
    user_id: str,
    auth_scheme: str,
    credentials: dict[str, str],
) -> ConnectedAccountCreateParams:
    """Validate a complete request against the SDK's public generated type."""
    from composio_client.types import ConnectedAccountCreateParams
    from pydantic import TypeAdapter

    return TypeAdapter(ConnectedAccountCreateParams).validate_python(
        {
            "auth_config": {"id": auth_config_id},
            "connection": {
                "user_id": user_id,
                "state": {
                    "auth_scheme": auth_scheme,
                    "val": {"status": "ACTIVE", **credentials},
                },
            },
        }
    )


def _auth_config_create_request(
    *, app_name: str, auth_scheme: str, managed: bool
) -> AuthConfigCreateParams:
    """Validate a complete request against the SDK's public generated type."""
    from composio_client.types import AuthConfigCreateParams
    from pydantic import TypeAdapter

    if managed:
        auth_config: object = {
            "type": "use_composio_managed_auth",
            "name": _auth_config_name(app_name, "managed"),
        }
    else:
        auth_config = {
            "type": "use_custom_auth",
            "auth_scheme": auth_scheme,
            "credentials": {},
            "name": _auth_config_name(app_name, auth_scheme.lower()),
        }
    return TypeAdapter(AuthConfigCreateParams).validate_python(
        {"toolkit": {"slug": app_name}, "auth_config": auth_config}
    )


async def _get_redirect_auth_config(
    *,
    client: AsyncComposio,
    toolkit: _Toolkit,
    app_name: str,
    auth_type: str,
) -> _AuthConfig:
    managed_schemes = _composio_managed_auth_schemes(toolkit)
    if managed_schemes is None or _has_composio_managed_auth_scheme(toolkit, auth_type):
        return await _get_or_create_auth_config(
            client=client,
            app_name=app_name,
            auth_type=auth_type,
            managed=True,
        )

    auth_scheme = _auth_type_to_composio_scheme(auth_type)
    existing = await _find_auth_config(client, app_name, auth_scheme, managed=False)
    if existing is None:
        raise ConnectorCustomAuthConfigRequired(app_name, auth_scheme)
    return existing


async def _find_auth_config(
    client: AsyncComposio,
    app_name: str,
    auth_scheme: str,
    *,
    managed: bool,
) -> _AuthConfig | None:
    cursor: str | None = None
    while True:
        if cursor:
            raw_response = await _call_generated_sdk(
                client.auth_configs.list(
                    toolkit_slug=app_name,
                    is_composio_managed=managed,
                    show_disabled=False,
                    limit=100,
                    cursor=cursor,
                )
            )
        else:
            raw_response = await _call_generated_sdk(
                client.auth_configs.list(
                    toolkit_slug=app_name,
                    is_composio_managed=managed,
                    show_disabled=False,
                    limit=100,
                )
            )
        response = _normalize_sdk_response(raw_response, _AuthConfigPage)
        for item in response.items:
            if item.status != "ENABLED":
                continue
            if item.is_composio_managed is not None and item.is_composio_managed != managed:
                continue
            item_scheme = _str_or_none(item.auth_scheme)
            if managed and item_scheme and _normalize_composio_scheme(item_scheme) != auth_scheme:
                continue
            if not managed and (
                not item_scheme or _normalize_composio_scheme(item_scheme) != auth_scheme
            ):
                continue
            return item
        cursor = response.next_cursor
        if not cursor:
            return None


async def _connect_disabled_reason(
    client: AsyncComposio,
    toolkit: _Toolkit,
    app_name: str,
    auth_type: str,
    *,
    custom_auth_config_index: frozenset[tuple[str, str]] | None = None,
) -> str | None:
    if not _requires_preconfigured_custom_oauth(toolkit, auth_type):
        return None

    auth_scheme = _auth_type_to_composio_scheme(auth_type)
    toolkit_slug = _normalize_toolkit_slug(app_name)
    existing = (
        (toolkit_slug, auth_scheme) in custom_auth_config_index
        if custom_auth_config_index is not None and toolkit_slug is not None
        else (await _find_auth_config(client, app_name, auth_scheme, managed=False)) is not None
    )
    if existing:
        return None
    return CUSTOM_OAUTH_CONFIG_REQUIRED_MESSAGE


async def _annotate_connect_status(
    client: AsyncComposio,
    toolkit: _Toolkit,
    app: ConnectorAvailableAppResponse,
    *,
    custom_auth_config_index: frozenset[tuple[str, str]] | None = None,
) -> ConnectorAvailableAppResponse:
    reason = await _connect_disabled_reason(
        client,
        toolkit,
        app.name,
        app.auth_type,
        custom_auth_config_index=custom_auth_config_index,
    )
    return app.model_copy(
        update={
            "connect_disabled": reason is not None,
            "connect_disabled_reason": reason,
        }
    )


_custom_auth_config_index: frozenset[tuple[str, str]] | None = None
_custom_auth_config_index_at: datetime | None = None


async def _get_custom_auth_config_index(
    client: AsyncComposio,
) -> frozenset[tuple[str, str]]:
    """Return enabled custom auth configs keyed by (toolkit slug, auth scheme)."""
    global _custom_auth_config_index, _custom_auth_config_index_at
    now = datetime.now(UTC)
    if _custom_auth_config_index is not None and _custom_auth_config_index_at is not None:
        if (now - _custom_auth_config_index_at) < _COMPOSIO_METADATA_CACHE_TTL:
            return _custom_auth_config_index

    index: set[tuple[str, str]] = set()
    cursor: str | None = None
    while True:
        if cursor:
            raw_response = await _call_generated_sdk(
                client.auth_configs.list(
                    is_composio_managed=False,
                    show_disabled=False,
                    limit=100,
                    cursor=cursor,
                )
            )
        else:
            raw_response = await _call_generated_sdk(
                client.auth_configs.list(
                    is_composio_managed=False,
                    show_disabled=False,
                    limit=100,
                )
            )
        response = _normalize_sdk_response(raw_response, _AuthConfigPage)
        for item in response.items:
            if item.status != "ENABLED":
                continue
            if item.is_composio_managed:
                continue
            toolkit_slug = _auth_config_toolkit_slug(item)
            auth_scheme = _normalize_composio_scheme(item.auth_scheme)
            if toolkit_slug and auth_scheme:
                index.add((toolkit_slug, auth_scheme))
        cursor = response.next_cursor
        if not cursor:
            break

    _custom_auth_config_index = frozenset(index)
    _custom_auth_config_index_at = now
    return _custom_auth_config_index


def _auth_config_toolkit_slug(auth_config: _AuthConfig) -> str | None:
    return (
        _normalize_toolkit_slug(auth_config.toolkit.slug)
        if auth_config.toolkit is not None
        else None
    )


def _normalize_toolkit_slug(value: str | None) -> str | None:
    text = _str_or_none(value)
    return text.lower() if text else None


def _auth_config_name(app_name: str, suffix: str) -> str:
    clean = re.sub(r"[^a-zA-Z0-9_.-]+", "-", app_name.strip()).strip("-")
    return f"Clawdi {clean or 'connector'} {suffix}"


def _auth_type_to_composio_scheme(auth_type: str) -> str:
    normalized = _normalize_auth_type(auth_type)
    if normalized == "oauth":
        return "OAUTH2"
    if normalized == "oauth1":
        return "OAUTH1"
    if normalized == "oauth2":
        return "OAUTH2"
    if normalized in {"none", "no_auth"}:
        return "NO_AUTH"
    if normalized == "bearer":
        return "BEARER_TOKEN"
    return normalized.upper()


def _normalize_composio_scheme(value: str | None) -> str:
    text = (value or "").strip().upper().replace("-", "_").replace(" ", "_")
    if text == "BEARER":
        return "BEARER_TOKEN"
    if text == "APIKEY":
        return "API_KEY"
    if text == "OAUTH":
        return "OAUTH2"
    return text


def _normalize_auth_type(value: str) -> str:
    text = value.strip().lower().replace("-", "_").replace(" ", "_")
    if text == "oauth":
        return "oauth2"
    if text == "apikey":
        return "api_key"
    if text == "bearer":
        return "bearer_token"
    if text == "basic_auth":
        return "basic"
    if text == "noauth":
        return "no_auth"
    return text


def _has_composio_managed_auth_scheme(toolkit: _Toolkit, auth_type: str) -> bool:
    managed_schemes = _composio_managed_auth_schemes(toolkit)
    if managed_schemes is None:
        return False
    auth_scheme = _auth_type_to_composio_scheme(auth_type)
    return any(_auth_type_to_composio_scheme(scheme) == auth_scheme for scheme in managed_schemes)


def _requires_preconfigured_custom_oauth(toolkit: _Toolkit, auth_type: str) -> bool:
    if auth_type not in _REDIRECT_AUTH_TYPES:
        return False
    managed_schemes = _composio_managed_auth_schemes(toolkit)
    if managed_schemes is None:
        # Older/partial toolkit payloads may omit the field. Treat that
        # as unknown instead of disabling a connector from incomplete
        # metadata; the connect path falls back to the previous managed-auth
        # behavior unless the current payload explicitly says custom auth is
        # required.
        return False
    return not _has_composio_managed_auth_scheme(toolkit, auth_type)


def _composio_managed_auth_schemes(toolkit: _Toolkit) -> list[str] | None:
    return toolkit.composio_managed_auth_schemes


def _serialize_auth_field(
    field: _AuthField,
    *,
    required: bool | None = None,
) -> ConnectorAuthFieldResponse:
    display_name = field.display_name.strip() or field.name
    field_type = field.type.strip() or "string"
    is_secret = field.is_secret or _looks_secret_field(field.name, field_type)
    return ConnectorAuthFieldResponse(
        name=field.name,
        display_name=display_name,
        description=field.description,
        type=field_type,
        required=required if required is not None else field.required,
        is_secret=is_secret,
        expected_from_customer=field.expected_from_customer,
        default=_str_or_none(field.default),
    )


def _looks_secret_field(name: str, field_type: str) -> bool:
    text = f"{name} {field_type}".lower()
    return any(token in text for token in ("password", "secret", "token", "api_key", "apikey"))


def _auth_fields_from_toolkit_detail(
    toolkit: _Toolkit,
    auth_scheme: str,
) -> list[ConnectorAuthFieldResponse]:
    selected = next(
        (
            detail
            for detail in toolkit.auth_config_details or []
            if _auth_type_to_composio_scheme(detail.mode) == auth_scheme
        ),
        None,
    )
    if selected is None:
        return []

    initiation = selected.fields.connected_account_initiation
    return [
        *[_serialize_auth_field(field, required=True) for field in initiation.required],
        *[_serialize_auth_field(field, required=False) for field in initiation.optional],
    ]


def _primary_auth_type(toolkit: _Toolkit) -> str:
    """Lowercase auth scheme for connector routing."""
    if toolkit.no_auth:
        return "none"

    managed_schemes = [
        _normalize_auth_type(value) for value in toolkit.composio_managed_auth_schemes or []
    ]
    all_schemes = [
        *managed_schemes,
        *[_normalize_auth_type(value) for value in toolkit.auth_schemes or []],
    ]
    detail_schemes = [
        _normalize_auth_type(detail.mode) for detail in toolkit.auth_config_details or []
    ]
    all_schemes.extend(scheme for scheme in detail_schemes if scheme)

    for scheme in all_schemes:
        if scheme in _REDIRECT_AUTH_TYPES:
            return scheme
    for scheme in all_schemes:
        if scheme:
            return scheme
    raise ConnectorAuthMetadataError(f"Connector auth metadata unavailable for {toolkit.slug}")


def _serialize_app(
    toolkit: _Toolkit,
    *,
    allow_unknown_auth_type: bool = False,
) -> ConnectorAvailableAppResponse:
    try:
        auth_type = _primary_auth_type(toolkit)
    except ConnectorAuthMetadataError:
        if not allow_unknown_auth_type:
            raise
        auth_type = "unknown"
    return ConnectorAvailableAppResponse(
        name=toolkit.slug,
        display_name=toolkit.name or _titleize_slug(toolkit.slug),
        logo=toolkit.meta.logo,
        description=toolkit.meta.description[:200],
        auth_type=auth_type,
        connect_disabled=False,
        connect_disabled_reason=None,
    )


def _titleize_slug(slug: str) -> str:
    clean = slug.lstrip("_-")
    spaced = re.sub(r"([a-z])([A-Z])", r"\1 \2", clean)
    spaced = spaced.replace("_", " ").replace("-", " ")
    return spaced.title()


_toolkits_cache: list[_Toolkit] | None = None
_toolkits_cache_at: datetime | None = None


async def _get_all_toolkits() -> list[_Toolkit]:
    """Fetch and cache the Composio toolkit catalog."""
    global _toolkits_cache, _toolkits_cache_at
    now = datetime.now(UTC)
    if _toolkits_cache is not None and _toolkits_cache_at is not None:
        if (now - _toolkits_cache_at) < _COMPOSIO_METADATA_CACHE_TTL:
            return _toolkits_cache

    client = get_composio_client()
    toolkits: list[_Toolkit] = []
    cursor: str | None = None
    while True:
        if cursor:
            raw_response = await _call_generated_sdk(
                client.toolkits.list(
                    managed_by="composio",
                    sort_by="usage",
                    limit=1000,
                    cursor=cursor,
                )
            )
        else:
            raw_response = await _call_generated_sdk(
                client.toolkits.list(
                    managed_by="composio",
                    sort_by="usage",
                    limit=1000,
                )
            )
        response = _normalize_sdk_response(raw_response, _ToolkitPage)
        toolkits.extend(response.items)
        cursor = response.next_cursor
        if not cursor:
            break

    _toolkits_cache = toolkits
    _toolkits_cache_at = now
    return toolkits


async def get_app_by_name(name: str) -> ConnectorAvailableAppResponse | None:
    """Look up one toolkit by Composio slug."""
    client = get_composio_client()
    toolkits = await _get_all_toolkits()
    for toolkit in toolkits:
        app = _serialize_app(toolkit, allow_unknown_auth_type=True)
        if app.name == name:
            detail = await _get_toolkit_detail(name)
            return await _annotate_connect_status(client, detail, _serialize_app(detail))
    return None


async def _get_toolkit_detail(name: str) -> _Toolkit:
    client = get_composio_client()
    response = await _call_generated_sdk(client.toolkits.retrieve(name))
    return _normalize_sdk_response(response, _Toolkit)


async def get_available_apps(
    search: str | None = None,
    page: int = 1,
    page_size: int = 24,
) -> ConnectorAppPage:
    """Paginated catalog query.

    The catalog is a user-facing list of connectors they can actually
    set up in this deployment. OAuth toolkits that require a custom
    Composio auth config are hidden until that config exists; direct
    detail lookup still reports the setup reason for admins/deep links.
    """
    client = get_composio_client()
    toolkits = await _get_all_toolkits()
    items = [
        (toolkit, _serialize_app(toolkit, allow_unknown_auth_type=True)) for toolkit in toolkits
    ]
    query = (search or "").strip().casefold()
    if query:
        ranked_items = [
            (rank, toolkit, app)
            for toolkit, app in items
            if (rank := _connector_search_rank(app, query)) is not None
        ]
        ranked_items.sort(key=lambda item: item[0])
        items = [(toolkit, app) for _, toolkit, app in ranked_items]
    needs_custom_oauth = any(
        _requires_preconfigured_custom_oauth(
            toolkit,
            app.auth_type,
        )
        for toolkit, app in items
    )
    custom_auth_config_index: frozenset[tuple[str, str]] = (
        await _get_custom_auth_config_index(client) if needs_custom_oauth else frozenset()
    )
    visible_items: list[ConnectorAvailableAppResponse] = []
    for toolkit, app in items:
        annotated = await _annotate_connect_status(
            client,
            toolkit,
            app,
            custom_auth_config_index=custom_auth_config_index,
        )
        if not annotated.connect_disabled:
            visible_items.append(annotated)

    total = len(visible_items)
    start = max(0, (page - 1) * page_size)
    end = start + page_size
    return {
        "items": visible_items[start:end],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


def _connector_search_rank(app: ConnectorAvailableAppResponse, query: str) -> int | None:
    identity = (app.display_name.casefold(), app.name.casefold())
    for index, value in enumerate(identity):
        if value == query:
            return index
    for index, value in enumerate(identity):
        if value.startswith(query):
            return len(identity) + index
    for index, value in enumerate(identity):
        if query in value:
            return len(identity) * 2 + index
    if query in app.description.casefold():
        return len(identity) * 3
    fields = (*identity, app.description.casefold())
    terms = tuple(dict.fromkeys(query.split()))
    if terms and all(any(term in field for field in fields) for term in terms):
        supporting_matches = sum(any(term in field for field in fields[2:]) for term in terms)
        return len(identity) * 3 + 1 + supporting_matches
    return None


def _str_or_none(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.strip()
    return text or None
