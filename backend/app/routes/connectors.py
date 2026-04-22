from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.core.auth import AuthContext, get_auth
from app.core.config import settings
from app.services.composio import (
    create_connect_link,
    create_proxy_token,
    disconnect_account,
    get_app_tools,
    get_available_apps,
    get_connected_accounts,
    get_connected_tools,
)

router = APIRouter(prefix="/api/connectors", tags=["connectors"])


class ConnectRequest(BaseModel):
    redirect_url: str | None = None


@router.get("")
async def list_connections(auth: AuthContext = Depends(get_auth)):
    """List user's connected services."""
    if not settings.composio_api_key:
        return []
    accounts = await get_connected_accounts(str(auth.user_id))
    return accounts


@router.get("/available")
async def list_available_apps(
    auth: AuthContext = Depends(get_auth),
    search: str | None = Query(default=None, max_length=100),
):
    """List all available Composio apps."""
    if not settings.composio_api_key:
        return []
    apps = await get_available_apps(search=search)
    return apps


@router.post("/{app_name}/connect")
async def connect_app(
    app_name: str,
    body: ConnectRequest | None = None,
    auth: AuthContext = Depends(get_auth),
):
    """Generate OAuth connect link for an app."""
    if not settings.composio_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Composio not configured")

    result = await create_connect_link(str(auth.user_id), app_name)
    return result


@router.delete("/{connection_id}")
async def disconnect(
    connection_id: str,
    auth: AuthContext = Depends(get_auth),
):
    """Disconnect a connected account."""
    success = await disconnect_account(connection_id)
    if not success:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Failed to disconnect")
    return {"status": "disconnected"}


@router.get("/connected-tools")
async def list_connected_tools(auth: AuthContext = Depends(get_auth)):
    """List all tools from user's active connected apps."""
    if not settings.composio_api_key:
        return []
    tools = await get_connected_tools(str(auth.user_id))
    return tools


@router.get("/mcp-config")
async def get_mcp_config(auth: AuthContext = Depends(get_auth)):
    """Get MCP proxy config for the current user."""
    if not settings.composio_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Composio not configured")

    token = create_proxy_token(str(auth.user_id))
    (
        str(settings.cors_origins[0]).rstrip("/")
        if settings.cors_origins
        else "http://localhost:8000"
    )

    return {
        "mcp_url": "http://localhost:8000/api/mcp/proxy",
        "mcp_token": token,
    }


@router.get("/{app_name}/tools")
async def list_app_tools(
    app_name: str,
    auth: AuthContext = Depends(get_auth),
):
    """List available tools/actions for a specific app."""
    if not settings.composio_api_key:
        return []
    tools = await get_app_tools(app_name)
    return tools
