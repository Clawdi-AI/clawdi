import uuid
from datetime import datetime
from typing import Literal

from pydantic import JsonValue
from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.project import Project


class AgentEnvironment(Base, TimestampMixin):
    __tablename__ = "agent_environments"
    # `id` is the stable agent identity. `registration_key` is an
    # idempotency key for implicit registration flows. Current Hosted V2
    # identities are explicit and leave it NULL, but historical Legacy V1
    # Admin registration could populate the same key shape as self-managed
    # setup, so registration_key alone is never Connected origin evidence.
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "registration_key",
            name="uq_agent_envs_user_registration_key",
        ),
        CheckConstraint(
            "connected_agent_registered_at IS NULL OR registration_key IS NOT NULL",
            name="ck_agent_envs_connected_registration_origin",
        ),
        CheckConstraint(
            "project_skill_reconcile_version IS NULL OR project_skill_reconcile_version = 1",
            name="ck_agent_environments_project_skill_reconcile_version",
        ),
        CheckConstraint(
            "project_skill_reconcile_version IS NULL OR connected_agent_registered_at IS NOT NULL",
            name="ck_agent_environments_project_skill_reconcile_eligibility",
        ),
        CheckConstraint(
            "(project_skill_reconcile_version IS NULL) = "
            "(project_skill_reconcile_observed_at IS NULL)",
            name="ck_agent_environments_project_skill_reconcile_observation",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    machine_id: Mapped[str] = mapped_column(String(200), nullable=False)
    machine_name: Mapped[str] = mapped_column(String(200), nullable=False)
    agent_type: Mapped[str] = mapped_column(String(50), nullable=False)
    agent_version: Mapped[str | None] = mapped_column(String(50))
    os: Mapped[str] = mapped_column(String(50), nullable=False)
    registration_key: Mapped[str | None] = mapped_column(String(300))
    # Archived agents retain their stable identity and every relationship.
    # Operational/query boundaries treat only NULL as active; registration
    # may reactivate the row in place.
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Agent identity labels. `default_name` is assigned by Cloud API for
    # explicit hosted identities; `display_name` is the user's dashboard override.
    # Runtime registration keeps machine_name/agent_type accurate as
    # observed metadata, but machine_name is no longer the identity label.
    default_name: Mapped[str | None] = mapped_column(String(200))
    display_name: Mapped[str | None] = mapped_column(String(120))
    avatar_asset_key: Mapped[str | None] = mapped_column(String(512))
    sort_order: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)

    # `clawdi daemon` observability. last_seen_at is the
    # legacy "anything happened on this env" timestamp; sync_*
    # fields are specifically about the daemon's projection cycle.
    # Dashboard renders "Last synced: X ago" + "Daemon offline" red
    # badge by reading these.
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_sync_error: Mapped[str | None] = mapped_column(Text)
    # Last `users.skills_revision` the daemon reconciled successfully —
    # lets the server detect missed invalidations if SSE drops mid-flight.
    last_revision_seen: Mapped[int | None] = mapped_column(Integer)
    # Peak retry-queue depth since the daemon last booted. Resets
    # on `clawdi daemon` start. NOT a 24h rolling window — that
    # needs real time-series storage and is not part of v1.
    queue_depth_high_water_since_start: Mapped[int] = mapped_column(
        Integer, server_default="0", nullable=False
    )
    # Sessions / skills dropped due to queue overflow since last
    # daemon start. Same reset semantics as above.
    dropped_count_since_start: Mapped[int] = mapped_column(
        Integer, server_default="0", nullable=False
    )
    # Canary toggle: pre-existing envs default to false (won't
    # auto-pick-up the new sync until operator opts them in); new
    # envs created post-v1 default to true.
    sync_enabled: Mapped[bool] = mapped_column(Boolean, server_default="false", nullable=False)
    # Positive, durable Connected Agent origin evidence. Only the current
    # self-managed registration route may write this marker, and only for an
    # OAuth CLI or unbound unmanaged API key. Historical ambiguous rows remain
    # NULL; Admin, managed, and environment-bound registration never qualify.
    connected_agent_registered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Connected Agent-only compatibility observation retained for deployed CLI
    # clients. Desired-state reads and writes do not depend on these fields.
    project_skill_reconcile_version: Mapped[int | None] = mapped_column(Integer)
    project_skill_reconcile_observed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    # Derived from the adapter's actual complete modules. NULL is retained for
    # legacy Connected rows and all Hosted rows.
    adapter_modules: Mapped[list[Literal["sessions", "skills"]] | None] = mapped_column(
        ARRAY(String(20))
    )

    # Default project this env's daemon writes into. Phase-1 migration
    # creates one env-local project per env and points this column at
    # it. Daemon resolution: api_key bound to env → that env's
    # default_project_id. This is the agent's fixed Agent Project;
    # user-created/shared Projects may be attached as context, but they
    # do not replace this write target.
    #
    # CASCADE so user-delete propagates: user → project cascade
    # would otherwise be RESTRICTed by this env's reference,
    # blocking the whole tear-down.
    default_project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(Project.id, ondelete="CASCADE"),
        nullable=False,
    )


class SessionSyncSuppression(Base):
    __tablename__ = "session_sync_suppressions"

    __table_args__ = (
        Index(
            "uq_session_sync_suppressions_legacy",
            "user_id",
            "local_session_id",
            unique=True,
            postgresql_where=text("origin_environment_id IS NULL"),
        ),
        Index(
            "uq_session_sync_suppressions_origin",
            "user_id",
            "origin_environment_id",
            "local_session_id",
            unique=True,
            postgresql_where=text("origin_environment_id IS NOT NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
    )
    # NULL rows are legacy wildcard suppressions. Current deletes always write
    # the immutable origin so equal source-local IDs from other Agents remain live.
    origin_environment_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    local_session_id: Mapped[str] = mapped_column(String(200))


class Session(Base, TimestampMixin):
    __tablename__ = "sessions"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "origin_environment_id",
            "local_session_id",
            name="uq_sessions_user_origin_local",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    # Nullable + ON DELETE SET NULL: deleting an agent environment doesn't
    # destroy past sessions, just orphans them. The list query already
    # outer-joins so unlabeled sessions still render. See migration
    # 6dee7134c53f for the constraint definition.
    environment_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agent_environments.id", ondelete="SET NULL"),
        nullable=True,
    )
    # Immutable ingest identity. Unlike environment_id this is deliberately
    # not a foreign key, so archiving/deleting an Agent cannot erase origin.
    origin_environment_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True, index=True
    )
    local_session_id: Mapped[str] = mapped_column(String(200), nullable=False)
    project_path: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # When the user actually used this session last (= max(message
    # timestamps)). Derived from the JSONL during ingest, NOT
    # `func.now()` like `updated_at`. The dashboard's "Last activity"
    # column reads from here so a session pushed in the morning whose
    # last message was yesterday at 11pm shows "yesterday at 11pm",
    # not "this morning". Adapters supply their best timestamp; the
    # ingest path applies clock-skew guards (see
    # `_clamp_last_activity` in routes/sessions.py).
    #
    # `server_default=now()` is a safety net for direct ORM inserts
    # (test fixtures, migration scripts) that don't go through the
    # route. Production writes always provide an explicit value via
    # the upsert path; the default exists so adding the NOT NULL
    # column doesn't break code that constructs Session() in-memory
    # without supplying every field.
    last_activity_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    duration_seconds: Mapped[int | None] = mapped_column(Integer)
    message_count: Mapped[int] = mapped_column(Integer, server_default="0")
    input_tokens: Mapped[int] = mapped_column(BigInteger, server_default="0")
    output_tokens: Mapped[int] = mapped_column(BigInteger, server_default="0")
    cache_read_tokens: Mapped[int] = mapped_column(BigInteger, server_default="0")
    model: Mapped[str | None] = mapped_column(String(100))
    models_used: Mapped[list[str] | None] = mapped_column(ARRAY(String))
    summary: Mapped[str | None] = mapped_column(Text)
    tags: Mapped[list[str] | None] = mapped_column(ARRAY(String))
    status: Mapped[str] = mapped_column(String(20), server_default="completed")
    file_key: Mapped[str | None] = mapped_column(Text)
    # SHA-256 of snapshot bytes, or the committed events-v1 head hash. Used
    # by batch/list compatibility consumers to identify current content.
    content_hash: Mapped[str | None] = mapped_column(String(64))
    content_uploaded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    content_protocol: Mapped[Literal["snapshot-v1", "events-v1"]] = mapped_column(
        String(20), server_default="snapshot-v1", nullable=False
    )
    event_generation_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    event_revision: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    event_count: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    event_head_hash: Mapped[str | None] = mapped_column(String(64))
    # Derived, rebuildable search projection. A NULL value means the current
    # content has not been indexed yet; it never changes content authority.
    search_index_revision: Mapped[str | None] = mapped_column(String(80))

    # Extracted external entities surfaced in the session sidebar. Schema:
    #   {"prs": ["owner/repo#123"], "repos": [...], "branches": [...]}
    # Best-effort regex extraction over message content at upload time;
    # the sidebar renders whatever we find. Promotable to a relational
    # `session_refs` table when cross-session queries become a need.
    #
    # `none_as_null=True` is load-bearing: without it SQLAlchemy
    # serializes Python `None` as the JSONB literal `'null'`, NOT as
    # SQL NULL. That breaks `COALESCE(excluded.related_refs, ...)`
    # in the batch upsert — `'null'::jsonb IS NOT NULL`, so the
    # coalesce returns it instead of falling through to the prior
    # value, and a re-push from an older CLI that omits this field
    # would clobber related_refs back to JSON null. With this flag,
    # Python None → SQL NULL, and the coalesce preserves the
    # server-computed value across re-pushes.
    related_refs: Mapped[dict[str, JsonValue] | None] = mapped_column(JSONB(none_as_null=True))


class SessionMessageSearch(Base):
    __tablename__ = "session_message_search"
    __table_args__ = (
        CheckConstraint("position >= 0", name="ck_session_message_search_position"),
        CheckConstraint(
            "role IN ('user', 'assistant')",
            name="ck_session_message_search_role",
        ),
        Index("ix_session_message_search_user", "user_id"),
        Index("ix_session_message_search_generation", "generation_id"),
        Index(
            "ix_session_message_search_content_trgm",
            "content",
            postgresql_using="gin",
            postgresql_ops={"content": "gin_trgm_ops"},
        ),
        Index(
            "ix_session_message_search_content_fts",
            text("to_tsvector('simple'::regconfig, content)"),
            postgresql_using="gin",
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("sessions.id", ondelete="CASCADE"),
        primary_key=True,
        nullable=False,
    )
    # Event rows follow generation retention automatically. Snapshot rows have
    # no generation and are replaced atomically with the uploaded snapshot.
    generation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("session_event_generations.id", ondelete="CASCADE"),
    )
    content_revision: Mapped[str] = mapped_column(String(80), primary_key=True, nullable=False)
    position: Mapped[int] = mapped_column(Integer, primary_key=True, nullable=False)
    role: Mapped[Literal["user", "assistant"]] = mapped_column(String(20), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)


class SessionEventGeneration(Base, TimestampMixin):
    __tablename__ = "session_event_generations"
    __table_args__ = (
        UniqueConstraint("session_id", "append_id", name="uq_session_event_generation_append"),
        Index(
            "ix_session_event_generations_status_created_at",
            "status",
            "created_at",
        ),
        Index(
            "ix_session_event_generations_status_superseded_at",
            "status",
            "superseded_at",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    append_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    status: Mapped[Literal["staging", "committed"]] = mapped_column(String(20), nullable=False)
    base_generation_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    base_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    base_count: Mapped[int] = mapped_column(Integer, nullable=False)
    base_head_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    final_count: Mapped[int] = mapped_column(Integer, nullable=False)
    final_head_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SessionEventChunk(Base, TimestampMixin):
    __tablename__ = "session_event_chunks"
    __table_args__ = (
        UniqueConstraint("generation_id", "start_seq", name="uq_session_event_chunk_start"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    generation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("session_event_generations.id", ondelete="CASCADE"),
        nullable=False,
    )
    start_seq: Mapped[int] = mapped_column(Integer, nullable=False)
    end_seq: Mapped[int] = mapped_column(Integer, nullable=False)
    event_count: Mapped[int] = mapped_column(Integer, nullable=False)
    base_head_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    result_head_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    file_key: Mapped[str] = mapped_column(Text, nullable=False)
    # NULL means this chunk predates, or has not completed, the rebuildable
    # visible-message search projection. Content remains authoritative in the
    # object store regardless of this derived-state checkpoint.
    search_indexed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SessionEventAppendReceipt(Base, TimestampMixin):
    __tablename__ = "session_event_append_receipts"
    __table_args__ = (
        UniqueConstraint("session_id", "append_id", name="uq_session_event_append_receipt"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    append_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    generation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("session_event_generations.id", ondelete="CASCADE"),
        nullable=False,
    )
    base_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    base_count: Mapped[int] = mapped_column(Integer, nullable=False)
    base_head_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    result_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    result_count: Mapped[int] = mapped_column(Integer, nullable=False)
    result_head_hash: Mapped[str] = mapped_column(String(64), nullable=False)
