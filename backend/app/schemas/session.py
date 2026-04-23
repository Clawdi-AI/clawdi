from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class SessionCreate(BaseModel):
    environment_id: str
    local_session_id: str
    project_path: str | None = None
    started_at: datetime
    ended_at: datetime | None = None
    duration_seconds: int | None = None
    message_count: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    model: str | None = None
    models_used: list[str] | None = None
    summary: str | None = None
    tags: list[str] | None = None
    status: str = "completed"


class SessionBatchRequest(BaseModel):
    sessions: list[SessionCreate]


class EnvironmentCreate(BaseModel):
    machine_id: str
    machine_name: str
    agent_type: str
    agent_version: str | None = None
    os: str


class EnvironmentCreatedResponse(BaseModel):
    id: str


class EnvironmentResponse(BaseModel):
    id: str
    machine_name: str
    agent_type: str
    agent_version: str | None
    os: str
    last_seen_at: datetime | None


class SessionBatchResponse(BaseModel):
    synced: int


class SessionListItemResponse(BaseModel):
    id: str
    local_session_id: str
    project_path: str | None
    agent_type: str | None
    started_at: datetime
    ended_at: datetime | None
    duration_seconds: int | None
    message_count: int
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    model: str | None
    models_used: list[str] | None
    summary: str | None
    tags: list[str] | None
    status: str


class SessionDetailResponse(SessionListItemResponse):
    has_content: bool


class SessionUploadResponse(BaseModel):
    status: Literal["uploaded"]
    file_key: str
