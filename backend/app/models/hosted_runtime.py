import uuid

from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.session import AgentEnvironment  # noqa: F401 - register FK target


class HostedRuntimeState(Base, TimestampMixin):
    __tablename__ = "hosted_runtime_states"

    environment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agent_environments.id", ondelete="CASCADE"),
        primary_key=True,
    )
    deployment_id: Mapped[str] = mapped_column(String(200), nullable=False)
    app_id: Mapped[str | None] = mapped_column(String(200))
    instance_id: Mapped[str] = mapped_column(String(200), nullable=False)
    generation: Mapped[int] = mapped_column(Integer, nullable=False)
    provider_id: Mapped[str | None] = mapped_column(String(80))
    locale: Mapped[dict] = mapped_column(JSONB(none_as_null=True), nullable=False)
    system: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    control_plane: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    egress_engine: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    runtimes: Mapped[dict] = mapped_column(JSONB(none_as_null=True), nullable=False)
    bridge: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    live_sync: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    recovery: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    egress_profiles: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    mcp: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    tools: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    observed: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
