"""finalize agent v2 runtime contract

Revision ID: d8f2a1c4b6e9
Revises: c4e8f1a2b3d5
Create Date: 2026-07-11 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "d8f2a1c4b6e9"
down_revision: str | Sequence[str] | None = "c4e8f1a2b3d5"
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
            "Cannot apply migration d8f2a1c4b6e9: hosted_runtime_states is not empty. "
            "Agent deployment v2 has not launched, so existing hosted runtime state "
            "is a rollout stop condition. Stop the rollout and resolve or decommission "
            "this state through the approved operator procedure before retrying. This "
            "migration does not backfill or preserve existing state."
        )

    op.add_column(
        "hosted_runtime_states",
        sa.Column(
            "locale",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
    )
    op.alter_column(
        "hosted_runtime_states",
        "system",
        existing_type=postgresql.JSONB(astext_type=sa.Text()),
        nullable=False,
    )
    op.drop_column("hosted_runtime_states", "clawdi_cli")
    op.drop_column("hosted_runtime_states", "control_plane")
    op.drop_column("hosted_runtime_states", "provider_id")


def downgrade() -> None:
    op.add_column(
        "hosted_runtime_states",
        sa.Column("provider_id", sa.String(length=80), nullable=True),
    )
    op.add_column(
        "hosted_runtime_states",
        sa.Column(
            "control_plane",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )
    op.add_column(
        "hosted_runtime_states",
        sa.Column(
            "clawdi_cli",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )
    op.alter_column(
        "hosted_runtime_states",
        "system",
        existing_type=postgresql.JSONB(astext_type=sa.Text()),
        nullable=True,
    )
    op.drop_column("hosted_runtime_states", "locale")
