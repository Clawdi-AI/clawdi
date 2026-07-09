from typing import Literal

from pydantic import BaseModel

from app.schemas.ai_provider import AiProviderModel


class ManagedAiCatalogResponse(BaseModel):
    source: Literal["gateway", "fallback"]
    models: list[AiProviderModel]
