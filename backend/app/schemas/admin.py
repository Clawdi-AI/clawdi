"""Schemas for admin endpoints (`/api/admin/*`).

These run behind the `X-Admin-Key` header gate (require_admin_api_key)
and are used by SaaS batch tooling + ops-side scripts. Kept in a
separate file so they don't pollute user-facing schemas.
"""

from pydantic import BaseModel


class AdminEnvironmentCreate(BaseModel):
    """Body for `POST /api/admin/environments`. Mirrors the
    user-facing EnvironmentCreate but takes target_clerk_id
    instead of relying on auth context to resolve the user.

    Idempotent — re-registering the same (user, machine_id) pair
    updates `machine_name` / `agent_version` / `last_seen_at` and
    returns the existing env id.
    """

    target_clerk_id: str
    machine_id: str
    machine_name: str
    agent_type: str
    agent_version: str | None = None
    os_name: str = "linux"


class AdminApiKeyCreate(BaseModel):
    """Body for `POST /api/admin/auth/keys` — mint an api_key on
    behalf of a user identified by Clerk id. The route resolves
    `target_clerk_id` to the internal `User.id` and then calls the
    existing `mint_api_key` service, preserving the env-ownership
    invariant the service enforces.

    `environment_id` is optional — if set, the minted key is bound
    to that env (deploy-key semantics). If null, the key is unbound.

    `scopes` is optional — semantics differ from the user-facing
    `ApiKeyCreate`:
      - `None` defaults to the admin write-side allowlist (NOT full
        account access). See `ADMIN_ALLOWED_SCOPES` in routes/admin.py.
      - Non-`None` must be a subset of the allowlist; values outside
        return 400. Caller can narrow further but cannot expand
        beyond the allowlist.

    The asymmetry is deliberate: admin keys are operational tools
    for batch tasks (migration, ops cleanup) and must not become a
    privacy bypass.
    """

    target_clerk_id: str
    label: str
    environment_id: str | None = None
    scopes: list[str] | None = None
