import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class HostedV1AgentOwnership(Base, TimestampMixin):
    """Durable first-party claim that a Hosted V1 deployment owns an Agent."""

    __tablename__ = "hosted_v1_agent_ownerships"
    __table_args__ = (
        CheckConstraint(
            "agent_type IN ('hermes', 'openclaw')",
            name="ck_hosted_v1_agent_ownerships_agent_type",
        ),
        CheckConstraint(
            "(archived_at IS NULL) = (archive_reason IS NULL)",
            name="ck_hosted_v1_agent_ownerships_archive_state",
        ),
        CheckConstraint(
            "archive_reason IS NULL OR archive_reason IN "
            "('released', 'replaced', 'agent_archived')",
            name="ck_hosted_v1_agent_ownerships_archive_reason",
        ),
        Index(
            "uq_hosted_v1_agent_ownerships_active_environment",
            "environment_id",
            unique=True,
            postgresql_where=text("archived_at IS NULL"),
        ),
        Index(
            "uq_hosted_v1_agent_ownerships_active_deployment_agent",
            "deployment_id",
            "agent_type",
            unique=True,
            postgresql_where=text("archived_at IS NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    environment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agent_environments.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    api_key_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("api_keys.id"),
        nullable=False,
        index=True,
    )
    deployment_id: Mapped[str] = mapped_column(String(200), nullable=False)
    agent_type: Mapped[str] = mapped_column(String(50), nullable=False)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    archive_reason: Mapped[str | None] = mapped_column(String(32))
