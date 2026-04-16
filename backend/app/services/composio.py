"""Composio integration service for connector management and MCP proxy."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
from composio import Composio
from starlette.concurrency import run_in_threadpool

from app.core.config import settings

logger = logging.getLogger(__name__)

_client: Composio | None = None
_session_cache: dict[str, tuple[str, dict[str, str | None]]] = {}


def get_composio_client() -> Composio:
    global _client
    if _client is None:
        if not settings.composio_api_key:
            raise RuntimeError("COMPOSIO_API_KEY not configured")
        _client = Composio(api_key=settings.composio_api_key)
    return _client


def create_proxy_token(user_id: str) -> str:
    """Create a JWT for MCP proxy authentication."""
    key = settings.encryption_key or settings.vault_encryption_key
    if not key:
        raise RuntimeError("No encryption key configured for JWT signing")
    payload = {
        "sub": "mcp",
        "user_id": user_id,
        "exp": datetime.now(timezone.utc) + timedelta(days=30),
    }
    return jwt.encode(payload, key, algorithm="HS256")


def verify_proxy_token(token: str) -> str:
    """Verify MCP proxy JWT, return user_id."""
    key = settings.encryption_key or settings.vault_encryption_key
    if not key:
        raise RuntimeError("No encryption key configured")
    payload = jwt.decode(token, key, algorithms=["HS256"])
    return payload["user_id"]


async def get_composio_session(
    user_id: str, *, force_refresh: bool = False
) -> tuple[str, dict[str, str | None]]:
    """Get Composio Tool Router MCP session for a user. Returns (mcp_url, headers)."""
    if not force_refresh and user_id in _session_cache:
        return _session_cache[user_id]

    client = get_composio_client()

    def _create_session():
        session = client.connected_accounts.create_session(user_id=user_id)
        return session.mcp.url, dict(session.mcp.headers) if session.mcp.headers else {}

    url, headers = await run_in_threadpool(_create_session)
    _session_cache[user_id] = (url, headers)
    return url, headers


def invalidate_composio_session(user_id: str) -> None:
    _session_cache.pop(user_id, None)


async def get_connected_accounts(user_id: str) -> list[dict]:
    """List connected accounts for a user."""
    client = get_composio_client()

    def _list():
        accounts = client.connected_accounts.list(user_id=user_id)
        return [
            {
                "id": str(a.id),
                "app_name": a.app_name,
                "status": getattr(a, "status", "unknown"),
                "created_at": str(getattr(a, "created_at", "")),
            }
            for a in accounts
        ]

    return await run_in_threadpool(_list)


async def create_connect_link(user_id: str, app_name: str) -> dict:
    """Generate OAuth connect link for an app."""
    client = get_composio_client()

    def _create():
        result = client.connected_accounts.initiate(
            user_id=user_id,
            app_name=app_name,
        )
        return {"connect_url": result.redirect_url, "id": str(result.id)}

    return await run_in_threadpool(_create)


async def disconnect_account(connected_account_id: str) -> bool:
    """Disconnect/revoke a connected account."""
    client = get_composio_client()

    def _disconnect():
        client.connected_accounts.remove(id=connected_account_id)
        return True

    try:
        return await run_in_threadpool(_disconnect)
    except Exception as e:
        logger.warning(f"Failed to disconnect account {connected_account_id}: {e}")
        return False


async def get_available_apps(search: str | None = None) -> list[dict]:
    """List available Composio apps."""
    client = get_composio_client()

    def _list():
        apps = client.apps.list()
        result = []
        for app in apps:
            name = getattr(app, "name", "") or ""
            display = getattr(app, "display_name", name) or name
            logo = getattr(app, "logo", "") or ""
            if search and search.lower() not in name.lower() and search.lower() not in display.lower():
                continue
            result.append({
                "name": name,
                "display_name": display,
                "logo": logo,
            })
        return sorted(result, key=lambda x: x["display_name"])

    return await run_in_threadpool(_list)
