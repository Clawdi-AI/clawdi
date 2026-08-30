"""Reserve the Session message full-text search rollout revision.

Revision ID: e4b8c2d6f1a9
Revises: b1d7e3f9a4c2
"""

from collections.abc import Sequence

revision: str = "e4b8c2d6f1a9"
down_revision: str | Sequence[str] | None = "b1d7e3f9a4c2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The original revision rewrote every historical message row into a stored
    # generated column. Keep this published revision as a compatibility marker;
    # the successor builds a non-redundant expression index online.
    pass


def downgrade() -> None:
    pass
