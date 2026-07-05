import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, LargeBinary, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.user import User  # noqa: F401 - register users table for FK resolution


class AiProvider(Base, TimestampMixin):
    __tablename__ = "ai_providers"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    scope: Mapped[str] = mapped_column(String(40), nullable=False, server_default="account_global")
    provider_id: Mapped[str] = mapped_column(String(80), nullable=False)
    type: Mapped[str] = mapped_column(String(80), nullable=False)
    label: Mapped[str | None] = mapped_column(String(200))
    base_url: Mapped[str] = mapped_column(String(1000), nullable=False)
    api_mode: Mapped[str | None] = mapped_column(String(80))
    capabilities: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    models: Mapped[list[dict] | None] = mapped_column(JSONB(none_as_null=True))
    auth_type: Mapped[str] = mapped_column(String(80), nullable=False)
    auth_ref: Mapped[str | None] = mapped_column(String(1000))
    auth_metadata: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    managed_by: Mapped[str] = mapped_column(String(80), nullable=False, server_default="user")
    runtime_env_name: Mapped[str | None] = mapped_column(String(128))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint("owner_user_id", "provider_id", name="uq_ai_providers_owner_provider_id"),
    )


class AiProviderAuthPayload(Base, TimestampMixin):
    __tablename__ = "ai_provider_auth_payloads"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    provider_id: Mapped[str] = mapped_column(String(80), nullable=False)
    auth_profile: Mapped[str] = mapped_column(String(120), nullable=False, server_default="default")
    kind: Mapped[str] = mapped_column(String(80), nullable=False)
    source: Mapped[str] = mapped_column(String(80), nullable=False)
    encrypted_payload: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    nonce: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    payload_metadata: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint(
            "owner_user_id",
            "provider_id",
            "auth_profile",
            name="uq_ai_provider_auth_payloads_owner_provider_profile",
        ),
    )
