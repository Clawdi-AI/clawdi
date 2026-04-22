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
            return {
                "jsonrpc": "2.0",
                "id": rpc_id,
                "error": {"code": -32601, "message": f"Unknown method: {method}"},
            }

        return {"jsonrpc": "2.0", "id": rpc_id, "result": result}
    except Exception as e:
        logger.exception(f"MCP proxy error: {e}")
        return {"jsonrpc": "2.0", "id": rpc_id, "error": {"code": -32000, "message": str(e)}}


async def _handle_tools_list(user_id: str) -> dict:
    """List available tools for the user's connected accounts."""
    from app.services.composio import get_connected_tools

    tools = await get_connected_tools(user_id)
    return {"tools": [{"name": t["name"], "description": t["description"]} for t in tools]}


async def _handle_tools_call(user_id: str, params: dict) -> dict:
    """Execute a tool call via Composio."""
    from starlette.concurrency import run_in_threadpool

    tool_name = params.get("name", "")
    arguments = params.get("arguments", {})

    if not tool_name:
        raise ValueError("Missing tool name")

    client = get_composio_client()

    def _call():
        # Find user's connected account for this tool's app
        accounts = client.connected_accounts.get(entity_ids=[user_id], active=True)
        if not isinstance(accounts, list):
            accounts = [accounts] if accounts else []

        # Resolve the Action enum and find matching connected account
        from composio.client import Action

        action = Action(tool_name)
        action_data = action.load()
        app_name = action_data.app

        connected_account_id = None
        for acc in accounts:
            if acc.appName and acc.appName.lower() == app_name.lower():
                connected_account_id = str(acc.id)
                break

        if not connected_account_id and not action_data.no_auth:
            raise ValueError(
                f"No connected account for {app_name}. Connect it in the dashboard first."
            )

        result = client.actions.execute(
            action=action,
            params=arguments,
            entity_id=user_id,
            connected_account=connected_account_id,
        )
        return result

    result = await run_in_threadpool(_call)
    return {"content": [{"type": "text", "text": json.dumps(result, default=str)}]}
