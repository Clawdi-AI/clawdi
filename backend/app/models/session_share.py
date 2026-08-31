import uuid
from datetime import datetime
from typing import Literal

from pydantic import JsonValue
from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, String, Text, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class SessionShare(Base, TimestampMixin):
    """Immutable, revocable public view of a bounded session revision."""

    __tablename__ = "session_shares"
    __table_args__ = (
        CheckConstraint(
            "scope IN ('session', 'through', 'response')",
            name="ck_session_shares_scope",
        ),
        CheckConstraint(
            "source_protocol IN ('snapshot-v1', 'events-v1')",
            name="ck_session_shares_source_protocol",
        ),
        CheckConstraint(
            "end_position >= 0 AND (start_position IS NULL OR start_position >= 0)",
            name="ck_session_shares_positions_nonnegative",
        ),
        CheckConstraint(
            "(scope = 'response' AND start_position = end_position) OR "
            "(scope IN ('session', 'through') AND start_position IS NULL)",
            name="ck_session_shares_scope_positions",
        ),
        CheckConstraint(
            "(source_protocol = 'snapshot-v1' AND snapshot_file_key IS NOT NULL "
            "AND event_generation_id IS NULL AND event_count IS NULL) OR "
            "(source_protocol = 'events-v1' AND snapshot_file_key IS NULL "
            "AND event_generation_id IS NOT NULL AND event_count > 0)",
            name="ck_session_shares_source_reference",
        ),
        Index(
            "ix_session_shares_session_active_created",
            "session_id",
            text("created_at DESC"),
            postgresql_where=text("revoked_at IS NULL"),
        ),
        Index(
            "ix_session_shares_generation_active",
            "event_generation_id",
            postgresql_where=text("event_generation_id IS NOT NULL AND revoked_at IS NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("sessions.id", ondelete="CASCADE"),
        nullable=False,
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
    )
    scope: Mapped[Literal["session", "through", "response"]] = mapped_column(
        String(20), nullable=False
    )
    start_position: Mapped[int | None] = mapped_column(Integer)
    end_position: Mapped[int] = mapped_column(Integer, nullable=False)

    source_protocol: Mapped[Literal["snapshot-v1", "events-v1"]] = mapped_column(
        String(20), nullable=False
    )
    source_revision: Mapped[str] = mapped_column(String(80), nullable=False)
    event_generation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("session_event_generations.id", ondelete="CASCADE"),
    )
    event_count: Mapped[int | None] = mapped_column(Integer)
    snapshot_file_key: Mapped[str | None] = mapped_column(Text)
    public_metadata: Mapped[dict[str, JsonValue]] = mapped_column(JSONB, nullable=False)

    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
