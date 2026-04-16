"""MCP proxy: forwards JSON-RPC requests to Composio Tool Router."""

import logging

import httpx
from fastapi import APIRouter, HTTPException, Request, Response, status

from app.services.composio import (
    get_composio_session,
    invalidate_composio_session,
    verify_proxy_token,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/mcp", tags=["mcp"])

# Shared HTTP client for proxying
_http_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0))
    return _http_client


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
    """Forward JSON-RPC POST to Composio Tool Router."""
    user_id = _extract_user_id(request)

    body = await request.body()
    mcp_url, mcp_headers = await get_composio_session(user_id)

    client = _get_client()

    # Forward request
    headers = {k: v for k, v in mcp_headers.items() if v is not None}
    headers["Content-Type"] = "application/json"

    resp = await client.post(mcp_url, content=body, headers=headers)

    # On auth failure, refresh session and retry once
    if resp.status_code in (401, 403):
        invalidate_composio_session(user_id)
        mcp_url, mcp_headers = await get_composio_session(user_id, force_refresh=True)
        headers = {k: v for k, v in mcp_headers.items() if v is not None}
        headers["Content-Type"] = "application/json"
        resp = await client.post(mcp_url, content=body, headers=headers)

    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type", "application/json"),
    )


@router.get("/proxy")
async def mcp_proxy_sse(request: Request):
    """Forward SSE GET to Composio Tool Router."""
    user_id = _extract_user_id(request)

    mcp_url, mcp_headers = await get_composio_session(user_id)

    client = _get_client()
    headers = {k: v for k, v in mcp_headers.items() if v is not None}
    headers["Accept"] = "text/event-stream"

    resp = await client.get(mcp_url, headers=headers)

    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type", "text/event-stream"),
    )
