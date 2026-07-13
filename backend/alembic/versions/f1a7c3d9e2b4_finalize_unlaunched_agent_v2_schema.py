"""Add Agent v2 runtime config observations without contracting live columns.

Revision ID: f1a7c3d9e2b4
Revises: f3a1c7d9e2b4
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "f1a7c3d9e2b4"
down_revision: str | Sequence[str] | None = "f3a1c7d9e2b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "hosted_runtime_config_observations",
        sa.Column("environment_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("observed_config_generation", sa.Integer(), nullable=True),
        sa.Column("observed_manifest_etag", sa.String(length=1024), nullable=True),
        sa.Column("observed_source_revision", sa.String(length=64), nullable=True),
        sa.Column(
            "diagnostics",
            postgresql.JSONB(astext_type=sa.Text()),
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
        sa.CheckConstraint(
            "observed_config_generation IS NULL OR observed_config_generation >= 0",
            name="ck_hosted_runtime_config_observations_generation",
        ),
        sa.ForeignKeyConstraint(
            ["environment_id"],
            ["hosted_runtime_states.environment_id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("environment_id"),
    )


def downgrade() -> None:
    op.drop_table("hosted_runtime_config_observations")
