"""Composio integration service for connector management and MCP proxy."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

import jwt
from composio import Composio
from starlette.concurrency import run_in_threadpool

from app.core.config import settings

logger = logging.getLogger(__name__)

_client: Composio | None = None


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


async def get_connected_accounts(user_id: str) -> list[dict]:
    """List connected accounts for a user."""
    client = get_composio_client()

    def _list():
        accounts = client.connected_accounts.get(entity_ids=[user_id])
        if not isinstance(accounts, list):
            accounts = [accounts] if accounts else []
        return [
            {
                "id": str(a.id),
                "app_name": a.appName,
                "status": a.status,
                "created_at": str(a.createdAt) if a.createdAt else "",
            }
            for a in accounts
        ]

    return await run_in_threadpool(_list)


async def create_connect_link(user_id: str, app_name: str) -> dict:
    """Generate OAuth connect link for an app."""
    client = get_composio_client()

    def _create():
        result = client.connected_accounts.initiate(
            integration_id=app_name,
            entity_id=user_id,
        )
        return {
            "connect_url": result.redirectUrl,
            "id": str(result.connectedAccountId),
        }

    return await run_in_threadpool(_create)


async def disconnect_account(connected_account_id: str) -> bool:
    """Disconnect/revoke a connected account."""
    client = get_composio_client()

    def _disconnect():
        client.http_client.delete(f"/v1/connectedAccounts/{connected_account_id}")
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
        apps = client.apps.get()
        if not isinstance(apps, list):
            apps = [apps] if apps else []
        result = []
        for app in apps:
            name = app.name or ""
            display = app.key or name
            logo = app.logo or ""
            desc = app.description or ""
            if search and search.lower() not in name.lower() and search.lower() not in display.lower():
                continue
            result.append({
                "name": name,
                "display_name": display,
                "logo": logo,
                "description": desc[:200] if desc else "",
            })
        return sorted(result, key=lambda x: x["display_name"].lower())

    return await run_in_threadpool(_list)
