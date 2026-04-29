import logging

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.auth import AuthContext, get_auth
from app.core.config import settings
from app.schemas.common import Paginated
from app.schemas.connector import (
    ConnectorAuthFieldsResponse,
    ConnectorAvailableAppResponse,
    ConnectorConnectionResponse,
    ConnectorConnectResponse,
    ConnectorCredentialsConnectRequest,
    ConnectorCredentialsConnectResponse,
    ConnectorDisconnectResponse,
    ConnectorMcpConfigResponse,
    ConnectorToolResponse,
    ConnectRequest,
)
from app.services.composio import (
    connect_with_credentials,
    create_connect_link,
    create_proxy_token,
    disconnect_account,
    get_app_by_name,
    get_app_tools,
    get_auth_fields,
    get_available_apps,
    get_connected_accounts,
)

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/connectors", tags=["connectors"])


def _map_composio_error(exc: Exception, *, scrub: dict[str, str] | None = None) -> HTTPException:
    """Translate Composio SDK exceptions into deterministic HTTP responses.

    Imports `composio.exceptions` lazily — the package initializes a
    filesystem cache directory at import time, which breaks cold
    starts in read-only / sandboxed environments. We mirror the
    lazy-import pattern already used in `app/services/composio.py` so
    the route module stays importable without a writable home dir.

    Buckets the SDK's structured exception subclasses (slug missing,
    credential validation, upstream timeout, upstream HTTP failure)
    into specific HTTP codes. Unknown exceptions get logged on the
    server with the full traceback and surface as a generic 502 —
    never `str(exc)`, which can echo internal IDs, stack info, or the
    user's own credentials back over the wire.

    `scrub` is the user's submitted credentials map; when present, any
    >=4-char value is redacted from the message text returned to the
    client (Composio sometimes echoes them in upstream templates).
    """
    from composio.exceptions import (
        HTTPError as ComposioHTTPError,
    )
    from composio.exceptions import (
        NotFoundError as ComposioNotFoundError,
    )
    from composio.exceptions import (
        SDKTimeoutError,
    )
    from composio.exceptions import (
        ValidationError as ComposioValidationError,
    )

    if isinstance(exc, (ComposioNotFoundError, ValueError)):
        return HTTPException(status.HTTP_404_NOT_FOUND, "Connector not found")
    if isinstance(exc, SDKTimeoutError):
        return HTTPException(
            status.HTTP_504_GATEWAY_TIMEOUT,
            "Composio took too long to respond. Please retry.",
        )
    if isinstance(exc, ComposioValidationError):
        msg = _scrub_credentials(str(exc), scrub or {}) or "Invalid credentials"
        return HTTPException(status.HTTP_400_BAD_REQUEST, msg)
    if isinstance(exc, ComposioHTTPError):
        return HTTPException(status.HTTP_502_BAD_GATEWAY, "Composio request failed")
    log.exception("Unhandled Composio SDK error", extra={"exc_type": type(exc).__name__})
    return HTTPException(status.HTTP_502_BAD_GATEWAY, "Connector service error")


@router.get("")
async def list_connections(
    auth: AuthContext = Depends(get_auth),
) -> list[ConnectorConnectionResponse]:
    """List user's connected services."""
    if not settings.composio_api_key:
        return []
    accounts = await get_connected_accounts(auth.user.clerk_id)
    return [ConnectorConnectionResponse.model_validate(account) for account in accounts]


@router.get("/available")
async def list_available_apps(
    auth: AuthContext = Depends(get_auth),
    search: str | None = Query(default=None, max_length=100),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=24, ge=1, le=100),
) -> Paginated[ConnectorAvailableAppResponse]:
    """Paginated Composio app catalog. Server holds the full list in a
    5-min in-process cache and slices per request, so paginating doesn't
    cost a Composio roundtrip per page and the browser only ships one
    page at a time. Search is substring across slug, display name, and
    description (server-side, before pagination)."""
    if not settings.composio_api_key:
        return Paginated[ConnectorAvailableAppResponse](
            items=[], total=0, page=page, page_size=page_size
        )
    page_data = await get_available_apps(search=search, page=page, page_size=page_size)
    return Paginated[ConnectorAvailableAppResponse](
        items=[ConnectorAvailableAppResponse.model_validate(a) for a in page_data["items"]],
        total=page_data["total"],
        page=page_data["page"],
        page_size=page_data["page_size"],
    )


@router.get("/available/{app_name}")
async def get_available_app(
    app_name: str,
    auth: AuthContext = Depends(get_auth),
) -> ConnectorAvailableAppResponse:
    """Single-app metadata lookup — used by the detail page so it doesn't
    have to page through the whole catalog to find one app's display name.
    Re-uses the cache that `/available` populates."""
    if not settings.composio_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Composio not configured")
    app = await get_app_by_name(app_name)
    if app is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Connector not found")
    return ConnectorAvailableAppResponse.model_validate(app)


@router.post("/{app_name}/connect")
async def connect_app(
    app_name: str,
    body: ConnectRequest | None = None,
    auth: AuthContext = Depends(get_auth),
) -> ConnectorConnectResponse:
    """Generate OAuth connect link for an app.

    Forwards `body.redirect_url` to Composio so the OAuth provider
    sends the user back to the caller's chosen landing page (e.g.
    the connector detail page on the frontend). If omitted, Composio
    falls back to its own managed callback.
    """
    if not settings.composio_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Composio not configured")
    redirect_url = body.redirect_url if body else None
    try:
        result = await create_connect_link(auth.user.clerk_id, app_name, redirect_url)
    except HTTPException:
        raise
    except Exception as exc:
        raise _map_composio_error(exc) from exc
    return ConnectorConnectResponse.model_validate(result)


@router.get("/{app_name}/auth-fields")
async def auth_fields(
    app_name: str,
    auth: AuthContext = Depends(get_auth),
) -> ConnectorAuthFieldsResponse:
    """Return the auth scheme + credential fields for non-OAuth apps.

    Used by the Connect dialog to render the right form (input names,
    secret vs. plaintext, required markers). The frontend only opens
    this dialog when the connector's `auth_type` is API-key style;
    OAuth apps short-circuit to `window.open(connect_url)` instead.
    """
    if not settings.composio_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Composio not configured")
    try:
        fields = await get_auth_fields(app_name)
    except HTTPException:
        raise
    except Exception as exc:
        raise _map_composio_error(exc) from exc
    return ConnectorAuthFieldsResponse.model_validate(fields)


def _scrub_credentials(message: str, credentials: dict[str, str]) -> str:
    """Redact submitted credential values from an error message.

    Composio's validation errors sometimes echo back the value the user
    submitted (e.g. "invalid api_key 'sk-…'"). Strip any of the user's
    actual values from the string before it reaches the client. We
    only redact non-trivial values (>= 4 chars) to avoid eating short
    placeholder words from generic error templates.
    """
    safe = message
    for v in credentials.values():
        v = (v or "").strip()
        if len(v) >= 4:
            safe = safe.replace(v, "***")
    return safe


@router.post("/{app_name}/connect-credentials")
async def connect_credentials(
    app_name: str,
    body: ConnectorCredentialsConnectRequest,
    auth: AuthContext = Depends(get_auth),
) -> ConnectorCredentialsConnectResponse:
    """Create a connection from user-supplied API-key credentials.

    The service polls Composio's `wait_until_active` (capped at 15s) so
    a 200 here means the connection is ACTIVE — the frontend can render
    it immediately without its own polling loop. Slow upstream auth
    surfaces as 504.
    """
    if not settings.composio_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Composio not configured")
    if not body.credentials:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Credentials required")
    # Reject blank values up front. The SDK forwards them to Composio
    # which 400s with a less helpful "field X is required" — surface
    # the issue here so the user keeps their other inputs in the form.
    if any(not v.strip() for v in body.credentials.values()):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Credential values cannot be empty")
    try:
        result = await connect_with_credentials(auth.user.clerk_id, app_name, body.credentials)
    except TimeoutError as exc:
        # `connect_with_credentials` polls Composio with a bounded
        # timeout; built-in `TimeoutError` is what `wait_until_active`
        # raises (separate hierarchy from `SDKTimeoutError`). Surface
        # as 504 so the frontend can distinguish "credentials look
        # wrong" (400) from "we couldn't reach Composio" (504).
        raise HTTPException(
            status.HTTP_504_GATEWAY_TIMEOUT,
            "Composio did not validate the connection in time. Please retry.",
        ) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise _map_composio_error(exc, scrub=body.credentials) from exc
    return ConnectorCredentialsConnectResponse.model_validate(result)


@router.delete("/{connection_id}")
async def disconnect(
    connection_id: str,
    auth: AuthContext = Depends(get_auth),
) -> ConnectorDisconnectResponse:
    """Disconnect a connected account.

    Ownership guard: Composio identifies connections by id globally, so we
    must confirm the connection belongs to this user before deleting it —
    otherwise any authenticated user could delete anyone else's integration.
    """
    if not settings.composio_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Composio not configured")

    accounts = await get_connected_accounts(auth.user.clerk_id)
    if not any(a.get("id") == connection_id for a in accounts):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found")

    success = await disconnect_account(connection_id)
    if not success:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Failed to disconnect")
    return ConnectorDisconnectResponse(status="disconnected")


@router.get("/mcp-config")
async def get_mcp_config(
    auth: AuthContext = Depends(get_auth),
) -> ConnectorMcpConfigResponse:
    """Get MCP proxy config for the current user."""
    if not settings.composio_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Composio not configured")

    token = create_proxy_token(auth.user.clerk_id)
    base = settings.public_api_url.rstrip("/")

    return ConnectorMcpConfigResponse(
        mcp_url=f"{base}/api/mcp/proxy",
        mcp_token=token,
    )


@router.get("/{app_name}/tools")
async def list_app_tools(
    app_name: str,
    auth: AuthContext = Depends(get_auth),
) -> list[ConnectorToolResponse]:
    """List available tools/actions for a specific app."""
    if not settings.composio_api_key:
        return []
    tools = await get_app_tools(app_name)
    return [ConnectorToolResponse.model_validate(tool) for tool in tools]
