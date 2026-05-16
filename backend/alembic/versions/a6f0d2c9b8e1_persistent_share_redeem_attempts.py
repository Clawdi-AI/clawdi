"""Persistent share redeem attempts.

Revision ID: a6f0d2c9b8e1
Revises: f4d7b3c8a9e1
Create Date: 2026-05-16 09:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a6f0d2c9b8e1"
down_revision: str | None = "f4d7b3c8a9e1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "share_redeem_attempts",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "link_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("project_share_links.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("client_key", sa.String(128), nullable=False),
        sa.Column("idempotency_key", sa.String(200)),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.UniqueConstraint(
            "link_id",
            "idempotency_key",
            name="uq_share_redeem_attempts_link_idempotency",
        ),
    )
    op.create_index(
        "ix_share_redeem_attempts_link_client_created",
        "share_redeem_attempts",
        ["link_id", "client_key", "created_at"],
    )
    op.create_index(
        "ix_share_redeem_attempts_created_at",
        "share_redeem_attempts",
        ["created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_share_redeem_attempts_created_at", "share_redeem_attempts")
    op.drop_index("ix_share_redeem_attempts_link_client_created", "share_redeem_attempts")
    op.drop_table("share_redeem_attempts")
