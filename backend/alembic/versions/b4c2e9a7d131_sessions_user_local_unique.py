"""sessions: unique constraint on (user_id, local_session_id)

Revision ID: b4c2e9a7d131
Revises: e81a04e870b4
Create Date: 2026-04-23

Guards against concurrent CLI batch ingests producing duplicate session rows,
and lets the batch route use `ON CONFLICT DO NOTHING` instead of an O(n)
SELECT-per-row pre-check.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "b4c2e9a7d131"
down_revision: str | Sequence[str] | None = "e81a04e870b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Deduplicate any existing rows before taking the unique constraint.
    # Keep the oldest row per (user_id, local_session_id) — that's the one
    # the duplicate-skip path in the old route would have preserved anyway.
    # `id` is used as a tiebreaker so ties on `created_at` don't leave a
    # pair of duplicates that would break the constraint creation below.
    op.execute(
        """
        DELETE FROM sessions a
        USING sessions b
        WHERE a.user_id = b.user_id
          AND a.local_session_id = b.local_session_id
          AND (a.created_at, a.id) > (b.created_at, b.id)
        """
    )
    op.create_unique_constraint(
        "uq_sessions_user_local", "sessions", ["user_id", "local_session_id"]
    )


def downgrade() -> None:
    op.drop_constraint("uq_sessions_user_local", "sessions", type_="unique")
