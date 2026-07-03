"""add sessions.last_activity_at

Revision ID: d2f9e1a0c4b3
Revises: c1d99ac4f9e6
Create Date: 2026-05-01 11:00:00.000000

Adds a per-session "last activity" timestamp distinct from
`updated_at`:

  - `updated_at` (TimestampMixin, server clock): when the row was
    last written to. Bumped by the upsert path on content_hash
    change. Used for ETag / cache invalidation. NOT exposed in
    the dashboard.
  - `last_activity_at` (NEW, derived from message timestamps):
    when the user actually used the session last. The dashboard's
    "Last activity" column reads from this; sort default is
    `last_activity_at DESC`.

Why a new column instead of repurposing `updated_at`: the row-level
"last writer wins" semantic of `updated_at` is load-bearing for
cache invalidation and incremental fetch. Reusing it for user-
activity time would conflate two distinct contracts and rule out a
future cache layer that depends on the writer-time semantic.

Why not reuse `ended_at`: each adapter populates it inconsistently
(Hermes can leave it null, OpenClaw falls back to its index's
updated_at, Claude Code passes the parsed value). `ended_at` is
adapter-defined; `last_activity_at` is what we own.

Backfill: existing rows get `COALESCE(ended_at, started_at)`. This
loses precision for sessions whose daemon push lagged behind actual
use, but those are unrecoverable server-side anyway — authoritative
source is the JSONL on the daemon's machine, re-stamped as soon as
the next push lands.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "d2f9e1a0c4b3"
down_revision: Union[str, Sequence[str], None] = "c1d99ac4f9e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add as nullable first so the table doesn't fail on existing rows,
    # backfill, then enforce NOT NULL. This is the standard zero-downtime
    # pattern; for a single backend instance the brief nullable window
    # is invisible to clients.
    op.add_column(
        "sessions",
        sa.Column(
            "last_activity_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
    )

    # Backfill: prefer ended_at (if a real value), else started_at.
    # Both are guaranteed-present by existing schema (started_at is
    # NOT NULL; ended_at is nullable but populated for completed
    # sessions).
    op.execute(
        """
        UPDATE sessions
        SET last_activity_at = COALESCE(ended_at, started_at)
        """
    )

    op.alter_column("sessions", "last_activity_at", nullable=False)

    # Composite index on (user_id, last_activity_at DESC) — mirrors
    # the existing (user_id, updated_at DESC) index from migration
    # c1d99ac4f9e6 since the default list query is now sorted by
    # last_activity_at. Without this, the hot path sequential-scans
    # sessions for users with thousands of rows.
    #
    # Plain CREATE INDEX (no CONCURRENTLY) so the whole migration
    # stays in one transaction. CONCURRENTLY would require
    # autocommit_block(), which commits prior column adds + backfill
    # BEFORE alembic stamps the revision; if the index step then
    # fails (cancel, OOM, replication lag), `alembic upgrade head`
    # retries the column add and 422s on duplicate columns. The
    # sessions table is small enough that the ACCESS EXCLUSIVE lock
    # holds for milliseconds — well inside the deploy restart
    # window. Same trade-off codified in c1d99ac4f9e6 step 18.
    op.create_index(
        "ix_sessions_user_last_activity",
        "sessions",
        ["user_id", sa.text("last_activity_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_sessions_user_last_activity", table_name="sessions")
    op.drop_column("sessions", "last_activity_at")
