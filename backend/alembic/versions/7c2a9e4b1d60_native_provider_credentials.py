"""Distinguish native credential connections from explicit model catalogs."""

import sqlalchemy as sa

from alembic import op

revision = "7c2a9e4b1d60"
down_revision = "e1c7a4b9d2f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "ai_providers",
        sa.Column("configuration_mode", sa.String(16), nullable=False, server_default="catalog"),
    )
    op.add_column("ai_providers", sa.Column("native_provider", sa.String(120)))
    op.add_column("ai_providers", sa.Column("native_variant", sa.String(120)))


def downgrade() -> None:
    op.drop_column("ai_providers", "native_variant")
    op.drop_column("ai_providers", "native_provider")
    op.drop_column("ai_providers", "configuration_mode")
