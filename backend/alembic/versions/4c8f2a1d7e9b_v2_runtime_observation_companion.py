"""Add the v2 runtime observation companion schema.

Revision ID: 4c8f2a1d7e9b
Revises: c7e4a9b2d6f1
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "4c8f2a1d7e9b"
down_revision: str | Sequence[str] | None = "c7e4a9b2d6f1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "v2_runtime_environment_fences",
        sa.Column("environment_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("owner_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("deployment_id", sa.String(length=200), nullable=False),
        sa.Column("state", sa.String(length=16), server_default="active", nullable=False),
        sa.Column("stream_high_water", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("retirement_id", sa.String(length=200), nullable=True),
        sa.Column("retirement_receipt_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "retirement_receipt",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column("retired_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("final_cursor", sa.String(length=2000), nullable=True),
        sa.Column("final_stream_position", sa.BigInteger(), nullable=True),
        sa.Column(
            "final_session_high_waters",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
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
        sa.CheckConstraint(
            "state IN ('active', 'retired')",
            name="ck_v2_runtime_environment_fences_state",
        ),
        sa.CheckConstraint(
            "stream_high_water >= 0",
            name="ck_v2_runtime_environment_fences_stream_high_water",
        ),
        sa.CheckConstraint(
            "(state = 'active' AND retirement_id IS NULL "
            "AND retirement_receipt_id IS NULL AND retirement_receipt IS NULL "
            "AND retired_at IS NULL AND final_cursor IS NULL "
            "AND final_stream_position IS NULL AND final_session_high_waters IS NULL) "
            "OR (state = 'retired' AND retirement_id IS NOT NULL "
            "AND retirement_receipt_id IS NOT NULL AND retirement_receipt IS NOT NULL "
            "AND retired_at IS NOT NULL AND final_cursor IS NOT NULL "
            "AND final_stream_position IS NOT NULL "
            "AND final_session_high_waters IS NOT NULL)",
            name="ck_v2_runtime_environment_fences_retirement",
        ),
        sa.PrimaryKeyConstraint("environment_id"),
        sa.UniqueConstraint(
            "environment_id",
            "deployment_id",
            name="uq_v2_runtime_environment_fences_binding",
        ),
    )
    op.create_index(
        op.f("ix_v2_runtime_environment_fences_owner_id"),
        "v2_runtime_environment_fences",
        ["owner_id"],
    )
    op.create_index(
        op.f("ix_v2_runtime_environment_fences_deployment_id"),
        "v2_runtime_environment_fences",
        ["deployment_id"],
    )

    op.create_table(
        "v2_runtime_observation_inbox",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("environment_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("deployment_id", sa.String(length=200), nullable=False),
        sa.Column("generation", sa.BigInteger(), nullable=False),
        sa.Column("manifest_etag", sa.String(length=1024), nullable=False),
        sa.Column("apply_receipt_id", sa.String(length=128), nullable=False),
        sa.Column("boot_nonce", sa.String(length=128), nullable=False),
        sa.Column("boot_session_id", sa.String(length=128), nullable=False),
        sa.Column("sequence", sa.BigInteger(), nullable=False),
        sa.Column("event_id", sa.String(length=128), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "received_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("freshness_deadline", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload_hash", sa.String(length=64), nullable=False),
        sa.Column("health", sa.String(length=16), nullable=False),
        sa.Column(
            "diagnostics",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.CheckConstraint(
            "generation > 0",
            name="ck_v2_runtime_observation_inbox_generation",
        ),
        sa.CheckConstraint(
            "sequence > 0 AND sequence <= 9007199254740991",
            name="ck_v2_runtime_observation_inbox_sequence",
        ),
        sa.CheckConstraint(
            "health IN ('ok', 'error', 'unknown')",
            name="ck_v2_runtime_observation_inbox_health",
        ),
        sa.CheckConstraint(
            "payload_hash ~ '^[0-9a-f]{64}$'",
            name="ck_v2_runtime_observation_inbox_payload_hash",
        ),
        sa.ForeignKeyConstraint(
            ["environment_id", "deployment_id"],
            [
                "v2_runtime_environment_fences.environment_id",
                "v2_runtime_environment_fences.deployment_id",
            ],
            name="fk_v2_runtime_observation_inbox_fence_binding",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "environment_id",
            "boot_session_id",
            "sequence",
            name="uq_v2_runtime_observation_inbox_session_sequence",
        ),
        sa.UniqueConstraint(
            "event_id",
            name="uq_v2_runtime_observation_inbox_event_id",
        ),
    )
    op.create_index(
        "ix_v2_runtime_observation_inbox_environment_stream",
        "v2_runtime_observation_inbox",
        ["environment_id", "id"],
    )
    op.create_index(
        "ix_v2_runtime_observation_inbox_received_at",
        "v2_runtime_observation_inbox",
        ["received_at"],
    )

    op.create_table(
        "v2_runtime_observation_heads",
        sa.Column("environment_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("boot_session_id", sa.String(length=128), nullable=False),
        sa.Column("deployment_id", sa.String(length=200), nullable=False),
        sa.Column("generation", sa.BigInteger(), nullable=False),
        sa.Column("manifest_etag", sa.String(length=1024), nullable=False),
        sa.Column("apply_receipt_id", sa.String(length=128), nullable=False),
        sa.Column("boot_nonce", sa.String(length=128), nullable=False),
        sa.Column("highest_sequence", sa.BigInteger(), nullable=False),
        sa.Column("latest_inbox_id", sa.BigInteger(), nullable=True),
        sa.Column("latest_stream_position", sa.BigInteger(), nullable=False),
        sa.Column("latest_event_id", sa.String(length=128), nullable=False),
        sa.Column("latest_payload_hash", sa.String(length=64), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("freshness_deadline", sa.DateTime(timezone=True), nullable=True),
        sa.Column("health", sa.String(length=16), nullable=True),
        sa.Column("state", sa.String(length=16), server_default="active", nullable=False),
        sa.Column("tombstoned_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.CheckConstraint(
            "generation > 0",
            name="ck_v2_runtime_observation_heads_generation",
        ),
        sa.CheckConstraint(
            "highest_sequence > 0 AND highest_sequence <= 9007199254740991",
            name="ck_v2_runtime_observation_heads_sequence",
        ),
        sa.CheckConstraint(
            "state IN ('active', 'retired')",
            name="ck_v2_runtime_observation_heads_state",
        ),
        sa.CheckConstraint(
            "health IS NULL OR health IN ('ok', 'error', 'unknown')",
            name="ck_v2_runtime_observation_heads_health",
        ),
        sa.CheckConstraint(
            "(state = 'active' AND latest_event_id IS NOT NULL "
            "AND captured_at IS NOT NULL AND freshness_deadline IS NOT NULL "
            "AND health IS NOT NULL AND tombstoned_at IS NULL) "
            "OR (state = 'retired' AND latest_inbox_id IS NULL "
            "AND latest_event_id IS NOT NULL AND captured_at IS NULL "
            "AND freshness_deadline IS NULL AND health IS NULL "
            "AND tombstoned_at IS NOT NULL)",
            name="ck_v2_runtime_observation_heads_lifecycle",
        ),
        sa.ForeignKeyConstraint(
            ["environment_id", "deployment_id"],
            [
                "v2_runtime_environment_fences.environment_id",
                "v2_runtime_environment_fences.deployment_id",
            ],
            name="fk_v2_runtime_observation_heads_fence_binding",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["latest_inbox_id"],
            ["v2_runtime_observation_inbox.id"],
            name="fk_v2_runtime_observation_heads_latest_inbox",
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("environment_id", "boot_session_id"),
    )

    op.create_table(
        "v2_runtime_observation_consumer_cursors",
        sa.Column("environment_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("consumer_id", sa.String(length=200), nullable=False),
        sa.Column("deployment_id", sa.String(length=200), nullable=False),
        sa.Column("required", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("cursor_epoch", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("state", sa.String(length=16), server_default="active", nullable=False),
        sa.Column("acked_cursor", sa.String(length=2000), nullable=False),
        sa.Column("acked_stream_position", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("acknowledged_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "replay_horizon_started_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("expired_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expiry_boundary_stream_position", sa.BigInteger(), nullable=True),
        sa.Column("expiry_boundary_cursor", sa.String(length=2000), nullable=True),
        sa.Column(
            "expiry_session_high_waters",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column("reset_barrier_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reset_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.CheckConstraint(
            "state IN ('active', 'expired')",
            name="ck_v2_runtime_observation_consumer_cursors_state",
        ),
        sa.CheckConstraint(
            "acked_stream_position >= 0",
            name="ck_v2_runtime_observation_consumer_cursors_acked_position",
        ),
        sa.CheckConstraint(
            "(state = 'active' AND expired_at IS NULL) "
            "OR (state = 'expired' AND expired_at IS NOT NULL "
            "AND expiry_boundary_stream_position IS NOT NULL "
            "AND expiry_boundary_cursor IS NOT NULL "
            "AND expiry_session_high_waters IS NOT NULL "
            "AND reset_barrier_at IS NOT NULL)",
            name="ck_v2_runtime_observation_consumer_cursors_expiry",
        ),
        sa.ForeignKeyConstraint(
            ["environment_id", "deployment_id"],
            [
                "v2_runtime_environment_fences.environment_id",
                "v2_runtime_environment_fences.deployment_id",
            ],
            name="fk_v2_runtime_observation_consumer_cursors_fence_binding",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("environment_id", "consumer_id"),
    )
    op.create_index(
        "ix_v2_runtime_observation_consumer_cursors_retention",
        "v2_runtime_observation_consumer_cursors",
        ["environment_id", "required", "state", "acked_stream_position"],
    )

    op.drop_constraint(
        "ck_platform_workload_clients_allowed_scopes",
        "platform_workload_clients",
        type_="check",
    )
    op.create_check_constraint(
        "ck_platform_workload_clients_allowed_scopes",
        "platform_workload_clients",
        "cardinality(allowed_scopes) > 0 AND allowed_scopes <@ "
        "ARRAY['platform:agents:create','platform:agents:delete',"
        "'platform:runtime-state:write','platform:keys:mint',"
        "'platform:keys:revoke','platform:runtime-observations:read']::varchar[]",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_platform_workload_clients_allowed_scopes",
        "platform_workload_clients",
        type_="check",
    )
    op.create_check_constraint(
        "ck_platform_workload_clients_allowed_scopes",
        "platform_workload_clients",
        "cardinality(allowed_scopes) > 0 AND allowed_scopes <@ "
        "ARRAY['platform:agents:create','platform:agents:delete',"
        "'platform:runtime-state:write','platform:keys:mint',"
        "'platform:keys:revoke']::varchar[]",
    )
    op.drop_index(
        "ix_v2_runtime_observation_consumer_cursors_retention",
        table_name="v2_runtime_observation_consumer_cursors",
    )
    op.drop_table("v2_runtime_observation_consumer_cursors")
    op.drop_table("v2_runtime_observation_heads")
    op.drop_index(
        "ix_v2_runtime_observation_inbox_received_at",
        table_name="v2_runtime_observation_inbox",
    )
    op.drop_index(
        "ix_v2_runtime_observation_inbox_environment_stream",
        table_name="v2_runtime_observation_inbox",
    )
    op.drop_table("v2_runtime_observation_inbox")
    op.drop_index(
        op.f("ix_v2_runtime_environment_fences_deployment_id"),
        table_name="v2_runtime_environment_fences",
    )
    op.drop_index(
        op.f("ix_v2_runtime_environment_fences_owner_id"),
        table_name="v2_runtime_environment_fences",
    )
    op.drop_table("v2_runtime_environment_fences")
