"""project constraint-name normalization

Revision ID: f4d7b3c8a9e1
Revises: b8e4d1c6f23a
Create Date: 2026-05-14 08:20:00.000000
"""

from collections.abc import Sequence

revision: str = "f4d7b3c8a9e1"
down_revision: str | Sequence[str] | None = "b8e4d1c6f23a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The consolidated migration chain now creates project-named
    # constraints/indexes directly, so this revision is intentionally
    # a no-op while preserving migration graph continuity.
    pass


def downgrade() -> None:
    pass
