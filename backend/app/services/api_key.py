"""ApiKey minting service.

Single source of truth for ApiKey creation. The dashboard route
`POST /api/auth/keys` walks through `mint_api_key()`. Deploy-key
flow (where the dashboard mints a key for an externally-hosted
agent pod and hands it to clawdi.ai's control plane) uses the
SAME route, with `environment_id` set on the request body —
gated by the user's Clerk JWT, no backend-to-backend secrets.

Deploy-keys differ from interactive keys only in their
`environment_id` column. Default scope is full account access
just like a self-installed clawdi key; the dashboard can pass an
explicit narrower `scopes` list per use-case if it wants.
"""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.api_key import ApiKey
from app.models.session import AgentEnvironment


@dataclass
class MintedKey:
    """Result of `mint_api_key()`. The raw key is shown once and
    discarded — only the hash lives in the DB."""

    api_key: ApiKey
    raw_key: str


def _generate() -> tuple[str, str, str]:
    """Returns (raw_key, key_hash, key_prefix)."""
    raw = "clawdi_" + secrets.token_urlsafe(32)
    key_hash = hashlib.sha256(raw.encode()).hexdigest()
    key_prefix = raw[:16]
    return raw, key_hash, key_prefix


async def mint_api_key(
    db: AsyncSession,
    *,
    user_id: UUID,
    label: str,
    scopes: list[str] | None = None,
    environment_id: UUID | None = None,
) -> MintedKey:
    """Create a new ApiKey row.

    `scopes=None` means full account access — interactive keys
    minted via `clawdi auth login`. `scopes=[...]` narrows the
    key to specific operations; v1 deploy-keys use
    `["sessions:write", "skills:read", "skills:write"]`.

    `environment_id` binds the key to a single AgentEnvironment.
    A leaked deploy-key from pod A then can't write into pod B's
    resources on the same account — narrows the blast radius.
    """
    # Defense-in-depth: every route caller already checks env
    # ownership before calling this service, but the service
    # itself enforces it too. A future caller that forgets the
    # check (or a refactor that drops it) can't accidentally
    # mint a key bound to someone else's env. Cheap one-row
    # SELECT compared to the cost of cross-tenant credentials.
    if environment_id is not None:
        owner_check = await db.execute(
            select(AgentEnvironment.id).where(
                AgentEnvironment.id == environment_id,
                AgentEnvironment.user_id == user_id,
            )
        )
        if owner_check.scalar_one_or_none() is None:
            raise ValueError(
                f"environment {environment_id} is not owned by user {user_id}; "
                "refusing to mint cross-tenant deploy key"
            )
    raw, key_hash, key_prefix = _generate()
    api_key = ApiKey(
        user_id=user_id,
        key_hash=key_hash,
        key_prefix=key_prefix,
        label=label,
        scopes=scopes,
        environment_id=environment_id,
    )
    db.add(api_key)
    await db.commit()
    await db.refresh(api_key)
    return MintedKey(api_key=api_key, raw_key=raw)
