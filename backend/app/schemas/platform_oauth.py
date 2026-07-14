from typing import Literal

from pydantic import BaseModel


class PlatformOAuthTokenResponse(BaseModel):
    access_token: str
    token_type: Literal["Bearer"] = "Bearer"
    expires_in: int
    scope: str


class PlatformOAuthErrorResponse(BaseModel):
    error: str
    error_description: str
