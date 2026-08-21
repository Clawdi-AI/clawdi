"""Add the independent reversible Clerk principal suspension fence.

Revision ID: 2e6a9c4f1b7d
Revises: d1a4e7c9b2f6
Create Date: 2026-08-21 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "2e6a9c4f1b7d"
down_revision: str | Sequence[str] | None = "d1a4e7c9b2f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "clerk_principal_suspensions",
        sa.Column("issuer", sa.String(length=255), nullable=False),
        sa.Column("subject", sa.String(length=200), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("suspended_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reason", sa.String(length=191), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("issuer", "subject"),
        sa.UniqueConstraint(
            "user_id",
            name="uq_clerk_principal_suspensions_user_id",
        ),
    )
    op.create_index(
        "ix_clerk_principal_suspensions_user_id",
        "clerk_principal_suspensions",
        ["user_id"],
    )


def downgrade() -> None:
    bind = op.get_bind()
    uncovered = bind.execute(
        sa.text(
            "SELECT count(*) FROM clerk_principal_suspensions AS suspension "
            "WHERE NOT EXISTS ("
            "SELECT 1 FROM principal_lifecycles AS lifecycle "
            "WHERE lifecycle.issuer = suspension.issuer "
            "AND lifecycle.subject = suspension.subject)"
        )
    ).scalar_one()
    if uncovered:
        raise RuntimeError("cannot downgrade while platform suspensions are active")
    op.drop_index(
        "ix_clerk_principal_suspensions_user_id",
        table_name="clerk_principal_suspensions",
    )
    op.drop_table("clerk_principal_suspensions")
