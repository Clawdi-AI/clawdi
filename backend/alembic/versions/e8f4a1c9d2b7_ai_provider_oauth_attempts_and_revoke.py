"""Add durable AI provider OAuth attempts and revoke tombstones.

Revision ID: e8f4a1c9d2b7
Revises: a9c4e7d2f1b6
Create Date: 2026-07-31 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "e8f4a1c9d2b7"
down_revision: str | Sequence[str] | None = "a9c4e7d2f1b6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "ai_provider_oauth_attempts",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("flow_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("owner_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("provider_row_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("provider_id", sa.String(length=80), nullable=False),
        sa.Column("oauth_provider", sa.String(length=80), nullable=False),
        sa.Column("auth_profile", sa.String(length=120), nullable=False),
        sa.Column("flow_kind", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), server_default="pending", nullable=False),
        sa.Column("base_credential_revision", sa.String(length=64), nullable=True),
        sa.Column("state_sha256", sa.String(length=64), nullable=False),
        sa.Column("encrypted_flow_payload", sa.LargeBinary(), nullable=False),
        sa.Column("flow_payload_nonce", sa.LargeBinary(), nullable=False),
        sa.Column("receipt", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("exchange_started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.CheckConstraint(
            "flow_kind IN ('authorization_code', 'device_code')",
            name="ck_ai_provider_oauth_attempts_flow_kind",
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'exchanging', 'committed', 'failed')",
            name="ck_ai_provider_oauth_attempts_status",
        ),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["provider_row_id"], ["ai_providers.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("flow_id"),
        sa.UniqueConstraint("state_sha256"),
    )
    op.create_index(
        "ix_ai_provider_oauth_attempts_owner_user_id",
        "ai_provider_oauth_attempts",
        ["owner_user_id"],
    )
    op.create_index(
        "ix_ai_provider_oauth_attempts_provider_row_id",
        "ai_provider_oauth_attempts",
        ["provider_row_id"],
    )
    op.create_table(
        "ai_provider_oauth_revoke_tombstones",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("owner_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        # No FK by design: compensation survives provider/attempt cascade deletion.
        sa.Column("oauth_attempt_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("provider_id", sa.String(length=80), nullable=False),
        sa.Column("oauth_provider", sa.String(length=80), nullable=False),
        sa.Column("token_type", sa.String(length=32), nullable=False),
        sa.Column("token_sha256", sa.String(length=64), nullable=False),
        sa.Column("encrypted_token", sa.LargeBinary(), nullable=True),
        sa.Column("token_nonce", sa.LargeBinary(), nullable=True),
        sa.Column("status", sa.String(length=32), server_default="pending", nullable=False),
        sa.Column("attempt_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("claim_id", sa.String(length=64), nullable=True),
        sa.Column("last_error", sa.String(length=500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.CheckConstraint(
            "status IN ('pending', 'processing', 'revoked', 'cancelled')",
            name="ck_ai_provider_oauth_revoke_status",
        ),
        sa.CheckConstraint(
            "token_type IN ('refresh_token', 'access_token')",
            name="ck_ai_provider_oauth_revoke_token_type",
        ),
        sa.CheckConstraint(
            "((status IN ('pending', 'processing')) AND encrypted_token IS NOT NULL AND "
            "token_nonce IS NOT NULL) OR ((status IN ('revoked', 'cancelled')) AND "
            "encrypted_token IS NULL AND token_nonce IS NULL)",
            name="ck_ai_provider_oauth_revoke_material",
        ),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "owner_user_id",
            "oauth_provider",
            "token_type",
            "token_sha256",
            name="uq_ai_provider_oauth_revoke_token",
        ),
    )
    op.create_index(
        "ix_ai_provider_oauth_revoke_tombstones_oauth_attempt_id",
        "ai_provider_oauth_revoke_tombstones",
        ["oauth_attempt_id"],
    )
    op.create_index(
        "ix_ai_provider_oauth_revoke_tombstones_owner_user_id",
        "ai_provider_oauth_revoke_tombstones",
        ["owner_user_id"],
    )
    op.create_index(
        "ix_ai_provider_oauth_revoke_tombstones_next_attempt_at",
        "ai_provider_oauth_revoke_tombstones",
        ["next_attempt_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_ai_provider_oauth_revoke_tombstones_next_attempt_at")
    op.drop_index("ix_ai_provider_oauth_revoke_tombstones_owner_user_id")
    op.drop_index("ix_ai_provider_oauth_revoke_tombstones_oauth_attempt_id")
    op.drop_table("ai_provider_oauth_revoke_tombstones")
    op.drop_index("ix_ai_provider_oauth_attempts_provider_row_id")
    op.drop_index("ix_ai_provider_oauth_attempts_owner_user_id")
    op.drop_table("ai_provider_oauth_attempts")
