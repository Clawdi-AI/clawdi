"""add observed source revision"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b7c4e1a9d2f6"
down_revision: str | Sequence[str] | None = "a6d4e2f8c1b3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "hosted_runtime_config_observations",
        sa.Column("observed_source_revision", sa.String(length=64), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("hosted_runtime_config_observations", "observed_source_revision")
