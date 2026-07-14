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

BASE_REVISION = "d8f2a1c4b6e9"
PRINCIPAL_REVISION = "a26c40c6965e"
BACKEND_DIR = Path(__file__).parents[1]


def _sync_url(url: URL, *, database: str) -> URL:
    return url.set(drivername="postgresql+psycopg2", database=database)


def _url_text(url: URL) -> str:
    return url.render_as_string(hide_password=False)


def _run_alembic(database_url: URL, *args: str) -> None:
    env = os.environ.copy()
    env["DATABASE_URL"] = _url_text(database_url)
    subprocess.run(
        [str(Path(sys.executable).with_name("alembic")), *args],
        cwd=BACKEND_DIR,
        env=env,
        check=True,
    )


def test_principal_user_migration_apply_and_rollback():
    source_url = make_url(os.environ["DATABASE_URL"])
    database_name = f"clawdi_principal_migration_{uuid.uuid4().hex}"
    admin_engine = create_engine(
        _sync_url(source_url, database="postgres"),
        isolation_level="AUTOCOMMIT",
    )
    database_url = source_url.set(database=database_name)
    sync_database_url = _sync_url(source_url, database=database_name)
    tenant_user_id = uuid.uuid4()
    clerk_user_id = uuid.uuid4()

    with admin_engine.connect() as connection:
        connection.execute(text(f'CREATE DATABASE "{database_name}"'))

    database_engine = create_engine(sync_database_url)
    try:
        _run_alembic(database_url, "upgrade", BASE_REVISION)

        with database_engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO users (id, clerk_id, email, name, skills_revision) "
                    "VALUES (:id, :clerk_id, NULL, NULL, 0)"
                ),
                {"id": clerk_user_id, "clerk_id": "user_existing_tenant_zero"},
            )

        _run_alembic(database_url, "upgrade", PRINCIPAL_REVISION)

        inspector = inspect(database_engine)
        columns = {column["name"]: column for column in inspector.get_columns("users")}
        checks = {constraint["name"] for constraint in inspector.get_check_constraints("users")}
        assert columns["clerk_id"]["nullable"] is True
        assert columns["principal_kind"]["nullable"] is False
        assert "partner_tenant_ref" in columns
        assert "ck_users_principal_identity" in checks

        with database_engine.begin() as connection:
            existing = connection.execute(
                text("SELECT principal_kind, partner_tenant_ref FROM users WHERE id = :id"),
                {"id": clerk_user_id},
            ).one()
            assert existing == ("clerk", None)
            connection.execute(
                text(
                    "INSERT INTO users "
                    "(id, clerk_id, principal_kind, partner_tenant_ref, email, name, "
                    "skills_revision) VALUES "
                    "(:id, NULL, 'partner_tenant', :partner_tenant_ref, NULL, NULL, 0)"
                ),
                {
                    "id": tenant_user_id,
                    "partner_tenant_ref": "ptn_migration",
                },
            )

        with pytest.raises(IntegrityError):
            with database_engine.begin() as connection:
                connection.execute(
                    text(
                        "INSERT INTO users "
                        "(id, clerk_id, principal_kind, partner_tenant_ref, email, name, "
                        "skills_revision) VALUES "
                        "(:id, :clerk_id, 'partner_tenant', :partner_tenant_ref, "
                        "NULL, NULL, 0)"
                    ),
                    {
                        "id": uuid.uuid4(),
                        "clerk_id": "user_illegal_double_identity",
                        "partner_tenant_ref": "ptn_illegal",
                    },
                )

        with database_engine.begin() as connection:
            connection.execute(
                text("DELETE FROM users WHERE id = :id"),
                {"id": tenant_user_id},
            )

        _run_alembic(database_url, "downgrade", BASE_REVISION)

        inspector = inspect(database_engine)
        columns = {column["name"]: column for column in inspector.get_columns("users")}
        assert columns["clerk_id"]["nullable"] is False
        assert "principal_kind" not in columns
        assert "partner_tenant_ref" not in columns
        with database_engine.connect() as connection:
            clerk_id = connection.execute(
                text("SELECT clerk_id FROM users WHERE id = :id"),
                {"id": clerk_user_id},
            ).scalar_one()
        assert clerk_id == "user_existing_tenant_zero"
    finally:
        database_engine.dispose()
        with admin_engine.connect() as connection:
            connection.execute(text(f'DROP DATABASE IF EXISTS "{database_name}" WITH (FORCE)'))
        admin_engine.dispose()
