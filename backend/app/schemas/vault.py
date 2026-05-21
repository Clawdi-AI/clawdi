import re
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, RootModel, field_validator

VAULT_SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$")
VAULT_ITEM_SEGMENT_RE = re.compile(r"^[A-Za-z0-9_.-]+$")


def _clean_segment(value: str, *, field_name: str, allow_empty: bool = False) -> str:
    cleaned = value.strip()
    if not cleaned:
        if allow_empty:
            return ""
        raise ValueError(f"{field_name} cannot be empty")
    if len(cleaned) > 200:
        raise ValueError(f"{field_name} must be at most 200 characters")
    if not VAULT_ITEM_SEGMENT_RE.fullmatch(cleaned):
        raise ValueError(
            f"{field_name} may contain only letters, numbers, dots, underscores, and hyphens"
        )
    return cleaned


class VaultCreate(BaseModel):
    slug: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=200)

    @field_validator("slug", mode="after")
    @classmethod
    def validate_slug(cls, value: str) -> str:
        slug = value.strip()
        if not VAULT_SLUG_RE.fullmatch(slug):
            raise ValueError(
                "slug must use lowercase letters, numbers, and hyphens, "
                "without leading or trailing hyphens"
            )
        return slug

    @field_validator("name", mode="after")
    @classmethod
    def validate_name(cls, value: str) -> str:
        name = value.strip()
        if not name:
            raise ValueError("name cannot be empty")
        return name


class VaultItemUpsert(BaseModel):
    section: str = Field(default="", max_length=200)
    fields: dict[str, str] = Field(min_length=1, max_length=200)

    @field_validator("section", mode="after")
    @classmethod
    def validate_section(cls, value: str) -> str:
        return _clean_segment(value, field_name="section", allow_empty=True)

    @field_validator("fields", mode="after")
    @classmethod
    def validate_field_names(cls, value: dict[str, str]) -> dict[str, str]:
        return {
            _clean_segment(field_name, field_name="field name"): field_value
            for field_name, field_value in value.items()
        }


class VaultItemDelete(BaseModel):
    section: str = Field(default="", max_length=200)
    fields: list[str] = Field(min_length=1, max_length=200)

    @field_validator("section", mode="after")
    @classmethod
    def validate_section(cls, value: str) -> str:
        return _clean_segment(value, field_name="section", allow_empty=True)

    @field_validator("fields", mode="after")
    @classmethod
    def validate_field_names(cls, value: list[str]) -> list[str]:
        return [_clean_segment(field_name, field_name="field name") for field_name in value]


class VaultResponse(BaseModel):
    id: str
    slug: str
    name: str
    # Legacy single-Project field kept for older CLI versions and
    # scripts. New clients should read `project_ids`.
    project_id: str | None = None
    # Projects this vault is attached to and visible through for the
    # current caller. Key rows belong to the vault, not to Projects.
    project_ids: list[str]
    is_owner: bool = True
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


class VaultReferenceResolveInput(BaseModel):
    reference: str = Field(min_length=1, max_length=1000)
    vault_slug: str = Field(min_length=1, max_length=200)
    section: str = Field(default="", max_length=200)
    field: str = Field(min_length=1, max_length=200)
    project_id: UUID | None = None


class VaultBulkResolveRequest(BaseModel):
    references: list[VaultReferenceResolveInput] = Field(min_length=1, max_length=200)
    project_id: UUID | None = None
    agent_id: UUID | None = None
    allow_conflicts: bool = False
    debug: bool = False
    preview: bool = False


class VaultBulkResolveResponse(BaseModel):
    results: dict[str, dict[str, object]]


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
