from __future__ import annotations

import importlib.util
import json
import uuid
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect
from sqlalchemy.ext.asyncio import AsyncEngine

REVISION = "a6d2f4c8b1e7"
MIGRATION_FILENAME = f"{REVISION}_harden_v2_runtime_observation_boundary.py"


def _load_migration():
    migration_path = Path(__file__).parents[1] / "alembic" / "versions" / MIGRATION_FILENAME
    spec = importlib.util.spec_from_file_location(
        "runtime_observation_hardening_migration",
        migration_path,
    )
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def test_runtime_observation_hardening_migration_rejects_invalid_credentials_and_round_trips(
    engine: AsyncEngine,
) -> None:
    migration = _load_migration()
    schema = f"runtime_observation_hardening_{uuid.uuid4().hex}"
    tables = (
        "api_keys",
        "platform_workload_clients",
        "v2_runtime_environment_fences",
        "v2_runtime_observation_inbox",
        "v2_runtime_observation_heads",
        "v2_runtime_observation_consumer_cursors",
    )

    def run(sync_conn: sa.Connection) -> None:
        old_op = migration.op
        sync_conn.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
        try:
            for table in tables:
                sync_conn.execute(
                    sa.text(
                        f'CREATE TABLE "{schema}"."{table}" (LIKE public."{table}" INCLUDING ALL)'
                    )
                )
            sync_conn.execute(sa.text(f'SET search_path TO "{schema}"'))
            sync_conn.execute(
                sa.text(
                    """
                    ALTER TABLE api_keys
                    DROP CONSTRAINT ck_api_keys_runtime_deployment_binding;
                    ALTER TABLE api_keys
                    ADD CONSTRAINT ck_api_keys_runtime_deployment_binding
                    CHECK (
                        runtime_deployment_id IS NULL
                        OR (managed AND environment_id IS NOT NULL)
                    );
                    ALTER TABLE platform_workload_clients
                    DROP CONSTRAINT ck_platform_workload_clients_allowed_scopes;
                    ALTER TABLE platform_workload_clients
                    ADD CONSTRAINT ck_platform_workload_clients_allowed_scopes
                    CHECK (
                        cardinality(allowed_scopes) > 0
                        AND allowed_scopes <@ ARRAY[
                            'platform:agents:create',
                            'platform:agents:delete',
                            'platform:runtime-state:write',
                            'platform:keys:mint',
                            'platform:keys:revoke',
                            'platform:runtime-observations:read'
                        ]::varchar[]
                        );
                    ALTER TABLE v2_runtime_environment_fences
                    DROP CONSTRAINT ck_v2_runtime_environment_fences_retirement;
                    ALTER TABLE v2_runtime_environment_fences
                    ADD CONSTRAINT ck_v2_runtime_environment_fences_retirement
                    CHECK (
                        (state = 'active' AND retirement_id IS NULL
                         AND retirement_receipt_id IS NULL
                         AND retirement_receipt IS NULL AND retired_at IS NULL
                         AND final_cursor IS NULL AND final_stream_position IS NULL
                         AND final_session_high_waters IS NULL)
                        OR (state = 'retired' AND retirement_id IS NOT NULL
                            AND retirement_receipt_id IS NOT NULL
                            AND retirement_receipt IS NOT NULL
                            AND retired_at IS NOT NULL AND final_cursor IS NOT NULL
                            AND final_stream_position IS NOT NULL
                            AND final_session_high_waters IS NOT NULL)
                    );
                    ALTER TABLE v2_runtime_observation_heads
                    DROP CONSTRAINT ck_v2_runtime_observation_heads_lifecycle;
                    ALTER TABLE v2_runtime_observation_heads
                    ADD CONSTRAINT ck_v2_runtime_observation_heads_lifecycle
                    CHECK (
                        (state = 'active' AND latest_event_id IS NOT NULL
                         AND captured_at IS NOT NULL AND freshness_deadline IS NOT NULL
                         AND health IS NOT NULL AND tombstoned_at IS NULL)
                        OR (state = 'retired' AND latest_inbox_id IS NULL
                            AND latest_event_id IS NOT NULL AND captured_at IS NULL
                            AND freshness_deadline IS NULL AND health IS NULL
                            AND tombstoned_at IS NOT NULL)
                    );
                    ALTER TABLE v2_runtime_observation_inbox
                    DROP COLUMN IF EXISTS reported_at;
                    ALTER TABLE v2_runtime_observation_inbox
                    DROP COLUMN IF EXISTS payload_purged_at;
                    """
                )
            )
            retired_environment_id = uuid.uuid4()
            retired_receipt_id = uuid.uuid4()
            sync_conn.execute(
                sa.text(
                    """
                    INSERT INTO v2_runtime_environment_fences (
                        environment_id, owner_id, deployment_id, state,
                        stream_high_water, retirement_id, retirement_receipt_id,
                        retirement_receipt, retired_at, final_cursor,
                        final_stream_position, final_session_high_waters
                    ) VALUES (
                        :environment_id, :owner_id, 'deployment-retired', 'retired',
                        7, 'retirement-old-shape', :receipt_id,
                        CAST(:receipt AS jsonb),
                        '2026-07-20T00:00:00Z', 'old-final-cursor', 7,
                        '{"boot-b": 7, "boot-a": 3}'::jsonb
                    )
                    """
                ),
                {
                    "environment_id": retired_environment_id,
                    "owner_id": uuid.uuid4(),
                    "receipt_id": retired_receipt_id,
                    "receipt": json.dumps(
                        {
                            "retirementReceiptId": str(retired_receipt_id),
                            "retirementId": "retirement-old-shape",
                            "environmentId": str(retired_environment_id),
                            "deploymentId": "deployment-retired",
                            "retiredAt": "2026-07-20T00:00:00+00:00",
                            "finalCursor": "old-final-cursor",
                            "finalSessionHighWaterMarks": {"boot-b": 7, "boot-a": 3},
                        }
                    ),
                },
            )
            invalid_key_id = uuid.uuid4()
            sync_conn.execute(
                sa.text(
                    """
                    INSERT INTO api_keys (
                        id, user_id, key_hash, key_prefix, label, managed,
                        scopes, environment_id, runtime_deployment_id
                    ) VALUES (
                        :id, :user_id, :key_hash, 'clawdi_invalid', 'invalid-v2', true,
                        NULL, :environment_id, 'deployment-invalid'
                    )
                    """
                ),
                {
                    "id": invalid_key_id,
                    "user_id": uuid.uuid4(),
                    "key_hash": uuid.uuid4().hex + uuid.uuid4().hex,
                    "environment_id": uuid.uuid4(),
                },
            )
            migration.op = Operations(MigrationContext.configure(sync_conn))
            invalid_upgrade_savepoint = sync_conn.begin_nested()
            with pytest.raises(
                sa.exc.DBAPIError,
                match="invalid deployment-bound runtime credentials",
            ):
                migration.upgrade()
            invalid_upgrade_savepoint.rollback()

            sync_conn.execute(
                sa.text("DELETE FROM api_keys WHERE id = :id"), {"id": invalid_key_id}
            )
            missing_ingest_scope_key_id = uuid.uuid4()
            sync_conn.execute(
                sa.text(
                    """
                    INSERT INTO api_keys (
                        id, user_id, key_hash, key_prefix, label, managed,
                        scopes, environment_id, runtime_deployment_id
                    ) VALUES (
                        :id, :user_id, :key_hash, 'clawdi_oldv2', 'old-v2', true,
                        ARRAY['sessions:write']::varchar[],
                        :environment_id, 'deployment-old-v2'
                    )
                    """
                ),
                {
                    "id": missing_ingest_scope_key_id,
                    "user_id": uuid.uuid4(),
                    "key_hash": uuid.uuid4().hex + uuid.uuid4().hex,
                    "environment_id": uuid.uuid4(),
                },
            )
            missing_scope_upgrade_savepoint = sync_conn.begin_nested()
            with pytest.raises(
                sa.exc.DBAPIError,
                match="invalid deployment-bound runtime credentials",
            ):
                migration.upgrade()
            missing_scope_upgrade_savepoint.rollback()
            sync_conn.execute(
                sa.text("DELETE FROM api_keys WHERE id = :id"),
                {"id": missing_ingest_scope_key_id},
            )

            mismatched_fence_savepoint = sync_conn.begin_nested()
            sync_conn.execute(
                sa.text(
                    "UPDATE v2_runtime_environment_fences "
                    "SET final_stream_position = 6 WHERE environment_id = :environment_id"
                ),
                {"environment_id": retired_environment_id},
            )
            with pytest.raises(
                sa.exc.DBAPIError,
                match="final position must match its high-water",
            ):
                migration.upgrade()
            mismatched_fence_savepoint.rollback()

            invalid_head_environment_id = uuid.uuid4()
            sync_conn.execute(
                sa.text(
                    """
                    INSERT INTO v2_runtime_environment_fences (
                        environment_id, owner_id, deployment_id
                    ) VALUES (:environment_id, :owner_id, 'deployment-invalid-head')
                    """
                ),
                {
                    "environment_id": invalid_head_environment_id,
                    "owner_id": uuid.uuid4(),
                },
            )
            sync_conn.execute(
                sa.text(
                    """
                    INSERT INTO v2_runtime_observation_heads (
                        environment_id, boot_session_id, deployment_id,
                        generation, manifest_etag, apply_receipt_id, boot_nonce,
                        highest_sequence, latest_inbox_id, latest_stream_position,
                        latest_event_id, latest_payload_hash, captured_at,
                        freshness_deadline, health
                    ) VALUES (
                        :environment_id, 'invalid-active-head',
                        'deployment-invalid-head', 1, 'manifest-etag',
                        'apply-receipt-invalid', 'boot-nonce-invalid', 1,
                        NULL, 1, 'invalid-active-head-event', :payload_hash,
                        '2026-07-20T00:00:00Z', '2026-07-20T00:01:00Z', 'ok'
                    )
                    """
                ),
                {
                    "environment_id": invalid_head_environment_id,
                    "payload_hash": "a" * 64,
                },
            )
            invalid_head_upgrade_savepoint = sync_conn.begin_nested()
            with pytest.raises(
                sa.exc.DBAPIError,
                match="active v2 runtime heads require an exact inbox position",
            ):
                migration.upgrade()
            invalid_head_upgrade_savepoint.rollback()
            sync_conn.execute(
                sa.text(
                    "DELETE FROM v2_runtime_observation_heads "
                    "WHERE environment_id = :environment_id"
                ),
                {"environment_id": invalid_head_environment_id},
            )
            sync_conn.execute(
                sa.text(
                    "DELETE FROM v2_runtime_environment_fences "
                    "WHERE environment_id = :environment_id"
                ),
                {"environment_id": invalid_head_environment_id},
            )

            legacy_key_id = uuid.uuid4()
            sync_conn.execute(
                sa.text(
                    """
                    INSERT INTO api_keys (
                        id, user_id, key_hash, key_prefix, label, managed,
                        scopes, environment_id, runtime_deployment_id
                    ) VALUES (
                        :id, :user_id, :key_hash, 'clawdi_legacy', 'legacy-v1', false,
                        NULL, NULL, NULL
                    )
                    """
                ),
                {
                    "id": legacy_key_id,
                    "user_id": uuid.uuid4(),
                    "key_hash": uuid.uuid4().hex + uuid.uuid4().hex,
                },
            )
            migration.upgrade()

            normalized_receipt = sync_conn.scalar(
                sa.text(
                    "SELECT retirement_receipt "
                    "FROM v2_runtime_environment_fences WHERE environment_id = :environment_id"
                ),
                {"environment_id": retired_environment_id},
            )
            assert normalized_receipt == {
                "environmentReference": str(retired_environment_id),
                "expectedDeploymentBinding": "deployment-retired",
                "retirementId": "retirement-old-shape",
                "retiredAt": "2026-07-20T00:00:00Z",
                "finalCursor": "old-final-cursor",
                "finalSessionHighWaterMarks": [
                    {"bootSessionId": "boot-a", "sequence": 3},
                    {"bootSessionId": "boot-b", "sequence": 7},
                ],
            }

            checks = {
                check["name"]: check["sqltext"]
                for check in inspect(sync_conn).get_check_constraints(
                    "api_keys",
                    schema=schema,
                )
            }
            deployment_check = checks["ck_api_keys_runtime_deployment_binding"]
            assert "cardinality(scopes) > 0" in deployment_check
            assert "runtime-observations:write" in deployment_check
            assert "ANY" in deployment_check
            workload_checks = {
                check["name"]: check["sqltext"]
                for check in inspect(sync_conn).get_check_constraints(
                    "platform_workload_clients",
                    schema=schema,
                )
            }
            workload_check = workload_checks["ck_platform_workload_clients_allowed_scopes"]
            assert "platform:runtime-observations:consume" in workload_check
            assert "platform:runtime-environments:retire" in workload_check
            assert "platform:runtime-observations:read" not in workload_check
            fence_checks = {
                check["name"]: check["sqltext"]
                for check in inspect(sync_conn).get_check_constraints(
                    "v2_runtime_environment_fences",
                    schema=schema,
                )
            }
            assert (
                "final_stream_position = stream_high_water"
                in fence_checks["ck_v2_runtime_environment_fences_retirement"]
            )
            head_checks = {
                check["name"]: check["sqltext"]
                for check in inspect(sync_conn).get_check_constraints(
                    "v2_runtime_observation_heads",
                    schema=schema,
                )
            }
            head_lifecycle_check = head_checks["ck_v2_runtime_observation_heads_lifecycle"]
            assert "latest_inbox_id IS NOT NULL" in head_lifecycle_check
            assert "latest_stream_position = latest_inbox_id" in head_lifecycle_check

            invalid_retired_fence_savepoint = sync_conn.begin_nested()
            with pytest.raises(sa.exc.IntegrityError):
                sync_conn.execute(
                    sa.text(
                        """
                        INSERT INTO v2_runtime_environment_fences (
                            environment_id, owner_id, deployment_id, state,
                            stream_high_water, retirement_id, retirement_receipt_id,
                            retirement_receipt, retired_at, final_cursor,
                            final_stream_position, final_session_high_waters
                        ) VALUES (
                            :environment_id, :owner_id, 'deployment-final-mismatch',
                            'retired', 7, 'retirement-final-mismatch', :receipt_id,
                            '{}'::jsonb, '2026-07-20T00:00:00Z', 'final-cursor',
                            6, '{}'::jsonb
                        )
                        """
                    ),
                    {
                        "environment_id": uuid.uuid4(),
                        "owner_id": uuid.uuid4(),
                        "receipt_id": uuid.uuid4(),
                    },
                )
            invalid_retired_fence_savepoint.rollback()

            invalid_insert_savepoint = sync_conn.begin_nested()
            with pytest.raises(sa.exc.IntegrityError):
                sync_conn.execute(
                    sa.text(
                        """
                        INSERT INTO api_keys (
                            id, user_id, key_hash, key_prefix, label, managed,
                            scopes, environment_id, runtime_deployment_id
                        ) VALUES (
                            :id, :user_id, :key_hash, 'clawdi_full', 'full-v2', true,
                            NULL, :environment_id, 'deployment-full'
                        )
                        """
                    ),
                    {
                        "id": uuid.uuid4(),
                        "user_id": uuid.uuid4(),
                        "key_hash": uuid.uuid4().hex + uuid.uuid4().hex,
                        "environment_id": uuid.uuid4(),
                    },
                )
            invalid_insert_savepoint.rollback()

            missing_ingest_scope_savepoint = sync_conn.begin_nested()
            with pytest.raises(sa.exc.IntegrityError):
                sync_conn.execute(
                    sa.text(
                        """
                        INSERT INTO api_keys (
                            id, user_id, key_hash, key_prefix, label, managed,
                            scopes, environment_id, runtime_deployment_id
                        ) VALUES (
                            :id, :user_id, :key_hash, 'clawdi_noscope',
                            'missing-v2-ingest-scope', true,
                            ARRAY['sessions:write']::varchar[],
                            :environment_id, 'deployment-missing-ingest-scope'
                        )
                        """
                    ),
                    {
                        "id": uuid.uuid4(),
                        "user_id": uuid.uuid4(),
                        "key_hash": uuid.uuid4().hex + uuid.uuid4().hex,
                        "environment_id": uuid.uuid4(),
                    },
                )
            missing_ingest_scope_savepoint.rollback()

            valid_bound_key_id = uuid.uuid4()
            sync_conn.execute(
                sa.text(
                    """
                    INSERT INTO api_keys (
                        id, user_id, key_hash, key_prefix, label, managed,
                        scopes, environment_id, runtime_deployment_id
                    ) VALUES (
                        :id, :user_id, :key_hash, 'clawdi_v2ok', 'valid-v2', true,
                        ARRAY['runtime-observations:write','sessions:write']::varchar[],
                        :environment_id, 'deployment-valid'
                    )
                    """
                ),
                {
                    "id": valid_bound_key_id,
                    "user_id": uuid.uuid4(),
                    "key_hash": uuid.uuid4().hex + uuid.uuid4().hex,
                    "environment_id": uuid.uuid4(),
                },
            )
            assert (
                sync_conn.scalar(
                    sa.text("SELECT count(*) FROM api_keys WHERE id = :id"),
                    {"id": valid_bound_key_id},
                )
                == 1
            )

            inbox_columns = {
                column["name"]
                for column in inspect(sync_conn).get_columns(
                    "v2_runtime_observation_inbox",
                    schema=schema,
                )
            }
            assert {"reported_at", "payload_purged_at"} <= inbox_columns

            environment_id = uuid.uuid4()
            owner_id = uuid.uuid4()
            sync_conn.execute(
                sa.text(
                    """
                    INSERT INTO v2_runtime_environment_fences (
                        environment_id, owner_id, deployment_id
                    ) VALUES (:environment_id, :owner_id, 'deployment-immutable')
                    """
                ),
                {"environment_id": environment_id, "owner_id": owner_id},
            )
            invalid_update_savepoint = sync_conn.begin_nested()
            with pytest.raises(sa.exc.DBAPIError, match="binding is immutable"):
                sync_conn.execute(
                    sa.text(
                        "UPDATE v2_runtime_environment_fences "
                        "SET owner_id = :owner_id WHERE environment_id = :environment_id"
                    ),
                    {"environment_id": environment_id, "owner_id": uuid.uuid4()},
                )
            invalid_update_savepoint.rollback()

            inbox_id = sync_conn.scalar(
                sa.text(
                    """
                    INSERT INTO v2_runtime_observation_inbox (
                        environment_id, deployment_id, generation, manifest_etag,
                        apply_receipt_id, boot_nonce, boot_session_id, sequence,
                        event_id, reported_at, captured_at, received_at,
                        freshness_deadline, payload_hash, health, diagnostics
                    ) VALUES (
                        :environment_id, 'deployment-immutable', 1, 'manifest-etag',
                        'apply-receipt-guard', 'boot-nonce-guard', 'guard-session', 1,
                        'guard-event', '2026-07-20T00:00:00Z',
                        '2026-07-20T00:00:00Z', '2026-07-20T00:00:01Z',
                        '2026-07-20T00:01:00Z', :payload_hash, 'ok',
                        '{"private":"diagnostic"}'::jsonb
                    ) RETURNING id
                    """
                ),
                {"environment_id": environment_id, "payload_hash": "b" * 64},
            )
            assert isinstance(inbox_id, int)

            null_head_reference_savepoint = sync_conn.begin_nested()
            with pytest.raises(
                sa.exc.DBAPIError,
                match="head inbox reference does not match its binding",
            ):
                sync_conn.execute(
                    sa.text(
                        """
                        INSERT INTO v2_runtime_observation_heads (
                            environment_id, boot_session_id, deployment_id,
                            generation, manifest_etag, apply_receipt_id, boot_nonce,
                            highest_sequence, latest_inbox_id, latest_stream_position,
                            latest_event_id, latest_payload_hash, captured_at,
                            freshness_deadline, health
                        ) VALUES (
                            :environment_id, 'null-reference', 'deployment-immutable',
                            1, 'manifest-etag', 'apply-receipt-guard',
                            'boot-nonce-guard', 1, NULL, :inbox_id, 'guard-event',
                            :payload_hash, '2026-07-20T00:00:00Z',
                            '2026-07-20T00:01:00Z', 'ok'
                        )
                        """
                    ),
                    {
                        "environment_id": environment_id,
                        "inbox_id": inbox_id,
                        "payload_hash": "b" * 64,
                    },
                )
            null_head_reference_savepoint.rollback()

            mismatched_head_position_savepoint = sync_conn.begin_nested()
            with pytest.raises(
                sa.exc.DBAPIError,
                match="head inbox reference does not match its binding",
            ):
                sync_conn.execute(
                    sa.text(
                        """
                        INSERT INTO v2_runtime_observation_heads (
                            environment_id, boot_session_id, deployment_id,
                            generation, manifest_etag, apply_receipt_id, boot_nonce,
                            highest_sequence, latest_inbox_id, latest_stream_position,
                            latest_event_id, latest_payload_hash, captured_at,
                            freshness_deadline, health
                        ) VALUES (
                            :environment_id, 'guard-session', 'deployment-immutable',
                            1, 'manifest-etag', 'apply-receipt-guard',
                            'boot-nonce-guard', 1, :inbox_id, :wrong_position,
                            'guard-event', :payload_hash, '2026-07-20T00:00:00Z',
                            '2026-07-20T00:01:00Z', 'ok'
                        )
                        """
                    ),
                    {
                        "environment_id": environment_id,
                        "inbox_id": inbox_id,
                        "wrong_position": inbox_id + 1,
                        "payload_hash": "b" * 64,
                    },
                )
            mismatched_head_position_savepoint.rollback()

            sync_conn.execute(
                sa.text(
                    """
                    INSERT INTO v2_runtime_observation_heads (
                        environment_id, boot_session_id, deployment_id,
                        generation, manifest_etag, apply_receipt_id, boot_nonce,
                        highest_sequence, latest_inbox_id, latest_stream_position,
                        latest_event_id, latest_payload_hash, captured_at,
                        freshness_deadline, health
                    ) VALUES (
                        :environment_id, 'guard-session', 'deployment-immutable',
                        1, 'manifest-etag', 'apply-receipt-guard',
                        'boot-nonce-guard', 1, :inbox_id, :inbox_id, 'guard-event',
                        :payload_hash, '2026-07-20T00:00:00Z',
                        '2026-07-20T00:01:00Z', 'ok'
                    )
                    """
                ),
                {
                    "environment_id": environment_id,
                    "inbox_id": inbox_id,
                    "payload_hash": "b" * 64,
                },
            )
            sync_conn.execute(
                sa.text(
                    "UPDATE v2_runtime_observation_inbox "
                    "SET diagnostics = '{}'::jsonb, payload_purged_at = now() "
                    "WHERE id = :inbox_id"
                ),
                {"inbox_id": inbox_id},
            )
            assert (
                sync_conn.scalar(
                    sa.text(
                        "SELECT latest_inbox_id FROM v2_runtime_observation_heads "
                        "WHERE environment_id = :environment_id "
                        "AND boot_session_id = 'guard-session'"
                    ),
                    {"environment_id": environment_id},
                )
                == inbox_id
            )

            migration.downgrade()
            downgraded_receipt = sync_conn.scalar(
                sa.text(
                    "SELECT retirement_receipt "
                    "FROM v2_runtime_environment_fences WHERE environment_id = :environment_id"
                ),
                {"environment_id": retired_environment_id},
            )
            assert downgraded_receipt == {
                "retirementReceiptId": str(retired_receipt_id),
                "retirementId": "retirement-old-shape",
                "environmentId": str(retired_environment_id),
                "deploymentId": "deployment-retired",
                "retiredAt": "2026-07-20T00:00:00Z",
                "finalCursor": "old-final-cursor",
                "finalSessionHighWaterMarks": {"boot-a": 3, "boot-b": 7},
            }
            downgraded_inbox_columns = {
                column["name"]
                for column in inspect(sync_conn).get_columns(
                    "v2_runtime_observation_inbox",
                    schema=schema,
                )
            }
            assert "payload_purged_at" not in downgraded_inbox_columns
            previous_checks = {
                check["name"]: check["sqltext"]
                for check in inspect(sync_conn).get_check_constraints(
                    "api_keys",
                    schema=schema,
                )
            }
            assert (
                "cardinality(scopes)"
                not in previous_checks["ck_api_keys_runtime_deployment_binding"]
            )
            trigger_count = sync_conn.scalar(
                sa.text(
                    """
                    SELECT count(*)
                    FROM information_schema.triggers
                    WHERE trigger_schema = :schema
                      AND trigger_name LIKE 'trg_v2_runtime_%'
                    """
                ),
                {"schema": schema},
            )
            assert trigger_count == 0
            sync_conn.execute(
                sa.text(
                    "UPDATE v2_runtime_environment_fences "
                    "SET owner_id = :owner_id WHERE environment_id = :environment_id"
                ),
                {"environment_id": environment_id, "owner_id": uuid.uuid4()},
            )

            migration.upgrade()
            migration.downgrade()
        finally:
            migration.op = old_op
            sync_conn.execute(sa.text("SET search_path TO public"))
            sync_conn.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))

    sync_url = engine.url.set(drivername="postgresql+psycopg2")
    sync_engine = create_engine(sync_url)
    try:
        with sync_engine.begin() as connection:
            run(connection)
    finally:
        sync_engine.dispose()
