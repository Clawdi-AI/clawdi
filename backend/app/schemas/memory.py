from typing import Literal

from pydantic import BaseModel


class MemoryCreate(BaseModel):
    content: str
    category: str = "fact"
    source: str = "manual"
    tags: list[str] | None = None


class MemoryResponse(BaseModel):
    id: str
    content: str
    category: str
    source: str
    tags: list[str] | None = None
    access_count: int | None = None
    created_at: str | None = None


class MemoryCreatedResponse(BaseModel):
    id: str


class MemoryDeleteResponse(BaseModel):
    status: Literal["deleted"]
