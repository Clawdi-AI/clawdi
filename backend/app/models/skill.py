import uuid

from sqlalchemy import Boolean, CheckConstraint, ForeignKey, Index, Integer, String, Text
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.project import Project

SKILL_AUTHORITY_AGENT_SYNC = "agent_sync"
SKILL_AUTHORITY_CLOUD = "cloud"
SKILL_AUTHORITIES = (
    SKILL_AUTHORITY_AGENT_SYNC,
    SKILL_AUTHORITY_CLOUD,
)


class Skill(Base, TimestampMixin):
    __tablename__ = "skills"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    # Project this skill belongs to. Tenancy boundary stays user_id;
    # project_id sub-divides within a user. Phase-1 migration backfills
    # to the most-recently-active env's local project (multi-env users)
    # or the user's Personal project (no envs registered).
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        # CASCADE: deleting a project (e.g. user removes a machine
        # and its env-local project is archived) takes its skills
        # with it. Otherwise the project delete would be RESTRICTed
        # by every child skill and turn into a manual cleanup chore.
        ForeignKey(Project.id, ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    skill_key: Mapped[str] = mapped_column(String(200), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    version: Mapped[int] = mapped_column(Integer, server_default="1")
    source: Mapped[str] = mapped_column(String(50), server_default="local")
    # Durable write authority. Existing rows are deliberately backfilled to
    # `cloud`: historical project/source metadata cannot prove that an Agent
    # filesystem authored the bytes. Only the authenticated Agent sync route
    # may claim a row as `agent_sync` after observing it on that filesystem.
    # Manifest Skills remain desired-state inventory and are not persisted as
    # mutable Skill rows.
    authority: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        default=SKILL_AUTHORITY_CLOUD,
        server_default=SKILL_AUTHORITY_CLOUD,
    )
    # The Agent that owns an `agent_sync` projection. CASCADE keeps
    # an Agent deletion from leaving an unclaimable authoritative row behind.
    authority_agent_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agent_environments.id", ondelete="CASCADE"),
        index=True,
    )
    agent_types: Mapped[list[str] | None] = mapped_column(ARRAY(String))
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    file_key: Mapped[str | None] = mapped_column(Text)
    source_repo: Mapped[str | None] = mapped_column(String(200))
    file_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, server_default="true")

    __table_args__ = (
        CheckConstraint(
            "authority IN ('agent_sync', 'cloud')",
            name="ck_skills_authority",
        ),
        CheckConstraint(
            "(authority = 'agent_sync' AND authority_agent_id IS NOT NULL) OR "
            "(authority = 'cloud' AND authority_agent_id IS NULL)",
            name="ck_skills_authority_agent",
        ),
        # Partial unique — only active rows compete for the
        # (user_id, project_id, skill_key) slot. Soft-deleted
        # duplicates remain in the table for audit but don't block
        # new uploads. Matches every existing read path's
        # `WHERE is_active = true` filter.
        Index(
            "uq_skills_active_user_project_skill_key",
            "user_id",
            "project_id",
            "skill_key",
            unique=True,
            postgresql_where=("is_active = true"),
        ),
    )
