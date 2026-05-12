import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin

# Current allowed values. Adding new kinds (e.g. team / workspace)
# later means extending this tuple + the matching CHECK constraint
# + the relevant identifier column.
PERMISSION_KIND_LINK = "link"
PERMISSION_KIND_USER = "user"
PERMISSION_KIND_EMAIL = "email"
PERMISSION_KINDS = (
    PERMISSION_KIND_LINK,
    PERMISSION_KIND_USER,
    PERMISSION_KIND_EMAIL,
)

ROLE_VIEWER = "viewer"
ROLES = (ROLE_VIEWER,)


class SessionPermission(Base, TimestampMixin):
    """Polymorphic access permission on a session.

    Modeled after Google Drive's `permissions` resource: a `kind`
    discriminator + explicit identifier columns (`user_id`, `email`,
    ...). `kind='link'` is "anyone with the URL `/s/{session_id}` can
    view" — the row's existence is the access policy. `kind='user'`
    grants access to a specific Clawdi user. `kind='email'` grants
    access to whoever signs up under that email (pending until they do).

    Owner does NOT need a row; access is implicit via
    `session.user_id == visitor.user_id`. These rows exist purely to
    grant access to *others*.

    Why explicit identifier columns instead of one polymorphic
    `principal_id text`? FK on `user_id` enforces "this user actually
    exists"; mutually exclusive columns let the access-check helper
    use simple equality rather than dispatch on `kind`. New principal
    kinds add one column — the table stays narrow because we ship only
    what we use.
    """

    __tablename__ = "session_permissions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Discriminator. CHECK constraint enforces the v1 set; new kinds
    # are added by replacing the constraint, never by ENUM ALTER (the
    # project convention from `Scope.kind` and `ApiKey.kind`).
    kind: Mapped[str] = mapped_column(String(32), nullable=False)

    # Identifier columns. Populated according to `kind`:
    #   kind='link'  → both NULL (anyone with the URL)
    #   kind='user'  → user_id set, email NULL
    #   kind='email' → email set (lowercased), user_id NULL until the
    #                  invitee signs up and we reconcile to user_id
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
    )
    # Stored lowercased — see the POST /permissions handler. VARCHAR(320)
    # is the RFC-5321 maximum (64 local + @ + 255 domain). Held as plain
    # VARCHAR rather than CITEXT to avoid a DB-extension dependency for
    # one column; we only ever compare with `==`.
    email: Mapped[str | None] = mapped_column(String(320), nullable=True)

    # Role enum. Today only 'viewer' is produced; the CHECK constraint
    # rejects anything else at the DB layer. Future roles
    # (commenter/editor/owner) require both a constraint update and
    # producer code.
    role: Mapped[str] = mapped_column(String(32), nullable=False, server_default=ROLE_VIEWER)

    # Lifecycle.
    # `invited_by` records who created the row — useful for audit trail
    # display. SET NULL (not CASCADE) so removing a user account
    # doesn't wipe the access permissions they handed out.
    invited_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    # NULL = pending. Set on signup-reconciliation for email invites,
    # or eagerly on insert for kinds that don't need acceptance
    # (anyone-with-link, direct user grants).
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Forward-compat: column exists, no UI sets it today. The
    # access-check helper will treat `now() > expires_at` the same as
    # a revoke once we wire it up.
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Soft-delete. NULL = active. Lets the dashboard show audit history
    # (when was access granted / revoked, by whom) without losing rows.
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(
            "kind IN ('link', 'user', 'email')",
            name="ck_session_permissions_kind",
        ),
        CheckConstraint(
            "role IN ('viewer')",
            name="ck_session_permissions_role",
        ),
        # Sparse index for "which user has access?" lookups. Only
        # populated for kind='user' rows — partial keeps the index
        # small.
        Index(
            "ix_session_permissions_user_id",
            "user_id",
            postgresql_where=text("user_id IS NOT NULL"),
        ),
        # Pending-invite reconciliation: when alice@x.com signs up,
        # we look up email-kind rows still waiting for them.
        Index(
            "ix_session_permissions_email_pending",
            "email",
            postgresql_where=text(
                "email IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL"
            ),
        ),
        # At most one ACTIVE permission per (session, kind, identifier).
        # COALESCE collapses both identifier columns to a single string
        # so the constraint expresses naturally. kind='link' rows have
        # NULL for both → COALESCE returns '' → at most one link
        # permission per session.
        Index(
            "uq_active_permission_per_principal",
            "session_id",
            "kind",
            text("COALESCE(user_id::text, email, '')"),
            unique=True,
            postgresql_where=text("revoked_at IS NULL"),
        ),
    )
