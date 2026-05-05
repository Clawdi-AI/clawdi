from datetime import datetime
from typing import Literal

from pydantic import BaseModel, RootModel


class VaultCreate(BaseModel):
    slug: str
    name: str


class VaultItemUpsert(BaseModel):
    section: str = ""
    fields: dict[str, str]


class VaultItemDelete(BaseModel):
    section: str = ""
    fields: list[str]


class VaultResponse(BaseModel):
    id: str
    slug: str
    name: str
    # Scope this vault lives in. Required by the dashboard so a JWT
    # user with the same slug in two scopes (e.g. Personal + env-A)
    # can disambiguate when issuing slug-keyed sub-requests
    # (`/api/vault/{slug}/items?scope_id=...`). Without this, a
    # dashboard mutation could land in the wrong scope's vault.
    scope_id: str
    created_at: datetime


class VaultCreatedResponse(BaseModel):
    id: str
    slug: str


class VaultDeleteResponse(BaseModel):
    status: Literal["deleted"]


class VaultSectionsResponse(RootModel[dict[str, list[str]]]):
    pass


class VaultItemsUpsertResponse(BaseModel):
    status: Literal["ok"]
    fields: int


class VaultItemsDeleteResponse(BaseModel):
    status: Literal["deleted"]


class VaultResolveResponse(RootModel[dict[str, str]]):
    pass
