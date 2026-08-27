"""Small PostgreSQL-backed coordination state shared by API workers."""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, PrimaryKeyConstraint, String, func
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class SharedRateLimitBucket(Base):
    __tablename__ = "shared_rate_limit_buckets"

    namespace: Mapped[str] = mapped_column(String(64), nullable=False)
    key_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    attempts: Mapped[list[datetime]] = mapped_column(
        ARRAY(DateTime(timezone=True)),
        nullable=False,
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        PrimaryKeyConstraint("namespace", "key_hash", name="pk_shared_rate_limit_buckets"),
        Index("ix_shared_rate_limit_buckets_expiry", "namespace", "expires_at"),
    )


class SyncSubscriptionLease(Base):
    __tablename__ = "sync_subscription_leases"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    bound_api_key_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("api_keys.id", ondelete="CASCADE"),
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    __table_args__ = (
        Index("ix_sync_subscription_leases_user_expiry", "user_id", "expires_at"),
        Index(
            "ix_sync_subscription_leases_bound_key_expiry",
            "bound_api_key_id",
            "expires_at",
        ),
    )
