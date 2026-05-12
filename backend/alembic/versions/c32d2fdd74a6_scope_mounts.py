"""scope mounts

Revision ID: c32d2fdd74a6
Revises: b8e4d1c6f23a
Create Date: 2026-05-12 00:14:26.795912

DDL-only migration. Adds the scope_mounts composition table on top
of the existing membership tables. No row-level data migrations.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "c32d2fdd74a6"
down_revision: str | Sequence[str] | None = "b8e4d1c6f23a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "scope_mounts",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
        ),
        sa.Column(
            "parent_scope_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("scopes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "source_scope_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("scopes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("alias", sa.String(length=80), nullable=False),
        sa.Column(
            "mode",
            sa.String(length=20),
            nullable=False,
            server_default="live",
        ),
        sa.Column(
            "created_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "parent_scope_id",
            "source_scope_id",
            name="uq_scope_mounts_parent_source",
        ),
        sa.UniqueConstraint(
            "parent_scope_id",
            "alias",
            name="uq_scope_mounts_parent_alias",
        ),
        sa.CheckConstraint("mode IN ('live')", name="ck_scope_mounts_mode_v2"),
    )
    op.create_index(
        "ix_scope_mounts_parent",
        "scope_mounts",
        ["parent_scope_id"],
    )
    op.create_index(
        "ix_scope_mounts_source",
        "scope_mounts",
        ["source_scope_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_scope_mounts_source", "scope_mounts")
    op.drop_index("ix_scope_mounts_parent", "scope_mounts")
    op.drop_table("scope_mounts")
