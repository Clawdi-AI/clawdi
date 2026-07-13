"""separate hosted runtime CONFIG observations

Revision ID: f1a7c3d9e2b4
Revises: f3a6c9d2e5b8
Create Date: 2026-07-13 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "f1a7c3d9e2b4"
down_revision: str | Sequence[str] | None = "f3a6c9d2e5b8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("LOCK TABLE hosted_runtime_states IN ACCESS EXCLUSIVE MODE"))
    op.create_table(
        "hosted_runtime_config_observations",
        sa.Column("environment_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("reported_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=True),
        sa.Column("observed_config_generation", sa.Integer(), nullable=True),
        sa.Column("instance_id", sa.String(length=200), nullable=True),
        sa.Column("observed_manifest_etag", sa.String(length=1024), nullable=True),
        sa.Column("observed_channels_etag", sa.String(length=1024), nullable=True),
        sa.Column(
            "payload",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.CheckConstraint(
            "status IS NULL OR status IN ('ok', 'error', 'unknown')",
            name="ck_hosted_runtime_config_observations_status",
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
    bind.execute(
        sa.text(
            """
            INSERT INTO hosted_runtime_config_observations (environment_id, payload)
            SELECT environment_id, observed
            FROM hosted_runtime_states
            WHERE observed IS NOT NULL
            """
        )
    )
    op.drop_column("hosted_runtime_states", "observed")


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("LOCK TABLE hosted_runtime_states IN ACCESS EXCLUSIVE MODE"))
    bind.execute(sa.text("LOCK TABLE hosted_runtime_config_observations IN ACCESS EXCLUSIVE MODE"))
    op.add_column(
        "hosted_runtime_states",
        sa.Column(
            "observed",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )
    bind.execute(
        sa.text(
            """
            UPDATE hosted_runtime_states AS state
            SET observed = observation.payload
            FROM hosted_runtime_config_observations AS observation
            WHERE observation.environment_id = state.environment_id
            """
        )
    )
    op.drop_table("hosted_runtime_config_observations")
