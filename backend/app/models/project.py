"""Project — first-class container for skills, vaults, and memories."""

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin

# Allowed values for `Project.kind`. Future entries — e.g. public
# subscribe-only marketplace projects — will be added by dropping and
# re-adding the CHECK constraint, not via ENUM ALTER (cheaper to evolve).
PROJECT_KIND_PERSONAL = "personal"
PROJECT_KIND_ENVIRONMENT = "environment"
PROJECT_KIND_WORKSPACE = "workspace"
PROJECT_KINDS_V2 = (PROJECT_KIND_PERSONAL, PROJECT_KIND_ENVIRONMENT, PROJECT_KIND_WORKSPACE)


class Project(Base, TimestampMixin):
    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # User-readable name (display only) and stable URL slug. Both are
    # mutable; api uses `id` as the durable identifier so renaming
    # never breaks links. Slug uniqueness is per-user, not global.
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    slug: Mapped[str] = mapped_column(String(80), nullable=False)

    # Kind separates auto-managed project types (personal, environment)
    # from user-created Projects. New kinds get added by
    # replacing the CHECK constraint.
    kind: Mapped[str] = mapped_column(String(32), nullable=False)

    # Env-local projects record which env they were spawned for.
    # ON DELETE SET NULL: deleting an env doesn't destroy its project.
    origin_environment_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agent_environments.id", ondelete="SET NULL"),
        index=True,
    )

    description: Mapped[str | None] = mapped_column(Text)

    # Soft-delete column — lets the dashboard show closed projects
    # without losing history. Phase 1 doesn't surface this; reserved.
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        # Slug unique per owner so the dashboard URL `/projects/{slug}`
        # is unambiguous within an account; slugs can repeat across
        # owners.
        UniqueConstraint("user_id", "slug", name="uq_projects_user_slug"),
        # Database-enforced kind whitelist.
        CheckConstraint(
            "kind IN "
            f"('{PROJECT_KIND_PERSONAL}', "
            f"'{PROJECT_KIND_ENVIRONMENT}', "
            f"'{PROJECT_KIND_WORKSPACE}')",
            name="ck_projects_kind_v2",
        ),
        # Exactly one personal-kind project per user. Partial unique
        # index — environment-kind projects are unrestricted (one per
        # env, naturally unique on `origin_environment_id`).
        Index(
            "uq_projects_one_personal_per_user",
            "user_id",
            unique=True,
            postgresql_where=(f"kind = '{PROJECT_KIND_PERSONAL}'"),
        ),
    )
