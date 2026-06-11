import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.user import User  # noqa: F401 - register `users` table for FK resolution


class XTraceBackfillJob(Base, TimestampMixin):
    __tablename__ = "xtrace_backfill_jobs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    requested_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    scope_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    include_sessions: Mapped[bool] = mapped_column(Boolean, server_default="true", nullable=False)
    include_skills: Mapped[bool] = mapped_column(Boolean, server_default="true", nullable=False)
    force: Mapped[bool] = mapped_column(Boolean, server_default="false", nullable=False)
    dry_run: Mapped[bool] = mapped_column(Boolean, server_default="false", nullable=False)
    limit: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(
        String(50),
        server_default="queued",
        nullable=False,
        index=True,
    )
    current_source_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    current_source_key: Mapped[str | None] = mapped_column(String(300), nullable=True)
    considered_count: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    sent_count: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    skipped_count: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    failed_count: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    mirrored_count: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    sessions_considered: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    sessions_sent: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    sessions_skipped: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    sessions_failed: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    sessions_mirrored: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    skills_considered: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    skills_sent: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    skills_skipped: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    skills_failed: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    skills_mirrored: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
