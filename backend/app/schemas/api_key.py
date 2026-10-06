from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.core.api_scopes import PERSONAL_KEY_SCOPES


class ApiKeyCreate(BaseModel):
    label: str
    # Optional Agent binding; mint_api_key enforces ownership. Bound and
    # unbound personal keys both require explicit permissions and expiry.
    environment_id: str | None = None
    scopes: list[str] = Field(min_length=1)
    expires_in_days: Literal[7, 30, 90]

    @field_validator("scopes")
    @classmethod
    def validate_scopes(cls, scopes: list[str]) -> list[str]:
        if any(scope not in PERSONAL_KEY_SCOPES for scope in scopes):
            raise ValueError("scopes must be a subset of personal key permissions")
        return list(dict.fromkeys(scopes))


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
