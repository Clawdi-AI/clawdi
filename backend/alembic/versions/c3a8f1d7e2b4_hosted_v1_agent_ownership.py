"""Add durable Hosted V1 Agent ownership.

Revision ID: c3a8f1d7e2b4
Revises: b7e1c4a9d2f6
Create Date: 2026-08-13 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "c3a8f1d7e2b4"
down_revision: str | Sequence[str] | None = "b7e1c4a9d2f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "hosted_v1_agent_ownerships",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("environment_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("api_key_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("deployment_id", sa.String(length=200), nullable=False),
        sa.Column("agent_type", sa.String(length=50), nullable=False),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("archive_reason", sa.String(length=32), nullable=True),
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
        sa.CheckConstraint(
            "agent_type IN ('hermes', 'openclaw')",
            name="ck_hosted_v1_agent_ownerships_agent_type",
        ),
        sa.CheckConstraint(
            "(archived_at IS NULL) = (archive_reason IS NULL)",
            name="ck_hosted_v1_agent_ownerships_archive_state",
        ),
        sa.CheckConstraint(
            "archive_reason IS NULL OR archive_reason IN "
            "('released', 'replaced', 'agent_archived')",
            name="ck_hosted_v1_agent_ownerships_archive_reason",
        ),
        sa.ForeignKeyConstraint(
            ["environment_id"],
            ["agent_environments.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(["api_key_id"], ["api_keys.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_hosted_v1_agent_ownerships_environment_id",
        "hosted_v1_agent_ownerships",
        ["environment_id"],
    )
    op.create_index(
        "ix_hosted_v1_agent_ownerships_api_key_id",
        "hosted_v1_agent_ownerships",
        ["api_key_id"],
    )
    op.create_index(
        "ix_hosted_v1_agent_ownerships_archived_at",
        "hosted_v1_agent_ownerships",
        ["archived_at"],
    )
    op.create_index(
        "uq_hosted_v1_agent_ownerships_active_environment",
        "hosted_v1_agent_ownerships",
        ["environment_id"],
        unique=True,
        postgresql_where=sa.text("archived_at IS NULL"),
    )
    op.create_index(
        "uq_hosted_v1_agent_ownerships_active_deployment_agent",
        "hosted_v1_agent_ownerships",
        ["deployment_id", "agent_type"],
        unique=True,
        postgresql_where=sa.text("archived_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_table("hosted_v1_agent_ownerships")
