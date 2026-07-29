"""Add durable Skill authority and Agent provenance.

Revision ID: 5d2a9c7e4b18
Revises: 3e7a9c1d5b82
Create Date: 2026-07-29 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "5d2a9c7e4b18"
down_revision: str | Sequence[str] | None = "3e7a9c1d5b82"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Fail-safe backfill: project origin and the legacy `source=local` value
    # are not ownership evidence. Dashboard edits and older daemon uploads
    # both produced that shape, so every historical row stays cloud-owned
    # until an authenticated Agent explicitly reports the local filesystem.
    op.add_column(
        "skills",
        sa.Column("authority", sa.String(length=32), server_default="cloud", nullable=False),
    )
    op.add_column(
        "skills",
        sa.Column("authority_agent_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_skills_authority_agent_id",
        "skills",
        "agent_environments",
        ["authority_agent_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index(
        "ix_skills_authority_agent_id",
        "skills",
        ["authority_agent_id"],
        unique=False,
    )
    op.create_check_constraint(
        "ck_skills_authority",
        "skills",
        "authority IN ('agent_sync', 'cloud')",
    )
    op.create_check_constraint(
        "ck_skills_authority_agent",
        "skills",
        "(authority = 'agent_sync' AND authority_agent_id IS NOT NULL) OR "
        "(authority = 'cloud' AND authority_agent_id IS NULL)",
    )


def downgrade() -> None:
    # Provenance cannot be represented by the previous schema. Hold an
    # exclusive table lock across the evidence check and DDL so a concurrent
    # Agent claim cannot land between them and silently reopen that row to
    # Cloud mutation after rollback.
    bind = op.get_bind()
    bind.execute(sa.text("LOCK TABLE skills IN ACCESS EXCLUSIVE MODE"))
    has_agent_authority = bind.scalar(
        sa.text(
            """
            SELECT EXISTS (
                SELECT 1
                FROM skills
                WHERE authority <> 'cloud'
                   OR authority_agent_id IS NOT NULL
            )
            """
        )
    )
    if has_agent_authority:
        raise RuntimeError(
            "Cannot downgrade migration 5d2a9c7e4b18 while Agent-authoritative "
            "Skill projections exist"
        )

    op.drop_constraint("ck_skills_authority_agent", "skills", type_="check")
    op.drop_constraint("ck_skills_authority", "skills", type_="check")
    op.drop_index("ix_skills_authority_agent_id", table_name="skills")
    op.drop_constraint("fk_skills_authority_agent_id", "skills", type_="foreignkey")
    op.drop_column("skills", "authority_agent_id")
    op.drop_column("skills", "authority")
