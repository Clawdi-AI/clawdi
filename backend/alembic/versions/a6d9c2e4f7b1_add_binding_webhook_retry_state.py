"""Persist Telegram webhook fallback backoff per Binding."""

import sqlalchemy as sa
from alembic import op

revision = "a6d9c2e4f7b1"
down_revision = "9b3e2a71c640"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("channel_bindings", sa.Column("webhook_retry_at", sa.DateTime(timezone=True)))
    op.add_column(
        "channel_bindings",
        sa.Column("webhook_retry_step", sa.SmallInteger(), nullable=False, server_default="0"),
    )
    op.create_check_constraint(
        "ck_channel_bindings_webhook_retry_step_nonnegative",
        "channel_bindings",
        "webhook_retry_step >= 0",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_channel_bindings_webhook_retry_step_nonnegative",
        "channel_bindings",
        type_="check",
    )
    op.drop_column("channel_bindings", "webhook_retry_step")
    op.drop_column("channel_bindings", "webhook_retry_at")
