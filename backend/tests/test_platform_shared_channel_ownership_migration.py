from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncEngine

MIGRATION_FILENAME = "c2f8a4d6e9b1_platform_shared_channel_ownership.py"


def _load_migration():
    path = Path(__file__).parents[1] / "alembic" / "versions" / MIGRATION_FILENAME
    spec = importlib.util.spec_from_file_location("platform_shared_channel_ownership", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def _create_previous_schema(connection: sa.Connection) -> None:
    connection.execute(
        sa.text(
            """
            CREATE TABLE users (id uuid PRIMARY KEY);
            CREATE TABLE channel_accounts (
                id uuid PRIMARY KEY,
                user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                provider varchar(32) NOT NULL,
                name varchar(120) NOT NULL,
                status varchar(32) NOT NULL DEFAULT 'active',
                visibility varchar(32) NOT NULL DEFAULT 'private',
                encrypted_provider_token bytea,
                provider_token_nonce bytea,
                webhook_secret_hash varchar(64) NOT NULL,
                config jsonb,
                archived_at timestamptz,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE UNIQUE INDEX uq_channel_accounts_user_provider_name_active
                ON channel_accounts (user_id, provider, name)
                WHERE archived_at IS NULL;
            CREATE TABLE channel_secrets (
                id uuid PRIMARY KEY,
                account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
                user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name varchar(80) NOT NULL,
                encrypted_value bytea NOT NULL,
                value_nonce bytea NOT NULL
            );
            CREATE TABLE channel_whatsapp_auth_certs (
                id uuid PRIMARY KEY,
                account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
                user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE channel_whatsapp_onboarding_sessions (
                id uuid PRIMARY KEY,
                ownership_kind varchar(16) NOT NULL DEFAULT 'custom',
                sidecar_account_id uuid NOT NULL,
                sidecar_config_revision varchar(64) NOT NULL,
                channel_account_id uuid REFERENCES channel_accounts(id) ON DELETE SET NULL,
                user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                request_id uuid NOT NULL,
                name varchar(120) NOT NULL,
                state varchar(32) NOT NULL,
                method varchar(16) NOT NULL,
                started_at timestamptz NOT NULL,
                expires_at timestamptz NOT NULL,
                completed_at timestamptz,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT ck_channel_whatsapp_onboarding_ownership_kind
                    CHECK (ownership_kind IN ('custom', 'managed')),
                CONSTRAINT uq_channel_whatsapp_onboarding_kind_user_request
                    UNIQUE (ownership_kind, user_id, request_id)
            );
            CREATE UNIQUE INDEX uq_channel_whatsapp_onboarding_active_user_name
                ON channel_whatsapp_onboarding_sessions (user_id, name)
                WHERE state IN ('generating', 'ready', 'scanned', 'connected', 'error');
            CREATE TABLE channel_bot_agent_links (
                id uuid PRIMARY KEY,
                account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
                user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE channel_bindings (
                id uuid PRIMARY KEY,
                account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
                bot_agent_link_id uuid NOT NULL REFERENCES channel_bot_agent_links(id)
                    ON DELETE CASCADE,
                user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE channel_messages (
                id uuid PRIMARY KEY,
                account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
                bot_agent_link_id uuid REFERENCES channel_bot_agent_links(id) ON DELETE SET NULL,
                binding_id uuid REFERENCES channel_bindings(id) ON DELETE SET NULL,
                user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE channel_agent_credentials (
                id uuid PRIMARY KEY,
                account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
                bot_agent_link_id uuid NOT NULL REFERENCES channel_bot_agent_links(id)
                    ON DELETE CASCADE,
                user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                encrypted_credentials bytea NOT NULL
            )
            """
        )
    )


def test_migration_preserves_public_credentials_and_tenant_children(engine: AsyncEngine) -> None:
    migration = _load_migration()
    schema = f"platform_shared_channel_{uuid.uuid4().hex}"
    ids = {name: uuid.uuid4() for name in _ID_NAMES}
    sync_engine = create_engine(engine.url.set(drivername="postgresql+psycopg2"))
    old_op = migration.op
    try:
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
            connection.execute(sa.text(f'SET search_path TO "{schema}"'))
            _create_previous_schema(connection)
            _seed_previous_rows(connection, ids)
            migration.op = Operations(MigrationContext.configure(connection))

            migration.upgrade()

            account = connection.execute(
                sa.text(
                    "SELECT user_id, encrypted_provider_token FROM channel_accounts WHERE id = :id"
                ),
                {"id": ids["account"]},
            ).one()
            secret = connection.execute(
                sa.text("SELECT user_id, encrypted_value FROM channel_secrets WHERE id = :id"),
                {"id": ids["secret"]},
            ).one()
            child_owners = connection.execute(
                sa.text(
                    """
                    SELECT user_id FROM channel_bot_agent_links WHERE id = :link
                    UNION ALL SELECT user_id FROM channel_bindings WHERE id = :binding
                    UNION ALL SELECT user_id FROM channel_messages WHERE id = :message
                    UNION ALL SELECT user_id FROM channel_agent_credentials WHERE id = :credential
                    """
                ),
                ids,
            ).scalars()

            assert account.user_id is None
            assert bytes(account.encrypted_provider_token) == b"provider-token"
            assert secret.user_id is None
            assert bytes(secret.encrypted_value) == b"provider-secret"
            assert list(child_owners) == [ids["tenant"]] * 4

            connection.execute(
                sa.text("DELETE FROM users WHERE id = :fake_owner"),
                ids,
            )
            assert connection.scalar(sa.text("SELECT count(*) FROM channel_accounts")) == 1
            assert connection.scalar(sa.text("SELECT count(*) FROM channel_secrets")) == 1
            assert connection.scalar(sa.text("SELECT count(*) FROM channel_messages")) == 1
            assert connection.scalar(sa.text("SELECT count(*) FROM channel_agent_credentials")) == 1
    finally:
        migration.op = old_op
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        sync_engine.dispose()


_ID_NAMES = (
    "fake_owner",
    "tenant",
    "account",
    "secret",
    "link",
    "binding",
    "message",
    "credential",
)


def _seed_previous_rows(connection: sa.Connection, ids: dict[str, uuid.UUID]) -> None:
    connection.execute(
        sa.text("INSERT INTO users (id) VALUES (:fake_owner), (:tenant)"),
        ids,
    )
    connection.execute(
        sa.text(
            """
            INSERT INTO channel_accounts (
                id, user_id, provider, name, visibility, encrypted_provider_token,
                provider_token_nonce, webhook_secret_hash, config
            ) VALUES (
                :account, :fake_owner, 'telegram', 'Shared Bot', 'public',
                :token, :nonce, :hash, '{}'::jsonb
            );
            INSERT INTO channel_secrets (
                id, account_id, user_id, name, encrypted_value, value_nonce
            ) VALUES (
                :secret, :account, :fake_owner, 'provider_secret', :secret_value, :nonce
            );
            INSERT INTO channel_bot_agent_links (id, account_id, user_id)
            VALUES (:link, :account, :tenant);
            INSERT INTO channel_bindings (id, account_id, bot_agent_link_id, user_id)
            VALUES (:binding, :account, :link, :tenant);
            INSERT INTO channel_messages (id, account_id, bot_agent_link_id, binding_id, user_id)
            VALUES (:message, :account, :link, :binding, :tenant);
            INSERT INTO channel_agent_credentials (
                id, account_id, bot_agent_link_id, user_id, encrypted_credentials
            ) VALUES (:credential, :account, :link, :tenant, :credential_value)
            """
        ),
        {
            **ids,
            "token": b"provider-token",
            "secret_value": b"provider-secret",
            "credential_value": b"tenant-credential",
            "nonce": b"nonce",
            "hash": "0" * 64,
        },
    )
