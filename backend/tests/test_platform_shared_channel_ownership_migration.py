from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import pytest
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
            CREATE TABLE users (
                id uuid PRIMARY KEY
            );
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


def test_platform_shared_channel_migration_preserves_inventory_and_tenant_children(
    engine: AsyncEngine,
) -> None:
    migration = _load_migration()
    assert migration.down_revision == "b4e8c1d7a2f9"
    schema = f"platform_shared_channel_{uuid.uuid4().hex}"
    sync_engine = create_engine(engine.url.set(drivername="postgresql+psycopg2"))
    old_op = migration.op
    ids = {name: uuid.uuid4() for name in _ID_NAMES}
    try:
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
            connection.execute(sa.text(f'SET search_path TO "{schema}"'))
            _create_previous_schema(connection)
            _seed_previous_rows(connection, ids)
            migration.op = Operations(MigrationContext.configure(connection))

            migration.upgrade()

            public_rows = connection.execute(
                sa.text(
                    """
                    SELECT id, user_id, encrypted_provider_token
                    FROM channel_accounts
                    WHERE visibility = 'public'
                    ORDER BY id
                    """
                )
            ).all()
            assert len(public_rows) == 3
            assert all(row.user_id is None for row in public_rows)
            telegram = next(row for row in public_rows if row.id == ids["telegram_account"])
            assert bytes(telegram.encrypted_provider_token) == b"telegram-provider-token"
            assert (
                connection.scalar(
                    sa.text("SELECT user_id FROM channel_accounts WHERE id = :id"),
                    {"id": ids["private_account"]},
                )
                == ids["tenant_user"]
            )

            secret = connection.execute(
                sa.text("SELECT user_id, encrypted_value FROM channel_secrets WHERE id = :id"),
                {"id": ids["public_secret"]},
            ).one()
            assert secret.user_id is None
            assert bytes(secret.encrypted_value) == b"public-provider-secret"
            assert (
                connection.scalar(
                    sa.text("SELECT user_id FROM channel_whatsapp_auth_certs WHERE id = :id"),
                    {"id": ids["auth_cert"]},
                )
                is None
            )

            child_owners = connection.execute(
                sa.text(
                    """
                    SELECT user_id FROM channel_bot_agent_links WHERE id = :link_id
                    UNION ALL
                    SELECT user_id FROM channel_bindings WHERE id = :binding_id
                    UNION ALL
                    SELECT user_id FROM channel_messages WHERE id = :message_id
                    UNION ALL
                    SELECT user_id FROM channel_agent_credentials WHERE id = :credential_id
                    """
                ),
                {
                    "link_id": ids["link"],
                    "binding_id": ids["binding"],
                    "message_id": ids["message"],
                    "credential_id": ids["credential"],
                },
            ).scalars()
            assert list(child_owners) == [ids["tenant_user"]] * 4
            assert (
                bytes(
                    connection.scalar(
                        sa.text(
                            "SELECT encrypted_credentials "
                            "FROM channel_agent_credentials WHERE id = :id"
                        ),
                        {"id": ids["credential"]},
                    )
                )
                == b"tenant-credential"
            )

            custom = connection.execute(
                sa.text(
                    """
                    SELECT ownership_kind, user_id, request_id, name
                    FROM channel_whatsapp_onboarding_sessions
                    WHERE id = :id
                    """
                ),
                {"id": ids["custom_session"]},
            ).one()
            assert tuple(custom) == (
                "custom",
                ids["tenant_user"],
                ids["shared_request"],
                "Custom Device",
            )
            platform_sessions = connection.execute(
                sa.text(
                    """
                    SELECT user_id, request_id, name
                    FROM channel_whatsapp_onboarding_sessions
                    WHERE ownership_kind = 'platform'
                    ORDER BY id
                    """
                )
            ).all()
            assert len(platform_sessions) == 2
            assert all(row.user_id is None for row in platform_sessions)
            assert len({row.request_id for row in platform_sessions}) == 2
            assert len({row.name for row in platform_sessions}) == 2

            with pytest.raises(sa.exc.IntegrityError):
                with connection.begin_nested():
                    connection.execute(
                        sa.text(
                            """
                            INSERT INTO channel_accounts (
                                id, user_id, provider, name, visibility, webhook_secret_hash
                            ) VALUES (:id, :tenant_user, 'telegram', :name, 'public', :hash)
                            """
                        ),
                        {
                            "id": uuid.uuid4(),
                            "tenant_user": ids["tenant_user"],
                            "name": f"invalid-owned-public-{uuid.uuid4()}",
                            "hash": "1" * 64,
                        },
                    )
            with pytest.raises(sa.exc.IntegrityError):
                with connection.begin_nested():
                    connection.execute(
                        sa.text(
                            """
                            INSERT INTO channel_whatsapp_onboarding_sessions (
                                id, ownership_kind, sidecar_account_id, sidecar_config_revision,
                                user_id, request_id, name, state, method, started_at, expires_at
                            ) VALUES (
                                :id, 'platform', :sidecar, 'duplicate-request', NULL,
                                :request_id, :name, 'canceled', 'qr', now(), now()
                            )
                            """
                        ),
                        {
                            "id": uuid.uuid4(),
                            "sidecar": uuid.uuid4(),
                            "request_id": platform_sessions[0].request_id,
                            "name": f"duplicate-request-{uuid.uuid4()}",
                        },
                    )

            connection.execute(
                sa.text(
                    """
                    INSERT INTO channel_account_runtime_markers (
                        id, account_id, kind, scope, outcome
                    ) VALUES (
                        :id, :account_id, 'telegram_unpaired_tutorial',
                        'private:123', 'sent'
                    )
                    """
                ),
                {
                    "id": ids["runtime_marker"],
                    "account_id": ids["telegram_account"],
                },
            )

            connection.execute(
                sa.text("DELETE FROM users WHERE id = :id"),
                {"id": ids["fake_platform_owner"]},
            )
            assert (
                connection.scalar(
                    sa.text("SELECT count(*) FROM channel_accounts WHERE visibility = 'public'")
                )
                == 3
            )
            assert connection.scalar(sa.text("SELECT count(*) FROM channel_secrets")) == 1
            assert (
                connection.scalar(sa.text("SELECT count(*) FROM channel_whatsapp_auth_certs")) == 1
            )
            assert (
                connection.scalar(
                    sa.text(
                        "SELECT count(*) FROM channel_whatsapp_onboarding_sessions "
                        "WHERE ownership_kind = 'platform'"
                    )
                )
                == 2
            )
            assert connection.scalar(sa.text("SELECT count(*) FROM channel_messages")) == 1
            assert (
                connection.scalar(sa.text("SELECT count(*) FROM channel_account_runtime_markers"))
                == 1
            )

            with pytest.raises(RuntimeError, match="previous schema requires an arbitrary tenant"):
                migration.downgrade()
    finally:
        migration.op = old_op
        with sync_engine.begin() as connection:
            connection.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        sync_engine.dispose()


_ID_NAMES = (
    "fake_platform_owner",
    "tenant_user",
    "telegram_account",
    "discord_account",
    "whatsapp_account",
    "private_account",
    "public_secret",
    "auth_cert",
    "link",
    "binding",
    "message",
    "credential",
    "runtime_marker",
    "custom_session",
    "platform_session_one",
    "platform_session_two",
    "shared_request",
)


def _seed_previous_rows(connection: sa.Connection, ids: dict[str, uuid.UUID]) -> None:
    connection.execute(
        sa.text("INSERT INTO users (id) VALUES (:fake_owner), (:tenant_user)"),
        {
            "fake_owner": ids["fake_platform_owner"],
            "tenant_user": ids["tenant_user"],
        },
    )
    connection.execute(
        sa.text(
            """
            INSERT INTO channel_accounts (
                id, user_id, provider, name, visibility, encrypted_provider_token,
                provider_token_nonce, webhook_secret_hash, config
            ) VALUES
                (
                    :telegram, :fake_owner, 'telegram', 'Shared Bot', 'public',
                    :telegram_token, :nonce, :hash, '{}'::jsonb
                ),
                (
                    :discord, :fake_owner, 'discord', 'Shared Bot', 'public',
                    :discord_token, :nonce, :hash, '{}'::jsonb
                ),
                (
                    :whatsapp, :fake_owner, 'whatsapp', 'Shared WhatsApp', 'public',
                    NULL, NULL, :hash,
                    '{"connection_mode":"baileys_managed"}'::jsonb
                ),
                (
                    :private, :tenant_user, 'telegram', 'Private Bot', 'private',
                    :private_token, :nonce, :hash, '{}'::jsonb
                )
            """
        ),
        {
            "telegram": ids["telegram_account"],
            "discord": ids["discord_account"],
            "whatsapp": ids["whatsapp_account"],
            "private": ids["private_account"],
            "fake_owner": ids["fake_platform_owner"],
            "tenant_user": ids["tenant_user"],
            "telegram_token": b"telegram-provider-token",
            "discord_token": b"discord-provider-token",
            "private_token": b"private-provider-token",
            "nonce": b"nonce",
            "hash": "0" * 64,
        },
    )
    connection.execute(
        sa.text(
            """
            INSERT INTO channel_secrets (
                id, account_id, user_id, name, encrypted_value, value_nonce
            ) VALUES (
                :id, :account_id, :fake_owner, 'provider_secret', :value, :nonce
            );
            INSERT INTO channel_whatsapp_auth_certs (id, account_id, user_id)
            VALUES (:cert_id, :whatsapp_account, :fake_owner)
            """
        ),
        {
            "id": ids["public_secret"],
            "account_id": ids["telegram_account"],
            "fake_owner": ids["fake_platform_owner"],
            "value": b"public-provider-secret",
            "nonce": b"secret-nonce",
            "cert_id": ids["auth_cert"],
            "whatsapp_account": ids["whatsapp_account"],
        },
    )
    connection.execute(
        sa.text(
            """
            INSERT INTO channel_bot_agent_links (id, account_id, user_id)
            VALUES (:link, :account, :tenant_user);
            INSERT INTO channel_bindings (id, account_id, bot_agent_link_id, user_id)
            VALUES (:binding, :account, :link, :tenant_user);
            INSERT INTO channel_messages (
                id, account_id, bot_agent_link_id, binding_id, user_id
            ) VALUES (:message, :account, :link, :binding, :tenant_user);
            INSERT INTO channel_agent_credentials (
                id, account_id, bot_agent_link_id, user_id, encrypted_credentials
            ) VALUES (:credential, :account, :link, :tenant_user, :credential_value)
            """
        ),
        {
            "link": ids["link"],
            "binding": ids["binding"],
            "message": ids["message"],
            "credential": ids["credential"],
            "account": ids["telegram_account"],
            "tenant_user": ids["tenant_user"],
            "credential_value": b"tenant-credential",
        },
    )
    connection.execute(
        sa.text(
            """
            INSERT INTO channel_whatsapp_onboarding_sessions (
                id, ownership_kind, sidecar_account_id, sidecar_config_revision,
                channel_account_id, user_id, request_id, name, state, method,
                started_at, expires_at
            ) VALUES
                (
                    :custom, 'custom', :custom_sidecar, 'custom-revision', NULL,
                    :tenant_user, :request_id, 'Custom Device', 'ready', 'qr', now(),
                    now() + interval '5 minutes'
                ),
                (
                    :platform_one, 'managed', :whatsapp_account, 'managed-revision',
                    :whatsapp_account, :fake_owner, :request_id, 'Shared Device',
                    'connected', 'qr', now(), now() + interval '5 minutes'
                ),
                (
                    :platform_two, 'managed', :platform_sidecar, 'managed-revision-two',
                    NULL, :tenant_user, :request_id, 'Shared Device', 'ready', 'qr', now(),
                    now() + interval '5 minutes'
                )
            """
        ),
        {
            "custom": ids["custom_session"],
            "custom_sidecar": uuid.uuid4(),
            "platform_one": ids["platform_session_one"],
            "platform_two": ids["platform_session_two"],
            "platform_sidecar": uuid.uuid4(),
            "whatsapp_account": ids["whatsapp_account"],
            "fake_owner": ids["fake_platform_owner"],
            "tenant_user": ids["tenant_user"],
            "request_id": ids["shared_request"],
        },
    )
