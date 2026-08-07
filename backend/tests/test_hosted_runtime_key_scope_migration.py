from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine

MIGRATION_FILENAME = "f4c8a1d7e2b9_expand_hosted_runtime_key_scopes.py"
FULL_SCOPES = [
    "connectors:read",
    "connectors:invoke",
    "runtime-observations:write",
    "sessions:read",
    "sessions:write",
    "skills:read",
    "skills:write",
]
PREVIOUS_SCOPES = [
    "runtime-observations:write",
    "sessions:write",
    "skills:read",
    "skills:write",
]


def _load_migration():
    migration_path = Path(__file__).parents[1] / "alembic" / "versions" / MIGRATION_FILENAME
    spec = importlib.util.spec_from_file_location(
        "hosted_runtime_key_scope_migration",
        migration_path,
    )
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def _create_previous_schema(connection: sa.Connection) -> None:
    connection.execute(
        sa.text(
            """
            CREATE TABLE api_keys (
                id uuid PRIMARY KEY,
                managed boolean NOT NULL,
                environment_id uuid,
                runtime_deployment_id varchar(200),
                scopes varchar[],
                CONSTRAINT ck_api_keys_runtime_deployment_binding CHECK (
                    runtime_deployment_id IS NULL OR (
                        managed
                        AND environment_id IS NOT NULL
                        AND scopes IS NOT NULL
                        AND cardinality(scopes) > 0
                        AND scopes <@ ARRAY[
                            'runtime-observations:write',
                            'sessions:write',
                            'skills:read',
                            'skills:write'
                        ]::varchar[]
                        AND 'runtime-observations:write' = ANY(scopes)
                    )
                )
            )
            """
        )
    )


def _insert_runtime_key(
    connection: sa.Connection,
    *,
    managed: bool,
    environment_id: uuid.UUID | None,
    deployment_id: str,
    scopes: list[str] | None,
) -> uuid.UUID:
    key_id = uuid.uuid4()
    connection.execute(
        sa.text(
            """
            INSERT INTO api_keys (
                id,
                managed,
                environment_id,
                runtime_deployment_id,
                scopes
            )
            VALUES (
                CAST(:id AS uuid),
                :managed,
                CAST(:environment_id AS uuid),
                :runtime_deployment_id,
                :scopes
            )
            """
        ),
        {
            "id": str(key_id),
            "managed": managed,
            "environment_id": str(environment_id) if environment_id is not None else None,
            "runtime_deployment_id": deployment_id,
            "scopes": scopes,
        },
    )
    return key_id


def test_hosted_runtime_key_scope_migration_backfills_and_relaxes_only_authorization(
    engine: AsyncEngine,
) -> None:
    migration = _load_migration()
    schema = f"hosted_runtime_key_scopes_{uuid.uuid4().hex}"
    environment_id = uuid.uuid4()
    sync_engine = create_engine(engine.url.set(drivername="postgresql+psycopg2"))
    old_op = migration.op
    try:
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
            connection.execute(sa.text(f'SET search_path TO "{schema}"'))
            _create_previous_schema(connection)
            existing_key_id = _insert_runtime_key(
                connection,
                managed=True,
                environment_id=environment_id,
                deployment_id="deployment-existing",
                scopes=["runtime-observations:write"],
            )
            migration.op = Operations(MigrationContext.configure(connection))

            migration.upgrade()

            assert (
                connection.execute(
                    sa.text("SELECT scopes FROM api_keys WHERE id = CAST(:id AS uuid)"),
                    {"id": str(existing_key_id)},
                ).scalar_one()
                == FULL_SCOPES
            )
            checks = {
                check["name"]: check["sqltext"]
                for check in sa.inspect(connection).get_check_constraints("api_keys")
            }
            identity_check = checks["ck_api_keys_runtime_deployment_binding"]
            assert "managed" in identity_check
            assert "environment_id IS NOT NULL" in identity_check
            assert "scopes" not in identity_check

            future_key_id = _insert_runtime_key(
                connection,
                managed=True,
                environment_id=environment_id,
                deployment_id="deployment-future-scope",
                scopes=["future:runtime-capability"],
            )
            assert connection.execute(
                sa.text("SELECT scopes FROM api_keys WHERE id = CAST(:id AS uuid)"),
                {"id": str(future_key_id)},
            ).scalar_one() == ["future:runtime-capability"]

            with pytest.raises(IntegrityError):
                with connection.begin_nested():
                    _insert_runtime_key(
                        connection,
                        managed=False,
                        environment_id=environment_id,
                        deployment_id="deployment-unmanaged",
                        scopes=FULL_SCOPES,
                    )
            with pytest.raises(IntegrityError):
                with connection.begin_nested():
                    _insert_runtime_key(
                        connection,
                        managed=True,
                        environment_id=None,
                        deployment_id="deployment-unbound",
                        scopes=FULL_SCOPES,
                    )

            migration.downgrade()

            downgraded = connection.execute(
                sa.text(
                    """
                    SELECT scopes
                    FROM api_keys
                    WHERE runtime_deployment_id IS NOT NULL
                    ORDER BY runtime_deployment_id
                    """
                )
            ).scalars()
            assert list(downgraded) == [PREVIOUS_SCOPES, PREVIOUS_SCOPES]
            with pytest.raises(IntegrityError):
                with connection.begin_nested():
                    connection.execute(
                        sa.text(
                            """
                            UPDATE api_keys
                            SET scopes = ARRAY[
                                'runtime-observations:write',
                                'future:runtime-capability'
                            ]::varchar[]
                            WHERE id = CAST(:id AS uuid)
                            """
                        ),
                        {"id": str(existing_key_id)},
                    )
    finally:
        migration.op = old_op
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        sync_engine.dispose()
