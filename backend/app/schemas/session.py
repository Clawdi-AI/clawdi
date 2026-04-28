import re
import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, StringConstraints

# local_session_id flows straight into a file-store key
# (`sessions/{user_id}/{local_session_id}.json`). Restrict to a safe charset
# so a malicious client can't smuggle `/` or `..` and escape their own tenant
# prefix. Claude Code / Codex session IDs are UUIDs or short slugs in practice;
# we accept dashes, underscores, dots, and alphanumerics up to 200 chars.
_LOCAL_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-]{0,199}$")
SafeLocalSessionId = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=200,
        pattern=_LOCAL_SESSION_ID_RE.pattern,
    ),
]


class SessionCreate(BaseModel):
    # Typed as UUID so Pydantic returns a 422 on garbage input — without this
    # the route's `uuid.UUID(...)` raises and FastAPI surfaces a 500.
    environment_id: uuid.UUID
    local_session_id: SafeLocalSessionId
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
    # SHA-256 hex of the JSON-serialized messages array. Server compares
    # against the stored value to decide whether content needs reupload.
    # Optional so old clients that don't compute hashes still get inserted;
    # legacy rows with NULL hash are always treated as "needs content".
    content_hash: str | None = None


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
    # Rows that didn't exist before the batch.
    created: int
    # Rows that existed but were modified — either metadata changed,
    # the content hash differs, or the row had no `file_key` yet.
    updated: int
    # Rows whose hash matched and `file_key` was already set — no work to do.
    unchanged: int
    # local_session_ids that need a follow-up content upload. Always a
    # superset of `created` (new rows have no content yet); also includes
    # any updated row whose stored bytes are stale.
    needs_content: list[str]


class SessionListItemResponse(BaseModel):
    id: str
    local_session_id: str
    project_path: str | None
    agent_type: str | None
    machine_name: str | None = None
    started_at: datetime
    ended_at: datetime | None
    # Last time the row's metadata or content was touched on the server.
    # Bumped on every batch upsert and content upload. The dashboard sorts
    # by this so sessions with new messages bubble to the top.
    updated_at: datetime
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
    # Surfaced so `clawdi pull` can diff cloud vs. local sidecar without
    # downloading the content body.
    content_hash: str | None = None


class SessionDetailResponse(SessionListItemResponse):
    has_content: bool


class SessionUploadResponse(BaseModel):
    status: Literal["uploaded"]
    file_key: str
    # Hash of the bytes the server just stored. Lets the client confirm the
    # round-trip matched what it computed locally — divergence here would
    # indicate a multipart corruption or a charset issue worth surfacing.
    content_hash: str


class SessionExtractResponse(BaseModel):
    """Result of `POST /api/sessions/{local_session_id}/extract`."""

    memories_created: int


class SessionMessageResponse(BaseModel):
    """One agent message inside a session content file.

    Mirrors the shape the CLI writes via `clawdi push` — the JSON stored
    in the file store is a list of these. Declared here so it lives in the
    OpenAPI schema and flows through to generated TS types; keeps the frontend
    from having to maintain a parallel interface.
    """

    role: Literal["user", "assistant"]
    content: str
    model: str | None = None
    timestamp: datetime | None = None
