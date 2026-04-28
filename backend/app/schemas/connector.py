from typing import Literal

from pydantic import BaseModel, Field, field_validator


class ConnectRequest(BaseModel):
    """OAuth connect-link request body.

    `redirect_url` is the absolute URL Composio redirects the user
    back to after the OAuth flow completes. The frontend supplies
    its own connector detail page (e.g.
    `https://cloud.example.com/connectors/gmail`); when omitted,
    Composio uses its own managed callback. Length is capped and
    the scheme is restricted to http(s) so a hostile caller can't
    route OAuth through `javascript:` / `data:` / arbitrary schemes
    that Composio (or some downstream) might honor.
    """

    redirect_url: str | None = Field(default=None, max_length=2048)

    @field_validator("redirect_url")
    @classmethod
    def _http_scheme(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if not (v.startswith("http://") or v.startswith("https://")):
            raise ValueError("redirect_url must start with http:// or https://")
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
