from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, RootModel


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
    # Project this vault lives in. Required by clients so duplicate
    # slugs can be disambiguated on follow-up reads/writes.
    project_id: str
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


class VaultResolveResponse(RootModel[dict[str, object]]):
    pass


class VaultCredentialProfileUpsert(BaseModel):
    tool: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_.-]+$")
    profile: str = Field(
        default="default",
        min_length=1,
        max_length=120,
        pattern=r"^[A-Za-z0-9_.-]+$",
    )
    payload: str = Field(min_length=1)


class VaultCredentialProfileResolveRequest(BaseModel):
    tool: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_.-]+$")
    profile: str = Field(
        default="default",
        min_length=1,
        max_length=120,
        pattern=r"^[A-Za-z0-9_.-]+$",
    )
    project_id: UUID | None = None


class VaultCredentialProfileResponse(BaseModel):
    id: str
    project_id: str
    tool: str
    profile: str
    updated_at: datetime


class VaultCredentialProfileResolveResponse(VaultCredentialProfileResponse):
    payload: str
