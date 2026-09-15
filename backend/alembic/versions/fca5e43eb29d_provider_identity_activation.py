"""Activate identity fencing only for new, reactivated or explicitly handed-off providers."""

import sqlalchemy as sa

from alembic import op

revision = "fca5e43eb29d"
down_revision = "fb94e32da18c"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The old journal has no Cloud incarnation. Preserve existing healthy bindings.
    op.add_column(
        "ai_providers",
        sa.Column("identity_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.alter_column("ai_providers", "identity_enabled", server_default=sa.true())


def downgrade() -> None:
    # The previous renderer fences every connection. Removing the marker must not
    # silently enroll a legacy population during a rollback.
    connection = op.get_bind()
    connection.execute(sa.text("LOCK TABLE ai_providers IN ACCESS EXCLUSIVE MODE"))
    if connection.execute(
        sa.text(
            "SELECT 1 FROM ai_providers WHERE NOT identity_enabled "
            "AND configuration_mode IN ('custom', 'connection') LIMIT 1"
        )
    ).first():
        raise RuntimeError("Legacy providers require the capability-compatible renderer")
    op.drop_column("ai_providers", "identity_enabled")
