import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class AgentEnvironment(Base, TimestampMixin):
    __tablename__ = "agent_environments"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    machine_id: Mapped[str] = mapped_column(String(200), nullable=False)
    machine_name: Mapped[str] = mapped_column(String(200), nullable=False)
    agent_type: Mapped[str] = mapped_column(String(50), nullable=False)
    agent_version: Mapped[str | None] = mapped_column(String(50))
    os: Mapped[str] = mapped_column(String(50), nullable=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Session(Base, TimestampMixin):
    __tablename__ = "sessions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    environment_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
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
