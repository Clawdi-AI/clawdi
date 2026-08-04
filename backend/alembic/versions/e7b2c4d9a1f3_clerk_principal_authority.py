"""Add the current reversible Clerk principal authority projection.

Revision ID: e7b2c4d9a1f3
Revises: d1e5f7a9b3c2
Create Date: 2026-08-04 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "e7b2c4d9a1f3"
down_revision: str | Sequence[str] | None = "d1e5f7a9b3c2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "clerk_principal_authorities",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("issuer", sa.String(length=255), nullable=False),
        sa.Column("subject", sa.String(length=200), nullable=False),
        sa.Column("banned", sa.Boolean(), nullable=False),
        sa.Column("authority_updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("message_id", sa.String(length=191), nullable=False),
        sa.Column("payload_sha256", sa.String(length=64), nullable=False),
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
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "issuer",
            "subject",
            name="uq_clerk_principal_authorities_external_identity",
        ),
    )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.execute(
        sa.text(
            "SELECT count(*) FROM clerk_principal_authorities AS authority "
            "WHERE authority.banned AND NOT EXISTS ("
            "SELECT 1 FROM principal_lifecycles AS lifecycle "
            "WHERE lifecycle.issuer = authority.issuer "
            "AND lifecycle.subject = authority.subject)"
        )
    ).scalar_one():
        raise RuntimeError("cannot downgrade while Clerk ban authority is active")
    op.drop_table("clerk_principal_authorities")
