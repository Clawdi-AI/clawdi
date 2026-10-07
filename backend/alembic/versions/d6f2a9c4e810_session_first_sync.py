"""Bound session analytics to one successful sync per new session.

Revision ID: d6f2a9c4e810
Revises: a8c4f2d9e610
"""

import sqlalchemy as sa

from alembic import op

revision = "d6f2a9c4e810"
down_revision = "a8c4f2d9e610"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Snapshot batches can erase prior upload evidence. Conservatively exclude
    # every existing session instead of replaying history (including pending
    # legacy uploads). PostgreSQL's stable default avoids a table-wide UPDATE.
    op.add_column(
        "sessions",
        sa.Column(
            "first_synced_at",
            sa.DateTime(timezone=True),
            nullable=True,
            server_default=sa.func.now(),
        ),
    )
    # Only pre-existing rows retain the rollout marker; new rows start unsynced.
    op.alter_column("sessions", "first_synced_at", server_default=None)


def downgrade() -> None:
    op.drop_column("sessions", "first_synced_at")
