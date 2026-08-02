"""Add non-secret WhatsApp device-onboarding lifecycle metadata.

Revision ID: a9d4e7c2f1b8
Revises: b5d8e2a7c4f1
Create Date: 2026-08-02 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "a9d4e7c2f1b8"
down_revision: str | Sequence[str] | None = "b5d8e2a7c4f1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_UNRELEASED_STATES = "'generating', 'ready', 'scanned', 'connected', 'error'"


def upgrade() -> None:
    op.create_table(
        "channel_whatsapp_onboarding_sessions",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("sidecar_account_id", sa.UUID(), nullable=False),
        sa.Column("sidecar_config_revision", sa.String(length=64), nullable=False),
        sa.Column("channel_account_id", sa.UUID(), nullable=True),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("request_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("state", sa.String(length=32), nullable=False),
        sa.Column("method", sa.String(length=16), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["channel_account_id"],
            ["channel_accounts.id"],
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "request_id",
            name="uq_channel_whatsapp_onboarding_user_request",
        ),
    )
    op.create_index(
        "ix_channel_whatsapp_onboarding_sessions_channel_account_id",
        "channel_whatsapp_onboarding_sessions",
        ["channel_account_id"],
    )
    op.create_index(
        "ix_channel_whatsapp_onboarding_sessions_sidecar_account_id",
        "channel_whatsapp_onboarding_sessions",
        ["sidecar_account_id"],
    )
    op.create_index(
        "ix_channel_whatsapp_onboarding_sessions_expires_at",
        "channel_whatsapp_onboarding_sessions",
        ["expires_at"],
    )
    op.create_index(
        "ix_channel_whatsapp_onboarding_sessions_state",
        "channel_whatsapp_onboarding_sessions",
        ["state"],
    )
    op.create_index(
        "ix_channel_whatsapp_onboarding_sessions_user_id",
        "channel_whatsapp_onboarding_sessions",
        ["user_id"],
    )
    op.create_index(
        "uq_channel_whatsapp_onboarding_active_sidecar_account",
        "channel_whatsapp_onboarding_sessions",
        ["sidecar_account_id"],
        unique=True,
        postgresql_where=sa.text(f"state IN ({_UNRELEASED_STATES})"),
    )
    op.create_index(
        "uq_channel_whatsapp_onboarding_active_user_name",
        "channel_whatsapp_onboarding_sessions",
        ["user_id", "name"],
        unique=True,
        postgresql_where=sa.text(f"state IN ({_UNRELEASED_STATES})"),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_channel_whatsapp_onboarding_active_user_name",
        table_name="channel_whatsapp_onboarding_sessions",
    )
    op.drop_index(
        "uq_channel_whatsapp_onboarding_active_sidecar_account",
        table_name="channel_whatsapp_onboarding_sessions",
    )
    op.drop_index(
        "ix_channel_whatsapp_onboarding_sessions_user_id",
        table_name="channel_whatsapp_onboarding_sessions",
    )
    op.drop_index(
        "ix_channel_whatsapp_onboarding_sessions_state",
        table_name="channel_whatsapp_onboarding_sessions",
    )
    op.drop_index(
        "ix_channel_whatsapp_onboarding_sessions_expires_at",
        table_name="channel_whatsapp_onboarding_sessions",
    )
    op.drop_index(
        "ix_channel_whatsapp_onboarding_sessions_sidecar_account_id",
        table_name="channel_whatsapp_onboarding_sessions",
    )
    op.drop_index(
        "ix_channel_whatsapp_onboarding_sessions_channel_account_id",
        table_name="channel_whatsapp_onboarding_sessions",
    )
    op.drop_table("channel_whatsapp_onboarding_sessions")
