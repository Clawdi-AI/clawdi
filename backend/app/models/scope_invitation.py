"""Outstanding email-based invitation to a scope.

Row exists from `POST /api/scopes/{id}/invitations` until invitee
accepts (row deleted, `ScopeMembership` created), declines (row
deleted), or owner cancels (row deleted). No terminal "accepted_at"
state - the membership row IS the post-accept record.

Uniqueness is `(scope_id, invitee_user_id)` (NOT email): invitees
are looked up to a `users.id` at invitation time, and email changes
on the Clerk side don't lose the invite. `invitee_email` is kept
as historical context for the owner's UI but is no longer the
identity key. See spec sections 4.5 and 6.1.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.scope import Scope as Scope  # noqa: F401
from app.models.user import User as User  # noqa: F401


class ScopeInvitation(Base, TimestampMixin):
    __tablename__ = "scope_invitations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    scope_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("scopes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    invitee_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    invitee_email: Mapped[str] = mapped_column(String(320), nullable=False)
    invited_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        # One pending invite per (scope, invitee). Reinvites by
        # alternate email aliases of the same user still collide.
        UniqueConstraint(
            "scope_id",
            "invitee_user_id",
            name="uq_scope_invitations_scope_user",
        ),
    )
