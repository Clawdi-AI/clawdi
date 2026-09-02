import logging

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.auth import AuthContext, require_clerk_id, require_user_auth_short_session
from app.core.config import settings
from app.schemas.common import Paginated
from app.schemas.connector import (
    ConnectorAuthFieldsResponse,
    ConnectorAvailableAppResponse,
    ConnectorConnectionResponse,
    ConnectorConnectResponse,
    ConnectorCredentialsConnectRequest,
    ConnectorCredentialsConnectResponse,
    ConnectorDisconnectResponse,
    ConnectorMcpConfigResponse,
    ConnectorToolResponse,
    ConnectRequest,
)
from app.services.composio import (
    ComposioRouteError,
    ConnectorAuthMetadataError,
    connect_with_credentials,
    create_connect_link,
    create_mcp_bridge_token,
    disconnect_account,
    get_app_by_name,
    get_app_tools,
    get_auth_fields,
    get_available_apps,
    get_connected_accounts,
    invalidate_tool_router_mcp_session,
    normalize_composio_failure,
)

log = logging.getLogger(__name__)
router = APIRouter(prefix="/connectors", tags=["connectors"])


def _is_composio_auth_error(exc: ComposioRouteError) -> bool:
    """True when the configured Composio key is invalid/rotated.

    Read endpoints degrade to "nothing connected" instead of 500ing the
    whole Connectors page — a placeholder or expired key (preview
    deployments, fresh self-hosted installs) should look like an
    unconfigured integration, not an outage.
    """
    return normalize_composio_failure(exc).kind == "authentication"


_REDIRECT_AUTH_TYPES = {
    "oauth",
    "oauth1",
    "oauth2",
    "dcr_oauth",
    "composio_link",
    "none",
    "no_auth",
}


def _map_composio_error(exc: ComposioRouteError) -> HTTPException:
    """Map the adapter's sanitized failure record to the public HTTP contract."""
    failure = normalize_composio_failure(exc)
    if failure.kind == "metadata":
        return HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "Connector auth metadata unavailable",
        )
    if failure.kind == "configuration":
        return HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Composio not configured")
    if failure.kind == "invalid_request":
        return HTTPException(
            status.HTTP_400_BAD_REQUEST,
            failure.message or "Invalid connector request",
        )
    if failure.kind == "not_found":
        return HTTPException(status.HTTP_404_NOT_FOUND, "Connector not found")
    if failure.kind == "timeout":
        return HTTPException(
            status.HTTP_504_GATEWAY_TIMEOUT,
            "Composio took too long to respond. Please retry.",
        )
    if failure.kind == "validation":
        return HTTPException(
            status.HTTP_400_BAD_REQUEST,
            failure.message or "Invalid credentials",
        )
    if failure.kind == "status":
        if failure.status_code == status.HTTP_404_NOT_FOUND:
            return HTTPException(status.HTTP_404_NOT_FOUND, "Connector not found")
        if failure.status_code in {
            status.HTTP_408_REQUEST_TIMEOUT,
            status.HTTP_504_GATEWAY_TIMEOUT,
        }:
            return HTTPException(
                status.HTTP_504_GATEWAY_TIMEOUT,
                "Composio took too long to respond. Please retry.",
            )
        if failure.status_code in {status.HTTP_400_BAD_REQUEST, 422}:
            return HTTPException(
                status.HTTP_400_BAD_REQUEST,
                failure.message or "Invalid connector request",
            )
    if failure.kind in {"authentication", "connection", "protocol", "status"}:
        return HTTPException(status.HTTP_502_BAD_GATEWAY, "Composio request failed")
    return HTTPException(status.HTTP_502_BAD_GATEWAY, "Composio request failed")


@router.get("")
async def list_connections(
    auth: AuthContext = Depends(require_user_auth_short_session),
) -> list[ConnectorConnectionResponse]:
    """List user's connected services."""
    if not settings.composio_api_key:
        return []
    clerk_id = require_clerk_id(auth)
    try:
        accounts = await get_connected_accounts(clerk_id)
    except ComposioRouteError as exc:
        if _is_composio_auth_error(exc):
            log.warning("composio_key_invalid path=connectors_list")
            return []
        raise _map_composio_error(exc) from exc
    # The dashboard refetches connections after OAuth redirects complete.
    # Composio Tool Router sessions capture the active account set, so
    # observing the latest connected-account state should force the next
    # MCP bridge call to create a fresh session.
    await invalidate_tool_router_mcp_session(clerk_id)
    return [ConnectorConnectionResponse.model_validate(account) for account in accounts]


@router.get("/available")
async def list_available_apps(
    auth: AuthContext = Depends(require_user_auth_short_session),
    search: str | None = Query(default=None, max_length=100),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=24, ge=1, le=100),
) -> Paginated[ConnectorAvailableAppResponse]:
    """Paginated Composio app catalog. Server holds the full list in a
    5-min in-process cache and slices per request, so paginating doesn't
    cost a Composio roundtrip per page and the browser only ships one
    page at a time. Search is substring across slug, display name, and
    description (server-side, before pagination)."""
    if not settings.composio_api_key:
        return Paginated[ConnectorAvailableAppResponse](
            items=[], total=0, page=page, page_size=page_size
        )
    try:
        page_data = await get_available_apps(search=search, page=page, page_size=page_size)
    except ComposioRouteError as exc:
        if _is_composio_auth_error(exc):
            log.warning("composio_key_invalid path=connectors_available")
            return Paginated[ConnectorAvailableAppResponse](
                items=[], total=0, page=page, page_size=page_size
            )
        raise _map_composio_error(exc) from exc
    return Paginated[ConnectorAvailableAppResponse](
        items=page_data["items"],
        total=page_data["total"],
        page=page_data["page"],
        page_size=page_data["page_size"],
    )


@router.get("/available/{app_name}")
async def get_available_app(
    app_name: str,
    auth: AuthContext = Depends(require_user_auth_short_session),
) -> ConnectorAvailableAppResponse:
    """Single-app metadata lookup — used by the detail page so it doesn't
    have to page through the whole catalog to find one app's display name.
    Re-uses the cache that `/available` populates."""
    if not settings.composio_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Composio not configured")
    try:
        app = await get_app_by_name(app_name)
    except ComposioRouteError as exc:
        raise _map_composio_error(exc) from exc
    if app is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Connector not found")
    return app


@router.post("/{app_name}/connect")
async def connect_app(
    app_name: str,
    body: ConnectRequest | None = None,
    auth: AuthContext = Depends(require_user_auth_short_session),
) -> ConnectorConnectResponse:
    """Generate OAuth connect link for an app.

    Forwards `body.redirect_url` to Composio so the OAuth provider
    sends the user back to the caller's chosen landing page (e.g.
    the connector detail page on the frontend). If omitted, Composio
    falls back to its own managed callback.
    """
    if not settings.composio_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Composio not configured")
    redirect_url = body.redirect_url if body else None
    try:
        app = await get_app_by_name(app_name)
        if app is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Connector not found")
        auth_type = app.auth_type.strip().lower()
        if not auth_type or auth_type == "unknown":
            raise ConnectorAuthMetadataError(f"Connector auth metadata unavailable for {app_name}")
        if app.connect_disabled:
            detail = (app.connect_disabled_reason or "").strip()
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                detail or "Connector is not available for connection",
            )
        if auth_type not in _REDIRECT_AUTH_TYPES:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Connector requires credentials")
        result = await create_connect_link(require_clerk_id(auth), app_name, redirect_url)
    except ComposioRouteError as exc:
        raise _map_composio_error(exc) from exc
    return result


@router.get("/{app_name}/auth-fields")
async def auth_fields(
    app_name: str,
    auth: AuthContext = Depends(require_user_auth_short_session),
) -> ConnectorAuthFieldsResponse:
    """Return the auth scheme + credential fields for non-OAuth apps.

    Used by the Connect dialog to render the right form (input names,
    secret vs. plaintext, required markers). The frontend only opens
    this dialog when the connector's `auth_type` is API-key style;
    OAuth apps short-circuit to `window.open(connect_url)` instead.
    """
    if not settings.composio_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Composio not configured")
    try:
        fields = await get_auth_fields(app_name)
    except ComposioRouteError as exc:
        raise _map_composio_error(exc) from exc
    return fields


@router.post("/{app_name}/connect-credentials")
async def connect_credentials(
    app_name: str,
    body: ConnectorCredentialsConnectRequest,
    auth: AuthContext = Depends(require_user_auth_short_session),
) -> ConnectorCredentialsConnectResponse:
    """Create a connection from user-supplied API-key credentials.

    API-key-style connections are imported into Composio as ACTIVE
    credentials. We intentionally do not use Composio's experimental
    `validate_credentials` flag because some toolkits reject valid keys
    on that validation endpoint while the same credentials work through
    normal tool execution.
    """
    if not settings.composio_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Composio not configured")
    if not body.credentials:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Credentials required")
    # Reject blank values up front. The SDK forwards them to Composio
    # which 400s with a less helpful "field X is required" — surface
    # the issue here so the user keeps their other inputs in the form.
    if any(not v.strip() for v in body.credentials.values()):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Credential values cannot be empty")
    try:
        result = await connect_with_credentials(require_clerk_id(auth), app_name, body.credentials)
    except ComposioRouteError as exc:
        raise _map_composio_error(exc) from exc
    if not result.ok:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Composio returned connection status {result.status}",
        )
    return result


@router.delete("/{connection_id}")
async def disconnect(
    connection_id: str,
    auth: AuthContext = Depends(require_user_auth_short_session),
) -> ConnectorDisconnectResponse:
    """Disconnect a connected account.

    Ownership guard: Composio identifies connections by id globally, so we
    must confirm the connection belongs to this user before deleting it —
    otherwise any authenticated user could delete anyone else's integration.
    """
    if not settings.composio_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Composio not configured")

    clerk_id = require_clerk_id(auth)
    try:
        accounts = await get_connected_accounts(clerk_id)
    except ComposioRouteError as exc:
        raise _map_composio_error(exc) from exc
    if not any(account.id == connection_id for account in accounts):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found")

    try:
        success = await disconnect_account(connection_id)
    except ComposioRouteError as exc:
        raise _map_composio_error(exc) from exc
    if not success:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Failed to disconnect")
    await invalidate_tool_router_mcp_session(clerk_id)
    return ConnectorDisconnectResponse(status="disconnected")


@router.get("/mcp-config", response_model=ConnectorMcpConfigResponse)
async def get_mcp_config(
    auth: AuthContext = Depends(require_user_auth_short_session),
) -> ConnectorMcpConfigResponse:
    """Return the deprecated MCP bridge config required by legacy clients."""
    if not settings.composio_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Composio not configured")

    return ConnectorMcpConfigResponse(
        mcp_url=f"{settings.public_api_url.rstrip('/')}/v1/mcp/composio",
        mcp_token=create_mcp_bridge_token(require_clerk_id(auth)),
    )


@router.get("/{app_name}/tools")
async def list_app_tools(
    app_name: str,
    auth: AuthContext = Depends(require_user_auth_short_session),
) -> list[ConnectorToolResponse]:
    """List available tools/actions for a specific app."""
    if not settings.composio_api_key:
        return []
    try:
        tools = await get_app_tools(app_name)
    except ComposioRouteError as exc:
        raise _map_composio_error(exc) from exc
    return [ConnectorToolResponse.model_validate(tool) for tool in tools]
