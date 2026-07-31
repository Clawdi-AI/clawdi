from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy.ext.asyncio import AsyncEngine

MIGRATION_FILENAME = "e8f4a1c9d2b7_ai_provider_oauth_attempts_and_revoke.py"


def _load_migration():
    path = Path(__file__).parents[1] / "alembic" / "versions" / MIGRATION_FILENAME
    spec = importlib.util.spec_from_file_location("ai_provider_oauth_attempt_migration", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


@pytest.mark.asyncio
async def test_ai_provider_oauth_attempt_migration_preserves_revoke_compensation(
    engine: AsyncEngine,
) -> None:
    migration = _load_migration()
    assert migration.down_revision == "a9c4e7d2f1b6"
    schema = f"ai_provider_oauth_attempt_{uuid.uuid4().hex}"
    user_id = uuid.uuid4()
    provider_row_id = uuid.uuid4()
    attempt_id = uuid.uuid4()

    def run_migration(sync_conn: sa.Connection) -> None:
        old_op = migration.op
        sync_conn.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
        sync_conn.execute(sa.text(f'SET search_path TO "{schema}"'))
        try:
            sync_conn.execute(sa.text("CREATE TABLE users (id uuid PRIMARY KEY)"))
            sync_conn.execute(
                sa.text(
                    "CREATE TABLE ai_providers ("
                    "id uuid PRIMARY KEY, owner_user_id uuid NOT NULL REFERENCES users(id)"
                    ")"
                )
            )
            migration.op = Operations(MigrationContext.configure(sync_conn))
            migration.upgrade()
            sync_conn.execute(sa.text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            sync_conn.execute(
                sa.text(
                    "INSERT INTO ai_providers (id, owner_user_id) VALUES (:id, :owner_user_id)"
                ),
                {"id": provider_row_id, "owner_user_id": user_id},
            )
            sync_conn.execute(
                sa.text(
                    """
                    INSERT INTO ai_provider_oauth_attempts (
                        id, flow_id, owner_user_id, provider_row_id, provider_id,
                        oauth_provider, auth_profile, flow_kind, status,
                        state_sha256, encrypted_flow_payload, flow_payload_nonce,
                        expires_at
                    ) VALUES (
                        :id, :flow_id, :owner_user_id, :provider_row_id, 'openai-codex',
                        'codex', 'default', 'authorization_code', 'failed',
                        :state_sha256, :encrypted_flow_payload, :flow_payload_nonce,
                        now() + interval '5 minutes'
                    )
                    """
                ),
                {
                    "id": attempt_id,
                    "flow_id": uuid.uuid4(),
                    "owner_user_id": user_id,
                    "provider_row_id": provider_row_id,
                    "state_sha256": "a" * 64,
                    "encrypted_flow_payload": b"flow",
                    "flow_payload_nonce": b"nonce",
                },
            )
            sync_conn.execute(
                sa.text(
                    """
                    INSERT INTO ai_provider_oauth_revoke_tombstones (
                        id, owner_user_id, oauth_attempt_id, provider_id,
                        oauth_provider, token_type, token_sha256,
                        encrypted_token, token_nonce, status
                    ) VALUES (
                        :id, :owner_user_id, :oauth_attempt_id, 'openai-codex',
                        'codex', 'refresh_token', :token_sha256,
                        :encrypted_token, :token_nonce, 'pending'
                    )
                    """
                ),
                {
                    "id": uuid.uuid4(),
                    "owner_user_id": user_id,
                    "oauth_attempt_id": attempt_id,
                    "token_sha256": "b" * 64,
                    "encrypted_token": b"token",
                    "token_nonce": b"nonce",
                },
            )

            sync_conn.execute(
                sa.text("DELETE FROM ai_providers WHERE id = :id"),
                {"id": provider_row_id},
            )
            assert sync_conn.scalar(sa.text("SELECT count(*) FROM ai_provider_oauth_attempts")) == 0
            assert (
                sync_conn.scalar(
                    sa.text("SELECT count(*) FROM ai_provider_oauth_revoke_tombstones")
                )
                == 1
            )

            sync_conn.execute(sa.text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            assert (
                sync_conn.scalar(
                    sa.text("SELECT count(*) FROM ai_provider_oauth_revoke_tombstones")
                )
                == 0
            )
            migration.downgrade()
        finally:
            migration.op = old_op
            sync_conn.execute(sa.text("RESET search_path"))
            sync_conn.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))

    async with engine.begin() as conn:
        await conn.run_sync(run_migration)
