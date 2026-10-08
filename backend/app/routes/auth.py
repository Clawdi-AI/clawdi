from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth, require_reverified_web_auth
from app.core.database import get_session
from app.models.api_key import ApiKey
from app.schemas.api_key import (
    ApiKeyCreationRetiredResponse,
    ApiKeyResponse,
    ApiKeyRevokeResponse,
)
from app.schemas.problem import AccountSuspendedProblem
from app.schemas.user import CurrentUserResponse
from app.services.sync_events import notify_sync_subscriptions_changed

router = APIRouter(prefix="/auth", tags=["auth"])


_RETIRED_API_KEY_CREATION_DETAIL = (
    "API keys can no longer be created. Run `clawdi auth login` "
    "(use `--no-open` on a server). Existing keys keep working until revoked."
)


@router.post(
    "/keys",
    status_code=status.HTTP_410_GONE,
    response_model=ApiKeyCreationRetiredResponse,
    deprecated=True,
)
async def create_api_key() -> ApiKeyCreationRetiredResponse:
    raise HTTPException(status.HTTP_410_GONE, _RETIRED_API_KEY_CREATION_DETAIL)


@router.get("/keys", response_model=list[ApiKeyResponse])
async def list_api_keys(
    # Dashboard-only: a leaked deploy key would otherwise be able
    # to enumerate every other key issued for the account (id /
    # label / prefix / permission scopes / env binding). Mirrors the lockdown
    # applied to DELETE.
    auth: AuthContext = Depends(require_reverified_web_auth),
    db: AsyncSession = Depends(get_session),
):
    result = await db.execute(
        select(ApiKey)
        .where(
            ApiKey.user_id == auth.user_id,
            ApiKey.managed.is_(False),
            ApiKey.revoked_at.is_(None),
        )
        .order_by(ApiKey.created_at.desc())
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
            scopes=k.scopes,
        )
        for k in keys
    ]


@router.delete("/keys/{key_id}")
async def revoke_api_key(
    key_id: str,
    # Dashboard-only: a leaked key
    # otherwise could revoke its own parent / sibling keys to lock
    # the user out of the dashboard recovery flow.
    auth: AuthContext = Depends(require_reverified_web_auth),
    db: AsyncSession = Depends(get_session),
) -> ApiKeyRevokeResponse:
    result = await db.execute(
        select(ApiKey).where(ApiKey.id == key_id, ApiKey.user_id == auth.user_id)
    )
    api_key = result.scalar_one_or_none()
    if not api_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "API key not found")
    if api_key.managed:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Managed API keys cannot be revoked here")

    api_key.revoked_at = datetime.now(UTC)
    await notify_sync_subscriptions_changed(db, [api_key.user_id])
    await db.commit()
    return ApiKeyRevokeResponse(status="revoked")


@router.get(
    "/me",
    responses={
        status.HTTP_401_UNAUTHORIZED: {
            "model": AccountSuspendedProblem,
            "description": "The authenticated account is suspended",
            "content": {
                "application/problem+json": {
                    "schema": {"$ref": "#/components/schemas/AccountSuspendedProblem"}
                }
            },
        }
    },
)
async def get_me(auth: AuthContext = Depends(get_auth)) -> CurrentUserResponse:
    return CurrentUserResponse(
        id=str(auth.user.id),
        email=auth.user.email,
        name=auth.user.name,
        auth_type="api_key" if auth.is_cli else "clerk",
    )
