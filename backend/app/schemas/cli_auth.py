from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr


class OAuthConfigResponse(BaseModel):
    """Public configuration for the first-party Clerk OAuth CLI client."""

    issuer: str
    client_id: str
    audience: str
    authorized_parties: list[str] = Field(default_factory=list)


class OAuthRevokeRequest(BaseModel):
    """Refresh credential forwarded only to Clerk's revoke-grant endpoint."""

    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    refresh_token: SecretStr = Field(min_length=1, max_length=8192)


class OAuthRevokeResponse(BaseModel):
    status: Literal["revoked"]
