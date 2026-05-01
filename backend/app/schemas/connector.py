from typing import Literal
from urllib.parse import urlparse

from pydantic import BaseModel, Field, field_validator

from app.core.config import settings


def _allowed_redirect_origins() -> set[str]:
    """Parse `web_origin` (and `cors_origins`) into the set of
    `(scheme, netloc)` pairs we'll accept for OAuth callbacks. The
    web_origin is the canonical answer; CORS origins are added as
    a fallback for staging / preview deploys that share the same
    backend. We compare against (scheme, netloc) instead of the
    full URL so the caller can pick any path under our origin."""
    raw_origins: list[str] = []
    if settings.web_origin:
        raw_origins.append(settings.web_origin)
    raw_origins.extend(settings.cors_origins)
    out: set[str] = set()
    for o in raw_origins:
        parsed = urlparse(o.rstrip("/"))
        if parsed.scheme and parsed.netloc:
            out.add(f"{parsed.scheme}://{parsed.netloc}")
    return out


class ConnectRequest(BaseModel):
    """OAuth connect-link request body.

    `redirect_url` is the absolute URL Composio redirects the user
    back to after the OAuth flow completes. The frontend supplies
    its own connector detail page (e.g.
    `https://cloud.example.com/connectors/gmail`); when omitted,
    Composio uses its own managed callback. The origin must match
    `web_origin` (or one of `cors_origins` for staging/preview),
    otherwise an authenticated caller could turn this into an open
    redirect: present the user a "Connect Gmail" link that lands on
    an attacker-controlled domain after OAuth completes, where
    cookies / tokens / phishing UIs become reachable.
    """

    redirect_url: str | None = Field(default=None, max_length=2048)

    @field_validator("redirect_url")
    @classmethod
    def _origin_allowlist(cls, v: str | None) -> str | None:
        if v is None:
            return v
        try:
            parsed = urlparse(v)
        except ValueError as e:
            raise ValueError("redirect_url is not a valid URL") from e
        if parsed.scheme not in ("http", "https"):
            raise ValueError("redirect_url must use http:// or https://")
        if not parsed.netloc:
            raise ValueError("redirect_url must include a host")
        candidate = f"{parsed.scheme}://{parsed.netloc}"
        allowed = _allowed_redirect_origins()
        if not allowed:
            # Misconfigured deployment (no web_origin, no
            # cors_origins) — refuse rather than fail open.
            raise ValueError("redirect_url not allowed for this deployment")
        if candidate not in allowed:
            raise ValueError(
                f"redirect_url origin {candidate!r} is not in the configured allowlist"
            )
        return v


class ConnectorConnectionResponse(BaseModel):
    id: str
    app_name: str
    status: str
    created_at: str
    # User-facing identity label (e.g. their Gmail address). `None` when
    # Composio hasn't resolved it yet, which is common right after OAuth
    # completes. Surfacing it lets the UI tell apart multiple
    # connections to the same app.
    account_display: str | None = None


class ConnectorAvailableAppResponse(BaseModel):
    name: str
    display_name: str
    logo: str
    description: str
    # Surfaces Composio's auth scheme so the UI can pick OAuth vs an
    # API-key form on click. Lowercase strings — `oauth2`, `api_key`,
    # `bearer_token`, `basic`, `none`. Falls back to "oauth2" when the
    # SDK doesn't surface one.
    auth_type: str = "oauth2"


class ConnectorAuthFieldResponse(BaseModel):
    """One input expected from the user when connecting via API key."""

    name: str
    display_name: str
    description: str = ""
    type: str = "string"
    required: bool = True
    is_secret: bool = False
    expected_from_customer: bool = True
    default: str | None = None


class ConnectorAuthFieldsResponse(BaseModel):
    """Schema describing how the user should authenticate this connector."""

    auth_scheme: str
    expected_input_fields: list[ConnectorAuthFieldResponse]


class ConnectorCredentialsConnectRequest(BaseModel):
    """User-supplied credentials for an API-key style connector.

    Bounds picked to fit any sane API-key form (Composio's largest
    schema we've seen has ~6 fields; a single API key fits well under
    8KB) while rejecting payloads that don't look like credentials at
    all. Caps protect against accidental large-blob submissions and
    keep error logs / Composio request bodies small.
    """

    credentials: dict[str, str] = Field(..., min_length=1, max_length=20)

    @field_validator("credentials")
    @classmethod
    def _bounded(cls, v: dict[str, str]) -> dict[str, str]:
        for k, val in v.items():
            if len(k) > 64:
                raise ValueError("Credential field name too long")
            if len(val) > 8192:
                raise ValueError("Credential value too long")
        return v


class ConnectorCredentialsConnectResponse(BaseModel):
    id: str
    status: str
    ok: bool


class ConnectorConnectResponse(BaseModel):
    connect_url: str
    id: str


class ConnectorDisconnectResponse(BaseModel):
    status: Literal["disconnected"]


class ConnectorMcpConfigResponse(BaseModel):
    mcp_url: str
    mcp_token: str


class ConnectorToolParametersResponse(BaseModel):
    properties: dict
    required: list[str]


class ConnectorToolResponse(BaseModel):
    name: str
    display_name: str
    description: str
    is_deprecated: bool
    app: str | None = None
    parameters: ConnectorToolParametersResponse | None = None
