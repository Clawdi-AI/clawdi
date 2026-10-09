"""Retire mutable session grants; immutable snapshot shares remain.

Revision ID: d5f9a2b7c813
Revises: c4a8e2d6f913
Create Date: 2026-10-09

Existing live links intentionally stop working. Downgrade restores only the
empty schema, never the removed access grants.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d5f9a2b7c813"
down_revision: str | Sequence[str] | None = "c4a8e2d6f913"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_table("session_permissions")


def downgrade() -> None:
    op.create_table(
        "session_permissions",
        sa.Column("id", sa.dialects.postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "session_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column(
            "user_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("email", sa.String(320), nullable=True),
        sa.Column("role", sa.String(32), nullable=False, server_default="viewer"),
        sa.Column(
            "invited_by",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.CheckConstraint("kind IN ('link', 'user', 'email')", name="ck_session_permissions_kind"),
        sa.CheckConstraint("role IN ('viewer')", name="ck_session_permissions_role"),
    )
    op.create_index("ix_session_permissions_session_id", "session_permissions", ["session_id"])
    op.create_index(
        "ix_session_permissions_user_id",
        "session_permissions",
        ["user_id"],
        postgresql_where=sa.text("user_id IS NOT NULL"),
    )
    op.create_index(
        "ix_session_permissions_email_pending",
        "session_permissions",
        ["email"],
        postgresql_where=sa.text(
            "email IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL"
        ),
    )
    op.create_index(
        "uq_active_permission_per_principal",
        "session_permissions",
        ["session_id", "kind", sa.text("COALESCE(user_id::text, email, '')")],
        unique=True,
        postgresql_where=sa.text("revoked_at IS NULL"),
    )
