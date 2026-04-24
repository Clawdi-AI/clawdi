import uuid
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class Memory(Base, TimestampMixin):
    __tablename__ = "memories"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str] = mapped_column(String(50), server_default="fact")
    source: Mapped[str] = mapped_column(String(50), server_default="manual")
    source_session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    tags: Mapped[list[str] | None] = mapped_column(ARRAY(String))
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB)
    access_count: Mapped[int] = mapped_column(Integer, server_default="0")
    last_accessed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 768-dim vector: matches paraphrase-multilingual-mpnet-base-v2 (local
    # default) natively, and OpenAI text-embedding-3-* truncated via
    # `dimensions=768` for the API path. See services/embedding.py.
    embedding: Mapped[list[float] | None] = mapped_column(Vector(768), nullable=True)
