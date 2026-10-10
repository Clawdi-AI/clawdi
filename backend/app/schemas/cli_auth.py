from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr


class OAuthConfigResponse(BaseModel):
    """Public configuration for the first-party Clerk OAuth CLI client."""

    issuer: str
    client_id: str


class OAuthRevokeRequest(BaseModel):
    """Refresh credential forwarded only to Clerk's revoke-grant endpoint."""

    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    refresh_token: SecretStr = Field(min_length=1, max_length=8192)


class OAuthRevokeResponse(BaseModel):
    status: Literal["revoked"]


class DesktopSessionTicketResponse(BaseModel):
    """One-use Clerk sign-in token transported privately through Desktop's preload."""

    status: Literal["ticket", "signed-in", "sign-out"]
    ticket: str | None = Field(default=None, repr=False)
    expires_in: int
    clerk_user_id: str


class DesktopSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    user_id: str = Field(min_length=1, max_length=256, pattern=r"^user_[A-Za-z0-9_]+$")
    session_id: str = Field(min_length=1, max_length=256, pattern=r"^sess_[A-Za-z0-9]+$")


class DesktopSessionRevokeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    session_id: str = Field(min_length=1, max_length=256, pattern=r"^sess_[A-Za-z0-9]+$")
