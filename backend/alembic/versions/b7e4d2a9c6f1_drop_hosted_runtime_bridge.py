"""Drop the unused hosted runtime dashboard bridge state.

Revision ID: b7e4d2a9c6f1
Revises: a6d2f4c8b1e7
Create Date: 2026-07-22 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "b7e4d2a9c6f1"
down_revision: str | Sequence[str] | None = "a6d2f4c8b1e7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    # Keep writers out between the empty-table assertion and transactional DDL.
    bind.execute(sa.text("LOCK TABLE hosted_runtime_states IN ACCESS EXCLUSIVE MODE"))
    has_existing_state = bind.execute(
        sa.text("SELECT EXISTS (SELECT 1 FROM hosted_runtime_states)")
    ).scalar_one()
    if has_existing_state:
        raise RuntimeError(
            "Cannot apply migration b7e4d2a9c6f1: hosted_runtime_states is not empty. "
            "Agent deployment v2 has not launched, so existing hosted runtime state "
            "is a rollout stop condition. Stop the rollout and resolve or decommission "
            "this state through the approved operator procedure before retrying. This "
            "migration does not backfill or preserve existing state."
        )
    op.drop_column("hosted_runtime_states", "bridge")


def downgrade() -> None:
    op.add_column(
        "hosted_runtime_states",
        sa.Column("bridge", postgresql.JSONB(none_as_null=True), nullable=True),
    )
