"""Coalesce unchanged runtime heartbeats.

Revision ID: c8a4e1d7f2b6
Revises: b5e7d9a1c3f2
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c8a4e1d7f2b6"
down_revision: str | Sequence[str] | None = "b5e7d9a1c3f2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _replace_head_guards(*, coalesced_heartbeats: bool) -> None:
    refresh_guard = (
        """
                IF NEW.state = 'active' AND NEW.highest_sequence = OLD.highest_sequence
                   AND (NEW.latest_inbox_id IS DISTINCT FROM OLD.latest_inbox_id
                        OR NEW.latest_stream_position IS DISTINCT FROM OLD.latest_stream_position
                        OR NEW.latest_event_id IS DISTINCT FROM OLD.latest_event_id
                        OR NEW.latest_payload_hash IS DISTINCT FROM OLD.latest_payload_hash
                        OR NEW.last_seen_event_id IS DISTINCT FROM OLD.last_seen_event_id
                        OR NEW.last_seen_payload_hash IS DISTINCT FROM OLD.last_seen_payload_hash
                        OR NEW.last_seen_received_at IS DISTINCT FROM OLD.last_seen_received_at
                        OR (
                            NEW.latest_semantic_hash IS DISTINCT FROM OLD.latest_semantic_hash
                            AND NOT (
                                OLD.latest_semantic_hash IS NOT NULL
                                AND NEW.latest_semantic_hash IS NULL
                            )
                        )
                        OR NEW.captured_at IS DISTINCT FROM OLD.captured_at
                        OR NEW.freshness_deadline IS DISTINCT FROM OLD.freshness_deadline
                        OR NEW.health IS DISTINCT FROM OLD.health) THEN
                    RAISE EXCEPTION 'v2 runtime observation head cannot rebind a sequence';
                END IF;
                IF NEW.state = 'active' AND NEW.highest_sequence > OLD.highest_sequence
                   AND NEW.latest_stream_position = OLD.latest_stream_position
                   AND (NEW.latest_inbox_id IS DISTINCT FROM OLD.latest_inbox_id
                        OR NEW.latest_event_id IS DISTINCT FROM OLD.latest_event_id
                        OR NEW.latest_payload_hash IS DISTINCT FROM OLD.latest_payload_hash
                        OR NEW.latest_semantic_hash IS DISTINCT FROM OLD.latest_semantic_hash
                        OR NEW.health IS DISTINCT FROM OLD.health) THEN
                    RAISE EXCEPTION 'v2 runtime observation heartbeat refresh is invalid';
                END IF;
                IF NEW.state = 'active' AND NEW.highest_sequence > OLD.highest_sequence
                   AND NEW.latest_stream_position < OLD.latest_stream_position THEN
                    RAISE EXCEPTION 'v2 runtime observation head stream cannot regress';
                END IF;
"""
        if coalesced_heartbeats
        else """
                IF NEW.state = 'active' AND NEW.highest_sequence = OLD.highest_sequence
                   AND (NEW.latest_inbox_id IS DISTINCT FROM OLD.latest_inbox_id
                        OR NEW.latest_stream_position IS DISTINCT FROM OLD.latest_stream_position
                        OR NEW.latest_event_id IS DISTINCT FROM OLD.latest_event_id
                        OR NEW.latest_payload_hash IS DISTINCT FROM OLD.latest_payload_hash
                        OR NEW.captured_at IS DISTINCT FROM OLD.captured_at
                        OR NEW.freshness_deadline IS DISTINCT FROM OLD.freshness_deadline
                        OR NEW.health IS DISTINCT FROM OLD.health) THEN
                    RAISE EXCEPTION 'v2 runtime observation head cannot rebind a sequence';
                END IF;
                IF NEW.state = 'active' AND NEW.highest_sequence > OLD.highest_sequence
                   AND NEW.latest_stream_position <= OLD.latest_stream_position THEN
                    RAISE EXCEPTION 'v2 runtime observation head stream must advance';
                END IF;
"""
    )
    retirement_fields = (
        """
                        OR NEW.last_seen_event_id IS DISTINCT FROM OLD.last_seen_event_id
                        OR NEW.last_seen_payload_hash IS DISTINCT FROM OLD.last_seen_payload_hash
                        OR NEW.last_seen_received_at IS DISTINCT FROM OLD.last_seen_received_at
                        OR NEW.latest_semantic_hash IS DISTINCT FROM OLD.latest_semantic_hash"""
        if coalesced_heartbeats
        else ""
    )
    receive_time_guard = (
        """
                IF OLD.last_seen_received_at IS NOT NULL AND NEW.state = 'active'
                   AND NEW.last_seen_received_at < OLD.last_seen_received_at THEN
                    RAISE EXCEPTION 'v2 runtime observation receive time cannot regress';
                END IF;
"""
        if coalesced_heartbeats
        else ""
    )
    op.execute(
        sa.text(
            f"""
            CREATE OR REPLACE FUNCTION enforce_v2_runtime_head_immutability()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'v2 runtime observation heads are permanent';
                END IF;
                IF OLD.environment_id IS DISTINCT FROM NEW.environment_id
                   OR OLD.boot_session_id IS DISTINCT FROM NEW.boot_session_id
                   OR OLD.deployment_id IS DISTINCT FROM NEW.deployment_id
                   OR OLD.generation IS DISTINCT FROM NEW.generation
                   OR OLD.manifest_etag IS DISTINCT FROM NEW.manifest_etag
                   OR OLD.apply_receipt_id IS DISTINCT FROM NEW.apply_receipt_id
                   OR OLD.boot_nonce IS DISTINCT FROM NEW.boot_nonce
                   OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
                    RAISE EXCEPTION 'v2 runtime observation head binding is immutable';
                END IF;
                IF OLD.authorized_successor_boot_session_id IS NOT NULL
                   AND NEW.authorized_successor_boot_session_id
                        IS DISTINCT FROM OLD.authorized_successor_boot_session_id THEN
                    RAISE EXCEPTION
                        'v2 runtime observation authorized successor is immutable';
                END IF;
                IF OLD.state = 'retired' AND NEW IS DISTINCT FROM OLD THEN
                    RAISE EXCEPTION 'retired v2 runtime observation head is immutable';
                END IF;
                IF NEW.highest_sequence < OLD.highest_sequence
                   OR NEW.latest_stream_position < OLD.latest_stream_position THEN
                    RAISE EXCEPTION 'v2 runtime observation head high-water cannot regress';
                END IF;
                IF OLD.captured_at IS NOT NULL AND NEW.state = 'active'
                   AND (NEW.captured_at IS NULL OR NEW.captured_at < OLD.captured_at) THEN
                    RAISE EXCEPTION 'v2 runtime observation capture time cannot regress';
                END IF;
                IF OLD.freshness_deadline IS NOT NULL AND NEW.state = 'active'
                   AND (NEW.freshness_deadline IS NULL
                        OR NEW.freshness_deadline < OLD.freshness_deadline) THEN
                    RAISE EXCEPTION 'v2 runtime observation freshness cannot regress';
                END IF;
{receive_time_guard}
{refresh_guard}
                IF NEW.state = 'retired'
                   AND (NEW.highest_sequence IS DISTINCT FROM OLD.highest_sequence
                        OR NEW.latest_stream_position IS DISTINCT FROM OLD.latest_stream_position
                        OR NEW.latest_event_id IS DISTINCT FROM OLD.latest_event_id
                        OR NEW.latest_payload_hash IS DISTINCT FROM OLD.latest_payload_hash
{retirement_fields}) THEN
                    RAISE EXCEPTION 'v2 runtime observation tombstone high-water is immutable';
                END IF;
                RETURN NEW;
            END;
            $$;
            """
        )
    )

    inbox_sequence_match = "<=" if coalesced_heartbeats else "="
    op.execute(
        sa.text(
            f"""
            CREATE OR REPLACE FUNCTION enforce_v2_runtime_head_inbox_reference()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
                IF NEW.state = 'active'
                   AND (NEW.latest_inbox_id IS NULL
                        OR NEW.latest_stream_position
                           IS DISTINCT FROM NEW.latest_inbox_id
                        OR NOT EXISTS (
                       SELECT 1
                       FROM v2_runtime_observation_inbox AS inbox
                       WHERE inbox.id = NEW.latest_inbox_id
                         AND inbox.environment_id = NEW.environment_id
                         AND inbox.deployment_id = NEW.deployment_id
                         AND inbox.boot_session_id = NEW.boot_session_id
                         AND inbox.sequence {inbox_sequence_match} NEW.highest_sequence
                         AND inbox.event_id = NEW.latest_event_id
                         AND inbox.payload_hash = NEW.latest_payload_hash
                   )) THEN
                    RAISE EXCEPTION
                        'v2 runtime observation head inbox reference does not match its binding';
                END IF;
                RETURN NEW;
            END;
            $$;
            """
        )
    )


def upgrade() -> None:
    op.add_column(
        "v2_runtime_observation_heads",
        sa.Column("last_seen_event_id", sa.String(length=128), nullable=True),
    )
    op.add_column(
        "v2_runtime_observation_heads",
        sa.Column("last_seen_payload_hash", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "v2_runtime_observation_heads",
        sa.Column("latest_semantic_hash", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "v2_runtime_observation_heads",
        sa.Column("last_seen_received_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute("DROP TRIGGER trg_v2_runtime_head_immutability ON v2_runtime_observation_heads")
    op.execute(
        sa.text(
            """
            UPDATE v2_runtime_observation_heads AS head
            SET last_seen_event_id = head.latest_event_id,
                last_seen_payload_hash = head.latest_payload_hash,
                last_seen_received_at = inbox.received_at
            FROM v2_runtime_observation_inbox AS inbox
            WHERE inbox.event_id = head.latest_event_id
              AND inbox.environment_id = head.environment_id
              AND inbox.boot_session_id = head.boot_session_id
              AND inbox.payload_hash = head.latest_payload_hash
            """
        )
    )
    op.alter_column("v2_runtime_observation_heads", "last_seen_event_id", nullable=False)
    op.alter_column("v2_runtime_observation_heads", "last_seen_payload_hash", nullable=False)
    op.alter_column("v2_runtime_observation_heads", "last_seen_received_at", nullable=False)
    op.create_check_constraint(
        "ck_v2_runtime_observation_heads_last_seen_payload_hash",
        "v2_runtime_observation_heads",
        "last_seen_payload_hash ~ '^[0-9a-f]{64}$'",
    )
    op.create_check_constraint(
        "ck_v2_runtime_observation_heads_semantic_hash",
        "v2_runtime_observation_heads",
        "latest_semantic_hash IS NULL OR latest_semantic_hash ~ '^[0-9a-f]{64}$'",
    )
    _replace_head_guards(coalesced_heartbeats=True)
    op.execute(
        "CREATE TRIGGER trg_v2_runtime_head_immutability "
        "BEFORE UPDATE OR DELETE ON v2_runtime_observation_heads "
        "FOR EACH ROW EXECUTE FUNCTION enforce_v2_runtime_head_immutability()"
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER trg_v2_runtime_head_immutability ON v2_runtime_observation_heads")
    op.execute("DROP TRIGGER trg_v2_runtime_head_inbox_reference ON v2_runtime_observation_heads")
    op.execute(
        sa.text(
            """
            UPDATE v2_runtime_observation_heads AS head
            SET highest_sequence = inbox.sequence,
                captured_at = inbox.captured_at,
                freshness_deadline = inbox.freshness_deadline,
                health = inbox.health
            FROM v2_runtime_observation_inbox AS inbox
            WHERE head.state = 'active'
              AND inbox.id = head.latest_inbox_id
            """
        )
    )
    _replace_head_guards(coalesced_heartbeats=False)
    op.execute(
        "CREATE TRIGGER trg_v2_runtime_head_immutability "
        "BEFORE UPDATE OR DELETE ON v2_runtime_observation_heads "
        "FOR EACH ROW EXECUTE FUNCTION enforce_v2_runtime_head_immutability()"
    )
    op.execute(
        "CREATE TRIGGER trg_v2_runtime_head_inbox_reference "
        "BEFORE INSERT OR UPDATE ON v2_runtime_observation_heads "
        "FOR EACH ROW EXECUTE FUNCTION enforce_v2_runtime_head_inbox_reference()"
    )
    op.drop_constraint(
        "ck_v2_runtime_observation_heads_semantic_hash",
        "v2_runtime_observation_heads",
        type_="check",
    )
    op.drop_constraint(
        "ck_v2_runtime_observation_heads_last_seen_payload_hash",
        "v2_runtime_observation_heads",
        type_="check",
    )
    op.drop_column("v2_runtime_observation_heads", "latest_semantic_hash")
    op.drop_column("v2_runtime_observation_heads", "last_seen_received_at")
    op.drop_column("v2_runtime_observation_heads", "last_seen_payload_hash")
    op.drop_column("v2_runtime_observation_heads", "last_seen_event_id")
