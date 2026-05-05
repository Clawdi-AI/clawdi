import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class ApiKey(Base, TimestampMixin):
    __tablename__ = "api_keys"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    key_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    key_prefix: Mapped[str] = mapped_column(String(16), nullable=False)
    label: Mapped[str] = mapped_column(String(200), nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Scope set this key is allowed to act under. Examples:
    # `["sessions:write", "skills:read", "skills:write"]` (deploy-key
    # for `clawdi serve` daemon). NULL means full account access —
    # interactive `clawdi auth login` keys keep this null for backwards
    # compatibility with existing CLI flows.
    scopes: Mapped[list[str] | None] = mapped_column(ARRAY(String(64)))

    # Optional binding to a single agent environment. When set, the
    # key may only act on that env's resources (e.g. push sessions
    # under that env_id, pull skills as that env). Resource-scoping
    # alone isn't enough — a leaked deploy-key from pod A shouldn't
    # be able to write into pod B's sessions on the same account.
    # NULL = no binding (laptop / VPS / interactive keys).
    environment_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agent_environments.id", ondelete="CASCADE"),
        index=True,
    )
