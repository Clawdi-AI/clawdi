from typing import Literal

from pydantic import BaseModel


class ConnectRequest(BaseModel):
    """Empty body kept for future fields. Cloud-api's connect route
    currently uses defaults for everything (OAuth, Composio-managed
    callback). Re-add `redirect_url` here when Phase 2 wires it through
    `create_connect_link`."""


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
    """User-supplied credentials for an API-key style connector."""

    credentials: dict[str, str]


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
