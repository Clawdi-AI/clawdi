"""Deduplicate unlinked channel references.

Revision ID: 9c4e2a7b1d6f
Revises: 8d3f1a6c9b2e
Create Date: 2026-07-30 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "9c4e2a7b1d6f"
down_revision: str | Sequence[str] | None = "8d3f1a6c9b2e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The existing constraint already protects Link-scoped rows. PostgreSQL
    # treats NULLs as distinct, so retain the newest copy of any historical
    # unlinked race before adding the complementary partial unique index.
    op.execute(
        """
        WITH ranked AS (
            SELECT id,
                   row_number() OVER (
                       PARTITION BY account_id, ref_kind, ref_value
                       ORDER BY updated_at DESC, created_at DESC, id DESC
                   ) AS duplicate_rank
            FROM channel_agent_references
            WHERE bot_agent_link_id IS NULL
        )
        DELETE FROM channel_agent_references AS reference
        USING ranked
        WHERE reference.id = ranked.id AND ranked.duplicate_rank > 1
        """
    )
    op.create_index(
        "uq_channel_agent_references_account_unlinked_kind_value",
        "channel_agent_references",
        ["account_id", "ref_kind", "ref_value"],
        unique=True,
        postgresql_where=sa.text("bot_agent_link_id IS NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_channel_agent_references_account_unlinked_kind_value",
        table_name="channel_agent_references",
    )
