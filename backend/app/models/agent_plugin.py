import uuid
from datetime import datetime

from pydantic import JsonValue
from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Integer,
    SmallInteger,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class PluginCatalogSnapshot(Base):
    __tablename__ = "plugin_catalog_snapshots"
    __table_args__ = (
        CheckConstraint(
            "revision ~ '^[0-9a-f]{40}$'",
            name="ck_plugin_catalog_snapshots_revision",
        ),
        CheckConstraint(
            "schema_version = 1",
            name="ck_plugin_catalog_snapshots_schema_version",
        ),
        CheckConstraint(
            "entry_count >= 0",
            name="ck_plugin_catalog_snapshots_entry_count",
        ),
    )

    revision: Mapped[str] = mapped_column(String(40), primary_key=True)
    schema_version: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    entry_count: Mapped[int] = mapped_column(Integer, nullable=False)
    source_etag: Mapped[str | None] = mapped_column(String(512))
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class PluginCatalogEntry(Base):
    __tablename__ = "plugin_catalog_entries"
    __table_args__ = (
        UniqueConstraint(
            "snapshot_revision",
            "name",
            "version",
            name="uq_plugin_catalog_entries_revision_name_version",
        ),
        CheckConstraint(
            "name ~ '^[a-z0-9][a-z0-9.-]{0,63}$' AND name NOT LIKE '%--%' AND name NOT LIKE '%..%'",
            name="ck_plugin_catalog_entries_name",
        ),
        CheckConstraint(
            "content_digest ~ '^sha256-tree-v1:[0-9a-f]{64}$'",
            name="ck_plugin_catalog_entries_content_digest",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    snapshot_revision: Mapped[str] = mapped_column(
        String(40),
        ForeignKey("plugin_catalog_snapshots.revision", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    version: Mapped[str] = mapped_column(String(256), nullable=False)
    agent_plugins_schema: Mapped[str] = mapped_column(String(200), nullable=False)
    source_path: Mapped[str] = mapped_column(String(500), nullable=False)
    content_digest: Mapped[str] = mapped_column(String(79), nullable=False)
    public_metadata: Mapped[dict[str, JsonValue]] = mapped_column(
        "metadata",
        JSONB(none_as_null=True),
        nullable=False,
    )
    has_configuration: Mapped[bool] = mapped_column(Boolean, nullable=False)
    compatible_runtimes: Mapped[list[str]] = mapped_column(JSONB(none_as_null=True), nullable=False)


class PluginCatalogSyncState(Base):
    __tablename__ = "plugin_catalog_sync_state"
    __table_args__ = (
        CheckConstraint("id = 1", name="ck_plugin_catalog_sync_state_singleton"),
        CheckConstraint("failure_count >= 0", name="ck_plugin_catalog_sync_state_failure_count"),
    )

    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    current_revision: Mapped[str | None] = mapped_column(
        String(40),
        ForeignKey("plugin_catalog_snapshots.revision", ondelete="RESTRICT"),
    )
    head_etag: Mapped[str | None] = mapped_column(String(512))
    catalog_etag: Mapped[str | None] = mapped_column(String(512))
    failure_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    next_sync_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(String(200))


class AgentPluginInstallation(Base, TimestampMixin):
    __tablename__ = "agent_plugin_installations"
    __table_args__ = (
        UniqueConstraint(
            "environment_id",
            "plugin_name",
            name="uq_agent_plugin_installations_environment_plugin",
        ),
        ForeignKeyConstraint(
            ["catalog_revision", "plugin_name", "version"],
            [
                "plugin_catalog_entries.snapshot_revision",
                "plugin_catalog_entries.name",
                "plugin_catalog_entries.version",
            ],
            name="fk_agent_plugin_installations_catalog_entry",
            ondelete="RESTRICT",
        ),
        CheckConstraint(
            "catalog_revision ~ '^[0-9a-f]{40}$'",
            name="ck_agent_plugin_installations_catalog_revision",
        ),
        CheckConstraint(
            "content_digest ~ '^sha256-tree-v1:[0-9a-f]{64}$'",
            name="ck_agent_plugin_installations_content_digest",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    environment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agent_environments.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    plugin_name: Mapped[str] = mapped_column(String(64), nullable=False)
    catalog_revision: Mapped[str] = mapped_column(String(40), nullable=False)
    version: Mapped[str] = mapped_column(String(256), nullable=False)
    agent_plugins_schema: Mapped[str] = mapped_column(String(200), nullable=False)
    source_path: Mapped[str] = mapped_column(String(500), nullable=False)
    content_digest: Mapped[str] = mapped_column(String(79), nullable=False)
