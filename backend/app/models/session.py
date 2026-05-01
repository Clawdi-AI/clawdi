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
)
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.scope import (
    Scope as Scope,  # noqa: F401 — register `scopes` table for FK resolution
)


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
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    machine_id: Mapped[str] = mapped_column(String(200), nullable=False)
    machine_name: Mapped[str] = mapped_column(String(200), nullable=False)
    agent_type: Mapped[str] = mapped_column(String(50), nullable=False)
    agent_version: Mapped[str | None] = mapped_column(String(50))
    os: Mapped[str] = mapped_column(String(50), nullable=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # `clawdi serve` daemon observability. last_seen_at is the
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
    # on `clawdi serve` start. NOT a 24h rolling window — that
    # needs real time-series storage and is out of scope for v1.
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

    # Default scope this env's daemon writes into. Phase-1 migration
    # creates one env-local scope per env and points this column at
    # it. Daemon resolution: api_key bound to env → that env's
    # default_scope_id. Reassigning this column moves NEW writes to
    # a different scope; existing skills stay in their original
    # scope (move/copy is a separate explicit operation).
    #
    # CASCADE so user-delete propagates: user → scope cascade
    # would otherwise be RESTRICTed by this env's reference,
    # blocking the whole tear-down.
    default_scope_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("scopes.id", ondelete="CASCADE"),
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
