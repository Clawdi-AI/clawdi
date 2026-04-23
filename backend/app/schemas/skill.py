from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class SkillInstallRequest(BaseModel):
    repo: str  # owner/repo
    path: str | None = None  # subdirectory within repo


class SkillSummaryResponse(BaseModel):
    id: str
    skill_key: str
    name: str
    description: str | None
    version: int
    source: str
    source_repo: str | None
    agent_types: list[str] | None
    file_count: int | None
    content_hash: str
    is_active: bool
    created_at: datetime
    updated_at: datetime
    content: str | None = None


class SkillDetailResponse(BaseModel):
    id: str
    skill_key: str
    name: str
    description: str | None
    version: int
    source: str
    source_repo: str | None
    file_count: int | None
    content: str | None
    agent_types: list[str] | None
    created_at: datetime


class SkillUploadResponse(BaseModel):
    skill_key: str
    name: str
    version: int
    file_count: int


class SkillDeleteResponse(BaseModel):
    status: Literal["deleted"]


class SkillInstallResponse(BaseModel):
    skill_key: str
    name: str
    description: str | None
    version: int
    file_count: int
    repo: str
