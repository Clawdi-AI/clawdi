"""hosted runtime states

Revision ID: 5f3a9d2c8e10
Revises: 2d4c8e1b7a90
Create Date: 2026-06-10 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "5f3a9d2c8e10"
down_revision: str | Sequence[str] | None = "2d4c8e1b7a90"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "hosted_runtime_states",
        sa.Column("environment_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("deployment_id", sa.String(length=200), nullable=False),
        sa.Column("app_id", sa.String(length=200), nullable=True),
        sa.Column("instance_id", sa.String(length=200), nullable=False),
        sa.Column("generation", sa.Integer(), nullable=False),
        sa.Column("provider_id", sa.String(length=80), nullable=True),
        sa.Column("system", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("control_plane", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("clawdi_cli", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("runtimes", postgresql.JSONB(none_as_null=True), nullable=False),
        sa.Column("live_sync", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("recovery", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("mitm_profiles", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.ForeignKeyConstraint(
            ["environment_id"],
            ["agent_environments.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("environment_id"),
    )


def downgrade() -> None:
    op.drop_table("hosted_runtime_states")
