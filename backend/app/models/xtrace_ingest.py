import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.session import Session  # noqa: F401 - register `sessions` table for FK resolution
from app.models.skill import Skill  # noqa: F401 - register `skills` table for FK resolution


class XTraceMemoryIngest(Base, TimestampMixin):
    __tablename__ = "xtrace_memory_ingests"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    source_type: Mapped[str] = mapped_column(String(50), server_default="session", nullable=False)
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("sessions.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    skill_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("skills.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    local_session_id: Mapped[str | None] = mapped_column(String(200), nullable=True, index=True)
    source_key: Mapped[str | None] = mapped_column(String(300), nullable=True, index=True)
    job_id: Mapped[str | None] = mapped_column(String(200), nullable=True, index=True)
    status: Mapped[str | None] = mapped_column(String(50), nullable=True, index=True)
    created_ref_count: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    updated_ref_count: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    mirrored_count: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    attempt_count: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    claimed_by: Mapped[str | None] = mapped_column(String(200), nullable=True, index=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    response: Mapped[dict | None] = mapped_column(JSONB)
