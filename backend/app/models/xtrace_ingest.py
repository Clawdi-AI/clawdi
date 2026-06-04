import uuid

from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.session import Session  # noqa: F401 - register `sessions` table for FK resolution


class XTraceMemoryIngest(Base, TimestampMixin):
    __tablename__ = "xtrace_memory_ingests"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    local_session_id: Mapped[str] = mapped_column(String(200), nullable=False, index=True)
    job_id: Mapped[str | None] = mapped_column(String(200), nullable=True, index=True)
    status: Mapped[str | None] = mapped_column(String(50), nullable=True, index=True)
    created_ref_count: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    updated_ref_count: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    mirrored_count: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    response: Mapped[dict | None] = mapped_column(JSONB)
