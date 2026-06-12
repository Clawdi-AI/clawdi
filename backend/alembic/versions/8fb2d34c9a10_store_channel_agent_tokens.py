"""store channel agent tokens

Revision ID: 8fb2d34c9a10
Revises: 5f3a9d2c8e10
Create Date: 2026-06-11 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "8fb2d34c9a10"
down_revision: str | Sequence[str] | None = "5f3a9d2c8e10"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "channel_bot_agent_links",
        sa.Column("encrypted_agent_token", sa.LargeBinary(), nullable=True),
    )
    op.add_column(
        "channel_bot_agent_links",
        sa.Column("agent_token_nonce", sa.LargeBinary(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("channel_bot_agent_links", "agent_token_nonce")
    op.drop_column("channel_bot_agent_links", "encrypted_agent_token")
