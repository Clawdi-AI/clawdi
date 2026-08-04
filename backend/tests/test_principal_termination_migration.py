from __future__ import annotations

import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import IntegrityError

BRIDGE_REVISION = "c9f4e2a7b1d6"
DIRECT_REVISION = "d1e5f7a9b3c2"
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


def test_direct_webhook_migration_preserves_legacy_evidence_and_is_one_way() -> None:
    source_url = make_url(os.environ["DATABASE_URL"])
    database_name = f"clawdi_clerk_webhook_{uuid.uuid4().hex}"
    admin_engine = create_engine(
        _sync_url(source_url, database="postgres"),
        isolation_level="AUTOCOMMIT",
    )
    database_url = source_url.set(database=database_name)
    database_engine = create_engine(_sync_url(source_url, database=database_name))

    with admin_engine.connect() as connection:
        connection.execute(text(f'CREATE DATABASE "{database_name}"'))
    try:
        _run_alembic(database_url, "upgrade", BRIDGE_REVISION)
        lifecycle_id = uuid.uuid4()
        command_id = f"legacy-{uuid.uuid4().hex}"
        sole_client_id = uuid.uuid4()
        mixed_client_id = uuid.uuid4()
        assertion_replay_id = uuid.uuid4()
        with database_engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO principal_lifecycles "
                    "(id, issuer, subject, current_revision, terminated_at, "
                    "cleanup_attempts, next_cleanup_attempt_at) "
                    "VALUES (:id, 'https://clerk.example.test', "
                    "'legacy-user', 7, now(), 0, now())"
                ),
                {"id": lifecycle_id},
            )
            connection.execute(
                text(
                    "INSERT INTO principal_lifecycle_commands "
                    "(command_id, lifecycle_id, requested_revision, "
                    "accepted_revision, advanced) VALUES (:command_id, :id, 7, 7, true)"
                ),
                {"command_id": command_id, "id": lifecycle_id},
            )
            connection.execute(
                text(
                    "INSERT INTO platform_workload_clients "
                    "(id, client_id, assertion_kid, assertion_algorithm, public_jwk, "
                    "status, allowed_scopes, token_version) VALUES "
                    "(:id, 'legacy-termination-client', 'legacy-kid', 'RS256', "
                    "CAST(:jwk AS jsonb), 'active', "
                    "ARRAY['platform:principals:terminate']::varchar[], 1)"
                ),
                {
                    "id": sole_client_id,
                    "jwk": '{"kid":"legacy-kid","alg":"RS256","kty":"RSA"}',
                },
            )
            connection.execute(
                text(
                    "INSERT INTO platform_workload_assertion_replays "
                    "(id, client_id, jti, assertion_expires_at) VALUES "
                    "(:id, 'legacy-termination-client', 'legacy-replay', "
                    "now() + interval '1 hour')"
                ),
                {"id": assertion_replay_id},
            )
            connection.execute(
                text(
                    "INSERT INTO platform_workload_clients "
                    "(id, client_id, assertion_kid, assertion_algorithm, public_jwk, "
                    "status, allowed_scopes, token_version) VALUES "
                    "(:id, 'mixed-termination-client', 'mixed-kid', 'RS256', "
                    "CAST(:jwk AS jsonb), 'active', "
                    "ARRAY['platform:agents:create', "
                    "'platform:principals:terminate']::varchar[], 1)"
                ),
                {
                    "id": mixed_client_id,
                    "jwk": '{"kid":"mixed-kid","alg":"RS256","kty":"RSA"}',
                },
            )

        _run_alembic(database_url, "upgrade", DIRECT_REVISION)
        with database_engine.connect() as connection:
            receipt = connection.execute(
                text(
                    "SELECT lifecycle_id, receipt_source, event_type, payload_sha256 "
                    "FROM clerk_webhook_event_receipts WHERE message_id = :message_id"
                ),
                {"message_id": command_id},
            ).one()
            assert receipt == (lifecycle_id, "legacy_platform_bridge", "user.deleted", None)
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM platform_workload_clients WHERE id = :id"),
                    {"id": sole_client_id},
                )
                == 0
            )
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM platform_workload_assertion_replays WHERE id = :id"),
                    {"id": assertion_replay_id},
                )
                == 0
            )
            assert connection.scalar(
                text("SELECT allowed_scopes FROM platform_workload_clients WHERE id = :id"),
                {"id": mixed_client_id},
            ) == ["platform:agents:create"]
            assert "current_revision" not in {
                column["name"] for column in inspect(connection).get_columns("principal_lifecycles")
            }

        with database_engine.connect() as connection:
            with pytest.raises(IntegrityError):
                connection.execute(
                    text(
                        "INSERT INTO platform_workload_clients "
                        "(id, client_id, assertion_kid, assertion_algorithm, "
                        "public_jwk, status, allowed_scopes, token_version) VALUES "
                        "(:id, 'empty-scope-client', 'empty-kid', 'RS256', "
                        "CAST(:jwk AS jsonb), 'active', ARRAY[]::varchar[], 1)"
                    ),
                    {
                        "id": uuid.uuid4(),
                        "jwk": ('{"kid":"empty-kid","alg":"RS256","kty":"RSA"}'),
                    },
                )

        _run_alembic(database_url, "downgrade", BRIDGE_REVISION)
        with database_engine.connect() as connection:
            assert (
                connection.scalar(
                    text(
                        "SELECT count(*) FROM principal_lifecycle_commands "
                        "WHERE command_id = :command_id"
                    ),
                    {"command_id": command_id},
                )
                == 1
            )

        _run_alembic(database_url, "upgrade", DIRECT_REVISION)
        direct_lifecycle_id = uuid.uuid4()
        with database_engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO principal_lifecycles "
                    "(id, issuer, subject, terminated_at, cleanup_attempts, "
                    "next_cleanup_attempt_at) VALUES "
                    "(:id, 'https://clerk.example.test', 'direct-user', now(), 0, now())"
                ),
                {"id": direct_lifecycle_id},
            )
            connection.execute(
                text(
                    "INSERT INTO clerk_webhook_event_receipts "
                    "(message_id, lifecycle_id, receipt_source, event_type, "
                    "payload_sha256, event_occurred_at) VALUES "
                    "('msg_direct', :id, 'clerk', 'user.deleted', :hash, now())"
                ),
                {"id": direct_lifecycle_id, "hash": "a" * 64},
            )
        with pytest.raises(subprocess.CalledProcessError):
            _run_alembic(database_url, "downgrade", BRIDGE_REVISION)
        with database_engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == (
                DIRECT_REVISION
            )
    finally:
        database_engine.dispose()
        with admin_engine.connect() as connection:
            connection.execute(text(f'DROP DATABASE IF EXISTS "{database_name}" WITH (FORCE)'))
        admin_engine.dispose()
