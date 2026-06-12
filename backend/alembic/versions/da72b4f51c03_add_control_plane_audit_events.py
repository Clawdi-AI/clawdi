"""add control plane audit events

Revision ID: da72b4f51c03
Revises: f12a8c4d6e90
Create Date: 2026-06-11 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "da72b4f51c03"
down_revision: str | Sequence[str] | None = "f12a8c4d6e90"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "control_plane_audit_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("actor_type", sa.String(length=32), nullable=False),
        sa.Column("actor_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("target_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("source", sa.String(length=64), nullable=False),
        sa.Column("action", sa.String(length=100), nullable=False),
        sa.Column("resource_type", sa.String(length=80), nullable=False),
        sa.Column("resource_id", sa.String(length=200), nullable=True),
        sa.Column("environment_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("channel_account_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("channel_agent_link_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "details",
            postgresql.JSONB(none_as_null=True),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["actor_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["target_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["environment_id"], ["agent_environments.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["channel_account_id"], ["channel_accounts.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["channel_agent_link_id"],
            ["channel_bot_agent_links.id"],
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_control_plane_audit_events_target_created",
        "control_plane_audit_events",
        ["target_user_id", "created_at"],
    )
    for column in (
        "actor_type",
        "actor_user_id",
        "target_user_id",
        "source",
        "action",
        "resource_type",
        "resource_id",
        "environment_id",
        "channel_account_id",
        "channel_agent_link_id",
    ):
        op.create_index(
            f"ix_control_plane_audit_events_{column}",
            "control_plane_audit_events",
            [column],
        )


def downgrade() -> None:
    for column in (
        "channel_agent_link_id",
        "channel_account_id",
        "environment_id",
        "resource_id",
        "resource_type",
        "action",
        "source",
        "target_user_id",
        "actor_user_id",
        "actor_type",
    ):
        op.drop_index(
            f"ix_control_plane_audit_events_{column}",
            table_name="control_plane_audit_events",
        )
    op.drop_index(
        "ix_control_plane_audit_events_target_created",
        table_name="control_plane_audit_events",
    )
    op.drop_table("control_plane_audit_events")
