"""Add issuer-scoped principal termination fences.

Revision ID: c9f4e2a7b1d6
Revises: d7f3a1c9e5b2
Create Date: 2026-08-02 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "c9f4e2a7b1d6"
down_revision: str | Sequence[str] | None = "d7f3a1c9e5b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_WORKLOAD_SCOPE_CHECK = (
    "cardinality(allowed_scopes) > 0 AND allowed_scopes <@ "
    "ARRAY['platform:agents:create','platform:agents:delete',"
    "'platform:runtime-state:write','platform:keys:mint',"
    "'platform:keys:revoke','platform:runtime-observations:consume',"
    "'platform:runtime-environments:retire',"
    "'platform:principals:terminate']::varchar[]"
)
_PREVIOUS_WORKLOAD_SCOPE_CHECK = (
    "cardinality(allowed_scopes) > 0 AND allowed_scopes <@ "
    "ARRAY['platform:agents:create','platform:agents:delete',"
    "'platform:runtime-state:write','platform:keys:mint',"
    "'platform:keys:revoke','platform:runtime-observations:consume',"
    "'platform:runtime-environments:retire']::varchar[]"
)


def upgrade() -> None:
    op.add_column("users", sa.Column("clerk_issuer", sa.String(length=255), nullable=True))
    op.drop_constraint("ck_users_principal_identity", "users", type_="check")
    op.create_check_constraint(
        "ck_users_principal_identity",
        "users",
        "(principal_kind = 'clerk' AND clerk_id IS NOT NULL "
        "AND partner_tenant_ref IS NULL) OR "
        "(principal_kind = 'partner_tenant' AND clerk_id IS NULL "
        "AND clerk_issuer IS NULL AND partner_tenant_ref IS NOT NULL)",
    )

    op.create_table(
        "principal_lifecycles",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("issuer", sa.String(length=255), nullable=False),
        sa.Column("subject", sa.String(length=200), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("current_revision", sa.BigInteger(), nullable=False),
        sa.Column("terminated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("cleanup_attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("cleanup_completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("next_cleanup_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cleanup_claim_id", sa.String(length=64), nullable=True),
        sa.Column("cleanup_claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint("current_revision >= 1", name="ck_principal_lifecycles_revision"),
        sa.CheckConstraint(
            "cleanup_attempts >= 0", name="ck_principal_lifecycles_cleanup_attempts"
        ),
        sa.CheckConstraint(
            "(cleanup_completed_at IS NULL AND next_cleanup_attempt_at IS NOT NULL "
            "AND ((cleanup_claim_id IS NULL AND cleanup_claimed_at IS NULL) OR "
            "(cleanup_claim_id IS NOT NULL AND cleanup_claimed_at IS NOT NULL))) OR "
            "(cleanup_completed_at IS NOT NULL AND next_cleanup_attempt_at IS NULL "
            "AND cleanup_claim_id IS NULL AND cleanup_claimed_at IS NULL)",
            name="ck_principal_lifecycles_cleanup",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "issuer",
            "subject",
            name="uq_principal_lifecycles_external_identity",
        ),
        sa.UniqueConstraint("user_id", name="uq_principal_lifecycles_user_id"),
    )
    op.create_index("ix_principal_lifecycles_user_id", "principal_lifecycles", ["user_id"])
    op.create_index(
        "ix_principal_lifecycles_cleanup_due",
        "principal_lifecycles",
        ["next_cleanup_attempt_at"],
        postgresql_where=sa.text("cleanup_completed_at IS NULL"),
    )
    op.create_table(
        "principal_lifecycle_commands",
        sa.Column("command_id", sa.String(length=191), nullable=False),
        sa.Column("lifecycle_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("requested_revision", sa.BigInteger(), nullable=False),
        sa.Column("accepted_revision", sa.BigInteger(), nullable=False),
        sa.Column("advanced", sa.Boolean(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
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

    op.drop_constraint(
        "ck_platform_workload_clients_allowed_scopes",
        "platform_workload_clients",
        type_="check",
    )
    op.create_check_constraint(
        "ck_platform_workload_clients_allowed_scopes",
        "platform_workload_clients",
        _WORKLOAD_SCOPE_CHECK,
    )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.execute(sa.text("SELECT count(*) FROM principal_lifecycles")).scalar_one():
        raise RuntimeError("cannot downgrade while principal lifecycle fences exist")
    if bind.execute(
        sa.text(
            "SELECT count(*) FROM platform_workload_clients "
            "WHERE 'platform:principals:terminate' = ANY(allowed_scopes)"
        )
    ).scalar_one():
        raise RuntimeError("cannot downgrade while principal-termination workload grants exist")

    op.drop_constraint(
        "ck_platform_workload_clients_allowed_scopes",
        "platform_workload_clients",
        type_="check",
    )
    op.create_check_constraint(
        "ck_platform_workload_clients_allowed_scopes",
        "platform_workload_clients",
        _PREVIOUS_WORKLOAD_SCOPE_CHECK,
    )
    op.drop_index(
        "ix_principal_lifecycle_commands_lifecycle_id",
        table_name="principal_lifecycle_commands",
    )
    op.drop_table("principal_lifecycle_commands")
    op.drop_index("ix_principal_lifecycles_cleanup_due", table_name="principal_lifecycles")
    op.drop_index("ix_principal_lifecycles_user_id", table_name="principal_lifecycles")
    op.drop_table("principal_lifecycles")
    op.drop_constraint("ck_users_principal_identity", "users", type_="check")
    op.create_check_constraint(
        "ck_users_principal_identity",
        "users",
        "(principal_kind = 'clerk' AND clerk_id IS NOT NULL "
        "AND partner_tenant_ref IS NULL) OR "
        "(principal_kind = 'partner_tenant' AND clerk_id IS NULL "
        "AND partner_tenant_ref IS NOT NULL)",
    )
    op.drop_column("users", "clerk_issuer")
