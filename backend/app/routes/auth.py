from datetime import UTC
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth, require_web_auth
from app.core.database import get_session
from app.models.api_key import ApiKey
from app.schemas.api_key import ApiKeyCreate, ApiKeyCreated, ApiKeyResponse, ApiKeyRevokeResponse
from app.schemas.user import CurrentUserResponse
from app.services.api_key import mint_api_key

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/keys", response_model=ApiKeyCreated)
async def create_api_key(
    body: ApiKeyCreate,
    # Dashboard-only: a leaked deploy-key must not be able to mint a
    # broader-scope or unscoped key for itself. Minting flows live
    # behind a human-in-browser action (settings → API Keys, or the
    # device-flow approval). Headless callers should use the
    # device-flow / OAuth path, not call this endpoint directly.
    #
    # When `body.environment_id` is set, this also serves as the
    # "mint a deploy key for a hosted-agent pod" path — the
    # dashboard hands the resulting key to the external control
    # plane (clawdi-monorepo) which bakes it into the pod's
    # CLAWDI_AUTH_TOKEN env. No backend-to-backend call required;
    # the user's browser is the only conduit and `mint_api_key`
    # service-layer validates env ownership against `auth.user_id`.
    #
    # Scope policy: deploy keys default to FULL account access —
    # same as a key the user mints for their own laptop. The hosted
    # agent should be able to do whatever the user can do (vault,
    # memories, settings — not just push sessions/skills). The
    # `scopes` body field is still honoured if the caller wants to
    # narrow on purpose; passing `null`/omitting it = no narrowing.
    auth: AuthContext = Depends(require_web_auth),
    db: AsyncSession = Depends(get_session),
):
    env_uuid: UUID | None = None
    if body.environment_id:
        try:
            env_uuid = UUID(body.environment_id)
        except (TypeError, ValueError) as e:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "environment_id is not a valid UUID"
            ) from e
    try:
        minted = await mint_api_key(
            db,
            user_id=auth.user_id,
            label=body.label,
            scopes=body.scopes,
            environment_id=env_uuid,
        )
    except ValueError as e:
        # `mint_api_key` raises ValueError for cross-tenant
        # environment_id — surface as 403 so the dashboard's UI
        # doesn't accidentally dump the user_id mismatch detail.
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(e)) from e
    api_key = minted.api_key
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


@router.get("/keys", response_model=list[ApiKeyResponse])
async def list_api_keys(
    # Dashboard-only: a leaked deploy key would otherwise be able
    # to enumerate every other key issued for the account (id /
    # label / prefix / scopes / env binding). Mirrors the lockdown
    # already applied to POST + DELETE.
    auth: AuthContext = Depends(require_web_auth),
    db: AsyncSession = Depends(get_session),
):
    result = await db.execute(
        select(ApiKey).where(ApiKey.user_id == auth.user_id).order_by(ApiKey.created_at.desc())
    )
    keys = result.scalars().all()
    return [
        ApiKeyResponse(
            id=str(k.id),
            label=k.label,
            key_prefix=k.key_prefix,
            created_at=k.created_at,
            last_used_at=k.last_used_at,
            expires_at=k.expires_at,
            revoked_at=k.revoked_at,
        )
        for k in keys
    ]


@router.delete("/keys/{key_id}")
async def revoke_api_key(
    key_id: str,
    # Dashboard-only for the same reason as create: a leaked key
    # otherwise could revoke its own parent / sibling keys to lock
    # the user out of the dashboard recovery flow.
    auth: AuthContext = Depends(require_web_auth),
    db: AsyncSession = Depends(get_session),
) -> ApiKeyRevokeResponse:
    from datetime import datetime

    result = await db.execute(
        select(ApiKey).where(ApiKey.id == key_id, ApiKey.user_id == auth.user_id)
    )
    api_key = result.scalar_one_or_none()
    if not api_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "API key not found")

    api_key.revoked_at = datetime.now(UTC)
    await db.commit()
    return ApiKeyRevokeResponse(status="revoked")


@router.get("/me")
async def get_me(auth: AuthContext = Depends(get_auth)) -> CurrentUserResponse:
    return CurrentUserResponse(
        id=str(auth.user.id),
        email=auth.user.email,
        name=auth.user.name,
        auth_type="api_key" if auth.is_cli else "clerk",
    )
