import uuid
from datetime import datetime

from pydantic import JsonValue
from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String
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
    instance_id: Mapped[str] = mapped_column(String(200), nullable=False)
    generation: Mapped[int] = mapped_column(Integer, nullable=False)
    cli_package_spec: Mapped[str] = mapped_column(String(200), nullable=False)
    locale: Mapped[dict] = mapped_column(JSONB(none_as_null=True), nullable=False)
    system: Mapped[dict] = mapped_column(JSONB(none_as_null=True), nullable=False)
    egress_engine: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    runtimes: Mapped[dict] = mapped_column(JSONB(none_as_null=True), nullable=False)
    live_sync: Mapped[dict] = mapped_column(JSONB(none_as_null=True), nullable=False)
    recovery: Mapped[dict] = mapped_column(JSONB(none_as_null=True), nullable=False)
    egress_profiles: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    mcp: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    tools: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))


class HostedRuntimeConfigObservation(Base, TimestampMixin):
    """Daemon-reported CONFIG convergence, separate from provider COMPUTE state."""

    __tablename__ = "hosted_runtime_config_observations"
    __table_args__ = (
        CheckConstraint(
            "observed_config_generation IS NULL OR observed_config_generation >= 0",
            name="ck_hosted_runtime_config_observations_generation",
        ),
    )

    environment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("hosted_runtime_states.environment_id", ondelete="CASCADE"),
        primary_key=True,
    )
    observed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    observed_config_generation: Mapped[int | None] = mapped_column(Integer)
    observed_manifest_etag: Mapped[str | None] = mapped_column(String(1024))
    observed_source_revision: Mapped[str | None] = mapped_column(String(64))
    diagnostics: Mapped[JsonValue] = mapped_column(JSONB(none_as_null=True), nullable=False)
