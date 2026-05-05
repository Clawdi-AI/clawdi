from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class ApiKeyCreate(BaseModel):
    label: str
    # Optional binding for "deploy key" minting via the same
    # endpoint. When the dashboard hosts an agent on Clawdi-cloud
    # (or any external control plane the user trusts), it mints
    # a key here pinned to that env. `environment_id` must be
    # owned by the calling user — enforced at the service layer
    # in `mint_api_key`.
    #
    # `scopes` defaults to None — i.e. full account access, same as
    # a key the user mints for their own laptop. The hosted agent
    # behaves identically to a self-installed clawdi: vault, memory,
    # settings, sessions, skills are all reachable. Pass an explicit
    # list only if the dashboard wants a narrower key for a specific
    # use-case.
    environment_id: str | None = None
    scopes: list[str] | None = None


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


class ApiKeyRevokeResponse(BaseModel):
    status: Literal["revoked"]
