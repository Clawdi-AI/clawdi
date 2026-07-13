"""Finalize the unpublished Agent v2 schema.

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


def _require_empty(table_name: str) -> None:
    has_rows = (
        op.get_bind().execute(sa.text(f"SELECT EXISTS (SELECT 1 FROM {table_name})")).scalar_one()
    )
    if has_rows:
        raise RuntimeError(
            f"{table_name} must be empty before finalizing the unpublished Agent v2 schema"
        )


def upgrade() -> None:
    _require_empty("hosted_runtime_states")
    op.drop_column("ai_providers", "scope")
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
    op.drop_column("hosted_runtime_states", "observed")
    op.drop_column("hosted_runtime_states", "app_id")


def downgrade() -> None:
    _require_empty("hosted_runtime_states")
    _require_empty("hosted_runtime_config_observations")
    op.add_column(
        "hosted_runtime_states",
        sa.Column("app_id", sa.String(length=200), nullable=True),
    )
    op.add_column(
        "hosted_runtime_states",
        sa.Column(
            "observed",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )
    op.drop_table("hosted_runtime_config_observations")
    op.add_column(
        "ai_providers",
        sa.Column(
            "scope",
            sa.String(length=40),
            server_default="account_global",
            nullable=False,
        ),
    )
