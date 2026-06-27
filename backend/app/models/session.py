import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.project import Project  # noqa: F401 — register `projects` table for FK resolution


class AgentEnvironment(Base, TimestampMixin):
    __tablename__ = "agent_environments"
    # Phase-1 unique constraint. Without it, two parallel `clawdi
    # setup` runs for the same user+machine+agent both pass the
    # check-then-insert in `register_environment` and create
    # duplicate envs. The DB-level guard is the only correctness
    # boundary; the route's IntegrityError catch reconverges to
    # the winning row.
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "machine_id",
            "agent_type",
            name="uq_agent_envs_user_machine_agent",
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
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # User-facing identity overrides. Runtime registration keeps
    # machine_name/agent_type accurate; dashboard preferences live here.
    display_name: Mapped[str | None] = mapped_column(String(120))
    avatar_asset_key: Mapped[str | None] = mapped_column(String(512))
    avatar_preset: Mapped[str | None] = mapped_column(String(40))
    sort_order: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)

    # `clawdi daemon` observability. last_seen_at is the
    # legacy "anything happened on this env" timestamp; sync_*
    # fields are specifically about the daemon's push/pull cycle.
    # Dashboard renders "Last synced: X ago" + "Daemon offline" red
    # badge by reading these.
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_sync_error: Mapped[str | None] = mapped_column(Text)
    # Last `users.skills_revision` the daemon pulled successfully —
    # lets server detect "missed events" if SSE drops mid-flight.
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
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )


class Session(Base, TimestampMixin):
    __tablename__ = "sessions"
    __table_args__ = (
        UniqueConstraint("user_id", "local_session_id", name="uq_sessions_user_local"),
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
    # SHA-256 hex of the messages JSON the CLI uploaded. Used by the batch
    # endpoint to skip content re-upload when the local copy is unchanged,
    # and by `clawdi pull` to diff cloud state against local sidecars.
    content_hash: Mapped[str | None] = mapped_column(String(64))
    content_uploaded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

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
    related_refs: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
