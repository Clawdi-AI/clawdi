from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.auth import AuthContext, get_auth
from app.core.config import settings
from app.schemas.common import Paginated
from app.schemas.connector import (
    ConnectorAvailableAppResponse,
    ConnectorConnectionResponse,
    ConnectorConnectResponse,
    ConnectorDisconnectResponse,
    ConnectorMcpConfigResponse,
    ConnectorToolResponse,
    ConnectRequest,
)
from app.services.composio import (
    create_connect_link,
    create_proxy_token,
    disconnect_account,
    get_app_by_name,
    get_app_tools,
    get_available_apps,
    get_connected_accounts,
)

router = APIRouter(prefix="/api/connectors", tags=["connectors"])


@router.get("")
async def list_connections(
    auth: AuthContext = Depends(get_auth),
) -> list[ConnectorConnectionResponse]:
    """List user's connected services."""
    if not settings.composio_api_key:
        return []
    accounts = await get_connected_accounts(str(auth.user_id))
    return [ConnectorConnectionResponse.model_validate(account) for account in accounts]


@router.get("/available")
async def list_available_apps(
    auth: AuthContext = Depends(get_auth),
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
    page_data = await get_available_apps(search=search, page=page, page_size=page_size)
    return Paginated[ConnectorAvailableAppResponse](
        items=[ConnectorAvailableAppResponse.model_validate(a) for a in page_data["items"]],
        total=page_data["total"],
        page=page_data["page"],
        page_size=page_data["page_size"],
    )


@router.get("/available/{app_name}")
async def get_available_app(
    app_name: str,
    auth: AuthContext = Depends(get_auth),
) -> ConnectorAvailableAppResponse:
    """Single-app metadata lookup — used by the detail page so it doesn't
    have to page through the whole catalog to find one app's display name.
    Re-uses the cache that `/available` populates."""
    if not settings.composio_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Composio not configured")
    app = await get_app_by_name(app_name)
    if app is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Connector not found")
    return ConnectorAvailableAppResponse.model_validate(app)


@router.post("/{app_name}/connect")
async def connect_app(
    app_name: str,
    body: ConnectRequest | None = None,
    auth: AuthContext = Depends(get_auth),
) -> ConnectorConnectResponse:
    """Generate OAuth connect link for an app."""
    if not settings.composio_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Composio not configured")

    result = await create_connect_link(str(auth.user_id), app_name)
    return ConnectorConnectResponse.model_validate(result)


@router.delete("/{connection_id}")
async def disconnect(
    connection_id: str,
    auth: AuthContext = Depends(get_auth),
) -> ConnectorDisconnectResponse:
    """Disconnect a connected account.

    Ownership guard: Composio identifies connections by id globally, so we
    must confirm the connection belongs to this user before deleting it —
    otherwise any authenticated user could delete anyone else's integration.
    """
    if not settings.composio_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Composio not configured")

    accounts = await get_connected_accounts(str(auth.user_id))
    if not any(a.get("id") == connection_id for a in accounts):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found")

    success = await disconnect_account(connection_id)
    if not success:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Failed to disconnect")
    return ConnectorDisconnectResponse(status="disconnected")


@router.get("/mcp-config")
async def get_mcp_config(
    auth: AuthContext = Depends(get_auth),
) -> ConnectorMcpConfigResponse:
    """Get MCP proxy config for the current user."""
    if not settings.composio_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Composio not configured")

    token = create_proxy_token(str(auth.user_id))
    base = settings.public_api_url.rstrip("/")

    return ConnectorMcpConfigResponse(
        mcp_url=f"{base}/api/mcp/proxy",
        mcp_token=token,
    )


@router.get("/{app_name}/tools")
async def list_app_tools(
    app_name: str,
    auth: AuthContext = Depends(get_auth),
) -> list[ConnectorToolResponse]:
    """List available tools/actions for a specific app."""
    if not settings.composio_api_key:
        return []
    tools = await get_app_tools(app_name)
    return [ConnectorToolResponse.model_validate(tool) for tool in tools]
