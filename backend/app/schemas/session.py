import re
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

# Lone UTF-16 surrogates (U+D800..U+DFFF) are valid Python `str`
# but cannot be encoded as UTF-8, so asyncpg rejects the bound
# parameter and 500s the whole batch. The CLI used to truncate
# `summary` with JS `.slice` (UTF-16 code units), which split an
# emoji's surrogate pair and left a lone high surrogate at the
# cut. The CLI now truncates by codepoint, but a stuck daemon
# retried the bad payload ~34k times in prod before we shipped
# the fix — strip on ingest so one bad record can't take the
# batch down again.
_LONE_SURROGATE_RE = re.compile(r"[\ud800-\udfff]")
_MODEL_FIELD_RE = re.compile(r"""["'](?:default|model)["']\s*:\s*["']([^"']+)["']""")
_MAX_MODEL_LENGTH = 100


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
    # Optional: caller-supplied "user actually used the session
    # last" timestamp (= max of message timestamps in the JSONL).
    # Adapters that can compute it (claude_code, codex) should
    # send it; ones that can't (or don't yet) leave it null and
    # the server falls back to ended_at / started_at. The route
    # applies a clock-skew guard before persisting — see
    # `_clamp_last_activity` in routes/sessions.py.
    last_activity_at: datetime | None = None
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

    @field_validator("summary", mode="after")
    @classmethod
    def _strip_summary_surrogates(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return _LONE_SURROGATE_RE.sub("", v)

    @field_validator("model", mode="after")
    @classmethod
    def _clean_model(cls, v: str | None) -> str | None:
        return _clean_model_value(v)

    @field_validator("models_used", mode="after")
    @classmethod
    def _clean_models_used(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return None
        models: list[str] = []
        for raw in v:
            model = _clean_model_value(raw)
            if model and model not in models:
                models.append(model)
        return models or None

    @field_validator("started_at", "ended_at", "last_activity_at", mode="after")
    @classmethod
    def _coerce_to_utc(cls, v: datetime | None) -> datetime | None:
        # Naive datetimes (no tzinfo) silently break the
        # `_clamp_last_activity` helper in routes/sessions.py — it
        # compares client values to `datetime.now(UTC)`, and naive vs
        # aware comparisons raise TypeError, surfacing as a 500.
        # JS clients always send `toISOString()` (ends in 'Z' →
        # aware), but anything sending a Python-style ISO without
        # offset would land naive. Coerce to UTC at the boundary —
        # naive timestamps are interpreted as UTC, which is the only
        # safe assumption for an unmarked value crossing a network.
        if v is None:
            return None
        if v.tzinfo is None:
            return v.replace(tzinfo=UTC)
        return v


def _clean_model_value(v: str | None) -> str | None:
    if v is None:
        return None
    value = _LONE_SURROGATE_RE.sub("", v).strip()
    if not value:
        return None
    if value.startswith("{"):
        match = _MODEL_FIELD_RE.search(value)
        if match:
            value = match.group(1).strip()
        else:
            return None
    if not value:
        return None
    return value[:_MAX_MODEL_LENGTH]


class SessionBatchRequest(BaseModel):
    # Cap at 500 sessions per request. The upsert builds a single
    # multi-VALUES INSERT with ~17 bound parameters per row;
    # asyncpg refuses queries with > 32767 parameters total
    # (PostgreSQL wire protocol limit). Pre-fix `clawdi push
    # --modules sessions --all` shipped every session in one
    # body — observed 500-ing in prod with
    # `sqlalchemy.exc.InterfaceError: ... query arguments cannot
    # exceed 32767` for users with > ~1900 sessions. 500 leaves
    # ample headroom (8500 params) and the CLI side now chunks
    # to match (packages/cli/src/commands/push.ts).
    sessions: list[SessionCreate] = Field(max_length=500)


class EnvironmentCreate(BaseModel):
    machine_id: str
    machine_name: str
    agent_type: str
    agent_version: str | None = None
    os: str


class EnvironmentCreatedResponse(BaseModel):
    id: str


class EnvironmentUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    display_name: str | None = Field(default=None, max_length=120)

    @field_validator("display_name", mode="after")
    @classmethod
    def _clean_display_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = _LONE_SURROGATE_RE.sub("", value).strip()
        return cleaned or None


class EnvironmentReorderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    environment_ids: list[uuid.UUID] = Field(min_length=1, max_length=500)


class EnvironmentResponse(BaseModel):
    id: str
    machine_name: str
    display_name: str | None = None
    avatar_url: str | None = None
    sort_order: int = 0
    agent_type: str
    agent_version: str | None
    os: str
    last_seen_at: datetime | None
    # `clawdi daemon` liveness / observability — populated by
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
    # DEPRECATED: derives from hosted-runtime desired state only. Dashboards
    # now classify externally-managed agents through their control plane's
    # ownership surface instead of this proxy; both fields remain for older
    # API consumers and will be removed in a future schema revision.
    hosted_managed: bool = False
    # DEPRECATED: see hosted_managed. Real deployment id when cloud-api has
    # runtime desired state for this env or a sibling env in the same
    # hosted compute.
    hosted_deployment_id: str | None = None
    # Schema-enforced NOT NULL on agent_environments — every env
    # has a default project after register_environment runs (which
    # heals legacy rows that lost their value). Daemons rely on this
    # being present to know which SSE events belong to them.
    # Stringified for JSON (UUIDs serialise as strings via
    # FastAPI default).
    default_project_id: str


class RuntimeObservedDesiredResponse(BaseModel):
    deployment_id: str
    instance_id: str
    generation: int
    provider_id: str | None = None
    enabled_runtimes: list[str]
    has_mcp: bool = False
    has_tools: bool = False
    updated_at: datetime | None = None


class RuntimeObservedHealthResponse(BaseModel):
    status: Literal["ok", "error", "stale", "unknown", "not_configured"]
    reasons: list[str] = []
    reported_at: datetime | None = None


class RuntimeObservedProviderHealthResponse(BaseModel):
    provider_id: str
    status: Literal["ok", "error", "unknown", "not_configured"]
    reasons: list[str] = []
    desired: dict[str, Any] | None = None
    observed: dict[str, Any] | None = None


class RuntimeObservedResponse(BaseModel):
    environment: EnvironmentResponse
    desired: RuntimeObservedDesiredResponse | None = None
    observed: dict[str, Any] | None = None
    health: RuntimeObservedHealthResponse
    provider_health: list[RuntimeObservedProviderHealthResponse] = []


class RuntimeObservedSummaryCountsResponse(BaseModel):
    ok: int = 0
    error: int = 0
    stale: int = 0
    unknown: int = 0
    not_configured: int = 0


class RuntimeObservedSummaryItemResponse(BaseModel):
    environment: EnvironmentResponse
    desired: RuntimeObservedDesiredResponse | None = None
    health: RuntimeObservedHealthResponse
    provider_health: list[RuntimeObservedProviderHealthResponse] = []


class RuntimeObservedSummaryResponse(BaseModel):
    counts: RuntimeObservedSummaryCountsResponse
    items: list[RuntimeObservedSummaryItemResponse]


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
    # Server clock — when the row was last written/updated. Used by
    # ETag/cache layers, NOT shown in the dashboard. Kept in the
    # response so callers that DO want "row last touched" semantics
    # (incremental fetch) can read it.
    updated_at: datetime
    # User activity time — derived from message timestamps during
    # ingest. The dashboard's "Last activity" column reads this.
    # Distinct from updated_at: a session pushed at 9am whose last
    # message was yesterday at 11pm has updated_at=9am and
    # last_activity_at=yesterday 11pm.
    last_activity_at: datetime
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
    # True when an active `kind='link'` row exists in `session_permissions`
    # for this session. Computed via EXISTS subquery in the list/detail
    # query — there is NO denormalized `sessions.visibility` column.
    # Default False so old generated clients that don't expect the field
    # still deserialize cleanly.
    is_shared: bool = False

    # Extracted external entities (PR refs, repo names, branches),
    # surfaced as sidebar chips. NULL when nothing was found or when
    # the row was uploaded before the column existed — the sidebar
    # hides the chip row in that case. See
    # `services/session_metrics.py` for the upload-time extraction.
    related_refs: dict[str, list[str]] | None = None


class PublicSessionResponse(BaseModel):
    """Public-safe session detail payload for `/v1/public/sessions/{id}`."""

    id: str
    summary: str | None
    project_path: str | None
    agent_type: str | None
    model: str | None
    models_used: list[str] | None
    started_at: datetime
    ended_at: datetime | None
    last_activity_at: datetime | None
    duration_seconds: int | None
    message_count: int
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    tags: list[str] | None
    status: str
    related_refs: dict[str, list[str] | None] | None = None
    owner_name: str | None
    owner_avatar_url: str | None


class SessionDetailResponse(SessionListItemResponse):
    has_content: bool


class SessionPermissionResponse(BaseModel):
    """One row from `session_permissions`.

    Returned by `GET /v1/sessions/{id}/permissions` and as the body of
    `POST /v1/sessions/{id}/permissions`. Identifier columns mirror
    Google Drive's `permissions` resource: a `kind` discriminator plus
    explicit fields for whichever principal type is populated.
    """

    id: str
    kind: Literal["link", "user", "email"]
    # Mutually exclusive based on `kind`. Both NULL for `kind='link'`.
    user_id: str | None = None
    email: str | None = None
    role: Literal["viewer"]
    invited_by: str | None = None
    accepted_at: datetime | None = None
    expires_at: datetime | None = None
    created_at: datetime


class SessionPermissionsResponse(BaseModel):
    """`GET /v1/sessions/{id}/permissions` — active permissions for a
    session, newest-first. Drives the share popover state and (in the
    future) the "people with access" list.
    """

    permissions: list[SessionPermissionResponse]


class SessionPermissionCreate(BaseModel):
    """`POST /v1/sessions/{id}/permissions` body.

    For today's "Public access" toggle the body is just
    `{"kind": "link"}`. Future invite-by-email sends `{"kind": "email",
    "email": "alice@x.com"}`; future direct user grant sends
    `{"kind": "user", "user_id": "..."}`.
    """

    kind: Literal["link", "user", "email"]
    user_id: str | None = None
    email: str | None = None
    # Optional in the request body — server defaults to 'viewer'.
    role: Literal["viewer"] | None = None


class SessionUploadResponse(BaseModel):
    status: Literal["uploaded"]
    file_key: str
    # Hash of the bytes the server just stored. Lets the client confirm the
    # round-trip matched what it computed locally — divergence here would
    # indicate a multipart corruption or a charset issue worth surfacing.
    content_hash: str


class SessionExtractResponse(BaseModel):
    """Result of `POST /v1/sessions/{local_session_id}/extract`."""

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


class PublicSessionExportResponse(PublicSessionResponse):
    """Public-safe structured session export payload."""

    messages: list[SessionMessageResponse]
    share_url: str


class SessionMessagesPage(BaseModel):
    """Paginated slice of a session's messages. Used by the dashboard's
    detail page; the full-content download endpoint
    (`GET /v1/sessions/{id}/content`) stays unchanged so the CLI's
    `clawdi pull` mirror still gets a single full JSON array.

    `total` is the count of messages in the underlying content file
    (not the count returned in `items`) so the client can render a
    "loaded N/M" hint and decide whether to fetch more pages.
    """

    items: list[SessionMessageResponse]
    total: int
    offset: int
    limit: int
