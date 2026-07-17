from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import JsonValue
from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKeyConstraint,
    Index,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin

RUNTIME_ENVIRONMENT_ACTIVE = "active"
RUNTIME_ENVIRONMENT_RETIRED = "retired"
RUNTIME_OBSERVATION_HEAD_ACTIVE = "active"
RUNTIME_OBSERVATION_HEAD_RETIRED = "retired"
RUNTIME_OBSERVATION_CURSOR_ACTIVE = "active"
RUNTIME_OBSERVATION_CURSOR_EXPIRED = "expired"


class V2RuntimeEnvironmentFence(Base, TimestampMixin):
    """Permanent environment/deployment identity and retirement fence.

    This table intentionally has no foreign key to ``agent_environments`` or
    ``users``. Both parent rows can be removed by legacy account/environment
    cleanup, while a retired v2 runtime identity must remain non-reusable.
    """

    __tablename__ = "v2_runtime_environment_fences"
    __table_args__ = (
        UniqueConstraint(
            "environment_id",
            "deployment_id",
            name="uq_v2_runtime_environment_fences_binding",
        ),
        CheckConstraint(
            "state IN ('active', 'retired')",
            name="ck_v2_runtime_environment_fences_state",
        ),
        CheckConstraint(
            "stream_high_water >= 0",
            name="ck_v2_runtime_environment_fences_stream_high_water",
        ),
        CheckConstraint(
            "replay_floor_stream_position >= 0 AND "
            "replay_floor_stream_position <= stream_high_water",
            name="ck_v2_runtime_environment_fences_replay_floor",
        ),
        CheckConstraint(
            "(state = 'active' AND retirement_id IS NULL "
            "AND retirement_receipt_id IS NULL AND retirement_receipt IS NULL "
            "AND retired_at IS NULL AND final_cursor IS NULL "
            "AND final_stream_position IS NULL AND final_session_high_waters IS NULL) "
            "OR (state = 'retired' AND retirement_id IS NOT NULL "
            "AND retirement_receipt_id IS NOT NULL AND retirement_receipt IS NOT NULL "
            "AND retired_at IS NOT NULL AND final_cursor IS NOT NULL "
            "AND final_stream_position IS NOT NULL "
            "AND final_session_high_waters IS NOT NULL)",
            name="ck_v2_runtime_environment_fences_retirement",
        ),
    )

    environment_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    owner_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    deployment_id: Mapped[str] = mapped_column(String(200), nullable=False, index=True)
    state: Mapped[str] = mapped_column(
        String(16),
        default=RUNTIME_ENVIRONMENT_ACTIVE,
        server_default=RUNTIME_ENVIRONMENT_ACTIVE,
        nullable=False,
    )
    stream_high_water: Mapped[int] = mapped_column(
        BigInteger,
        default=0,
        server_default="0",
        nullable=False,
    )
    replay_floor_stream_position: Mapped[int] = mapped_column(
        BigInteger,
        default=0,
        server_default="0",
        nullable=False,
    )
    replay_floor_advanced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    replay_floor_session_high_waters: Mapped[JsonValue] = mapped_column(
        JSONB(none_as_null=True),
        default=dict,
        server_default="{}",
        nullable=False,
    )
    retirement_id: Mapped[str | None] = mapped_column(String(200))
    retirement_receipt_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    retirement_receipt: Mapped[JsonValue | None] = mapped_column(JSONB(none_as_null=True))
    retired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    final_cursor: Mapped[str | None] = mapped_column(String(2000))
    final_stream_position: Mapped[int | None] = mapped_column(BigInteger)
    final_session_high_waters: Mapped[JsonValue | None] = mapped_column(JSONB(none_as_null=True))


class V2RuntimeObservationInbox(Base):
    """Immutable, append-only strict-v2 heartbeat event."""

    __tablename__ = "v2_runtime_observation_inbox"
    __table_args__ = (
        ForeignKeyConstraint(
            ["environment_id", "deployment_id"],
            [
                "v2_runtime_environment_fences.environment_id",
                "v2_runtime_environment_fences.deployment_id",
            ],
            ondelete="RESTRICT",
            name="fk_v2_runtime_observation_inbox_fence_binding",
        ),
        UniqueConstraint(
            "environment_id",
            "boot_session_id",
            "sequence",
            name="uq_v2_runtime_observation_inbox_session_sequence",
        ),
        UniqueConstraint("event_id", name="uq_v2_runtime_observation_inbox_event_id"),
        CheckConstraint(
            "generation > 0",
            name="ck_v2_runtime_observation_inbox_generation",
        ),
        CheckConstraint(
            "sequence > 0 AND sequence <= 9007199254740991",
            name="ck_v2_runtime_observation_inbox_sequence",
        ),
        CheckConstraint(
            "health IN ('ok', 'error', 'unknown')",
            name="ck_v2_runtime_observation_inbox_health",
        ),
        CheckConstraint(
            "payload_hash ~ '^[0-9a-f]{64}$'",
            name="ck_v2_runtime_observation_inbox_payload_hash",
        ),
        Index(
            "ix_v2_runtime_observation_inbox_environment_stream",
            "environment_id",
            "id",
        ),
        Index(
            "ix_v2_runtime_observation_inbox_received_at",
            "received_at",
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    environment_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    deployment_id: Mapped[str] = mapped_column(String(200), nullable=False)
    generation: Mapped[int] = mapped_column(BigInteger, nullable=False)
    manifest_etag: Mapped[str] = mapped_column(String(1024), nullable=False)
    apply_receipt_id: Mapped[str] = mapped_column(String(128), nullable=False)
    boot_nonce: Mapped[str] = mapped_column(String(128), nullable=False)
    boot_session_id: Mapped[str] = mapped_column(String(128), nullable=False)
    sequence: Mapped[int] = mapped_column(BigInteger, nullable=False)
    event_id: Mapped[str] = mapped_column(String(128), nullable=False)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    freshness_deadline: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    health: Mapped[str] = mapped_column(String(16), nullable=False)
    diagnostics: Mapped[JsonValue] = mapped_column(JSONB(none_as_null=True), nullable=False)


class V2RuntimeObservationHead(Base, TimestampMixin):
    """Immutable boot binding with a monotonic accepted-event head."""

    __tablename__ = "v2_runtime_observation_heads"
    __table_args__ = (
        ForeignKeyConstraint(
            ["environment_id", "deployment_id"],
            [
                "v2_runtime_environment_fences.environment_id",
                "v2_runtime_environment_fences.deployment_id",
            ],
            ondelete="RESTRICT",
            name="fk_v2_runtime_observation_heads_fence_binding",
        ),
        ForeignKeyConstraint(
            ["latest_inbox_id"],
            ["v2_runtime_observation_inbox.id"],
            ondelete="SET NULL",
            name="fk_v2_runtime_observation_heads_latest_inbox",
        ),
        CheckConstraint(
            "generation > 0",
            name="ck_v2_runtime_observation_heads_generation",
        ),
        CheckConstraint(
            "highest_sequence > 0 AND highest_sequence <= 9007199254740991",
            name="ck_v2_runtime_observation_heads_sequence",
        ),
        CheckConstraint(
            "state IN ('active', 'retired')",
            name="ck_v2_runtime_observation_heads_state",
        ),
        CheckConstraint(
            "(state = 'active' AND latest_event_id IS NOT NULL AND captured_at IS NOT NULL "
            "AND freshness_deadline IS NOT NULL AND health IS NOT NULL "
            "AND tombstoned_at IS NULL) "
            "OR (state = 'retired' AND latest_inbox_id IS NULL "
            "AND latest_event_id IS NOT NULL AND captured_at IS NULL "
            "AND freshness_deadline IS NULL AND health IS NULL "
            "AND tombstoned_at IS NOT NULL)",
            name="ck_v2_runtime_observation_heads_lifecycle",
        ),
        CheckConstraint(
            "health IS NULL OR health IN ('ok', 'error', 'unknown')",
            name="ck_v2_runtime_observation_heads_health",
        ),
    )

    environment_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    boot_session_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    deployment_id: Mapped[str] = mapped_column(String(200), nullable=False)
    generation: Mapped[int] = mapped_column(BigInteger, nullable=False)
    manifest_etag: Mapped[str] = mapped_column(String(1024), nullable=False)
    apply_receipt_id: Mapped[str] = mapped_column(String(128), nullable=False)
    boot_nonce: Mapped[str] = mapped_column(String(128), nullable=False)
    highest_sequence: Mapped[int] = mapped_column(BigInteger, nullable=False)
    latest_inbox_id: Mapped[int | None] = mapped_column(BigInteger)
    latest_stream_position: Mapped[int] = mapped_column(BigInteger, nullable=False)
    latest_event_id: Mapped[str] = mapped_column(String(128), nullable=False)
    latest_payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    captured_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    freshness_deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    health: Mapped[str | None] = mapped_column(String(16))
    state: Mapped[str] = mapped_column(
        String(16),
        default=RUNTIME_OBSERVATION_HEAD_ACTIVE,
        server_default=RUNTIME_OBSERVATION_HEAD_ACTIVE,
        nullable=False,
    )
    tombstoned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class V2RuntimeObservationConsumerCursor(Base, TimestampMixin):
    """Required consumer acknowledgement and explicit replay-loss boundary."""

    __tablename__ = "v2_runtime_observation_consumer_cursors"
    __table_args__ = (
        ForeignKeyConstraint(
            ["environment_id", "deployment_id"],
            [
                "v2_runtime_environment_fences.environment_id",
                "v2_runtime_environment_fences.deployment_id",
            ],
            ondelete="RESTRICT",
            name="fk_v2_runtime_observation_consumer_cursors_fence_binding",
        ),
        CheckConstraint(
            "state IN ('active', 'expired')",
            name="ck_v2_runtime_observation_consumer_cursors_state",
        ),
        CheckConstraint(
            "acked_stream_position >= 0",
            name="ck_v2_runtime_observation_consumer_cursors_acked_position",
        ),
        CheckConstraint(
            "(state = 'active' AND expired_at IS NULL) "
            "OR (state = 'expired' AND expired_at IS NOT NULL "
            "AND expiry_boundary_stream_position IS NOT NULL "
            "AND expiry_boundary_cursor IS NOT NULL "
            "AND expiry_session_high_waters IS NOT NULL "
            "AND reset_barrier_at IS NOT NULL)",
            name="ck_v2_runtime_observation_consumer_cursors_expiry",
        ),
        Index(
            "ix_v2_runtime_observation_consumer_cursors_retention",
            "environment_id",
            "required",
            "state",
            "acked_stream_position",
        ),
    )

    environment_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    consumer_id: Mapped[str] = mapped_column(String(200), primary_key=True)
    deployment_id: Mapped[str] = mapped_column(String(200), nullable=False)
    required: Mapped[bool] = mapped_column(
        Boolean,
        default=True,
        server_default="true",
        nullable=False,
    )
    cursor_epoch: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        default=uuid.uuid4,
        nullable=False,
    )
    state: Mapped[str] = mapped_column(
        String(16),
        default=RUNTIME_OBSERVATION_CURSOR_ACTIVE,
        server_default=RUNTIME_OBSERVATION_CURSOR_ACTIVE,
        nullable=False,
    )
    acked_cursor: Mapped[str] = mapped_column(String(2000), nullable=False)
    acked_stream_position: Mapped[int] = mapped_column(
        BigInteger,
        default=0,
        server_default="0",
        nullable=False,
    )
    acknowledged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    replay_horizon_started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    expired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expiry_boundary_stream_position: Mapped[int | None] = mapped_column(BigInteger)
    expiry_boundary_cursor: Mapped[str | None] = mapped_column(String(2000))
    expiry_session_high_waters: Mapped[JsonValue | None] = mapped_column(JSONB(none_as_null=True))
    reset_barrier_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reset_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
