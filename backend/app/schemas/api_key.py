from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class ApiKeyCreationRetiredResponse(BaseModel):
    detail: str


class ApiKeyResponse(BaseModel):
    id: str
    label: str
    key_prefix: str
    created_at: datetime
    last_used_at: datetime | None
    expires_at: datetime | None
    revoked_at: datetime | None
    scopes: list[str] | None

    model_config = {"from_attributes": True}


class ApiKeyCreated(ApiKeyResponse):
    """Returned only on creation — includes the raw key (shown once)."""

    raw_key: str


class ApiKeyRevokeResponse(BaseModel):
    status: Literal["revoked"]


class ApiKeyUsageResponse(BaseModel):
    """Usage metadata for rotation decisions, without credential material."""

    id: str
    created_at: datetime
    last_used_at: datetime | None
    expires_at: datetime | None
    revoked_at: datetime | None
