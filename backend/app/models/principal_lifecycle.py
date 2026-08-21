import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class PrincipalLifecycle(Base, TimestampMixin):
    """Issuer-scoped fail-closed account lifecycle fence."""

    __tablename__ = "principal_lifecycles"
    __table_args__ = (
        UniqueConstraint(
            "issuer",
            "subject",
            name="uq_principal_lifecycles_external_identity",
        ),
        UniqueConstraint("user_id", name="uq_principal_lifecycles_user_id"),
        CheckConstraint(
            "cleanup_attempts >= 0",
            name="ck_principal_lifecycles_cleanup_attempts",
        ),
        CheckConstraint(
            "(cleanup_completed_at IS NULL AND next_cleanup_attempt_at IS NOT NULL "
            "AND ((cleanup_claim_id IS NULL AND cleanup_claimed_at IS NULL) OR "
            "(cleanup_claim_id IS NOT NULL AND cleanup_claimed_at IS NOT NULL))) OR "
            "(cleanup_completed_at IS NOT NULL AND next_cleanup_attempt_at IS NULL "
            "AND cleanup_claim_id IS NULL AND cleanup_claimed_at IS NULL)",
            name="ck_principal_lifecycles_cleanup",
        ),
        Index(
            "ix_principal_lifecycles_cleanup_due",
            "next_cleanup_attempt_at",
            postgresql_where=text("cleanup_completed_at IS NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    issuer: Mapped[str] = mapped_column(String(255), nullable=False)
    subject: Mapped[str] = mapped_column(String(200), nullable=False)
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        index=True,
    )
    terminated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    cleanup_attempts: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=0,
        server_default="0",
    )
    cleanup_completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    next_cleanup_attempt_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    cleanup_claim_id: Mapped[str | None] = mapped_column(String(64))
    cleanup_claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ClerkWebhookEventReceipt(Base, TimestampMixin):
    """Minimal durable evidence for one verified Clerk deletion event."""

    __tablename__ = "clerk_webhook_event_receipts"
    __table_args__ = (
        CheckConstraint(
            "receipt_source IN ('clerk', 'legacy_platform_bridge')",
            name="ck_clerk_webhook_event_receipts_source",
        ),
        CheckConstraint(
            "event_type = 'user.deleted'",
            name="ck_clerk_webhook_event_receipts_type",
        ),
        CheckConstraint(
            "(receipt_source = 'clerk' AND length(payload_sha256) = 64) OR "
            "(receipt_source = 'legacy_platform_bridge' AND payload_sha256 IS NULL)",
            name="ck_clerk_webhook_event_receipts_payload",
        ),
    )

    message_id: Mapped[str] = mapped_column(String(191), primary_key=True)
    lifecycle_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("principal_lifecycles.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    receipt_source: Mapped[str] = mapped_column(String(32), nullable=False)
    event_type: Mapped[str] = mapped_column(String(32), nullable=False)
    payload_sha256: Mapped[str | None] = mapped_column(String(64))
    event_occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )


class ClerkPrincipalAuthority(Base, TimestampMixin):
    """Latest authoritative reversible Clerk ban projection for one subject."""

    __tablename__ = "clerk_principal_authorities"
    __table_args__ = (
        UniqueConstraint(
            "issuer",
            "subject",
            name="uq_clerk_principal_authorities_external_identity",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    issuer: Mapped[str] = mapped_column(String(255), nullable=False)
    subject: Mapped[str] = mapped_column(String(200), nullable=False)
    banned: Mapped[bool] = mapped_column(nullable=False)
    authority_updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    message_id: Mapped[str] = mapped_column(String(191), nullable=False)
    payload_sha256: Mapped[str] = mapped_column(String(64), nullable=False)


class ClerkPrincipalSuspension(Base, TimestampMixin):
    """Reversible platform suspension independent of Clerk plan features."""

    __tablename__ = "clerk_principal_suspensions"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            name="uq_clerk_principal_suspensions_user_id",
        ),
    )

    issuer: Mapped[str] = mapped_column(String(255), primary_key=True)
    subject: Mapped[str] = mapped_column(String(200), primary_key=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        index=True,
    )
    suspended_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    reason: Mapped[str] = mapped_column(String(191), nullable=False)
