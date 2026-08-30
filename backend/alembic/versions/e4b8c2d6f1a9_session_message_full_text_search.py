"""Add indexed full-text search to Session message projections.

Revision ID: e4b8c2d6f1a9
Revises: b1d7e3f9a4c2
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "e4b8c2d6f1a9"
down_revision: str | Sequence[str] | None = "b1d7e3f9a4c2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "session_message_search",
        sa.Column(
            "content_tsv",
            postgresql.TSVECTOR(),
            sa.Computed("to_tsvector('simple', content)", persisted=True),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_session_message_search_content_tsv",
        "session_message_search",
        ["content_tsv"],
        postgresql_using="gin",
    )


def downgrade() -> None:
    op.drop_index("ix_session_message_search_content_tsv", table_name="session_message_search")
    op.drop_column("session_message_search", "content_tsv")
