import uuid

from pydantic import JsonValue
from sqlalchemy import ForeignKey, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.channel import ChannelAccount, ChannelBotAgentLink
from app.models.session import AgentEnvironment
from app.models.user import User


class ControlPlaneAuditEvent(Base, TimestampMixin):
    __tablename__ = "control_plane_audit_events"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    actor_type: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(User.id, ondelete="SET NULL"),
        index=True,
    )
    target_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(User.id, ondelete="SET NULL"),
        index=True,
    )
    source: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    action: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    resource_type: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    resource_id: Mapped[str | None] = mapped_column(String(200), index=True)
    environment_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(AgentEnvironment.id, ondelete="SET NULL"),
        index=True,
    )
    channel_account_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(ChannelAccount.id, ondelete="SET NULL"),
        index=True,
    )
    channel_agent_link_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(ChannelBotAgentLink.id, ondelete="SET NULL"),
        index=True,
    )
    details: Mapped[dict[str, JsonValue]] = mapped_column(
        JSONB(none_as_null=True),
        nullable=False,
        default=dict,
    )
