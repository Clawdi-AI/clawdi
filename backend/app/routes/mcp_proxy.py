"""MCP proxy: executes Composio tool calls on behalf of authenticated users."""

import json
import logging

from fastapi import APIRouter, HTTPException, Request, status

from app.services.composio import get_composio_client, verify_proxy_token

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/mcp", tags=["mcp"])


def _extract_user_id(request: Request) -> str:
    """Extract and verify user_id from MCP proxy JWT."""
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing auth token")
    token = auth[7:]
    try:
        return verify_proxy_token(token)
    except Exception:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token")


@router.post("/proxy")
async def mcp_proxy_post(request: Request):
    """Handle MCP JSON-RPC requests using Composio SDK directly."""
    user_id = _extract_user_id(request)

    body = await request.json()
    method = body.get("method", "")
    params = body.get("params", {})
    rpc_id = body.get("id", 1)

    try:
        if method == "tools/list":
            result = await _handle_tools_list(user_id)
        elif method == "tools/call":
            result = await _handle_tools_call(user_id, params)
        else:
            return {"jsonrpc": "2.0", "id": rpc_id, "error": {"code": -32601, "message": f"Unknown method: {method}"}}

        return {"jsonrpc": "2.0", "id": rpc_id, "result": result}
    except Exception as e:
        logger.exception(f"MCP proxy error: {e}")
        return {"jsonrpc": "2.0", "id": rpc_id, "error": {"code": -32000, "message": str(e)}}


async def _handle_tools_list(user_id: str) -> dict:
    """List available tools for the user's connected accounts."""
    from starlette.concurrency import run_in_threadpool

    client = get_composio_client()

    def _list():
        # Get user's connected accounts to determine available apps
        accounts = client.connected_accounts.get(entity_ids=[user_id], active=True)
        if not isinstance(accounts, list):
            accounts = [accounts] if accounts else []

        app_names = list(set(a.appName for a in accounts if a.appName))
        if not app_names:
            return {"tools": []}

        # Get tools for connected apps
        tools = []
        for app_name in app_names:
            try:
                app_tools = client.actions.get(apps=[app_name])
                if not isinstance(app_tools, list):
                    app_tools = [app_tools] if app_tools else []
                for t in app_tools:
                    tools.append({
                        "name": t.name if hasattr(t, "name") else str(t),
                        "description": getattr(t, "description", "")[:200],
                    })
            except Exception as e:
                logger.warning(f"Failed to list tools for {app_name}: {e}")

        return {"tools": tools}

    return await run_in_threadpool(_list)


async def _handle_tools_call(user_id: str, params: dict) -> dict:
    """Execute a tool call via Composio."""
    from starlette.concurrency import run_in_threadpool

    tool_name = params.get("name", "")
    arguments = params.get("arguments", {})

    if not tool_name:
        raise ValueError("Missing tool name")

    client = get_composio_client()

    def _call():
        result = client.actions.execute(
            action=tool_name,
            params=arguments,
            entity_id=user_id,
        )
        return result

    result = await run_in_threadpool(_call)
    return {"content": [{"type": "text", "text": json.dumps(result, default=str)}]}
