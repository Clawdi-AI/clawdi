"""Backend capability flags for the dashboard.

Single GET endpoint that exposes which optional features the
current deployment supports, so the UI can hide / disable
controls that the backend can't honor (e.g. the `Mem0` memory
provider option when the `[mem0]` extra isn't installed).

Auth: any logged-in user (Clerk JWT). Capabilities are
deployment-wide, not per-user, so we don't need scope checks —
but we do require auth so unauth probes can't fingerprint the
deployment.

Cached at the module level via the underlying
`mem0_available()` helper (lru). Called once per dashboard page
load; near-zero cost.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.core.auth import AuthContext, require_user_auth
from app.services.memory_provider import mem0_available

router = APIRouter(prefix="/api", tags=["capabilities"])


class CapabilitiesResponse(BaseModel):
    """Feature flags the dashboard branches on.

    Add new fields here when introducing optional integrations.
    Keep field names stable — the frontend treats this response
    as a feature-detection contract."""

    memory_providers: list[str]
    """Memory providers the backend can serve. Always includes
    `\"builtin\"`. Includes `\"mem0\"` iff the `[mem0]` optional
    extra is installed and the `mem0` Python module imports
    cleanly. UI hides any provider not in this list."""


@router.get("/capabilities")
async def get_capabilities(
    _auth: AuthContext = Depends(require_user_auth),
) -> CapabilitiesResponse:
    providers = ["builtin"]
    if mem0_available():
        providers.append("mem0")
    return CapabilitiesResponse(memory_providers=providers)
