"""Keep channel plugin initialization on the stable Agent identity."""

import sqlalchemy as sa

from alembic import op

revision = "b81d7a2c903e"
down_revision = "9b3e2a71c640"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("agent_environments", sa.Column("plugin_bundle_revision", sa.String(40)))


def downgrade() -> None:
    op.drop_column("agent_environments", "plugin_bundle_revision")
