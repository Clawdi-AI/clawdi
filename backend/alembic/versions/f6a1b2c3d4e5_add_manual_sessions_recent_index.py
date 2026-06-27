"""add partial index for recent manual sessions

Revision ID: f6a1b2c3d4e5
Revises: e3b8a7c9d2f1
Create Date: 2026-06-27 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f6a1b2c3d4e5"
down_revision: str | Sequence[str] | None = "e3b8a7c9d2f1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Dashboard home requests recent manual sessions with
    # `automated=false`, ordered by last_activity_at DESC and limited to
    # a tiny page. Production fleets can be dominated by cron/heartbeat
    # rows, so this partial index lets Postgres skip those rows entirely
    # instead of scanning backward through automated sessions first.
    op.create_index(
        "ix_sessions_user_manual_last_activity",
        "sessions",
        ["user_id", sa.text("last_activity_at DESC")],
        postgresql_where=sa.text(
            "summary IS NULL OR (summary NOT LIKE 'Cron:%' AND summary NOT LIKE '[%')"
        ),
    )


def downgrade() -> None:
    op.drop_index("ix_sessions_user_manual_last_activity", table_name="sessions")
