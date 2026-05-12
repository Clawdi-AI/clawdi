"""add sessions.related_refs

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-05-12

Adds `related_refs JSONB NULL` — extracted PR refs / repo names /
branches from message content, surfaced in the session sidebar.
Schema: `{"prs": ["owner/repo#123"], "repos": [...], "branches": [...]}`.
NULL when nothing was found.

`JSONB(none_as_null=True)` lives on the SQLAlchemy column descriptor
(see `app/models/session.py`), not here — that flag controls how
Python `None` is sent to the driver (JSON `null` literal vs. SQL
`NULL`). The column itself just accepts both forms.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "b2c3d4e5f6a7"
down_revision: str | Sequence[str] | None = "a1b2c3d4e5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("sessions", sa.Column("related_refs", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("sessions", "related_refs")
