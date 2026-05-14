"""Membership of a user in a shared project.

Projects are backed by the existing `scopes` table in pass 1; the
user-facing API surface uses project terminology.
"""

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.scope import Scope as Scope  # noqa: F401 - FK target
from app.models.user import User as User  # noqa: F401 - FK target


class ProjectMembership(Base, TimestampMixin):
    __tablename__ = "project_memberships"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("scopes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    member_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # v1 sharees are viewer-only. Keep editor reserved for follow-up.
    role: Mapped[str] = mapped_column(String(32), nullable=False)
    joined_via: Mapped[str] = mapped_column(String(32), nullable=False)
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    resolved_owner_handle: Mapped[str] = mapped_column(String(64), nullable=False)

    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "member_user_id",
            name="uq_project_memberships_project_user",
        ),
        CheckConstraint("role IN ('viewer')", name="ck_project_memberships_role_v1"),
        CheckConstraint(
            "joined_via IN ('invite', 'link')",
            name="ck_project_memberships_joined_via_v1",
        ),
    )
