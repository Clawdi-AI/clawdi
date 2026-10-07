"""remove retired device_authorizations

Revision ID: b1c7d9e4f2a6
Revises: a8c4f2d9e610
Create Date: 2026-10-07

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b1c7d9e4f2a6"
down_revision: str | Sequence[str] | None = "a8c4f2d9e610"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Drop the table used only by the retired browser device flow."""
    op.drop_table("device_authorizations")


def downgrade() -> None:
    """Restore the legacy table when explicitly downgrading past retirement."""
    op.create_table(
        "device_authorizations",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("device_code", sa.String(length=64), nullable=False),
        sa.Column("user_code", sa.String(length=16), nullable=False),
        sa.Column("client_label", sa.String(length=200), nullable=True),
        sa.Column("status", sa.String(length=16), server_default="pending", nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=True),
        sa.Column("api_key_id", sa.UUID(), nullable=True),
        sa.Column("api_key_raw", sa.Text(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
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
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_device_authorizations_device_code"),
        "device_authorizations",
        ["device_code"],
        unique=True,
    )
    op.create_index(
        op.f("ix_device_authorizations_user_code"),
        "device_authorizations",
        ["user_code"],
        unique=True,
    )
