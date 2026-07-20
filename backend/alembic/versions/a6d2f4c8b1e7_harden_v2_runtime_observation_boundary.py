"""Harden the clean-v2 runtime observation boundary.

Revision ID: a6d2f4c8b1e7
Revises: 4c8f2a1d7e9b
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "a6d2f4c8b1e7"
down_revision: str | Sequence[str] | None = "4c8f2a1d7e9b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_RUNTIME_DEPLOYMENT_KEY_CHECK = (
    "runtime_deployment_id IS NULL OR (managed AND environment_id IS NOT NULL "
    "AND scopes IS NOT NULL AND cardinality(scopes) > 0 AND scopes <@ "
    "ARRAY['runtime-observations:write','sessions:write',"
    "'skills:read','skills:write']::varchar[] "
    "AND 'runtime-observations:write' = ANY(scopes))"
)

_WORKLOAD_SCOPE_CHECK = (
    "cardinality(allowed_scopes) > 0 AND allowed_scopes <@ "
    "ARRAY['platform:agents:create','platform:agents:delete',"
    "'platform:runtime-state:write','platform:keys:mint',"
    "'platform:keys:revoke','platform:runtime-observations:consume',"
    "'platform:runtime-environments:retire']::varchar[]"
)

_PREVIOUS_RUNTIME_DEPLOYMENT_KEY_CHECK = (
    "runtime_deployment_id IS NULL OR (managed AND environment_id IS NOT NULL)"
)

_PREVIOUS_WORKLOAD_SCOPE_CHECK = (
    "cardinality(allowed_scopes) > 0 AND allowed_scopes <@ "
    "ARRAY['platform:agents:create','platform:agents:delete',"
    "'platform:runtime-state:write','platform:keys:mint',"
    "'platform:keys:revoke','platform:runtime-observations:read']::varchar[]"
)

_FENCE_RETIREMENT_CHECK = (
    "(state = 'active' AND retirement_id IS NULL "
    "AND retirement_receipt_id IS NULL AND retirement_receipt IS NULL "
    "AND retired_at IS NULL AND final_cursor IS NULL "
    "AND final_stream_position IS NULL AND final_session_high_waters IS NULL) "
    "OR (state = 'retired' AND retirement_id IS NOT NULL "
    "AND retirement_receipt_id IS NOT NULL AND retirement_receipt IS NOT NULL "
    "AND retired_at IS NOT NULL AND final_cursor IS NOT NULL "
    "AND final_stream_position IS NOT NULL "
    "AND final_stream_position = stream_high_water "
    "AND final_session_high_waters IS NOT NULL)"
)

_PREVIOUS_FENCE_RETIREMENT_CHECK = (
    "(state = 'active' AND retirement_id IS NULL "
    "AND retirement_receipt_id IS NULL AND retirement_receipt IS NULL "
    "AND retired_at IS NULL AND final_cursor IS NULL "
    "AND final_stream_position IS NULL AND final_session_high_waters IS NULL) "
    "OR (state = 'retired' AND retirement_id IS NOT NULL "
    "AND retirement_receipt_id IS NOT NULL AND retirement_receipt IS NOT NULL "
    "AND retired_at IS NOT NULL AND final_cursor IS NOT NULL "
    "AND final_stream_position IS NOT NULL "
    "AND final_session_high_waters IS NOT NULL)"
)

_HEAD_LIFECYCLE_CHECK = (
    "(state = 'active' AND latest_inbox_id IS NOT NULL "
    "AND latest_stream_position = latest_inbox_id "
    "AND latest_event_id IS NOT NULL AND captured_at IS NOT NULL "
    "AND freshness_deadline IS NOT NULL AND health IS NOT NULL "
    "AND tombstoned_at IS NULL) "
    "OR (state = 'retired' AND latest_inbox_id IS NULL "
    "AND latest_event_id IS NOT NULL AND captured_at IS NULL "
    "AND freshness_deadline IS NULL AND health IS NULL "
    "AND tombstoned_at IS NOT NULL)"
)

_PREVIOUS_HEAD_LIFECYCLE_CHECK = (
    "(state = 'active' AND latest_event_id IS NOT NULL "
    "AND captured_at IS NOT NULL AND freshness_deadline IS NOT NULL "
    "AND health IS NOT NULL AND tombstoned_at IS NULL) "
    "OR (state = 'retired' AND latest_inbox_id IS NULL "
    "AND latest_event_id IS NOT NULL AND captured_at IS NULL "
    "AND freshness_deadline IS NULL AND health IS NULL "
    "AND tombstoned_at IS NOT NULL)"
)


def _create_immutability_guards() -> None:
    op.execute(
        sa.text(
            """
            CREATE FUNCTION enforce_v2_runtime_fence_immutability()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'v2 runtime environment fences are permanent';
                END IF;
                IF OLD.environment_id IS DISTINCT FROM NEW.environment_id
                   OR OLD.owner_id IS DISTINCT FROM NEW.owner_id
                   OR OLD.deployment_id IS DISTINCT FROM NEW.deployment_id
                   OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
                    RAISE EXCEPTION 'v2 runtime environment fence binding is immutable';
                END IF;
                IF OLD.state = 'retired'
                   AND (OLD.environment_id IS DISTINCT FROM NEW.environment_id
                        OR OLD.owner_id IS DISTINCT FROM NEW.owner_id
                        OR OLD.deployment_id IS DISTINCT FROM NEW.deployment_id
                        OR OLD.state IS DISTINCT FROM NEW.state
                        OR OLD.stream_high_water IS DISTINCT FROM NEW.stream_high_water
                        OR OLD.retirement_id IS DISTINCT FROM NEW.retirement_id
                        OR OLD.retirement_receipt_id IS DISTINCT FROM NEW.retirement_receipt_id
                        OR OLD.retirement_receipt IS DISTINCT FROM NEW.retirement_receipt
                        OR OLD.retired_at IS DISTINCT FROM NEW.retired_at
                        OR OLD.final_cursor IS DISTINCT FROM NEW.final_cursor
                        OR OLD.final_stream_position IS DISTINCT FROM NEW.final_stream_position
                        OR OLD.final_session_high_waters
                           IS DISTINCT FROM NEW.final_session_high_waters
                        OR OLD.created_at IS DISTINCT FROM NEW.created_at) THEN
                    RAISE EXCEPTION
                        'retired v2 runtime environment receipt and high-waters are immutable';
                END IF;
                IF NEW.stream_high_water < OLD.stream_high_water
                   OR NEW.replay_floor_stream_position < OLD.replay_floor_stream_position THEN
                    RAISE EXCEPTION 'v2 runtime environment fence high-water cannot regress';
                END IF;
                IF OLD.replay_floor_advanced_at IS NOT NULL
                   AND (NEW.replay_floor_advanced_at IS NULL
                        OR NEW.replay_floor_advanced_at < OLD.replay_floor_advanced_at) THEN
                    RAISE EXCEPTION
                        'v2 runtime environment replay-floor time cannot regress';
                END IF;
                IF NEW.replay_floor_stream_position > OLD.replay_floor_stream_position
                   AND NEW.replay_floor_advanced_at IS NULL THEN
                    RAISE EXCEPTION
                        'v2 runtime environment replay-floor advance requires a timestamp';
                END IF;
                IF OLD.state = 'retired'
                   AND NEW.replay_floor_stream_position = OLD.replay_floor_stream_position
                   AND (NEW.replay_floor_advanced_at
                            IS DISTINCT FROM OLD.replay_floor_advanced_at
                        OR NEW.replay_floor_session_high_waters
                            IS DISTINCT FROM OLD.replay_floor_session_high_waters) THEN
                    RAISE EXCEPTION
                        'retired v2 runtime environment replay metadata requires floor advance';
                END IF;
                RETURN NEW;
            END;
            $$;

            CREATE TRIGGER trg_v2_runtime_fence_immutability
            BEFORE UPDATE OR DELETE ON v2_runtime_environment_fences
            FOR EACH ROW EXECUTE FUNCTION enforce_v2_runtime_fence_immutability();

            CREATE FUNCTION enforce_v2_runtime_inbox_immutability()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION
                        'v2 runtime observation inbox identities are permanent';
                END IF;
                IF NEW IS NOT DISTINCT FROM OLD THEN
                    RETURN NEW;
                END IF;
                IF OLD.payload_purged_at IS NULL
                   AND NEW.payload_purged_at IS NOT NULL
                   AND NEW.diagnostics = '{}'::jsonb
                   AND OLD.id IS NOT DISTINCT FROM NEW.id
                   AND OLD.environment_id IS NOT DISTINCT FROM NEW.environment_id
                   AND OLD.deployment_id IS NOT DISTINCT FROM NEW.deployment_id
                   AND OLD.generation IS NOT DISTINCT FROM NEW.generation
                   AND OLD.manifest_etag IS NOT DISTINCT FROM NEW.manifest_etag
                   AND OLD.apply_receipt_id IS NOT DISTINCT FROM NEW.apply_receipt_id
                   AND OLD.boot_nonce IS NOT DISTINCT FROM NEW.boot_nonce
                   AND OLD.boot_session_id IS NOT DISTINCT FROM NEW.boot_session_id
                   AND OLD.sequence IS NOT DISTINCT FROM NEW.sequence
                   AND OLD.event_id IS NOT DISTINCT FROM NEW.event_id
                   AND OLD.reported_at IS NOT DISTINCT FROM NEW.reported_at
                   AND OLD.captured_at IS NOT DISTINCT FROM NEW.captured_at
                   AND OLD.received_at IS NOT DISTINCT FROM NEW.received_at
                   AND OLD.freshness_deadline IS NOT DISTINCT FROM NEW.freshness_deadline
                   AND OLD.payload_hash IS NOT DISTINCT FROM NEW.payload_hash
                   AND OLD.health IS NOT DISTINCT FROM NEW.health THEN
                    RETURN NEW;
                END IF;
                RAISE EXCEPTION 'v2 runtime observation inbox events are immutable';
            END;
            $$;

            CREATE TRIGGER trg_v2_runtime_inbox_immutability
            BEFORE UPDATE OR DELETE ON v2_runtime_observation_inbox
            FOR EACH ROW EXECUTE FUNCTION enforce_v2_runtime_inbox_immutability();

            CREATE FUNCTION enforce_v2_runtime_head_immutability()
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

            CREATE TRIGGER trg_v2_runtime_head_immutability
            BEFORE UPDATE OR DELETE ON v2_runtime_observation_heads
            FOR EACH ROW EXECUTE FUNCTION enforce_v2_runtime_head_immutability();

            CREATE FUNCTION enforce_v2_runtime_head_inbox_reference()
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
                         AND inbox.sequence = NEW.highest_sequence
                         AND inbox.event_id = NEW.latest_event_id
                         AND inbox.payload_hash = NEW.latest_payload_hash
                   )) THEN
                    RAISE EXCEPTION
                        'v2 runtime observation head inbox reference does not match its binding';
                END IF;
                RETURN NEW;
            END;
            $$;

            CREATE TRIGGER trg_v2_runtime_head_inbox_reference
            BEFORE INSERT OR UPDATE ON v2_runtime_observation_heads
            FOR EACH ROW EXECUTE FUNCTION enforce_v2_runtime_head_inbox_reference();

            CREATE FUNCTION enforce_v2_runtime_cursor_immutability()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'v2 runtime observation consumer cursors are permanent';
                END IF;
                IF OLD.environment_id IS DISTINCT FROM NEW.environment_id
                   OR OLD.consumer_id IS DISTINCT FROM NEW.consumer_id
                   OR OLD.deployment_id IS DISTINCT FROM NEW.deployment_id
                   OR OLD.required IS DISTINCT FROM NEW.required
                   OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
                    RAISE EXCEPTION 'v2 runtime observation consumer binding is immutable';
                END IF;
                IF NEW.acked_stream_position < OLD.acked_stream_position THEN
                    RAISE EXCEPTION 'v2 runtime observation acknowledgement cannot regress';
                END IF;
                IF OLD.expiry_boundary_stream_position IS NOT NULL
                   AND (NEW.expiry_boundary_stream_position IS NULL
                        OR NEW.expiry_boundary_stream_position
                           < OLD.expiry_boundary_stream_position) THEN
                    RAISE EXCEPTION 'v2 runtime observation expiry boundary cannot regress';
                END IF;
                IF OLD.state = 'active'
                   AND NEW.cursor_epoch IS DISTINCT FROM OLD.cursor_epoch THEN
                    RAISE EXCEPTION 'active v2 runtime observation cursor epoch is immutable';
                END IF;
                IF OLD.state = 'expired' AND NEW.state = 'expired'
                   AND NEW.cursor_epoch IS DISTINCT FROM OLD.cursor_epoch THEN
                    RAISE EXCEPTION 'expired v2 runtime observation cursor epoch is immutable';
                END IF;
                IF OLD.state = 'expired' AND NEW.state = 'active'
                   AND (NEW.cursor_epoch IS NOT DISTINCT FROM OLD.cursor_epoch
                        OR OLD.expiry_boundary_stream_position IS NULL
                        OR NEW.acked_stream_position
                           < OLD.expiry_boundary_stream_position) THEN
                    RAISE EXCEPTION 'v2 runtime observation cursor reset is invalid';
                END IF;
                RETURN NEW;
            END;
            $$;

            CREATE TRIGGER trg_v2_runtime_cursor_immutability
            BEFORE UPDATE OR DELETE ON v2_runtime_observation_consumer_cursors
            FOR EACH ROW EXECUTE FUNCTION enforce_v2_runtime_cursor_immutability();

            CREATE FUNCTION enforce_runtime_deployment_key_binding_immutability()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
                IF OLD.runtime_deployment_id IS DISTINCT FROM NEW.runtime_deployment_id THEN
                    RAISE EXCEPTION 'runtime deployment key binding is immutable';
                END IF;
                IF OLD.runtime_deployment_id IS NOT NULL
                   AND (OLD.environment_id IS DISTINCT FROM NEW.environment_id
                        OR OLD.user_id IS DISTINCT FROM NEW.user_id) THEN
                    RAISE EXCEPTION 'runtime deployment key authority is immutable';
                END IF;
                RETURN NEW;
            END;
            $$;

            CREATE TRIGGER trg_runtime_deployment_key_binding_immutability
            BEFORE UPDATE ON api_keys
            FOR EACH ROW EXECUTE FUNCTION enforce_runtime_deployment_key_binding_immutability();
            """
        )
    )


def _drop_immutability_guards() -> None:
    op.execute(
        sa.text(
            """
            DROP TRIGGER IF EXISTS trg_runtime_deployment_key_binding_immutability ON api_keys;
            DROP FUNCTION IF EXISTS enforce_runtime_deployment_key_binding_immutability();
            DROP TRIGGER IF EXISTS trg_v2_runtime_cursor_immutability
                ON v2_runtime_observation_consumer_cursors;
            DROP FUNCTION IF EXISTS enforce_v2_runtime_cursor_immutability();
            DROP TRIGGER IF EXISTS trg_v2_runtime_head_immutability
                ON v2_runtime_observation_heads;
            DROP FUNCTION IF EXISTS enforce_v2_runtime_head_immutability();
            DROP TRIGGER IF EXISTS trg_v2_runtime_head_inbox_reference
                ON v2_runtime_observation_heads;
            DROP FUNCTION IF EXISTS enforce_v2_runtime_head_inbox_reference();
            DROP TRIGGER IF EXISTS trg_v2_runtime_inbox_immutability
                ON v2_runtime_observation_inbox;
            DROP FUNCTION IF EXISTS enforce_v2_runtime_inbox_immutability();
            DROP TRIGGER IF EXISTS trg_v2_runtime_fence_immutability
                ON v2_runtime_environment_fences;
            DROP FUNCTION IF EXISTS enforce_v2_runtime_fence_immutability();
            """
        )
    )


def upgrade() -> None:
    op.execute(
        sa.text(
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1
                    FROM api_keys
                    WHERE runtime_deployment_id IS NOT NULL
                      AND NOT (
                          managed
                          AND environment_id IS NOT NULL
                          AND scopes IS NOT NULL
                          AND cardinality(scopes) > 0
                          AND scopes <@ ARRAY[
                              'runtime-observations:write', 'sessions:write',
                              'skills:read', 'skills:write'
                          ]::varchar[]
                          AND 'runtime-observations:write' = ANY(scopes)
                      )
                ) THEN
                    RAISE EXCEPTION
                        'invalid deployment-bound runtime credentials must be '
                        'deleted, unbound, or narrowed before upgrade';
                END IF;
            END;
            $$;
            """
        )
    )
    op.drop_constraint(
        "ck_api_keys_runtime_deployment_binding",
        "api_keys",
        type_="check",
    )
    op.create_check_constraint(
        "ck_api_keys_runtime_deployment_binding",
        "api_keys",
        _RUNTIME_DEPLOYMENT_KEY_CHECK,
    )

    op.execute(
        sa.text(
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1
                    FROM v2_runtime_environment_fences
                    WHERE state = 'retired'
                      AND final_stream_position IS DISTINCT FROM stream_high_water
                ) THEN
                    RAISE EXCEPTION
                        'retired v2 runtime fence final position must match its high-water';
                END IF;
                IF EXISTS (
                    SELECT 1
                    FROM v2_runtime_observation_heads
                    WHERE state = 'active'
                      AND (latest_inbox_id IS NULL
                           OR latest_stream_position IS DISTINCT FROM latest_inbox_id)
                ) THEN
                    RAISE EXCEPTION
                        'active v2 runtime heads require an exact inbox position';
                END IF;
            END;
            $$;
            """
        )
    )
    op.drop_constraint(
        "ck_v2_runtime_environment_fences_retirement",
        "v2_runtime_environment_fences",
        type_="check",
    )
    op.create_check_constraint(
        "ck_v2_runtime_environment_fences_retirement",
        "v2_runtime_environment_fences",
        _FENCE_RETIREMENT_CHECK,
    )
    op.drop_constraint(
        "ck_v2_runtime_observation_heads_lifecycle",
        "v2_runtime_observation_heads",
        type_="check",
    )
    op.create_check_constraint(
        "ck_v2_runtime_observation_heads_lifecycle",
        "v2_runtime_observation_heads",
        _HEAD_LIFECYCLE_CHECK,
    )

    op.add_column(
        "v2_runtime_observation_inbox",
        sa.Column("reported_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute(
        sa.text(
            "UPDATE v2_runtime_observation_inbox "
            "SET reported_at = captured_at WHERE reported_at IS NULL"
        )
    )
    op.alter_column(
        "v2_runtime_observation_inbox",
        "reported_at",
        existing_type=sa.DateTime(timezone=True),
        nullable=False,
    )
    op.add_column(
        "v2_runtime_observation_inbox",
        sa.Column("payload_purged_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_check_constraint(
        "ck_v2_runtime_observation_inbox_payload_compaction",
        "v2_runtime_observation_inbox",
        "payload_purged_at IS NULL OR diagnostics = '{}'::jsonb",
    )
    op.create_index(
        "ix_v2_runtime_observation_inbox_pending_retention",
        "v2_runtime_observation_inbox",
        ["received_at"],
        postgresql_where=sa.text("payload_purged_at IS NULL"),
    )

    # Normalize already-retired #429 receipts to the revision-16 Hosted port.
    # Keep the internal receipt UUID in its typed fence column for audit/replay
    # correlation, but do not expose it in the narrow public receipt JSON.
    op.execute(
        sa.text(
            """
            UPDATE v2_runtime_environment_fences AS fence
            SET retirement_receipt = jsonb_build_object(
                'environmentReference', fence.environment_id::text,
                'expectedDeploymentBinding', fence.deployment_id,
                'retirementId', fence.retirement_id,
                'retiredAt', replace(
                    fence.retirement_receipt->>'retiredAt',
                    '+00:00',
                    'Z'
                ),
                'finalCursor', fence.final_cursor,
                'finalSessionHighWaterMarks', COALESCE(
                    (
                        SELECT jsonb_agg(
                            jsonb_build_object(
                                'bootSessionId', high_water.key,
                                'sequence', high_water.value::bigint
                            )
                            ORDER BY high_water.key
                        )
                        FROM jsonb_each_text(
                            fence.final_session_high_waters::jsonb
                        ) AS high_water
                    ),
                    '[]'::jsonb
                )
            )
            WHERE fence.state = 'retired'
            """
        )
    )

    op.execute(
        sa.text(
            """
            UPDATE platform_workload_clients
            SET allowed_scopes = array_replace(
                allowed_scopes,
                'platform:runtime-observations:read',
                'platform:runtime-observations:consume'
            )
            WHERE 'platform:runtime-observations:read' = ANY(allowed_scopes)
            """
        )
    )
    op.drop_constraint(
        "ck_platform_workload_clients_allowed_scopes",
        "platform_workload_clients",
        type_="check",
    )
    op.create_check_constraint(
        "ck_platform_workload_clients_allowed_scopes",
        "platform_workload_clients",
        _WORKLOAD_SCOPE_CHECK,
    )
    _create_immutability_guards()


def downgrade() -> None:
    _drop_immutability_guards()
    op.drop_constraint(
        "ck_v2_runtime_observation_heads_lifecycle",
        "v2_runtime_observation_heads",
        type_="check",
    )
    op.create_check_constraint(
        "ck_v2_runtime_observation_heads_lifecycle",
        "v2_runtime_observation_heads",
        _PREVIOUS_HEAD_LIFECYCLE_CHECK,
    )
    op.drop_constraint(
        "ck_v2_runtime_environment_fences_retirement",
        "v2_runtime_environment_fences",
        type_="check",
    )
    op.create_check_constraint(
        "ck_v2_runtime_environment_fences_retirement",
        "v2_runtime_environment_fences",
        _PREVIOUS_FENCE_RETIREMENT_CHECK,
    )
    # Restore the #429 receipt shape for code running at the downgraded
    # revision. Payload compaction itself is intentionally irreversible.
    op.execute(
        sa.text(
            """
            UPDATE v2_runtime_environment_fences AS fence
            SET retirement_receipt = jsonb_build_object(
                'retirementReceiptId', fence.retirement_receipt_id::text,
                'retirementId', fence.retirement_id,
                'environmentId', fence.environment_id::text,
                'deploymentId', fence.deployment_id,
                'retiredAt', fence.retirement_receipt->>'retiredAt',
                'finalCursor', fence.final_cursor,
                'finalSessionHighWaterMarks', fence.final_session_high_waters
            )
            WHERE fence.state = 'retired'
            """
        )
    )
    op.execute(
        sa.text(
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1
                    FROM platform_workload_clients
                    WHERE 'platform:runtime-environments:retire' = ANY(allowed_scopes)
                ) THEN
                    RAISE EXCEPTION
                        'retirement-scoped workload clients must be removed before downgrade';
                END IF;
            END;
            $$;
            """
        )
    )
    op.drop_constraint(
        "ck_platform_workload_clients_allowed_scopes",
        "platform_workload_clients",
        type_="check",
    )
    op.execute(
        sa.text(
            """
            UPDATE platform_workload_clients
            SET allowed_scopes = array_replace(
                allowed_scopes,
                'platform:runtime-observations:consume',
                'platform:runtime-observations:read'
            )
            WHERE 'platform:runtime-observations:consume' = ANY(allowed_scopes)
            """
        )
    )
    op.create_check_constraint(
        "ck_platform_workload_clients_allowed_scopes",
        "platform_workload_clients",
        _PREVIOUS_WORKLOAD_SCOPE_CHECK,
    )

    op.drop_constraint(
        "ck_api_keys_runtime_deployment_binding",
        "api_keys",
        type_="check",
    )
    op.create_check_constraint(
        "ck_api_keys_runtime_deployment_binding",
        "api_keys",
        _PREVIOUS_RUNTIME_DEPLOYMENT_KEY_CHECK,
    )
    op.drop_index(
        "ix_v2_runtime_observation_inbox_pending_retention",
        table_name="v2_runtime_observation_inbox",
    )
    op.drop_constraint(
        "ck_v2_runtime_observation_inbox_payload_compaction",
        "v2_runtime_observation_inbox",
        type_="check",
    )
    op.drop_column("v2_runtime_observation_inbox", "payload_purged_at")
    op.execute(
        sa.text("ALTER TABLE v2_runtime_observation_inbox DROP COLUMN IF EXISTS reported_at")
    )
