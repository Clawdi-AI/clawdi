from datetime import datetime

from pydantic import BaseModel


class ApiKeyCreate(BaseModel):
    label: str


class ApiKeyResponse(BaseModel):
    id: str
    label: str
    key_prefix: str
    created_at: datetime
    last_used_at: datetime | None
    expires_at: datetime | None
    revoked_at: datetime | None

    model_config = {"from_attributes": True}


class ApiKeyCreated(ApiKeyResponse):
    """Returned only on creation — includes the raw key (shown once)."""

    raw_key: str
