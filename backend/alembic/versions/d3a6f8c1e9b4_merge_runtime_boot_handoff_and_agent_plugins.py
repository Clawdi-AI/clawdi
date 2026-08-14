"""Merge runtime boot handoff and Agent Plugins branches.

Revision ID: d3a6f8c1e9b4
Revises: e5c8a1d7f2b9, c6e2a9f4b7d1
Create Date: 2026-08-12 00:00:00.000000
"""

from collections.abc import Sequence

revision: str = "d3a6f8c1e9b4"
down_revision: str | Sequence[str] | None = ("e5c8a1d7f2b9", "c6e2a9f4b7d1")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
