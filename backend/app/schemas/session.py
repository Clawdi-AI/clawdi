import re
import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field, StringConstraints

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
    # Non-negative numeric observables. Without `ge=0` a malformed
    # client could post negative tokens / duration and corrupt the
    # dashboard's aggregate counters. The CLI never sends negatives
    # for legitimate sessions; this is a boundary defense.
    duration_seconds: int | None = Field(default=None, ge=0)
    message_count: int = Field(default=0, ge=0)
    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)
    cache_read_tokens: int = Field(default=0, ge=0)
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
    # `clawdi serve` daemon liveness / observability — populated by
    # the heartbeat endpoint. NULL on environments whose daemon
    # has never checked in (legacy laptops, freshly created
    # envs). Dashboard renders "offline" red when last_sync_at is
    # null or older than 90s; "syncing" green when fresh and
    # last_sync_error is null.
    last_sync_at: datetime | None = None
    last_sync_error: str | None = None
    last_revision_seen: int | None = None
    queue_depth_high_water: int = 0
    dropped_count: int = 0
    sync_enabled: bool = False
    # Schema-enforced NOT NULL on agent_environments — every env
    # has a scope after register_environment runs (which heals
    # legacy rows that lost their scope). Daemons rely on this
    # being present to know which SSE events belong to them.
    # Stringified for JSON (UUIDs serialise as strings via
    # FastAPI default).
    default_scope_id: str


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
    # local_session_ids the upsert dropped at the conflict step
    # (cross-env race window — see sessions.py `WHERE existing.env
    # IS NULL OR existing.env IS NOT DISTINCT FROM excluded.env`).
    # CLI/daemon callers MUST treat these as not-yet-synced:
    # don't write the lock entry, don't mark them done. The next
    # batch (after the winning writer's row is visible) will hit
    # the pre-fetch cross-env mismatch check and 409 cleanly.
    # Pre-round-46 the response silently omitted these ids; the
    # client treated "id not in needs_content" as success and
    # wrote a stale lock — the loser never retried.
    rejected: list[str] = []


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


class SessionMessagesPage(BaseModel):
    """Paginated slice of a session's messages. Used by the dashboard's
    detail page; the full-content download endpoint
    (`GET /api/sessions/{id}/content`) stays unchanged so the CLI's
    `clawdi pull` mirror still gets a single full JSON array.

    `total` is the count of messages in the underlying content file
    (not the count returned in `items`) so the client can render a
    "loaded N/M" hint and decide whether to fetch more pages.
    """

    items: list[SessionMessageResponse]
    total: int
    offset: int
    limit: int
