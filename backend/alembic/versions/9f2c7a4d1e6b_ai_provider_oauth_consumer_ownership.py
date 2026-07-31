"""Add single-consumer ownership to AI provider OAuth credentials.

Revision ID: 9f2c7a4d1e6b
Revises: c4a7e2d9f1b6
Create Date: 2026-07-31 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "9f2c7a4d1e6b"
down_revision: str | Sequence[str] | None = "c4a7e2d9f1b6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "ai_provider_auth_payloads",
        sa.Column("credential_revision", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "ai_provider_auth_payloads",
        sa.Column("consumer_environment_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "ai_provider_auth_payloads",
        sa.Column("consumer_runtime", sa.String(length=32), nullable=True),
    )
    op.execute(
        "UPDATE ai_provider_auth_payloads "
        "SET credential_revision = md5(id::text || created_at::text || encrypted_payload::text)"
    )
    op.alter_column("ai_provider_auth_payloads", "credential_revision", nullable=False)
    op.create_foreign_key(
        "fk_ai_provider_auth_payloads_consumer_environment_id",
        "ai_provider_auth_payloads",
        "agent_environments",
        ["consumer_environment_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_check_constraint(
        "ck_ai_provider_auth_payloads_consumer",
        "ai_provider_auth_payloads",
        "(consumer_environment_id IS NULL AND consumer_runtime IS NULL) OR "
        "(consumer_environment_id IS NOT NULL AND consumer_runtime IS NOT NULL AND "
        "consumer_runtime IN ('codex', 'hermes', 'openclaw'))",
    )
    op.create_index(
        "ix_ai_provider_auth_payloads_consumer_environment_id",
        "ai_provider_auth_payloads",
        ["consumer_environment_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_ai_provider_auth_payloads_consumer_environment_id")
    op.drop_constraint(
        "ck_ai_provider_auth_payloads_consumer",
        "ai_provider_auth_payloads",
        type_="check",
    )
    op.drop_constraint(
        "fk_ai_provider_auth_payloads_consumer_environment_id",
        "ai_provider_auth_payloads",
        type_="foreignkey",
    )
    op.drop_column("ai_provider_auth_payloads", "consumer_runtime")
    op.drop_column("ai_provider_auth_payloads", "consumer_environment_id")
    op.drop_column("ai_provider_auth_payloads", "credential_revision")
