"""Composio integration service for connector management and MCP proxy."""

from __future__ import annotations

import logging
import re
from datetime import UTC, datetime, timedelta

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
        "exp": datetime.now(UTC) + timedelta(days=30),
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
        accounts = client.connected_accounts.get(entity_ids=[user_id], active=True)
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
        # Get or create integration for this app
        integrations = client.integrations.get(app_name=app_name)
        if isinstance(integrations, list) and integrations:
            integration_id = str(integrations[0].id)
        else:
            # Need app_id to create integration
            app_info = client.apps.get(name=app_name)
            if isinstance(app_info, list):
                app_info = app_info[0] if app_info else None
            if not app_info:
                raise ValueError(f"App '{app_name}' not found")
            integration = client.integrations.create(app_id=app_info.appId, use_composio_auth=True)
            integration_id = str(integration.id)

        result = client.connected_accounts.initiate(
            integration_id=integration_id,
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
        client.http.delete(f"/v1/connectedAccounts/{connected_account_id}")
        return True

    try:
        return await run_in_threadpool(_disconnect)
    except Exception as e:
        logger.warning(f"Failed to disconnect account {connected_account_id}: {e}")
        return False


def _serialize_actions(
    actions,
    *,
    include_app: str | None = None,
    skip_deprecated: bool = False,
    include_parameters: bool = False,
) -> list[dict]:
    """Normalize Composio action objects into dicts."""
    if not isinstance(actions, list):
        actions = [actions] if actions else []
    result = []
    for a in actions:
        is_deprecated = getattr(a, "is_deprecated", False)
        if skip_deprecated and is_deprecated:
            continue
        item: dict = {
            "name": a.name or "",
            "display_name": a.display_name or a.name or "",
            "description": (a.description or "")[:300],
            "is_deprecated": is_deprecated,
        }
        if include_app is not None:
            item["app"] = include_app
        if include_parameters and hasattr(a, "parameters"):
            try:
                params = a.parameters
                item["parameters"] = {
                    "properties": params.properties,
                    "required": params.required or [],
                }
            except Exception:
                pass
        result.append(item)
    return result


async def get_connected_tools(user_id: str) -> list[dict]:
    """List all tools from user's active connected apps."""
    accounts = await get_connected_accounts(user_id)
    if not accounts:
        return []
    app_names = list({a["app_name"] for a in accounts})
    client = get_composio_client()

    def _list():
        try:
            actions = client.actions.get(apps=app_names)
            return _serialize_actions(actions, skip_deprecated=True, include_parameters=True)
        except Exception as e:
            logger.warning(f"Failed to get connected tools: {e}")
            return []

    return await run_in_threadpool(_list)


async def get_app_tools(app_name: str) -> list[dict]:
    """List available tools/actions for a specific Composio app."""
    client = get_composio_client()

    def _list():
        actions = client.actions.get(apps=[app_name])
        return _serialize_actions(actions)

    return await run_in_threadpool(_list)


def _extract_display_name(slug: str, description: str) -> str:
    """Extract human-readable name from description or slug.

    Description usually starts with the product name, e.g.:
    "Gmail is Google's email service..." → "Gmail"
    "Google Calendar is a time management tool..." → "Google Calendar"
    """
    if description:
        m = re.match(
            r"^(.+?)\s+(?:is|are|provides?|enables?|offers?|centralizes?|merges?|automates?|extends?|integrates?|streamlines?)\s",
            description,
            re.IGNORECASE,
        )
        if m:
            name = m.group(1).strip().rstrip(",")
            # Sanity check: not too long and not the whole sentence
            if 1 <= len(name) <= 40:
                return name

    # Fallback: clean up the slug
    clean = slug.lstrip("_-")
    spaced = re.sub(r"([a-z])([A-Z])", r"\1 \2", clean)
    spaced = spaced.replace("_", " ").replace("-", " ")
    return spaced.title()


async def get_available_apps(search: str | None = None) -> list[dict]:
    """List available Composio apps."""
    client = get_composio_client()

    def _list():
        apps = client.apps.get()
        if not isinstance(apps, list):
            apps = [apps] if apps else []
        result = []
        for app in apps:
            key = app.key or app.name or ""
            display = _extract_display_name(key, app.description or "")
            logo = app.logo or ""
            desc = app.description or ""
            if (
                search
                and search.lower() not in key.lower()
                and search.lower() not in display.lower()
            ):
                continue
            result.append(
                {
                    "name": key,
                    "display_name": display,
                    "logo": logo,
                    "description": desc[:200] if desc else "",
                }
            )
        return sorted(result, key=lambda x: x["display_name"].lower())

    return await run_in_threadpool(_list)
