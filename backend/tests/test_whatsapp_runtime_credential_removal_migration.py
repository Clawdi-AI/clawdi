from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect
from sqlalchemy.ext.asyncio import AsyncEngine

MIGRATION_FILENAME = "f2b7d4c9a1e6_drop_whatsapp_runtime_credentials.py"


def _load_migration():
    path = Path(__file__).parents[1] / "alembic" / "versions" / MIGRATION_FILENAME
    spec = importlib.util.spec_from_file_location("whatsapp_runtime_credential_removal", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def test_whatsapp_runtime_credential_tables_drop_and_round_trip(engine: AsyncEngine) -> None:
    migration = _load_migration()
    schema = f"whatsapp_runtime_removal_{uuid.uuid4().hex}"
    sync_engine = create_engine(engine.url.set(drivername="postgresql+psycopg2"))
    old_op = migration.op
    try:
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
            connection.execute(sa.text(f'SET search_path TO "{schema}"'))
            connection.execute(
                sa.text(
                    """
                    CREATE TABLE users (id uuid PRIMARY KEY);
                    CREATE TABLE channel_accounts (id uuid PRIMARY KEY);
                    CREATE TABLE channel_bot_agent_links (id uuid PRIMARY KEY);
                    CREATE TABLE channel_agent_credentials (
                        id uuid PRIMARY KEY,
                        account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
                        bot_agent_link_id uuid NOT NULL
                            REFERENCES channel_bot_agent_links(id) ON DELETE CASCADE,
                        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        provider varchar(32) NOT NULL,
                        identity_pub_key_hash varchar(64) NOT NULL,
                        identity_public_key bytea NOT NULL,
                        synthetic_jid varchar(300) NOT NULL,
                        encrypted_credentials bytea NOT NULL,
                        credential_nonce bytea NOT NULL,
                        config jsonb,
                        revoked_at timestamptz,
                        created_at timestamptz DEFAULT now(),
                        updated_at timestamptz DEFAULT now(),
                        CONSTRAINT uq_channel_agent_credentials_account_identity
                            UNIQUE (account_id, identity_pub_key_hash)
                    );
                    CREATE INDEX ix_channel_agent_credentials_account_id
                        ON channel_agent_credentials (account_id);
                    CREATE INDEX ix_channel_agent_credentials_bot_agent_link_id
                        ON channel_agent_credentials (bot_agent_link_id);
                    CREATE INDEX ix_channel_agent_credentials_provider
                        ON channel_agent_credentials (provider);
                    CREATE INDEX ix_channel_agent_credentials_revoked_at
                        ON channel_agent_credentials (revoked_at);
                    CREATE INDEX ix_channel_agent_credentials_user_id
                        ON channel_agent_credentials (user_id);
                    CREATE TABLE channel_whatsapp_auth_certs (
                        id uuid PRIMARY KEY,
                        account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
                        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        root_public_key bytea NOT NULL,
                        encrypted_root_private_key bytea NOT NULL,
                        root_private_key_nonce bytea NOT NULL,
                        intermediate_public_key bytea NOT NULL,
                        encrypted_intermediate_private_key bytea NOT NULL,
                        intermediate_private_key_nonce bytea NOT NULL,
                        serial integer NOT NULL DEFAULT 0,
                        created_at timestamptz DEFAULT now(),
                        updated_at timestamptz DEFAULT now()
                    );
                    CREATE UNIQUE INDEX ix_channel_whatsapp_auth_certs_account_id
                        ON channel_whatsapp_auth_certs (account_id);
                    CREATE INDEX ix_channel_whatsapp_auth_certs_user_id
                        ON channel_whatsapp_auth_certs (user_id)
                    """
                )
            )
            migration.op = Operations(MigrationContext.configure(connection))

            migration.upgrade()
            tables = set(inspect(connection).get_table_names())
            assert "channel_agent_credentials" not in tables
            assert "channel_whatsapp_auth_certs" not in tables

            migration.downgrade()
            tables = set(inspect(connection).get_table_names())
            assert "channel_agent_credentials" in tables
            assert "channel_whatsapp_auth_certs" in tables
            credential_indexes = {
                index["name"]
                for index in inspect(connection).get_indexes("channel_agent_credentials")
            }
            assert "ix_channel_agent_credentials_provider" in credential_indexes
            cert_indexes = {
                index["name"]
                for index in inspect(connection).get_indexes("channel_whatsapp_auth_certs")
            }
            assert "ix_channel_whatsapp_auth_certs_account_id" in cert_indexes
    finally:
        migration.op = old_op
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        sync_engine.dispose()
