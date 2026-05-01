import uuid

from sqlalchemy import Integer, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    clerk_id: Mapped[str] = mapped_column(String(200), unique=True, nullable=False)
    email: Mapped[str | None] = mapped_column(String(320))
    name: Mapped[str | None] = mapped_column(String(200))
    # Monotonic counter incremented on any skill insert / update /
    # soft-delete (`is_active=False`). Exposed as a collection-level
    # ETag on `GET /api/skills` and embedded in SSE `skill_changed`
    # event payloads so the daemon can detect missed events when
    # the stream drops mid-flight.
    skills_revision: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)


class UserSetting(Base, TimestampMixin):
    __tablename__ = "user_settings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, unique=True)
    settings: Mapped[dict] = mapped_column(JSONB, server_default="{}", nullable=False)
