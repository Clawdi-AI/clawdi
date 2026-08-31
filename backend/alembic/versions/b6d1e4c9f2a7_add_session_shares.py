"""Add immutable, scoped Session shares.

Revision ID: b6d1e4c9f2a7
Revises: a4d8c1e7f2b6
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b6d1e4c9f2a7"
down_revision: str | Sequence[str] | None = "a4d8c1e7f2b6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "session_shares",
        sa.Column("id", sa.dialects.postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "session_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_by",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
        ),
        sa.Column("scope", sa.String(20), nullable=False),
        sa.Column("start_position", sa.Integer()),
        sa.Column("end_position", sa.Integer(), nullable=False),
        sa.Column("source_protocol", sa.String(20), nullable=False),
        sa.Column("source_revision", sa.String(80), nullable=False),
        sa.Column(
            "event_generation_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("session_event_generations.id", ondelete="CASCADE"),
        ),
        sa.Column("snapshot_file_key", sa.Text()),
        sa.Column("public_metadata", sa.dialects.postgresql.JSONB(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "scope IN ('session', 'through', 'response')",
            name="ck_session_shares_scope",
        ),
        sa.CheckConstraint(
            "source_protocol IN ('snapshot-v1', 'events-v1')",
            name="ck_session_shares_source_protocol",
        ),
        sa.CheckConstraint(
            "end_position >= 0 AND (start_position IS NULL OR start_position >= 0)",
            name="ck_session_shares_positions_nonnegative",
        ),
        sa.CheckConstraint(
            "(scope = 'response' AND start_position = end_position) OR "
            "(scope IN ('session', 'through') AND start_position IS NULL)",
            name="ck_session_shares_scope_positions",
        ),
        sa.CheckConstraint(
            "(source_protocol = 'snapshot-v1' AND snapshot_file_key IS NOT NULL "
            "AND event_generation_id IS NULL) OR "
            "(source_protocol = 'events-v1' AND snapshot_file_key IS NULL "
            "AND event_generation_id IS NOT NULL)",
            name="ck_session_shares_source_reference",
        ),
    )
    op.create_index(
        "ix_session_shares_session_active_created",
        "session_shares",
        ["session_id", sa.text("created_at DESC")],
        postgresql_where=sa.text("revoked_at IS NULL"),
    )
    op.create_index(
        "ix_session_shares_generation_active",
        "session_shares",
        ["event_generation_id"],
        postgresql_where=sa.text("event_generation_id IS NOT NULL AND revoked_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_session_shares_generation_active", table_name="session_shares")
    op.drop_index("ix_session_shares_session_active_created", table_name="session_shares")
    op.drop_table("session_shares")
