from __future__ import annotations

import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL, make_url

BASE_REVISION = "d7f3a1c9e5b2"
TERMINATION_REVISION = "c9f4e2a7b1d6"
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


def test_principal_termination_migration_downgrade_guards_authority_state():
    source_url = make_url(os.environ["DATABASE_URL"])
    database_name = f"clawdi_principal_termination_{uuid.uuid4().hex}"
    admin_engine = create_engine(
        _sync_url(source_url, database="postgres"),
        isolation_level="AUTOCOMMIT",
    )
    database_url = source_url.set(database=database_name)
    database_engine = create_engine(_sync_url(source_url, database=database_name))

    with admin_engine.connect() as connection:
        connection.execute(text(f'CREATE DATABASE "{database_name}"'))
    try:
        _run_alembic(database_url, "upgrade", BASE_REVISION)
        _run_alembic(database_url, "upgrade", TERMINATION_REVISION)

        lifecycle_id = uuid.uuid4()
        with database_engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO principal_lifecycles "
                    "(id, issuer, subject, current_revision, terminated_at, "
                    "cleanup_attempts, next_cleanup_attempt_at) "
                    "VALUES (:id, 'https://clerk.example.test', "
                    "'terminated-user', 1, now(), 0, now())"
                ),
                {"id": lifecycle_id},
            )

        with pytest.raises(subprocess.CalledProcessError):
            _run_alembic(database_url, "downgrade", BASE_REVISION)

        with database_engine.begin() as connection:
            connection.execute(
                text("DELETE FROM principal_lifecycles WHERE id = :id"),
                {"id": lifecycle_id},
            )
            connection.execute(
                text(
                    "INSERT INTO platform_workload_clients "
                    "(id, client_id, assertion_kid, assertion_algorithm, public_jwk, "
                    "status, allowed_scopes, token_version) VALUES "
                    "(:id, 'termination-client', 'termination-kid', 'RS256', "
                    "CAST(:jwk AS jsonb), 'active', "
                    "ARRAY['platform:principals:terminate']::varchar[], 1)"
                ),
                {
                    "id": uuid.uuid4(),
                    "jwk": '{"kid":"termination-kid","alg":"RS256","kty":"RSA"}',
                },
            )

        with pytest.raises(subprocess.CalledProcessError):
            _run_alembic(database_url, "downgrade", BASE_REVISION)

        with database_engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == (
                TERMINATION_REVISION
            )
    finally:
        database_engine.dispose()
        with admin_engine.connect() as connection:
            connection.execute(text(f'DROP DATABASE IF EXISTS "{database_name}" WITH (FORCE)'))
        admin_engine.dispose()
