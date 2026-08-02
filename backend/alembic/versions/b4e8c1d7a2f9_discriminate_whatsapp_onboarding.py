"""Discriminate managed and Custom WhatsApp onboarding reservations."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b4e8c1d7a2f9"
down_revision: str | Sequence[str] | None = "a9d4e7c2f1b8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "channel_whatsapp_onboarding_sessions",
        sa.Column("ownership_kind", sa.String(length=16), server_default="custom", nullable=False),
    )
    op.create_check_constraint(
        "ck_channel_whatsapp_onboarding_ownership_kind",
        "channel_whatsapp_onboarding_sessions",
        "ownership_kind IN ('custom', 'managed')",
    )
    op.drop_constraint(
        "uq_channel_whatsapp_onboarding_user_request",
        "channel_whatsapp_onboarding_sessions",
        type_="unique",
    )
    op.create_unique_constraint(
        "uq_channel_whatsapp_onboarding_kind_user_request",
        "channel_whatsapp_onboarding_sessions",
        ["ownership_kind", "user_id", "request_id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_channel_whatsapp_onboarding_kind_user_request",
        "channel_whatsapp_onboarding_sessions",
        type_="unique",
    )
    op.create_unique_constraint(
        "uq_channel_whatsapp_onboarding_user_request",
        "channel_whatsapp_onboarding_sessions",
        ["user_id", "request_id"],
    )
    op.drop_constraint(
        "ck_channel_whatsapp_onboarding_ownership_kind",
        "channel_whatsapp_onboarding_sessions",
        type_="check",
    )
    op.drop_column("channel_whatsapp_onboarding_sessions", "ownership_kind")
