from __future__ import annotations

import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import DBAPIError

from app.core.config import settings

PREVIOUS_HEAD_REVISION = "b7e1c4a9d2f6"
CLEANUP_REVISION = "e5c8a1d7f2b9"
BACKEND_DIR = Path(__file__).parents[1]


def _sync_url(url: URL, *, database: str) -> URL:
    return url.set(drivername="postgresql+psycopg2", database=database)


def _run_alembic(database_url: URL, *args: str) -> None:
    env = os.environ.copy()
    env["DATABASE_URL"] = database_url.render_as_string(hide_password=False)
    subprocess.run(
        [str(Path(sys.executable).with_name("alembic")), *args],
        cwd=BACKEND_DIR,
        env=env,
        check=True,
    )


def test_runtime_state_cleanup_migration_extends_retired_fence_once() -> None:
    source_url = make_url(os.getenv("DATABASE_URL", settings.database_url))
    database_name = f"clawdi_runtime_cleanup_{uuid.uuid4().hex}"
    admin_engine = create_engine(
        _sync_url(source_url, database="postgres"),
        isolation_level="AUTOCOMMIT",
    )
    database_url = source_url.set(database=database_name)
    database_engine = create_engine(_sync_url(source_url, database=database_name))
    environment_id = uuid.uuid4()
    cleanup_id = f"cleanup-{environment_id}"

    with admin_engine.connect() as connection:
        connection.execute(text(f'CREATE DATABASE "{database_name}"'))
    try:
        _run_alembic(database_url, "upgrade", PREVIOUS_HEAD_REVISION)
        with database_engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO v2_runtime_environment_fences (
                        environment_id, owner_id, deployment_id, state,
                        retirement_id, retirement_receipt_id, retirement_receipt,
                        retired_at, final_cursor, final_stream_position,
                        final_session_high_waters
                    ) VALUES (
                        :environment_id, :owner_id, 'deployment-cleanup', 'retired',
                        'retirement-cleanup', :receipt_id, '{}'::jsonb,
                        now(), 'final-cursor', 0, '{}'::jsonb
                    )
                    """
                ),
                {
                    "environment_id": environment_id,
                    "owner_id": uuid.uuid4(),
                    "receipt_id": uuid.uuid4(),
                },
            )

        _run_alembic(database_url, "upgrade", CLEANUP_REVISION)
        receipt = {
            "schemaVersion": "clawdi.runtimeStateCleanupReceipt.v1",
            "environmentReference": str(environment_id),
            "expectedDeploymentBinding": "deployment-cleanup",
            "retirementId": "retirement-cleanup",
            "cleanupId": cleanup_id,
            "runtimeStateStatus": "absent",
            "cleanedAt": "2026-08-13T00:00:00Z",
        }
        with database_engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE v2_runtime_environment_fences "
                    "SET runtime_state_cleanup_id = :cleanup_id, "
                    "runtime_state_cleanup_receipt = CAST(:receipt AS jsonb) "
                    "WHERE environment_id = :environment_id"
                ),
                {
                    "cleanup_id": cleanup_id,
                    "receipt": json.dumps(receipt),
                    "environment_id": environment_id,
                },
            )
        with pytest.raises(DBAPIError, match="cleanup identity and receipt are immutable"):
            with database_engine.begin() as connection:
                connection.execute(
                    text(
                        "UPDATE v2_runtime_environment_fences "
                        "SET runtime_state_cleanup_id = 'different-cleanup' "
                        "WHERE environment_id = :environment_id"
                    ),
                    {"environment_id": environment_id},
                )

        _run_alembic(database_url, "downgrade", PREVIOUS_HEAD_REVISION)
        columns = {
            column["name"]
            for column in inspect(database_engine).get_columns("v2_runtime_environment_fences")
        }
        assert "runtime_state_cleanup_id" not in columns
        assert "runtime_state_cleanup_receipt" not in columns

        _run_alembic(database_url, "upgrade", CLEANUP_REVISION)
        fresh_columns = {
            column["name"]
            for column in inspect(database_engine).get_columns("v2_runtime_environment_fences")
        }
        assert "runtime_state_cleanup_id" in fresh_columns
        assert "runtime_state_cleanup_receipt" in fresh_columns
        _run_alembic(database_url, "downgrade", PREVIOUS_HEAD_REVISION)
    finally:
        database_engine.dispose()
        with admin_engine.connect() as connection:
            connection.execute(text(f'DROP DATABASE IF EXISTS "{database_name}" WITH (FORCE)'))
        admin_engine.dispose()
