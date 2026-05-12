"""add session_permissions table

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-05-12

Permission table modeled on Google Drive's `permissions` resource:
a `kind` discriminator plus explicit identifier columns. Today only
`kind='link'` (anyone with the URL `/s/{session_id}` can view) is
exercised by the UI; `kind='user'` and `kind='email'` are accepted
by the API and validator but the dashboard doesn't surface the
invite-people row yet.

Owner does NOT need a permission row — access is implicit via
`session.user_id == visitor.user_id`. Permission rows exist only to
grant access to *others*.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d4e5f6a7b8c9"
down_revision: str | Sequence[str] | None = "b2c3d4e5f6a7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "session_permissions",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
        ),
        sa.Column(
            "session_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Discriminator. Drive uses `type`; we use `kind` to avoid
        # SQLAlchemy `Column.type` shadowing in the model class.
        sa.Column("kind", sa.String(32), nullable=False),
        # Identifier columns — mutually exclusive based on `kind`.
        # Drive-style explicit columns (not a polymorphic `principal_id text`)
        # so FK constraints enforce referential integrity on `user_id`,
        # and emails compare by exact lowercase equality at the app layer.
        sa.Column(
            "user_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=True,
        ),
        # VARCHAR(320) — RFC-5321 max (64 local + @ + 255 domain).
        # Held as plain VARCHAR (not CITEXT) to avoid a DB extension
        # for one column; stored lowercased by the POST handler.
        sa.Column("email", sa.String(320), nullable=True),
        sa.Column(
            "role",
            sa.String(32),
            nullable=False,
            server_default="viewer",
        ),
        sa.Column(
            "invited_by",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        # NULL = pending (email-invited, not signed up yet).
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        # Forward-compat: column exists, no UI to set it today. The
        # access-check helper will treat `now() > expires_at` like a
        # revoke once we wire it up.
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        # Soft-delete preserves audit (who granted access, when revoked).
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "kind IN ('link', 'user', 'email')",
            name="ck_session_permissions_kind",
        ),
        sa.CheckConstraint(
            "role IN ('viewer')",
            name="ck_session_permissions_role",
        ),
    )

    # Lookup for the access-check helper, which loads every active
    # permission row for a given session on each public request.
    op.create_index(
        "ix_session_permissions_session_id",
        "session_permissions",
        ["session_id"],
    )

    # Sparse — only populated for kind='user' rows. Used for "does
    # this user have any direct grants?" lookups.
    op.create_index(
        "ix_session_permissions_user_id",
        "session_permissions",
        ["user_id"],
        postgresql_where=sa.text("user_id IS NOT NULL"),
    )

    # Pending-invite reconciliation at signup ("did anyone invite this
    # email before they had an account?").
    op.create_index(
        "ix_session_permissions_email_pending",
        "session_permissions",
        ["email"],
        postgresql_where=sa.text(
            "email IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL"
        ),
    )

    # At most one ACTIVE permission per (session, kind, identifier).
    # COALESCE collapses the two identifier columns into one comparable
    # string. kind='link' rows have NULL for both → COALESCE returns
    # '' → at most one link permission per session, exactly what the
    # toggle UI expects.
    op.create_index(
        "uq_active_permission_per_principal",
        "session_permissions",
        [
            "session_id",
            "kind",
            sa.text("COALESCE(user_id::text, email, '')"),
        ],
        unique=True,
        postgresql_where=sa.text("revoked_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_active_permission_per_principal", table_name="session_permissions")
    op.drop_index("ix_session_permissions_email_pending", table_name="session_permissions")
    op.drop_index("ix_session_permissions_user_id", table_name="session_permissions")
    op.drop_index("ix_session_permissions_session_id", table_name="session_permissions")
    op.drop_table("session_permissions")
