"""Reserve the online Session message search rollout revision.

Revision ID: f7c9a2e5d1b4
Revises: e4b8c2d6f1a9
"""

from collections.abc import Sequence

revision: str = "f7c9a2e5d1b4"
down_revision: str | Sequence[str] | None = "e4b8c2d6f1a9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Building one tsvector per complete message fails for PostgreSQL documents
    # above 1 MiB. Keep this already-published revision as a compatibility
    # marker; the successor introduces bounded message chunks before indexing.
    pass


def downgrade() -> None:
    pass
