"""Add adapter modules and immutable session event chunks.

Revision ID: c6e8a1f4d2b9
Revises: c8a4e1d7f2b6
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "c6e8a1f4d2b9"
down_revision: str | Sequence[str] | None = "c8a4e1d7f2b6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "agent_environments",
        sa.Column("adapter_modules", postgresql.ARRAY(sa.String(length=20)), nullable=True),
    )
    op.create_check_constraint(
        "ck_agent_environments_adapter_modules",
        "agent_environments",
        "adapter_modules IS NULL OR "
        "(cardinality(adapter_modules) >= 1 AND "
        "adapter_modules <@ ARRAY['sessions', 'skills']::varchar[])",
    )

    op.add_column(
        "session_sync_suppressions",
        sa.Column(
            "id",
            sa.UUID(),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
    )
    op.add_column(
        "session_sync_suppressions",
        sa.Column("origin_environment_id", sa.UUID(), nullable=True),
    )
    op.drop_constraint(
        "pk_session_sync_suppressions",
        "session_sync_suppressions",
        type_="primary",
    )
    op.create_primary_key(
        "pk_session_sync_suppressions",
        "session_sync_suppressions",
        ["id"],
    )
    op.create_index(
        "uq_session_sync_suppressions_legacy",
        "session_sync_suppressions",
        ["user_id", "local_session_id"],
        unique=True,
        postgresql_where=sa.text("origin_environment_id IS NULL"),
    )
    op.create_index(
        "uq_session_sync_suppressions_origin",
        "session_sync_suppressions",
        ["user_id", "origin_environment_id", "local_session_id"],
        unique=True,
        postgresql_where=sa.text("origin_environment_id IS NOT NULL"),
    )

    op.add_column(
        "sessions",
        sa.Column(
            "content_protocol",
            sa.String(length=20),
            server_default="snapshot-v1",
            nullable=False,
        ),
    )
    op.add_column("sessions", sa.Column("origin_environment_id", sa.UUID(), nullable=True))
    op.execute("UPDATE sessions SET origin_environment_id = environment_id")
    op.drop_constraint("uq_sessions_user_local", "sessions", type_="unique")
    op.create_unique_constraint(
        "uq_sessions_user_origin_local",
        "sessions",
        ["user_id", "origin_environment_id", "local_session_id"],
    )
    op.create_index("ix_sessions_origin_environment_id", "sessions", ["origin_environment_id"])
    op.add_column("sessions", sa.Column("event_generation_id", sa.UUID(), nullable=True))
    op.add_column(
        "sessions",
        sa.Column("event_revision", sa.Integer(), server_default="0", nullable=False),
    )
    op.add_column(
        "sessions",
        sa.Column("event_count", sa.Integer(), server_default="0", nullable=False),
    )
    op.add_column("sessions", sa.Column("event_head_hash", sa.String(length=64), nullable=True))
    op.create_check_constraint(
        "ck_sessions_content_protocol",
        "sessions",
        "content_protocol IN ('snapshot-v1', 'events-v1')",
    )
    op.create_check_constraint(
        "ck_sessions_event_state",
        "sessions",
        "event_revision >= 0 AND event_count >= 0",
    )

    op.create_table(
        "session_event_generations",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column(
            "session_id",
            sa.UUID(),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("append_id", sa.UUID(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("base_generation_id", sa.UUID(), nullable=True),
        sa.Column("base_revision", sa.Integer(), nullable=False),
        sa.Column("base_count", sa.Integer(), nullable=False),
        sa.Column("base_head_hash", sa.String(length=64), nullable=False),
        sa.Column("final_count", sa.Integer(), nullable=False),
        sa.Column("final_head_hash", sa.String(length=64), nullable=False),
        sa.Column("superseded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("session_id", "append_id", name="uq_session_event_generation_append"),
        sa.CheckConstraint("status IN ('staging', 'committed')", name="ck_event_generation_status"),
        sa.CheckConstraint(
            "base_revision >= 0 AND base_count >= 0 AND final_count >= 0",
            name="ck_event_generation_counts",
        ),
    )
    op.create_index(
        "ix_session_event_generations_session_id",
        "session_event_generations",
        ["session_id"],
    )
    op.create_index(
        "ix_session_event_generations_status_created_at",
        "session_event_generations",
        ["status", "created_at"],
    )
    op.create_index(
        "ix_session_event_generations_status_superseded_at",
        "session_event_generations",
        ["status", "superseded_at"],
    )

    op.create_table(
        "session_event_chunks",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column(
            "session_id",
            sa.UUID(),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "generation_id",
            sa.UUID(),
            sa.ForeignKey("session_event_generations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("start_seq", sa.Integer(), nullable=False),
        sa.Column("end_seq", sa.Integer(), nullable=False),
        sa.Column("event_count", sa.Integer(), nullable=False),
        sa.Column("base_head_hash", sa.String(length=64), nullable=False),
        sa.Column("result_head_hash", sa.String(length=64), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("file_key", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("generation_id", "start_seq", name="uq_session_event_chunk_start"),
        sa.CheckConstraint(
            "start_seq >= 0 AND end_seq >= start_seq AND event_count = end_seq - start_seq + 1",
            name="ck_session_event_chunk_range",
        ),
    )
    op.create_index("ix_session_event_chunks_session_id", "session_event_chunks", ["session_id"])

    op.create_table(
        "session_event_append_receipts",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column(
            "session_id",
            sa.UUID(),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("append_id", sa.UUID(), nullable=False),
        sa.Column(
            "generation_id",
            sa.UUID(),
            sa.ForeignKey("session_event_generations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("base_revision", sa.Integer(), nullable=False),
        sa.Column("base_count", sa.Integer(), nullable=False),
        sa.Column("base_head_hash", sa.String(length=64), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("result_revision", sa.Integer(), nullable=False),
        sa.Column("result_count", sa.Integer(), nullable=False),
        sa.Column("result_head_hash", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("session_id", "append_id", name="uq_session_event_append_receipt"),
        sa.CheckConstraint(
            "base_revision >= 0 AND base_count >= 0 AND result_revision >= 1",
            name="ck_session_event_append_receipt_counts",
        ),
    )
    op.create_index(
        "ix_session_event_append_receipts_session_id",
        "session_event_append_receipts",
        ["session_id"],
    )


def downgrade() -> None:
    event_state_count = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT "
                "(SELECT count(*) FROM session_event_generations) + "
                "(SELECT count(*) FROM session_event_chunks) + "
                "(SELECT count(*) FROM session_event_append_receipts) + "
                "(SELECT count(*) FROM sessions WHERE content_protocol <> 'snapshot-v1' "
                "OR event_generation_id IS NOT NULL OR event_revision <> 0 "
                "OR event_count <> 0 OR event_head_hash IS NOT NULL)"
            )
        )
        .scalar_one()
    )
    if event_state_count:
        raise RuntimeError(
            "Cannot downgrade migration c6e8a1f4d2b9: events-v1 data exists and the "
            "legacy Session schema cannot represent it. Export and explicitly migrate "
            "or delete the event Sessions before retrying the downgrade."
        )

    incompatible_state = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT "
                "(SELECT count(*) FROM agent_environments "
                "WHERE adapter_modules IS NOT NULL "
                "AND NOT (adapter_modules @> ARRAY['sessions', 'skills']::varchar[] "
                "AND adapter_modules <@ ARRAY['sessions', 'skills']::varchar[])) "
                "AS capability_count, "
                "(SELECT count(*) FROM sessions "
                "WHERE origin_environment_id IS DISTINCT FROM environment_id) "
                "AS session_origin_count, "
                "(SELECT count(*) FROM session_sync_suppressions "
                "WHERE origin_environment_id IS NOT NULL) AS suppression_origin_count"
            )
        )
        .one()
    )
    incompatible_details = [
        detail
        for count, detail in (
            (incompatible_state.capability_count, "restricted adapter capabilities"),
            (incompatible_state.session_origin_count, "immutable Session origin identity"),
            (
                incompatible_state.suppression_origin_count,
                "origin-scoped Session suppressions",
            ),
        )
        if count
    ]
    if incompatible_details:
        raise RuntimeError(
            "Cannot downgrade migration c6e8a1f4d2b9: the legacy schema cannot represent "
            f"{', '.join(incompatible_details)}. Restore legacy-equivalent state before "
            "retrying the downgrade."
        )

    conflicting_sessions = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT user_id, local_session_id, count(*) AS row_count "
                "FROM sessions "
                "GROUP BY user_id, local_session_id "
                "HAVING count(*) > 1 "
                "ORDER BY user_id, local_session_id "
                "LIMIT 5"
            )
        )
        .all()
    )
    if conflicting_sessions:
        session_examples = ", ".join(
            f"{row.user_id}/{row.local_session_id} ({row.row_count} rows)"
            for row in conflicting_sessions
        )
        raise RuntimeError(
            "Cannot downgrade migration c6e8a1f4d2b9: the legacy Session schema "
            "cannot represent equal local_session_id values from multiple origins. "
            f"Conflicts: {session_examples}. Export and explicitly delete or migrate the "
            "conflicting Sessions before retrying the downgrade."
        )

    op.drop_index(
        "ix_session_event_append_receipts_session_id",
        table_name="session_event_append_receipts",
    )
    op.drop_table("session_event_append_receipts")
    op.drop_index("ix_session_event_chunks_session_id", table_name="session_event_chunks")
    op.drop_table("session_event_chunks")
    op.drop_index(
        "ix_session_event_generations_status_superseded_at",
        table_name="session_event_generations",
    )
    op.drop_index(
        "ix_session_event_generations_status_created_at",
        table_name="session_event_generations",
    )
    op.drop_index("ix_session_event_generations_session_id", table_name="session_event_generations")
    op.drop_table("session_event_generations")
    op.drop_constraint("ck_sessions_event_state", "sessions", type_="check")
    op.drop_constraint("ck_sessions_content_protocol", "sessions", type_="check")
    op.drop_column("sessions", "event_head_hash")
    op.drop_column("sessions", "event_count")
    op.drop_column("sessions", "event_revision")
    op.drop_column("sessions", "event_generation_id")
    op.drop_column("sessions", "content_protocol")
    op.drop_index("ix_sessions_origin_environment_id", table_name="sessions")
    op.drop_constraint("uq_sessions_user_origin_local", "sessions", type_="unique")
    op.create_unique_constraint(
        "uq_sessions_user_local", "sessions", ["user_id", "local_session_id"]
    )
    op.drop_column("sessions", "origin_environment_id")
    op.drop_index(
        "uq_session_sync_suppressions_origin",
        table_name="session_sync_suppressions",
    )
    op.drop_index(
        "uq_session_sync_suppressions_legacy",
        table_name="session_sync_suppressions",
    )
    op.drop_constraint(
        "pk_session_sync_suppressions",
        "session_sync_suppressions",
        type_="primary",
    )
    op.drop_column("session_sync_suppressions", "origin_environment_id")
    op.drop_column("session_sync_suppressions", "id")
    op.create_primary_key(
        "pk_session_sync_suppressions",
        "session_sync_suppressions",
        ["user_id", "local_session_id"],
    )
    op.drop_constraint("ck_agent_environments_adapter_modules", "agent_environments", type_="check")
    op.drop_column("agent_environments", "adapter_modules")
