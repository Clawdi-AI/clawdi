"""add xtrace memory ingest audits

Revision ID: 84a75f7f0e2d
Revises: 3d0b4d7f9a2e
Create Date: 2026-06-04 16:45:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "84a75f7f0e2d"
down_revision: str | Sequence[str] | None = "3d0b4d7f9a2e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "xtrace_memory_ingests",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("session_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("local_session_id", sa.String(length=200), nullable=False),
        sa.Column("job_id", sa.String(length=200), nullable=True),
        sa.Column("status", sa.String(length=50), nullable=True),
        sa.Column("created_ref_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("updated_ref_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("mirrored_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("response", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
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
        sa.ForeignKeyConstraint(["session_id"], ["sessions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_xtrace_memory_ingests_job_id", "xtrace_memory_ingests", ["job_id"])
    op.create_index(
        "ix_xtrace_memory_ingests_local_session_id",
        "xtrace_memory_ingests",
        ["local_session_id"],
    )
    op.create_index(
        "ix_xtrace_memory_ingests_session_id",
        "xtrace_memory_ingests",
        ["session_id"],
    )
    op.create_index("ix_xtrace_memory_ingests_status", "xtrace_memory_ingests", ["status"])
    op.create_index("ix_xtrace_memory_ingests_user_id", "xtrace_memory_ingests", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_xtrace_memory_ingests_user_id", table_name="xtrace_memory_ingests")
    op.drop_index("ix_xtrace_memory_ingests_status", table_name="xtrace_memory_ingests")
    op.drop_index("ix_xtrace_memory_ingests_session_id", table_name="xtrace_memory_ingests")
    op.drop_index(
        "ix_xtrace_memory_ingests_local_session_id",
        table_name="xtrace_memory_ingests",
    )
    op.drop_index("ix_xtrace_memory_ingests_job_id", table_name="xtrace_memory_ingests")
    op.drop_table("xtrace_memory_ingests")
