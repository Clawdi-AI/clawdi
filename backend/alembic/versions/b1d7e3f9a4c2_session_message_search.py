"""Add rebuildable Session message search projection.

Revision ID: b1d7e3f9a4c2
Revises: a9c4e2f7b1d6
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b1d7e3f9a4c2"
down_revision: str | Sequence[str] | None = "a9c4e2f7b1d6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "session_event_chunks",
        sa.Column("search_indexed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "sessions",
        sa.Column("search_index_revision", sa.String(length=80), nullable=True),
    )
    op.create_table(
        "session_message_search",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("session_id", sa.UUID(), nullable=False),
        sa.Column("generation_id", sa.UUID(), nullable=True),
        sa.Column("content_revision", sa.String(length=80), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("role", sa.String(length=20), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.CheckConstraint("position >= 0", name="ck_session_message_search_position"),
        sa.CheckConstraint(
            "role IN ('user', 'assistant')",
            name="ck_session_message_search_role",
        ),
        sa.ForeignKeyConstraint(["session_id"], ["sessions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["generation_id"],
            ["session_event_generations.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "session_id",
            "content_revision",
            "position",
            name="pk_session_message_search",
        ),
    )
    op.create_index(
        "ix_session_message_search_user",
        "session_message_search",
        ["user_id"],
    )
    op.create_index(
        "ix_session_message_search_generation",
        "session_message_search",
        ["generation_id"],
    )
    op.create_index(
        "ix_session_message_search_content_trgm",
        "session_message_search",
        ["content"],
        postgresql_using="gin",
        postgresql_ops={"content": "gin_trgm_ops"},
    )


def downgrade() -> None:
    op.drop_table("session_message_search")
    op.drop_column("sessions", "search_index_revision")
    op.drop_column("session_event_chunks", "search_indexed_at")
