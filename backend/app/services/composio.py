"""Composio integration service for connector management and MCP proxy.

The composio package initializes a filesystem cache directory at import time,
which breaks cold starts in read-only / sandboxed environments. We defer the
import until the first actual call site so tests and health checks can run
without a writable home dir.
"""

from __future__ import annotations

import logging
import re
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

import jwt
from starlette.concurrency import run_in_threadpool

from app.core.config import settings

if TYPE_CHECKING:
    from composio import Composio

logger = logging.getLogger(__name__)

_client: Any = None


def get_composio_client() -> Composio:
    global _client
    if _client is None:
        if not settings.composio_api_key:
            raise RuntimeError("COMPOSIO_API_KEY not configured")
        # Import lazily: see module docstring.
        from composio import Composio

        _client = Composio(api_key=settings.composio_api_key)
    return _client


def _jwt_signing_key() -> str:
    """Return the MCP proxy JWT signing key.

    We deliberately do NOT fall back to `vault_encryption_key` — that would
    merge two key purposes (data-at-rest AES-GCM + proxy token HS256) into a
    single secret. A compromise of the fallback leaks both the vault
    contents AND the ability to mint MCP proxy tokens. Keep them separate.
    """
    key = settings.encryption_key
    if not key:
        raise RuntimeError(
            "ENCRYPTION_KEY is not configured. Generate a 32-byte hex value and "
            "set it in backend/.env — it must be distinct from VAULT_ENCRYPTION_KEY."
        )
    return key


def create_proxy_token(user_id: str) -> str:
    """Create a JWT for MCP proxy authentication."""
    payload = {
        "sub": "mcp",
        "user_id": user_id,
        "exp": datetime.now(UTC) + timedelta(days=30),
    }
    return jwt.encode(payload, _jwt_signing_key(), algorithm="HS256")


def verify_proxy_token(token: str) -> str:
    """Verify MCP proxy JWT, return user_id."""
    payload = jwt.decode(token, _jwt_signing_key(), algorithms=["HS256"])
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
                # Composio returns `connectionParams.connectionLabel` for
                # OAuth (the user's email/handle), or sometimes a
                # field on `meta.label`. Fall back through what the SDK
                # exposes; treat any AttributeError or missing value
                # as `None` so the UI shows its short-id fallback.
                "account_display": _account_display_label(a),
            }
            for a in accounts
        ]

    return await run_in_threadpool(_list)


def _account_display_label(account) -> str | None:
    """Best-effort identity label for a Composio connected account.

    Composio surfaces the user-facing identity (e.g. the connected
    Gmail address) in different fields across SDK versions:
    `connectionParams.connectionLabel`, `meta.label`, or sometimes the
    nested account dict. Try them in order and return None if nothing
    looks usable so the UI falls back to its short-id placeholder.
    """
    candidates = (
        getattr(getattr(account, "connectionParams", None), "connectionLabel", None),
        getattr(getattr(account, "meta", None), "label", None),
        getattr(account, "connectionLabel", None),
    )
    for v in candidates:
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


async def create_connect_link(
    entity_id: str, app_name: str, redirect_url: str | None = None
) -> dict:
    """Generate OAuth connect link for an app.

    `entity_id` is the Composio per-user identifier — we pass the
    Clerk user id so a single Composio account can serve many users
    keyed by their Clerk identity. This must match what
    `get_connected_accounts` filters by, otherwise the new connection
    would be invisible to subsequent reads.

    `redirect_url`, when provided, is forwarded to Composio so the
    OAuth provider sends the user back to the caller's chosen
    landing page (the connector detail page) instead of Composio's
    default callback. Lets the frontend skip a polling loop and just
    refetch on mount when the user lands.
    """
    client = get_composio_client()

    def _create():
        integration = _resolve_integration(client, app_name)
        kwargs: dict = {
            "integration_id": str(integration.id),
            "entity_id": entity_id,
        }
        if redirect_url:
            kwargs["redirect_url"] = redirect_url
        result = client.connected_accounts.initiate(**kwargs)
        return {
            "connect_url": result.redirectUrl,
            "id": str(result.connectedAccountId),
        }

    return await run_in_threadpool(_create)


def _resolve_integration(client, app_name: str):
    """Find an existing integration for the app or create a new one.

    Composio integrations are app-level metadata describing how the
    OAuth/API-key flow is configured. We look up the user's existing
    integration first; if none exists yet we create one with the
    Composio-managed default so the OAuth/credentials flow can run
    without requiring the user to provide their own client secrets.
    Returns the IntegrationModel from the SDK.
    """
    integrations = client.integrations.get(app_name=app_name)
    if isinstance(integrations, list) and integrations:
        return integrations[0]
    app_info = client.apps.get(name=app_name)
    if isinstance(app_info, list):
        app_info = app_info[0] if app_info else None
    if not app_info:
        raise ValueError(f"App '{app_name}' not found")
    return client.integrations.create(app_id=app_info.appId, use_composio_auth=True)


async def get_auth_fields(app_name: str) -> dict:
    """Return the auth scheme + expected user-provided fields for an app.

    Read-only: previously this called `_resolve_integration`, which
    creates a Composio integration record on first lookup as a side
    effect of a GET endpoint. The auth schema we surface in the
    connect form lives on the **app** (global Composio metadata), not
    on the integration (user-specific OAuth config) — so we can read
    it from `client.apps.get` without provisioning anything. The
    integration is only created later when the user actually submits
    credentials in `connect_with_credentials`.
    """
    client = get_composio_client()

    def _get():
        existing = client.integrations.get(app_name=app_name)
        if isinstance(existing, list) and existing:
            # An integration already exists for this app — prefer its
            # exact field list since it reflects the operator's
            # configured scheme.
            integration = existing[0]
            return {
                "auth_scheme": integration.authScheme,
                "expected_input_fields": [
                    _serialize_auth_field(f) for f in integration.expectedInputFields
                ],
            }
        # No integration yet: read the app's primary auth scheme
        # without creating anything. Composio apps expose
        # `auth_schemes` listing every supported flow with their
        # field schemas.
        app_info = client.apps.get(name=app_name)
        if isinstance(app_info, list):
            app_info = app_info[0] if app_info else None
        if not app_info:
            raise ValueError(f"App '{app_name}' not found")
        schemes = getattr(app_info, "auth_schemes", None) or []
        primary = schemes[0] if schemes else None
        if primary is None:
            return {"auth_scheme": "", "expected_input_fields": []}
        fields = getattr(primary, "fields", None) or []
        return {
            "auth_scheme": getattr(primary, "auth_mode", "") or getattr(primary, "name", ""),
            "expected_input_fields": [_serialize_auth_field(f) for f in fields],
        }

    return await run_in_threadpool(_get)


def _serialize_auth_field(f) -> dict:
    """Project Composio's SDK field object onto the cloud-api schema.

    Field attribute names differ slightly between IntegrationModel and
    the App auth_schemes shape, so handle both via getattr. `default`
    is whatever the SDK exposes; the frontend treats `None` as "leave
    blank".
    """
    return {
        "name": getattr(f, "name", ""),
        "display_name": getattr(f, "displayName", None)
        or getattr(f, "display_name", "")
        or getattr(f, "name", ""),
        "description": getattr(f, "description", "") or "",
        "type": getattr(f, "type", "string") or "string",
        "required": bool(getattr(f, "required", False)),
        "is_secret": bool(getattr(f, "is_secret", False)),
        "expected_from_customer": bool(getattr(f, "expected_from_customer", True)),
        "default": getattr(f, "default", None),
    }


async def connect_with_credentials(
    user_id: str, app_name: str, credentials: dict[str, str]
) -> dict:
    """Create a connection using API-key credentials (no OAuth).

    Composio's `initiate()` doubles as the credentials creator when
    `params` is populated — for non-OAuth schemes it stores the values
    and returns a `ConnectionRequestModel` whose `connectionStatus` is
    typically `INITIATED` immediately and `ACTIVE` after Composio
    validates the credentials. The SDK exposes `wait_until_active`
    which polls for that transition; we cap at 15s so a slow upstream
    auth check doesn't hang the API for 60s (the SDK default).
    `credentials` is never logged — these are user secrets.
    """
    client = get_composio_client()

    def _connect():
        integration = _resolve_integration(client, app_name)
        result = client.connected_accounts.initiate(
            integration_id=str(integration.id),
            entity_id=user_id,
            params=credentials,
        )
        status = (result.connectionStatus or "").upper()
        if status != "ACTIVE":
            # Polls Composio until status flips or timeout. Raises on
            # timeout, which surfaces to the route as a 500 / 502 — the
            # frontend then leaves the user on the dialog so they can
            # retry without losing their input.
            account = result.wait_until_active(client, timeout=15.0)
            status = (account.status or "ACTIVE").upper()
        return {
            "id": str(result.connectedAccountId),
            "status": status.lower(),
            "ok": True,
        }

    return await run_in_threadpool(_connect)


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


def _primary_auth_type(app) -> str:
    """Lowercase short auth scheme for the connector card UI.

    The Composio SDK reports `no_auth: bool` plus `auth_schemes` (a
    list of `AppAuthScheme`, each with `auth_mode` like `"OAUTH2"` or
    `"API_KEY"`). Most apps have one entry; we surface the first.
    Falls back to `"oauth2"` so click handlers behave like before
    when the SDK doesn't fill in the field.
    """
    if getattr(app, "no_auth", False):
        return "none"
    schemes = getattr(app, "auth_schemes", None) or []
    if schemes:
        mode = getattr(schemes[0], "auth_mode", None) or ""
        return str(mode).lower() or "oauth2"
    return "oauth2"


_apps_cache: list[dict] | None = None
_apps_cache_at: datetime | None = None
_APPS_CACHE_TTL = timedelta(minutes=5)


async def _get_all_apps() -> list[dict]:
    """Fetch and cache the full Composio app catalog.

    The catalog is ~1000 entries and changes rarely; loading it on every
    page-flip wastes both Composio's quota and our request latency. Cache
    in process for 5 minutes — short enough that newly-published apps
    show up the same hour, long enough that paginating through doesn't
    cost a roundtrip per page.

    Order is preserved from Composio's `/v1/apps` response — that IS the
    popularity-curated ordering they ship (gmail / github / slack /
    notion / …). Do NOT alphabetize.
    """
    global _apps_cache, _apps_cache_at
    now = datetime.now(UTC)
    if _apps_cache is not None and _apps_cache_at is not None:
        if (now - _apps_cache_at) < _APPS_CACHE_TTL:
            return _apps_cache

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
            result.append(
                {
                    "name": key,
                    "display_name": display,
                    "logo": logo,
                    "description": desc[:200] if desc else "",
                    "auth_type": _primary_auth_type(app),
                }
            )
        return result

    fresh = await run_in_threadpool(_list)
    _apps_cache = fresh
    _apps_cache_at = now
    return fresh


async def get_app_by_name(name: str) -> dict | None:
    """Look up a single app by Composio slug. Used by the detail page so
    it doesn't have to fetch the entire paginated catalog just to learn
    one app's display name + logo. Re-uses the same in-process cache."""
    items = await _get_all_apps()
    for app in items:
        if app["name"] == name:
            return app
    return None


async def get_available_apps(
    search: str | None = None,
    page: int = 1,
    page_size: int = 24,
) -> dict:
    """Paginated catalog query.

    Caching the full list and slicing locally avoids the dual problem of
    (a) shipping 1000+ entries to every browser and (b) hitting Composio
    per page while the user paginates. Search is substring across slug /
    display name / description — the same fields the v1 SDK exposes.
    """
    items = await _get_all_apps()
    if search:
        q = search.lower()
        items = [
            a
            for a in items
            if q in a["name"].lower()
            or q in a["display_name"].lower()
            or q in a["description"].lower()
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
