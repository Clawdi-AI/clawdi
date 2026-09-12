import re
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.vault import VaultCreate, VaultItemUpsert


class VaultSecretRequestCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: UUID
    vault_id: UUID
    slug: str
    section: str = ""
    fields: list[str] = Field(min_length=1, max_length=32)
    expires_in_seconds: int = Field(default=3600, ge=300, le=86400)

    @field_validator("slug")
    @classmethod
    def validate_slug(cls, value: str) -> str:
        return VaultCreate.validate_slug(value)

    @field_validator("section")
    @classmethod
    def validate_section(cls, value: str) -> str:
        return VaultItemUpsert.validate_section(value)

    @field_validator("fields")
    @classmethod
    def validate_fields(cls, fields: list[str]) -> list[str]:
        if len(set(fields)) != len(fields) or any(
            not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,199}", field) for field in fields
        ):
            raise ValueError("Fields must be distinct environment variable names")
        return fields


class VaultSecretRequestStatus(BaseModel):
    id: UUID
    vault_id: UUID
    project_id: UUID
    vault_name: str
    project_name: str
    slug: str
    section: str
    fields: list[str]
    update_fields: list[str] = Field(default_factory=list)
    status: Literal["pending", "supplied", "expired", "conflict"]
    expires_at: datetime
    supplied_at: datetime | None
    references: dict[str, str]
    local_command: str


class VaultSecretRequestCreated(VaultSecretRequestStatus):
    url: str


class VaultSecretRequestToken(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")


class VaultSecretRequestSupply(VaultSecretRequestToken):
    fields: dict[str, str] = Field(min_length=1, max_length=32)

    @field_validator("fields")
    @classmethod
    def validate_values(cls, fields: dict[str, str]) -> dict[str, str]:
        if any(not value or len(value) > 65536 or "\x00" in value for value in fields.values()):
            raise ValueError("Values must be nonempty text of at most 65536 characters")
        return fields


class VaultMaterializeInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: UUID
    vault_id: UUID
    section: str | None = Field(default=None, max_length=200)


class VaultMaterializeResponse(BaseModel):
    user_id: UUID
    project_id: UUID
    vault_id: UUID
    section: str | None
    item_ids: dict[str, UUID]
    references: dict[str, str]
    values: dict[str, str]
