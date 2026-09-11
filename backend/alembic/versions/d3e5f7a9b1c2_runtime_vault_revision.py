"""Track Vault value revisions without rendering consumer runtime manifests."""

import sqlalchemy as sa

from alembic import op

revision = "d3e5f7a9b1c2"
down_revision = "d03f6a9b2e51"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "vaults", sa.Column("runtime_revision", sa.BigInteger(), nullable=False, server_default="0")
    )


def downgrade() -> None:
    op.drop_column("vaults", "runtime_revision")
