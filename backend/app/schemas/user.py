from typing import Literal

from pydantic import BaseModel


class CurrentUserResponse(BaseModel):
    id: str
    email: str | None
    name: str | None
    auth_type: Literal["api_key", "clerk"]
