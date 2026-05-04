"""Admin endpoints — gated by `X-Admin-Key` shared secret.

Used by SaaS batch tooling (e.g. live-sync migration of pre-Phase-4a
deployments) + ops-side scripts that don't have a per-user Clerk JWT
in scope. Disabled by default — `settings.admin_api_key` must be set
to a strong secret to enable.

**Privacy invariant:** admin-minted keys can ONLY carry write-side
scopes. Read-side scopes (`sessions:read`, `memories:read`,
`vault:resolve`, `vault:write`) are deliberately excluded from the
allowlist. Rationale: admin-key compromise gives an attacker the
ability to push fake data into users' accounts (recoverable data-
integrity issue), NOT the ability to read users' existing data
(privacy catastrophe). Per-user mint via Clerk JWT
(`POST /api/auth/keys`) still grants full access — that path is
gated by the user's own auth, so they grant access to themselves.

Surface kept minimal: just the operations that batch tooling
genuinely can't accomplish via per-user Clerk JWTs. Future admin
endpoints (list users, view any deployment, audit-log query, etc.)
can land in this file under the same auth dep.
"""

import logging
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import require_admin_api_key
from app.core.database import get_session
from app.models.api_key import ApiKey
from app.models.user import User
from app.schemas.admin import AdminApiKeyCreate
from app.schemas.api_key import ApiKeyCreated, ApiKeyRevokeResponse
from app.services.api_key import mint_api_key

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin", tags=["admin"])

# Scopes admin-minted keys are allowed to carry. Any scope not in
# this set is silently incompatible with privacy goals — admin must
# not be able to mint keys that read user data. Live sync only needs
# write-side scopes plus skills:read for `clawdi pull` of starter
# skills. Vault scopes intentionally excluded until Phase 4b ships
# per-deployment vault allowlists (which would scope-down vault:resolve
# to whitelisted URIs — until then, admin granting vault:resolve
# would expose every secret in the user's account).
ADMIN_ALLOWED_SCOPES: frozenset[str] = frozenset({
    "sessions:write",
    "skills:read",
    "skills:write",
    "memories:write",
    "mcp:proxy",
    "tunnel:proxy",
})


@router.post("/auth/keys", response_model=ApiKeyCreated)
async def admin_mint_api_key(
    body: AdminApiKeyCreate,
    _: None = Depends(require_admin_api_key),
    db: AsyncSession = Depends(get_session),
) -> ApiKeyCreated:
    """Mint an api_key on behalf of a user identified by Clerk id.

    Used by SaaS batch tooling for live-sync migration: each pre-
    Phase-4a deployment needs a fresh api_key bound to a fresh env,
    but the migration script has no per-user Clerk JWT.
    """
    target = (
        await db.execute(select(User).where(User.clerk_id == body.target_clerk_id))
    ).scalar_one_or_none()
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "target user not found")

    env_uuid: UUID | None = None
    if body.environment_id:
        try:
            env_uuid = UUID(body.environment_id)
        except (TypeError, ValueError) as e:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "environment_id is not a valid UUID"
            ) from e

    # Privacy gate: admin endpoint can only grant write-side scopes.
    # `scopes=None` from the caller does NOT default to full account
    # access (that would defeat the privacy invariant) — instead it
    # defaults to the full allowlist. Caller can narrow further by
    # passing an explicit subset; expansion is rejected with 400.
    if body.scopes is None:
        scopes = sorted(ADMIN_ALLOWED_SCOPES)
    else:
        invalid = set(body.scopes) - ADMIN_ALLOWED_SCOPES
        if invalid:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "admin endpoint cannot grant these scopes: "
                f"{sorted(invalid)}. Allowed: {sorted(ADMIN_ALLOWED_SCOPES)}.",
            )
        scopes = body.scopes

    try:
        minted = await mint_api_key(
            db,
            user_id=target.id,
            label=body.label,
            scopes=scopes,
            environment_id=env_uuid,
        )
    except ValueError as e:
        # `mint_api_key` raises ValueError for cross-tenant
        # environment_id (env not owned by target user). Surface
        # as 403 — admin can't bypass the service-layer invariant.
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(e)) from e

    api_key = minted.api_key
    logger.info(
        "admin_api_key_minted target_clerk_id=%s key_id=%s environment_id=%s",
        body.target_clerk_id,
        api_key.id,
        api_key.environment_id,
    )
    return ApiKeyCreated(
        id=str(api_key.id),
        label=api_key.label,
        key_prefix=api_key.key_prefix,
        created_at=api_key.created_at,
        last_used_at=api_key.last_used_at,
        expires_at=api_key.expires_at,
        revoked_at=api_key.revoked_at,
        raw_key=minted.raw_key,
    )


@router.delete("/auth/keys/{key_id}", response_model=ApiKeyRevokeResponse)
async def admin_revoke_api_key(
    key_id: UUID,
    _: None = Depends(require_admin_api_key),
    db: AsyncSession = Depends(get_session),
) -> ApiKeyRevokeResponse:
    """Revoke any user's api_key. Used by SaaS admin/account-deletion
    paths (which don't have the user's Clerk JWT) to close the
    orphan-key gap from the cross-PR audit."""
    api_key = (
        await db.execute(select(ApiKey).where(ApiKey.id == key_id))
    ).scalar_one_or_none()
    if api_key is None:
        # 404 = idempotent success for the caller. The migration
        # script can re-run after a partial failure without
        # special-casing already-revoked keys.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "API key not found")

    if api_key.revoked_at is not None:
        # Already revoked — idempotent, return existing state.
        return ApiKeyRevokeResponse(status="revoked")

    api_key.revoked_at = datetime.now(UTC)
    await db.commit()
    logger.info(
        "admin_api_key_revoked target_user_id=%s key_id=%s",
        api_key.user_id,
        api_key.id,
    )
    return ApiKeyRevokeResponse(status="revoked")
