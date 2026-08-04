"""Replace principal bridge commands with direct Clerk event receipts.

Revision ID: d1e5f7a9b3c2
Revises: c9f4e2a7b1d6
Create Date: 2026-08-04 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "d1e5f7a9b3c2"
down_revision: str | Sequence[str] | None = "c9f4e2a7b1d6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_WORKLOAD_SCOPE_CHECK = (
    "cardinality(allowed_scopes) > 0 AND allowed_scopes <@ "
    "ARRAY['platform:agents:create','platform:agents:delete',"
    "'platform:runtime-state:write','platform:keys:mint',"
    "'platform:keys:revoke','platform:runtime-observations:consume',"
    "'platform:runtime-environments:retire']::varchar[]"
)
_LEGACY_WORKLOAD_SCOPE_CHECK = (
    # Downgrade restores the old schema vocabulary, not deleted clients or the
    # retired grant on mixed-scope clients.
    "cardinality(allowed_scopes) > 0 AND allowed_scopes <@ "
    "ARRAY['platform:agents:create','platform:agents:delete',"
    "'platform:runtime-state:write','platform:keys:mint',"
    "'platform:keys:revoke','platform:runtime-observations:consume',"
    "'platform:runtime-environments:retire',"
    "'platform:principals:terminate']::varchar[]"
)


def upgrade() -> None:
    op.create_table(
        "clerk_webhook_event_receipts",
        sa.Column("message_id", sa.String(length=191), nullable=False),
        sa.Column("lifecycle_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("receipt_source", sa.String(length=32), nullable=False),
        sa.Column("event_type", sa.String(length=32), nullable=False),
        sa.Column("payload_sha256", sa.String(length=64), nullable=True),
        sa.Column("event_occurred_at", sa.DateTime(timezone=True), nullable=False),
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
            "receipt_source IN ('clerk', 'legacy_platform_bridge')",
            name="ck_clerk_webhook_event_receipts_source",
        ),
        sa.CheckConstraint(
            "event_type = 'user.deleted'",
            name="ck_clerk_webhook_event_receipts_type",
        ),
        sa.CheckConstraint(
            "(receipt_source = 'clerk' AND length(payload_sha256) = 64) OR "
            "(receipt_source = 'legacy_platform_bridge' AND payload_sha256 IS NULL)",
            name="ck_clerk_webhook_event_receipts_payload",
        ),
        sa.ForeignKeyConstraint(
            ["lifecycle_id"],
            ["principal_lifecycles.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("message_id"),
    )
    op.create_index(
        "ix_clerk_webhook_event_receipts_lifecycle_id",
        "clerk_webhook_event_receipts",
        ["lifecycle_id"],
    )
    op.execute(
        sa.text(
            "INSERT INTO clerk_webhook_event_receipts "
            "(message_id, lifecycle_id, receipt_source, event_type, "
            "payload_sha256, event_occurred_at, created_at, updated_at) "
            "SELECT command_id, legacy_command.lifecycle_id, 'legacy_platform_bridge', "
            "'user.deleted', NULL, lifecycle.terminated_at, "
            "legacy_command.created_at, legacy_command.updated_at "
            "FROM principal_lifecycle_commands AS legacy_command "
            "JOIN principal_lifecycles AS lifecycle "
            "ON lifecycle.id = legacy_command.lifecycle_id"
        )
    )
    op.drop_index(
        "ix_principal_lifecycle_commands_lifecycle_id",
        table_name="principal_lifecycle_commands",
    )
    op.drop_table("principal_lifecycle_commands")
    op.drop_constraint(
        "ck_principal_lifecycles_revision",
        "principal_lifecycles",
        type_="check",
    )
    op.drop_column("principal_lifecycles", "current_revision")

    op.drop_constraint(
        "ck_platform_workload_clients_allowed_scopes",
        "platform_workload_clients",
        type_="check",
    )
    # The only dependent table is platform_workload_assertion_replays, whose
    # client_id FK is ON DELETE CASCADE. A sole-purpose bridge client therefore
    # has no remaining authority or credential use and can be retired together
    # with its replay evidence. Signing keys are independent of client rows.
    op.execute(
        sa.text(
            "DELETE FROM platform_workload_clients WHERE allowed_scopes <@ "
            "ARRAY['platform:principals:terminate']::varchar[]"
        )
    )
    op.execute(
        sa.text(
            "UPDATE platform_workload_clients SET allowed_scopes = "
            "array_remove(allowed_scopes, 'platform:principals:terminate') "
            "WHERE 'platform:principals:terminate' = ANY(allowed_scopes)"
        )
    )
    op.create_check_constraint(
        "ck_platform_workload_clients_allowed_scopes",
        "platform_workload_clients",
        _WORKLOAD_SCOPE_CHECK,
    )


def downgrade() -> None:
    bind = op.get_bind()
    direct_receipts = bind.execute(
        sa.text("SELECT count(*) FROM clerk_webhook_event_receipts WHERE receipt_source = 'clerk'")
    ).scalar_one()
    if direct_receipts:
        raise RuntimeError("cannot downgrade after direct Clerk webhook evidence has been accepted")

    op.drop_constraint(
        "ck_platform_workload_clients_allowed_scopes",
        "platform_workload_clients",
        type_="check",
    )
    op.create_check_constraint(
        "ck_platform_workload_clients_allowed_scopes",
        "platform_workload_clients",
        _LEGACY_WORKLOAD_SCOPE_CHECK,
    )

    op.add_column(
        "principal_lifecycles",
        sa.Column("current_revision", sa.BigInteger(), server_default="1", nullable=False),
    )
    op.alter_column("principal_lifecycles", "current_revision", server_default=None)
    op.create_check_constraint(
        "ck_principal_lifecycles_revision",
        "principal_lifecycles",
        "current_revision >= 1",
    )
    op.create_table(
        "principal_lifecycle_commands",
        sa.Column("command_id", sa.String(length=191), nullable=False),
        sa.Column("lifecycle_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("requested_revision", sa.BigInteger(), nullable=False),
        sa.Column("accepted_revision", sa.BigInteger(), nullable=False),
        sa.Column("advanced", sa.Boolean(), nullable=False),
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
            "requested_revision >= 1 AND accepted_revision >= requested_revision",
            name="ck_principal_lifecycle_commands_revisions",
        ),
        sa.ForeignKeyConstraint(
            ["lifecycle_id"],
            ["principal_lifecycles.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("command_id"),
    )
    op.create_index(
        "ix_principal_lifecycle_commands_lifecycle_id",
        "principal_lifecycle_commands",
        ["lifecycle_id"],
    )
    op.execute(
        sa.text(
            "INSERT INTO principal_lifecycle_commands "
            "(command_id, lifecycle_id, requested_revision, accepted_revision, "
            "advanced, created_at, updated_at) "
            "SELECT message_id, lifecycle_id, 1, 1, false, created_at, updated_at "
            "FROM clerk_webhook_event_receipts"
        )
    )
    op.drop_index(
        "ix_clerk_webhook_event_receipts_lifecycle_id",
        table_name="clerk_webhook_event_receipts",
    )
    op.drop_table("clerk_webhook_event_receipts")
