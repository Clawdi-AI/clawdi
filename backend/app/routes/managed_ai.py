from fastapi import APIRouter, Depends

from app.core.auth import AuthContext, require_user_auth
from app.schemas.managed_ai import ManagedAiCatalogResponse
from app.services import managed_ai_catalog

router = APIRouter(prefix="/managed-ai", tags=["managed-ai"])


@router.get("/models", response_model=ManagedAiCatalogResponse, response_model_exclude_none=True)
async def list_managed_ai_models(
    _: AuthContext = Depends(require_user_auth),
) -> ManagedAiCatalogResponse:
    catalog = await managed_ai_catalog.load_managed_ai_catalog()
    return ManagedAiCatalogResponse(source=catalog.source, models=catalog.models)
