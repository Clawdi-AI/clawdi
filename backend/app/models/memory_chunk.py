import uuid
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import DateTime, ForeignKey, Integer, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class MemoryChunk(Base):
    """One chunk of a Memory's content, embedded independently for retrieval.

    Memories are split at paragraph boundaries on write. Search hits chunks
    via FTS + vector, then DISTINCT ON (memory_id) rolls back to one row per
    parent. Position 0 is the first chunk (heading-ish) and gets FTS weight
    'A'; other chunks get 'B'. See alembic d7e3f8a4c1b2.
    """

    __tablename__ = "memory_chunks"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    memory_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("memories.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(768), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )
