"""extend xtrace ingests for skill sources

Revision ID: c7486d1f5b60
Revises: 84a75f7f0e2d
Create Date: 2026-06-04 17:10:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c7486d1f5b60"
down_revision: str | Sequence[str] | None = "84a75f7f0e2d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "xtrace_memory_ingests",
        sa.Column("source_type", sa.String(length=50), server_default="session", nullable=False),
    )
    op.add_column(
        "xtrace_memory_ingests",
        sa.Column("skill_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "xtrace_memory_ingests",
        sa.Column("source_key", sa.String(length=300), nullable=True),
    )
    op.alter_column("xtrace_memory_ingests", "session_id", nullable=True)
    op.alter_column("xtrace_memory_ingests", "local_session_id", nullable=True)
    op.create_foreign_key(
        "fk_xtrace_memory_ingests_skill_id_skills",
        "xtrace_memory_ingests",
        "skills",
        ["skill_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index(
        "ix_xtrace_memory_ingests_source_type",
        "xtrace_memory_ingests",
        ["source_type"],
    )
    op.create_index("ix_xtrace_memory_ingests_skill_id", "xtrace_memory_ingests", ["skill_id"])
    op.create_index("ix_xtrace_memory_ingests_source_key", "xtrace_memory_ingests", ["source_key"])


def downgrade() -> None:
    op.drop_index("ix_xtrace_memory_ingests_source_key", table_name="xtrace_memory_ingests")
    op.drop_index("ix_xtrace_memory_ingests_skill_id", table_name="xtrace_memory_ingests")
    op.drop_index("ix_xtrace_memory_ingests_source_type", table_name="xtrace_memory_ingests")
    op.drop_constraint(
        "fk_xtrace_memory_ingests_skill_id_skills",
        "xtrace_memory_ingests",
        type_="foreignkey",
    )
    op.alter_column("xtrace_memory_ingests", "local_session_id", nullable=False)
    op.alter_column("xtrace_memory_ingests", "session_id", nullable=False)
    op.drop_column("xtrace_memory_ingests", "source_key")
    op.drop_column("xtrace_memory_ingests", "skill_id")
    op.drop_column("xtrace_memory_ingests", "source_type")
