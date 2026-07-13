from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncEngine

from app.routes.sessions import _runtime_observed_columns
from app.schemas.runtime_observed import HostedRuntimeObserved, HostedRuntimeObservedV2


def _payload() -> dict:
    return {
        "schemaVersion": "clawdi.hostedRuntimeObserved.v2",
        "reportedAt": "2026-07-13T00:00:00Z",
        "runtimeMode": "hosted",
        "status": "ok",
        "activeCliVersion": "1.2.3",
        "applied": {
            "etag": '"bundle"',
            "sourceRevision": "a" * 64,
            "generation": 3,
            "instanceId": "instance",
            "projectedProviderIds": ["provider"],
        },
        "boot": None,
        "cli": None,
    }


def test_runtime_observed_v2_is_strict_and_applied_is_complete() -> None:
    adapter = TypeAdapter(HostedRuntimeObserved)
    assert isinstance(adapter.validate_python(_payload()), HostedRuntimeObservedV2)

    partial = _payload()
    del partial["applied"]["sourceRevision"]
    with pytest.raises(ValidationError):
        adapter.validate_python(partial)

    extra = _payload()
    extra["channels"] = {"etag": '"legacy"'}
    with pytest.raises(ValidationError):
        adapter.validate_python(extra)


def test_runtime_observed_v2_columns_come_from_applied_authority() -> None:
    value = TypeAdapter(HostedRuntimeObserved).validate_python(_payload())
    assert isinstance(value, HostedRuntimeObservedV2)
    columns = _runtime_observed_columns(
        value,
        observed_at=value.reported_at,
    )
    assert columns["observed_config_generation"] == 3
    assert columns["observed_manifest_etag"] == '"bundle"'
    assert columns["observed_source_revision"] == "a" * 64


def test_observed_source_revision_migration_is_single_head() -> None:
    backend_dir = Path(__file__).parents[1]
    config = Config(str(backend_dir / "alembic.ini"))
    config.set_main_option("script_location", str(backend_dir / "alembic"))
    scripts = ScriptDirectory.from_config(config)
    assert scripts.get_heads() == ["b7c4e1a9d2f6"]
    assert scripts.get_revision("b7c4e1a9d2f6").down_revision == "a6d4e2f8c1b3"


def test_observed_source_revision_migration_leaves_legacy_rows_null(
    engine: AsyncEngine,
) -> None:
    path = (
        Path(__file__).parents[1] / "alembic/versions/b7c4e1a9d2f6_add_observed_source_revision.py"
    )
    spec = importlib.util.spec_from_file_location("observed_source_revision_migration", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    schema = f"observed_source_revision_{uuid.uuid4().hex}"
    sync_engine = create_engine(engine.url.set(drivername="postgresql+psycopg2"))
    old_op = migration.op
    try:
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
            connection.execute(sa.text(f'SET search_path TO "{schema}"'))
            connection.execute(
                sa.text(
                    """
                    CREATE TABLE hosted_runtime_config_observations (
                        environment_id UUID PRIMARY KEY,
                        diagnostics JSONB NOT NULL
                    )
                    """
                )
            )
            environment_id = uuid.uuid4()
            connection.execute(
                sa.text(
                    """
                    INSERT INTO hosted_runtime_config_observations
                        (environment_id, diagnostics)
                    VALUES (:environment_id, '{}'::jsonb)
                    """
                ),
                {"environment_id": environment_id},
            )
            migration.op = Operations(MigrationContext.configure(connection))
            migration.upgrade()
            observed = connection.execute(
                sa.text(
                    """
                    SELECT observed_source_revision
                    FROM hosted_runtime_config_observations
                    WHERE environment_id = :environment_id
                    """
                ),
                {"environment_id": environment_id},
            ).scalar_one()
            assert observed is None
    finally:
        migration.op = old_op
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        sync_engine.dispose()
