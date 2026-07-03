"""add session content_hash and content_uploaded_at

Revision ID: 672acd66fc7d
Revises: 6dee7134c53f
Create Date: 2026-04-28 13:14:09.069562

Adds two columns to `sessions` to support content-hash-based sync:

- `content_hash`: SHA-256 hex of the messages JSON the CLI uploaded. The
  batch endpoint uses it to skip content re-upload when local is unchanged.
  `clawdi pull` uses it to diff cloud vs. local sidecars without fetching
  the body.
- `content_uploaded_at`: when the upload endpoint last wrote bytes to the
  file store. Useful for tooling/admin that wants to spot rows with
  metadata but no content.

Both columns are nullable. After deploying this migration, run:

    pdm run python -m scripts.backfill_session_content_hash --all

That walks every row with `file_key IS NOT NULL AND content_hash IS NULL`,
fetches the body from the file store, hashes it, and writes the column.
Without it, `clawdi pull` would re-download legacy rows on every run
(NULL hash on the remote means "always re-download" in the diff logic),
and the data only self-heals via push from the originating machine —
which doesn't help users on a different device or after a wipe.

The script is idempotent and skips rows whose file is missing from the
store (logs a warning rather than aborting). Safe to re-run.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "672acd66fc7d"
down_revision: Union[str, Sequence[str], None] = "6dee7134c53f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column("content_hash", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "sessions",
        sa.Column("content_uploaded_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("sessions", "content_uploaded_at")
    op.drop_column("sessions", "content_hash")
