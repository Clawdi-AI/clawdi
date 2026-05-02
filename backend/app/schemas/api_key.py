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


class ApiKeyIntrospectRequest(BaseModel):
    """Used by external control planes (e.g. clawdi-monorepo's deploy
    pipeline) to validate a raw_key the dashboard handed them is
    actually bound to the env they think it is, before injecting it
    into a pod Secret. Closes the intra-user "wrong env binding" gap
    that same-Clerk-tenant alone does not catch."""

    api_key: str
    # Caller's claim about which env this key is for. Server compares
    # against the row's stored binding; mismatch returns valid=False
    # without leaking which env the key actually points at.
    environment_id: str


class ApiKeyIntrospectResponse(BaseModel):
    valid: bool
    # Populated only when valid=True — caller already proved Clerk
    # ownership and matched the env binding, so the metadata is safe
    # to return. valid=False intentionally returns nothing else so a
    # malicious caller can't enumerate (api_key, env_id) pairs.
    key_id: str | None = None
    user_id: str | None = None
    environment_id: str | None = None
    scopes: list[str] | None = None
    expires_at: datetime | None = None
