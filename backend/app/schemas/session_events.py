from __future__ import annotations

import uuid
from datetime import datetime
from ipaddress import ip_address
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

Sha256Hex = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]


class SessionEventSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    adapter: Literal["claude_code", "codex", "openclaw", "pi"]
    session_key: str = Field(min_length=1, max_length=500)
    record_id: str = Field(min_length=1, max_length=500)
    record_seq: int | None = Field(default=None, ge=0)
    part_index: int | None = Field(default=None, ge=0)


class SessionTextPart(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["text"]
    text: str


class SessionAttachmentPart(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["attachment"]
    attachment_id: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    availability: Literal["external", "metadata_only"]
    uri: str | None = Field(default=None, min_length=1, max_length=4096)
    name: str | None = Field(default=None, max_length=512)
    media_type: str | None = Field(default=None, max_length=255)
    size_bytes: int | None = Field(default=None, ge=0)
    sha256: Sha256Hex | None = None

    @model_validator(mode="after")
    def validate_external_reference(self) -> SessionAttachmentPart:
        if self.availability == "metadata_only":
            if self.uri is not None:
                raise ValueError("metadata-only attachments cannot have a uri")
            return self
        if self.uri is None or not _safe_external_attachment_uri(self.uri):
            raise ValueError("external attachments require a safe remote uri")
        return self


def _safe_external_attachment_uri(uri: str) -> bool:
    if uri.startswith("provider-ref:"):
        return len(uri) > len("provider-ref:") and not any(character.isspace() for character in uri)
    try:
        parsed = urlsplit(uri)
    except ValueError:
        return False
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        return False
    hostname = parsed.hostname.lower()
    if hostname == "localhost" or hostname.endswith(".localhost") or hostname.endswith(".local"):
        return False
    try:
        ip_address(hostname)
    except ValueError:
        return True
    return False


SessionContentPart = Annotated[
    SessionTextPart | SessionAttachmentPart,
    Field(discriminator="type"),
]


class SessionEventBase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    seq: int = Field(ge=0)
    event_id: Sha256Hex
    source: SessionEventSource
    timestamp: datetime | None = None


class SessionMessageEvent(SessionEventBase):
    type: Literal["message"]
    role: Literal["user", "assistant", "system", "developer"]
    parts: list[SessionContentPart] = Field(max_length=1000)
    model: str | None = Field(default=None, max_length=100)


class SessionToolCallEvent(SessionEventBase):
    type: Literal["tool_call"]
    call_id: str = Field(min_length=1, max_length=500)
    name: str = Field(min_length=1, max_length=500)
    arguments_json: str | None = None
    model: str | None = Field(default=None, max_length=100)


class SessionToolResultEvent(SessionEventBase):
    type: Literal["tool_result"]
    call_id: str = Field(min_length=1, max_length=500)
    name: str | None = Field(default=None, max_length=500)
    status: Literal["completed", "error"]
    parts: list[SessionContentPart] = Field(max_length=1000)
    result_json: str | None = None


SessionEvent = Annotated[
    SessionMessageEvent | SessionToolCallEvent | SessionToolResultEvent,
    Field(discriminator="type"),
]


class SessionUploadCapabilitiesResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    protocols: list[Literal["snapshot-v1", "events-v1"]]
    event_chunk_target_bytes: int
    event_chunk_max_bytes: int


class SessionEventHeadResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    protocol: Literal["snapshot-v1", "events-v1"]
    generation: uuid.UUID | None
    revision: int = Field(ge=0)
    count: int = Field(ge=0)
    head_hash: Sha256Hex


class SessionEventGenerationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    environment_id: uuid.UUID
    generation: uuid.UUID
    append_id: uuid.UUID
    base_generation: uuid.UUID | None
    base_revision: int = Field(ge=0)
    base_count: int = Field(ge=0)
    base_head_hash: Sha256Hex
    final_count: int = Field(ge=0)
    final_head_hash: Sha256Hex


class SessionEventGenerationResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    generation: uuid.UUID
    status: Literal["staging", "committed"]


class SessionEventChunkResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    generation: uuid.UUID
    start_seq: int = Field(ge=0)
    end_seq: int = Field(ge=0)
    count: int = Field(ge=1)
    content_hash: Sha256Hex
    result_head_hash: Sha256Hex


class SessionEventCommitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    append_id: uuid.UUID
    base_generation: uuid.UUID | None
    base_revision: int = Field(ge=0)
    base_count: int = Field(ge=0)
    base_head_hash: Sha256Hex
    final_count: int = Field(ge=0)
    final_head_hash: Sha256Hex


class SessionEventAppendResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    generation: uuid.UUID
    revision: int = Field(ge=1)
    count: int = Field(ge=0)
    head_hash: Sha256Hex


class SessionEventsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    generation: uuid.UUID
    revision: int = Field(ge=1)
    count: int = Field(ge=0)
    head_hash: Sha256Hex
    events: list[SessionEvent]
