"""MCP bridge: forwards authenticated JSON-RPC to Composio Tool Router."""

import json
import logging

import httpx
from fastapi import APIRouter, HTTPException, Request, status

from app.core.config import settings
from app.services.composio import (
    ComposioMcpSession,
    get_tool_router_mcp_session,
    verify_mcp_bridge_token,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/mcp", tags=["mcp"])


def _extract_user_id(request: Request) -> str:
    """Extract and verify user_id from the MCP bridge JWT."""
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing auth token")
    token = auth[7:]
    try:
        return verify_mcp_bridge_token(token)
    except Exception:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token")


@router.post("/composio", include_in_schema=False)
async def mcp_composio_bridge_post(request: Request):
    """Forward MCP JSON-RPC to Composio Tool Router for an authenticated user."""
    user_id = _extract_user_id(request)
    body = await request.json()
    rpc_id = body.get("id", 1) if isinstance(body, dict) else None

    try:
        session = await get_tool_router_mcp_session(user_id)
        return await _forward_composio_mcp_request(session, body)
    except Exception:
        logger.exception("Composio MCP bridge error: user=%s", user_id)
        return {
            "jsonrpc": "2.0",
            "id": rpc_id,
            "error": {"code": -32000, "message": "internal error"},
        }


async def _forward_composio_mcp_request(session: ComposioMcpSession, body) -> dict | list:
    headers = _composio_mcp_headers(session)
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(session.url, json=body, headers=headers)

    if not resp.is_success:
        logger.warning(
            "Composio MCP bridge upstream failure: status=%s",
            resp.status_code,
        )
        rpc_id = body.get("id", 1) if isinstance(body, dict) else None
        return {
            "jsonrpc": "2.0",
            "id": rpc_id,
            "error": {"code": -32000, "message": "upstream MCP error"},
        }

    parsed = _parse_composio_mcp_response(resp)
    if not isinstance(parsed, (dict, list)):
        raise ValueError("Composio MCP bridge returned non-object JSON")
    return parsed


def _composio_mcp_headers(session: ComposioMcpSession) -> dict[str, str]:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        **session.headers,
    }
    lowered = {k.lower() for k in headers}
    if (
        settings.composio_api_key
        and "x-api-key" not in lowered
        and "x-user-api-key" not in lowered
        and "authorization" not in lowered
    ):
        headers["x-api-key"] = settings.composio_api_key
    return headers


def _parse_composio_mcp_response(resp: httpx.Response):
    content_type = resp.headers.get("content-type", "")
    if "text/event-stream" not in content_type:
        return resp.json()

    events = []
    data_lines: list[str] = []
    for line in resp.text.splitlines():
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
        elif not line and data_lines:
            events.append("\n".join(data_lines))
            data_lines = []
    if data_lines:
        events.append("\n".join(data_lines))
    events = [event for event in events if event.strip() and event.strip() != "[DONE]"]
    if not events:
        raise ValueError("Composio MCP bridge returned an empty SSE response")
    return json.loads(events[-1])
