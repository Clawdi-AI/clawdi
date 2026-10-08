from __future__ import annotations

import uuid

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.migration_harness import load_migration


def test_cli_oauth_redirect_uri_cleanup_is_scoped_and_idempotent(engine: AsyncEngine) -> None:
    migration = load_migration(
        "c4a8e2d6f913_remove_cli_oauth_redirect_uri.py", "cli_oauth_redirect_uri_migration"
    )
    schema = f"cli_oauth_redirect_uri_{uuid.uuid4().hex}"
    sync_engine = create_engine(engine.url.set(drivername="postgresql+psycopg2"))
    original_op = migration.op
    oauth_value = {
        "enabled": True,
        "schema_version": 1,
        "issuer": "https://clerk.example.test",
        "client_id": "client_cli",
        "application_id": "oauthapp_cli",
        "redirect_uri": "http://127.0.0.1:18473/oauth/callback",
        "audience": "",
        "authorized_parties": [],
    }
    try:
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
            connection.execute(sa.text(f'SET search_path TO "{schema}"'))
            table = sa.Table(
                "app_settings",
                sa.MetaData(),
                sa.Column("key", sa.Text(), primary_key=True),
                sa.Column("value_json", JSONB(), nullable=False),
            )
            table.create(connection)
            connection.execute(
                table.insert(),
                [
                    {"key": "clerk_cli_oauth", "value_json": oauth_value},
                    {"key": "unrelated", "value_json": {"redirect_uri": "keep"}},
                ],
            )
            migration.op = Operations(MigrationContext.configure(connection))

            expected = {
                "clerk_cli_oauth": {
                    key: value for key, value in oauth_value.items() if key != "redirect_uri"
                },
                "unrelated": {"redirect_uri": "keep"},
            }
            for _ in range(2):
                migration.upgrade()
                assert dict(connection.execute(sa.select(table)).all()) == expected

            migration.downgrade()
            assert dict(connection.execute(sa.select(table)).all()) == expected
            connection.execute(table.delete().where(table.c.key == "clerk_cli_oauth"))
            migration.upgrade()
            assert dict(connection.execute(sa.select(table)).all()) == {
                "unrelated": {"redirect_uri": "keep"}
            }
    finally:
        migration.op = original_op
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        sync_engine.dispose()
