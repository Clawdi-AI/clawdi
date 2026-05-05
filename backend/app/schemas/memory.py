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
    # Provenance: which session this memory was extracted from, plus
    # the machine that ran that session. Lets the dashboard render
    # "learned from session on my-mac" so multi-machine users can
    # tell which device an agent picked something up on. Null when
    # the memory was added manually or its session has been deleted.
    source_session_id: str | None = None
    source_environment_id: str | None = None
    source_machine_name: str | None = None


class MemoryCreatedResponse(BaseModel):
    id: str


class MemoryDeleteResponse(BaseModel):
    status: Literal["deleted"]


class EmbedBackfillResponse(BaseModel):
    processed: int
    failed: int
