from typing import Literal

from pydantic import BaseModel


class ConnectRequest(BaseModel):
    redirect_url: str | None = None


class ConnectorConnectionResponse(BaseModel):
    id: str
    app_name: str
    status: str
    created_at: str


class ConnectorAvailableAppResponse(BaseModel):
    name: str
    display_name: str
    logo: str
    description: str


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
