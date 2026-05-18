"""Persistent redeem attempts for share-link rate limits and idempotency."""

import uuid

from sqlalchemy import ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.project_share_link import ProjectShareLink  # noqa: F401


class ShareRedeemAttempt(Base, TimestampMixin):
    __tablename__ = "share_redeem_attempts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    link_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("project_share_links.id", ondelete="CASCADE"),
        nullable=False,
    )
    client_key: Mapped[str] = mapped_column(String(128), nullable=False)
    idempotency_key: Mapped[str | None] = mapped_column(String(200))

    __table_args__ = (
        UniqueConstraint(
            "link_id",
            "idempotency_key",
            name="uq_share_redeem_attempts_link_idempotency",
        ),
        Index(
            "ix_share_redeem_attempts_link_client_created",
            "link_id",
            "client_key",
            "created_at",
        ),
        Index("ix_share_redeem_attempts_created_at", "created_at"),
    )
