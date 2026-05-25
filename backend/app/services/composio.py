"""Composio integration service for connector management and the MCP bridge.

Connector auth uses Composio's current auth-config model:

- OAuth / redirect flows create or reuse a Composio-managed auth config, then
  create a Connect Link for the authenticated Clerk user id.
- API-key / bearer / basic flows create or reuse a custom auth config, then
  create a connected account with user-supplied credentials.
- No-auth toolkits do not create auth configs or connected accounts; Composio
  exposes their tools directly.

Imports stay lazy so health checks and tests do not import the Composio SDK
unless a connector path actually needs it.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

import httpx
import jwt

from app.core.config import settings

if TYPE_CHECKING:
    from composio_client import AsyncComposio

logger = logging.getLogger(__name__)

_client: Any = None
_tool_router_session_cache: dict[str, ComposioMcpSession] = {}

_REDIRECT_AUTH_TYPES = {"oauth", "oauth1", "oauth2", "dcr_oauth", "composio_link"}
_INSTANT_AUTH_TYPES = {"none", "no_auth"}
_ACTIVE_OR_PENDING_STATUSES = {"INITIALIZING", "INITIATED"}
_TERMINAL_STATUSES = {"ACTIVE", "FAILED", "EXPIRED", "INACTIVE", "REVOKED"}


@dataclass(frozen=True)
class ComposioMcpSession:
    url: str
    headers: dict[str, str]
    expires_at: datetime


def get_composio_client() -> AsyncComposio:
    """Return the shared Composio SDK client."""
    global _client
    if _client is None:
        if not settings.composio_api_key:
            raise RuntimeError("COMPOSIO_API_KEY not configured")
        from composio_client import AsyncComposio

        kwargs: dict[str, Any] = {"api_key": settings.composio_api_key}
        if settings.composio_api_base_url:
            kwargs["base_url"] = settings.composio_api_base_url.rstrip("/")
        _client = AsyncComposio(**kwargs)
    return _client


async def close_composio_client() -> None:
    """Close the shared Composio HTTP client on ASGI shutdown."""
    global _client
    if _client is not None:
        close = getattr(_client, "close", None)
        if callable(close):
            await close()
        _client = None


def _jwt_signing_key() -> str:
    """Return the MCP bridge JWT signing key."""
    key = settings.encryption_key
    if not key:
        raise RuntimeError(
            "ENCRYPTION_KEY is not configured. Generate a 32-byte hex value and "
            "set it in backend/.env — it must be distinct from VAULT_ENCRYPTION_KEY."
        )
    return key


def create_mcp_bridge_token(user_id: str) -> str:
    """Create a JWT for MCP bridge authentication."""
    payload = {
        "sub": "mcp",
        "user_id": user_id,
        "exp": datetime.now(UTC) + timedelta(days=30),
    }
    return jwt.encode(payload, _jwt_signing_key(), algorithm="HS256")


def verify_mcp_bridge_token(token: str) -> str:
    """Verify MCP bridge JWT, return user_id."""
    payload = jwt.decode(token, _jwt_signing_key(), algorithms=["HS256"])
    return payload["user_id"]


async def get_tool_router_mcp_session(user_id: str) -> ComposioMcpSession:
    """Return a user-scoped Composio Tool Router MCP session.

    The CLI must never receive the Composio project API key. We create the
    Composio session server-side, cache its MCP URL briefly, and let the
    authenticated Clawdi MCP bridge forward JSON-RPC to that URL.
    """
    now = datetime.now(UTC)
    cached = _tool_router_session_cache.get(user_id)
    if cached and cached.expires_at > now:
        return cached

    session = await _create_tool_router_mcp_session(user_id, now=now)
    _tool_router_session_cache[user_id] = session
    return session


async def _create_tool_router_mcp_session(
    user_id: str, *, now: datetime | None = None
) -> ComposioMcpSession:
    if not settings.composio_api_key:
        raise RuntimeError("COMPOSIO_API_KEY not configured")

    base_url = settings.composio_api_base_url.rstrip("/")
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"{base_url}/api/v3.1/tool_router/session",
            headers={"x-api-key": settings.composio_api_key},
            json={"user_id": user_id},
        )
    resp.raise_for_status()
    data = resp.json()
    mcp = data.get("mcp") if isinstance(data, dict) else None
    if not isinstance(mcp, dict) or not isinstance(mcp.get("url"), str):
        raise RuntimeError("Composio tool router session response did not include mcp.url")

    raw_headers = mcp.get("headers")
    headers = (
        {str(k): str(v) for k, v in raw_headers.items()} if isinstance(raw_headers, dict) else {}
    )
    issued_at = now or datetime.now(UTC)
    return ComposioMcpSession(
        url=mcp["url"],
        headers=headers,
        expires_at=issued_at + timedelta(minutes=30),
    )


async def get_connected_accounts(user_id: str) -> list[dict]:
    """List active connected accounts for a Composio user."""
    client = get_composio_client()
    accounts: list[Any] = []
    cursor: str | None = None

    while True:
        kwargs: dict[str, Any] = {
            "user_ids": [user_id],
            "statuses": ["ACTIVE"],
            "limit": 100,
        }
        if cursor:
            kwargs["cursor"] = cursor
        resp = await client.connected_accounts.list(**kwargs)
        accounts.extend(_items(resp))
        cursor = _str_or_none(_value(resp, "next_cursor"))
        if not cursor:
            break

    return [_serialize_connected_account(account) for account in accounts]


def _serialize_connected_account(account: Any) -> dict:
    toolkit = _value(account, "toolkit", default={})
    return {
        "id": str(_value(account, "id", default="")),
        "app_name": _str_or_none(_value(toolkit, "slug"))
        or _str_or_none(_value(account, "appName", "app_name"))
        or "",
        "status": _str_or_none(_value(account, "status")) or "",
        "created_at": _str_or_none(_value(account, "created_at", "createdAt")) or "",
        "account_display": _account_display_label(account),
    }


def _account_display_label(account: Any) -> str | None:
    """Best-effort user-facing label for a Composio connected account."""
    candidates = (
        _value(_value(account, "connectionParams", "connection_params"), "connectionLabel"),
        _value(_value(account, "meta"), "label"),
        _value(account, "connectionLabel", "connection_label"),
        _value(account, "alias"),
        _value(account, "word_id"),
    )
    for value in candidates:
        if isinstance(value, str) and value.strip():
            return value.strip()

    containers = (
        _value(account, "data"),
        _value(account, "params"),
        _value(_value(account, "state"), "val"),
        _value(_value(_value(account, "state"), "val"), "authed_user", "authedUser"),
    )
    for container in containers:
        for key in ("connectionLabel", "connection_label", "label", "email", "username"):
            value = _value(container, key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


async def create_connect_link(
    entity_id: str, app_name: str, redirect_url: str | None = None
) -> dict:
    """Create a Composio Connect Link for an OAuth connector."""
    client = get_composio_client()
    toolkit = await _get_toolkit_detail(app_name)
    auth_type = _primary_auth_type(toolkit)

    if auth_type in _INSTANT_AUTH_TYPES:
        return {
            "connect_url": redirect_url or settings.web_origin or "/connectors",
            "id": "",
        }

    if auth_type not in _REDIRECT_AUTH_TYPES:
        raise ValueError("Connector requires credentials")

    auth_config = await _get_or_create_auth_config(
        client=client,
        app_name=app_name,
        auth_type=auth_type,
        managed=True,
    )
    kwargs: dict[str, Any] = {
        "auth_config_id": auth_config["id"],
        "user_id": entity_id,
    }
    if redirect_url:
        kwargs["callback_url"] = redirect_url
    result = await client.link.create(**kwargs)
    return {
        "connect_url": _value(result, "redirect_url", "redirectUrl", default=""),
        "id": str(_value(result, "connected_account_id", "connectedAccountId", default="")),
    }


async def get_auth_fields(app_name: str) -> dict:
    """Return credential fields for a non-OAuth connector."""
    toolkit = await _get_toolkit_detail(app_name)
    auth_type = _primary_auth_type(toolkit)
    auth_scheme = _auth_type_to_composio_scheme(auth_type)
    if auth_type in _INSTANT_AUTH_TYPES:
        return {
            "auth_scheme": auth_scheme,
            "expected_input_fields": [],
        }

    detail_fields = _auth_fields_from_toolkit_detail(toolkit, auth_scheme)
    if detail_fields:
        return {
            "auth_scheme": auth_scheme,
            "expected_input_fields": detail_fields,
        }

    client = get_composio_client()
    auth_config = await _get_or_create_auth_config(
        client=client,
        app_name=app_name,
        auth_type=auth_type,
        managed=False,
    )
    retrieved = await client.auth_configs.retrieve(auth_config["id"])
    fields = [
        _serialize_auth_field(field)
        for field in _value(retrieved, "expected_input_fields", default=[]) or []
    ]
    return {
        "auth_scheme": _str_or_none(_value(retrieved, "auth_scheme")) or auth_scheme,
        "expected_input_fields": fields,
    }


async def connect_with_credentials(
    user_id: str, app_name: str, credentials: dict[str, str]
) -> dict:
    """Create a connected account with user-supplied credentials."""
    client = get_composio_client()
    toolkit = await _get_toolkit_detail(app_name)
    auth_type = _primary_auth_type(toolkit)
    if auth_type in _REDIRECT_AUTH_TYPES:
        raise ValueError("Connector uses redirect auth")
    if auth_type in _INSTANT_AUTH_TYPES:
        raise ValueError("Connector does not require credentials")
    return await _create_non_oauth_connection(
        client=client,
        user_id=user_id,
        app_name=app_name,
        auth_type=auth_type,
        credentials=credentials,
    )


async def _create_non_oauth_connection(
    *,
    client: AsyncComposio,
    user_id: str,
    app_name: str,
    auth_type: str,
    credentials: dict[str, str],
) -> dict:
    auth_scheme = _auth_type_to_composio_scheme(auth_type)
    auth_config = await _get_or_create_auth_config(
        client=client,
        app_name=app_name,
        auth_type=auth_type,
        managed=False,
    )
    result = await client.connected_accounts.create(
        auth_config={"id": auth_config["id"]},
        connection={
            "user_id": user_id,
            "state": {
                "auth_scheme": auth_scheme,
                "val": credentials,
            },
        },
        validate_credentials=True,
    )
    account_id = str(_value(result, "id", default=""))
    status = _normalize_status(_value(result, "status"))
    if status in _ACTIVE_OR_PENDING_STATUSES:
        status = await _wait_for_connection_status(client, account_id, status)
    return {
        "id": account_id,
        "status": status.lower(),
        "ok": status == "ACTIVE",
    }


async def _wait_for_connection_status(
    client: AsyncComposio,
    connected_account_id: str,
    initial_status: str,
) -> str:
    status = initial_status
    deadline = asyncio.get_running_loop().time() + 15.0
    while status in _ACTIVE_OR_PENDING_STATUSES and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(1.0)
        account = await client.connected_accounts.retrieve(connected_account_id)
        status = _normalize_status(_value(account, "status"))
    return status


async def disconnect_account(connected_account_id: str) -> bool:
    """Disconnect/revoke a connected account."""
    client = get_composio_client()
    try:
        resp = await client.connected_accounts.delete(connected_account_id)
        success = _value(resp, "success")
        return bool(success) if success is not None else True
    except Exception as e:
        logger.warning("Failed to disconnect account %s: %s", connected_account_id, e)
        return False


async def get_app_tools(app_name: str) -> list[dict]:
    """List available tools/actions for a specific Composio toolkit."""
    client = get_composio_client()
    tools: list[Any] = []
    cursor: str | None = None

    while True:
        kwargs: dict[str, Any] = {
            "toolkit_slug": app_name,
            "include_deprecated": False,
            "limit": 100,
        }
        if cursor:
            kwargs["cursor"] = cursor
        resp = await client.tools.list(**kwargs)
        tools.extend(_items(resp))
        cursor = _str_or_none(_value(resp, "next_cursor"))
        if not cursor or len(tools) >= 500:
            break

    return [_serialize_tool(tool) for tool in tools]


def _serialize_tool(tool: Any) -> dict:
    name = _str_or_none(_value(tool, "slug", "name")) or ""
    display = _str_or_none(_value(tool, "display_name", "displayName", "name")) or name
    return {
        "name": name,
        "display_name": display,
        "description": (_str_or_none(_value(tool, "description")) or "")[:300],
        "is_deprecated": bool(_value(tool, "is_deprecated", "isDeprecated", default=False)),
    }


async def _get_or_create_auth_config(
    *,
    client: AsyncComposio,
    app_name: str,
    auth_type: str,
    managed: bool,
) -> dict:
    auth_scheme = _auth_type_to_composio_scheme(auth_type)
    existing = await _find_auth_config(client, app_name, auth_scheme, managed=managed)
    if existing is not None:
        return existing

    if managed:
        auth_config: dict[str, Any] = {
            "type": "use_composio_managed_auth",
            "name": _auth_config_name(app_name, "managed"),
        }
    else:
        auth_config = {
            "type": "use_custom_auth",
            "auth_scheme": auth_scheme,
            "credentials": {},
            "name": _auth_config_name(app_name, auth_scheme.lower()),
        }
    created = await client.auth_configs.create(
        toolkit={"slug": app_name},
        auth_config=auth_config,
    )
    created_config = _value(created, "auth_config", default=created)
    return _serialize_auth_config(created_config)


async def _find_auth_config(
    client: AsyncComposio,
    app_name: str,
    auth_scheme: str,
    *,
    managed: bool,
) -> dict | None:
    cursor: str | None = None
    while True:
        kwargs: dict[str, Any] = {
            "toolkit_slug": app_name,
            "is_composio_managed": managed,
            "show_disabled": False,
            "limit": 100,
        }
        if cursor:
            kwargs["cursor"] = cursor
        resp = await client.auth_configs.list(**kwargs)
        for item in _items(resp):
            status = (_str_or_none(_value(item, "status")) or "ENABLED").upper()
            if status != "ENABLED":
                continue
            item_scheme = _str_or_none(_value(item, "auth_scheme"))
            if managed and item_scheme and _normalize_composio_scheme(item_scheme) != auth_scheme:
                continue
            if not managed and (
                not item_scheme or _normalize_composio_scheme(item_scheme) != auth_scheme
            ):
                continue
            return _serialize_auth_config(item)
        cursor = _str_or_none(_value(resp, "next_cursor"))
        if not cursor:
            return None


def _serialize_auth_config(auth_config: Any) -> dict:
    return {
        "id": str(_value(auth_config, "id", default="")),
        "auth_scheme": _normalize_composio_scheme(_value(auth_config, "auth_scheme")),
        "is_composio_managed": bool(_value(auth_config, "is_composio_managed", default=False)),
    }


def _auth_config_name(app_name: str, suffix: str) -> str:
    clean = re.sub(r"[^a-zA-Z0-9_.-]+", "-", app_name.strip()).strip("-")
    return f"Clawdi {clean or 'connector'} {suffix}"


def _auth_type_to_composio_scheme(auth_type: str) -> str:
    normalized = _normalize_auth_type(auth_type)
    if normalized == "oauth":
        return "OAUTH2"
    if normalized == "oauth1":
        return "OAUTH1"
    if normalized == "oauth2":
        return "OAUTH2"
    if normalized in {"none", "no_auth"}:
        return "NO_AUTH"
    if normalized == "bearer":
        return "BEARER_TOKEN"
    return normalized.upper()


def _normalize_composio_scheme(value: Any) -> str:
    text = str(value or "").strip().upper().replace("-", "_").replace(" ", "_")
    if text == "BEARER":
        return "BEARER_TOKEN"
    if text == "APIKEY":
        return "API_KEY"
    if text == "OAUTH":
        return "OAUTH2"
    return text


def _normalize_auth_type(value: Any) -> str:
    text = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    if text == "oauth":
        return "oauth2"
    if text == "apikey":
        return "api_key"
    if text == "bearer":
        return "bearer_token"
    if text == "basic_auth":
        return "basic"
    if text == "noauth":
        return "no_auth"
    return text


def _normalize_status(value: Any) -> str:
    status = str(value or "").strip().upper()
    return status if status in (_ACTIVE_OR_PENDING_STATUSES | _TERMINAL_STATUSES) else "UNKNOWN"


def _serialize_auth_field(field: Any, *, required: bool | None = None) -> dict:
    name = _str_or_none(_value(field, "name")) or ""
    field_type = _str_or_none(_value(field, "type")) or "string"
    is_secret = bool(_value(field, "is_secret", "isSecret", default=False)) or _looks_secret_field(
        name, field_type
    )
    return {
        "name": name,
        "display_name": _str_or_none(_value(field, "display_name", "displayName")) or name,
        "description": _str_or_none(_value(field, "description")) or "",
        "type": field_type,
        "required": bool(required) if required is not None else bool(_value(field, "required")),
        "is_secret": is_secret,
        "expected_from_customer": bool(_value(field, "expected_from_customer", default=True)),
        "default": _str_or_none(_value(field, "default")),
    }


def _looks_secret_field(name: str, field_type: str) -> bool:
    text = f"{name} {field_type}".lower()
    return any(token in text for token in ("password", "secret", "token", "api_key", "apikey"))


def _auth_fields_from_toolkit_detail(toolkit: Any, auth_scheme: str) -> list[dict]:
    details = _value(toolkit, "auth_config_details", default=[]) or []
    selected = None
    for detail in details:
        mode = _auth_type_to_composio_scheme(_value(detail, "mode", "name"))
        if mode == auth_scheme:
            selected = detail
            break
    if selected is None:
        return []

    fields = _value(selected, "fields")
    initiation = _value(fields, "connected_account_initiation")
    required_fields = _value(initiation, "required", default=[]) or []
    optional_fields = _value(initiation, "optional", default=[]) or []
    return [
        *[_serialize_auth_field(field, required=True) for field in required_fields],
        *[_serialize_auth_field(field, required=False) for field in optional_fields],
    ]


def _primary_auth_type(toolkit: Any) -> str:
    """Lowercase auth scheme for connector routing."""
    if bool(_value(toolkit, "no_auth", default=False)):
        return "none"

    managed_schemes = [
        _normalize_auth_type(v)
        for v in _string_list(_value(toolkit, "composio_managed_auth_schemes"))
    ]
    all_schemes = [
        *managed_schemes,
        *[_normalize_auth_type(v) for v in _string_list(_value(toolkit, "auth_schemes"))],
    ]
    detail_schemes = [
        _normalize_auth_type(_value(detail, "mode", "name"))
        for detail in (_value(toolkit, "auth_config_details", default=[]) or [])
    ]
    all_schemes.extend(scheme for scheme in detail_schemes if scheme)

    for scheme in all_schemes:
        if scheme in _REDIRECT_AUTH_TYPES:
            return scheme
    for scheme in all_schemes:
        if scheme:
            return scheme
    return "oauth2"


def _serialize_app(toolkit: Any) -> dict:
    meta = _value(toolkit, "meta", default={})
    key = _str_or_none(_value(toolkit, "slug", "key", "name")) or ""
    display = _str_or_none(_value(toolkit, "name", "display_name", "displayName"))
    display = display or _titleize_slug(key)
    logo = _str_or_none(_value(meta, "logo")) or _str_or_none(_value(toolkit, "logo")) or ""
    desc = _str_or_none(_value(meta, "description"))
    desc = desc or _str_or_none(_value(toolkit, "description")) or ""
    return {
        "name": key,
        "display_name": display,
        "logo": logo,
        "description": desc[:200],
        "auth_type": _primary_auth_type(toolkit),
    }


def _titleize_slug(slug: str) -> str:
    clean = slug.lstrip("_-")
    spaced = re.sub(r"([a-z])([A-Z])", r"\1 \2", clean)
    spaced = spaced.replace("_", " ").replace("-", " ")
    return spaced.title()


_apps_cache: list[dict] | None = None
_apps_cache_at: datetime | None = None
_APPS_CACHE_TTL = timedelta(minutes=5)


async def _get_all_apps() -> list[dict]:
    """Fetch and cache the Composio toolkit catalog."""
    global _apps_cache, _apps_cache_at
    now = datetime.now(UTC)
    if _apps_cache is not None and _apps_cache_at is not None:
        if (now - _apps_cache_at) < _APPS_CACHE_TTL:
            return _apps_cache

    client = get_composio_client()
    toolkits: list[Any] = []
    cursor: str | None = None
    while True:
        kwargs: dict[str, Any] = {
            "managed_by": "composio",
            "sort_by": "usage",
            "limit": 1000,
        }
        if cursor:
            kwargs["cursor"] = cursor
        resp = await client.toolkits.list(**kwargs)
        toolkits.extend(_items(resp))
        cursor = _str_or_none(_value(resp, "next_cursor"))
        if not cursor:
            break

    fresh = [_serialize_app(toolkit) for toolkit in toolkits]
    _apps_cache = fresh
    _apps_cache_at = now
    return fresh


async def get_app_by_name(name: str) -> dict | None:
    """Look up one toolkit by Composio slug."""
    items = await _get_all_apps()
    for app in items:
        if app["name"] == name:
            detail = await _get_app_detail_by_name(name)
            if detail is None:
                return app
            return {**app, "auth_type": detail["auth_type"]}
    return None


async def _get_app_detail_by_name(name: str) -> dict | None:
    try:
        toolkit = await _get_toolkit_detail(name)
    except Exception:
        return None
    return _serialize_app(toolkit)


async def _get_toolkit_detail(name: str) -> Any:
    client = get_composio_client()
    return await client.toolkits.retrieve(name)


async def get_available_apps(
    search: str | None = None,
    page: int = 1,
    page_size: int = 24,
) -> dict:
    """Paginated catalog query."""
    items = await _get_all_apps()
    if search:
        q = search.lower()
        items = [
            app
            for app in items
            if q in app["name"].lower()
            or q in app["display_name"].lower()
            or q in app["description"].lower()
        ]
    total = len(items)
    start = max(0, (page - 1) * page_size)
    end = start + page_size
    return {
        "items": items[start:end],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


def _items(response: Any) -> list[Any]:
    if isinstance(response, list):
        return response
    items = _value(response, "items", default=[])
    return list(items or [])


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()]


def _value(obj: Any, *names: str, default: Any = None) -> Any:
    if obj is None:
        return default
    for name in names:
        if isinstance(obj, dict) and name in obj:
            return obj[name]
        if hasattr(obj, name):
            return getattr(obj, name)
    return default


def _str_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None
