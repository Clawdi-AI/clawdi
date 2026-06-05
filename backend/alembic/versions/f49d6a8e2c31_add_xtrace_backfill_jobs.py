"""add xtrace backfill jobs

Revision ID: f49d6a8e2c31
Revises: c7486d1f5b60
Create Date: 2026-06-04 17:45:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f49d6a8e2c31"
down_revision: str | Sequence[str] | None = "c7486d1f5b60"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "xtrace_backfill_jobs",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("requested_by_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("scope_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("include_sessions", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("include_skills", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("force", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("dry_run", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("limit", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(length=50), server_default="queued", nullable=False),
        sa.Column("current_source_type", sa.String(length=50), nullable=True),
        sa.Column("current_source_key", sa.String(length=300), nullable=True),
        sa.Column("considered_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("sent_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("skipped_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("failed_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("mirrored_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("sessions_considered", sa.Integer(), server_default="0", nullable=False),
        sa.Column("sessions_sent", sa.Integer(), server_default="0", nullable=False),
        sa.Column("sessions_skipped", sa.Integer(), server_default="0", nullable=False),
        sa.Column("sessions_failed", sa.Integer(), server_default="0", nullable=False),
        sa.Column("sessions_mirrored", sa.Integer(), server_default="0", nullable=False),
        sa.Column("skills_considered", sa.Integer(), server_default="0", nullable=False),
        sa.Column("skills_sent", sa.Integer(), server_default="0", nullable=False),
        sa.Column("skills_skipped", sa.Integer(), server_default="0", nullable=False),
        sa.Column("skills_failed", sa.Integer(), server_default="0", nullable=False),
        sa.Column("skills_mirrored", sa.Integer(), server_default="0", nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.ForeignKeyConstraint(
            ["requested_by_user_id"],
            ["users.id"],
            name="fk_xtrace_backfill_jobs_requested_by_user_id_users",
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["scope_user_id"],
            ["users.id"],
            name="fk_xtrace_backfill_jobs_scope_user_id_users",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_xtrace_backfill_jobs_requested_by_user_id",
        "xtrace_backfill_jobs",
        ["requested_by_user_id"],
    )
    op.create_index(
        "ix_xtrace_backfill_jobs_scope_user_id",
        "xtrace_backfill_jobs",
        ["scope_user_id"],
    )
    op.create_index("ix_xtrace_backfill_jobs_status", "xtrace_backfill_jobs", ["status"])


def downgrade() -> None:
    op.drop_index("ix_xtrace_backfill_jobs_status", table_name="xtrace_backfill_jobs")
    op.drop_index("ix_xtrace_backfill_jobs_scope_user_id", table_name="xtrace_backfill_jobs")
    op.drop_index(
        "ix_xtrace_backfill_jobs_requested_by_user_id",
        table_name="xtrace_backfill_jobs",
    )
    op.drop_table("xtrace_backfill_jobs")
