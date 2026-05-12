"""Membership of a user in a scope owned by another user.

A row links one Clerk-bound `users.id` to one `scopes.id` with a role.
Anonymous share-token holders do NOT get rows here - token-only access
is governed by `scope_share_links` and does not produce membership
until the sharee signs in and upgrades.

`resolved_owner_handle` is frozen at row creation so the sharee's local
skill path (`<key>__<handle>/`) stays stable if the owner renames.
"""

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.scope import Scope as Scope  # noqa: F401 - FK target
from app.models.user import User as User  # noqa: F401 - FK target


class ScopeMembership(Base, TimestampMixin):
    __tablename__ = "scope_memberships"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    scope_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("scopes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # 'viewer' is the only v1 role. 'editor' reserved for follow-up;
    # CHECK constraint extended via DROP+ADD when that ships.
    role: Mapped[str] = mapped_column(String(32), nullable=False)
    # Origin of this membership row:
    #   'invite' - email invitation accepted
    #   'link'   - any share-link path (web direct, CLI direct,
    #              or post-anonymous token upgrade - all converge here)
    joined_via: Mapped[str] = mapped_column(String(32), nullable=False)
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # See spec section 11.6 - frozen owner display at join time so the local
    # skill folder `<key>__<handle>/` never moves under the sharee.
    resolved_owner_handle: Mapped[str] = mapped_column(String(64), nullable=False)

    __table_args__ = (
        UniqueConstraint("scope_id", "user_id", name="uq_scope_memberships_scope_user"),
        CheckConstraint("role IN ('viewer')", name="ck_scope_memberships_role_v1"),
        CheckConstraint(
            "joined_via IN ('invite', 'link')",
            name="ck_scope_memberships_joined_via_v1",
        ),
    )
