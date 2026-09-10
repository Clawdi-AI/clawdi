from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, is_env_bound_api_key, require_user_auth
from app.core.database import get_session
from app.core.project import resolve_default_write_project
from app.schemas.vault_requests import (
    VaultSecretRequestCreate,
    VaultSecretRequestCreated,
    VaultSecretRequestStatus,
    VaultSecretRequestSupply,
    VaultSecretRequestToken,
)
from app.services import vault_requests as service
from app.services.vault import get_vault_for_write

router = APIRouter(prefix="/vault/requests", tags=["vault"])


@router.post("")
async def create_request(
    body: VaultSecretRequestCreate,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> VaultSecretRequestCreated:
    return await service.create_request(db, auth, body)


@router.post("/inspect")
async def inspect_request(
    body: VaultSecretRequestToken,
    db: AsyncSession = Depends(get_session),
) -> VaultSecretRequestStatus:
    row = await service.token_request(db, body.token)
    result = await service.describe(db, row)
    if result.status != "pending":
        raise service.unavailable()
    return result


@router.post("/supply")
async def supply_request(
    body: VaultSecretRequestSupply,
    db: AsyncSession = Depends(get_session),
) -> VaultSecretRequestStatus:
    return await service.supply(db, body)


@router.get("")
async def list_requests(
    slug: str,
    vault_id: UUID,
    project_id: UUID | None = None,
    limit: int = Query(default=50, ge=1, le=100),
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> list[VaultSecretRequestStatus]:
    if project_id is None and is_env_bound_api_key(auth):
        project_id = await resolve_default_write_project(db, auth)
    await get_vault_for_write(db, auth, slug, project_id=project_id, vault_id=vault_id)
    return await service.recent_requests(db, vault_id, project_id, limit=limit)


@router.get("/{request_id:uuid}")
async def get_request(
    request_id: UUID,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> VaultSecretRequestStatus:
    return await service.describe(db, await service.owned_request(db, auth, request_id))
