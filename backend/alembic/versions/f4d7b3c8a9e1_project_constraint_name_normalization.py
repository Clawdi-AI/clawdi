"""preserve project-sharing migration graph continuity

Revision ID: f4d7b3c8a9e1
Revises: b8e4d1c6f23a
Create Date: 2026-05-14 08:20:00.000000

This revision existed on earlier iterations of the project-sharing PR.
Keep it as an intentional no-op so databases that already applied it can
continue to run Alembic commands after the schema work was consolidated
into b8e4d1c6f23a_project_sharing.py.
"""

from collections.abc import Sequence

revision: str = "f4d7b3c8a9e1"
down_revision: str | Sequence[str] | None = "b8e4d1c6f23a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
