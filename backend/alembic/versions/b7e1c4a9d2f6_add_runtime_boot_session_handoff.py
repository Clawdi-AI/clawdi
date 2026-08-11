"""Add causally fenced runtime boot-session handoff.

Revision ID: b7e1c4a9d2f6
Revises: a4f9c2e7d1b6
Create Date: 2026-08-11 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b7e1c4a9d2f6"
down_revision: str | Sequence[str] | None = "a4f9c2e7d1b6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _replace_head_guard(*, protect_successor: bool) -> None:
    successor_guard = (
        """
                IF OLD.authorized_successor_boot_session_id IS NOT NULL
                   AND NEW.authorized_successor_boot_session_id
                        IS DISTINCT FROM OLD.authorized_successor_boot_session_id THEN
                    RAISE EXCEPTION
                        'v2 runtime observation authorized successor is immutable';
                END IF;
"""
        if protect_successor
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
{successor_guard}
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
                IF NEW.state = 'retired'
                   AND (NEW.highest_sequence IS DISTINCT FROM OLD.highest_sequence
                        OR NEW.latest_stream_position IS DISTINCT FROM OLD.latest_stream_position
                        OR NEW.latest_event_id IS DISTINCT FROM OLD.latest_event_id
                        OR NEW.latest_payload_hash IS DISTINCT FROM OLD.latest_payload_hash) THEN
                    RAISE EXCEPTION 'v2 runtime observation tombstone high-water is immutable';
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
        sa.Column("authorized_successor_boot_session_id", sa.String(length=128), nullable=True),
    )
    _replace_head_guard(protect_successor=True)


def downgrade() -> None:
    _replace_head_guard(protect_successor=False)
    op.drop_column("v2_runtime_observation_heads", "authorized_successor_boot_session_id")
