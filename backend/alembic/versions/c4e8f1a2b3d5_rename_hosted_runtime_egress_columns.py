"""rename hosted runtime egress state columns

Revision ID: c4e8f1a2b3d5
Revises: b0d4e6f8a9c1
Create Date: 2026-07-10 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c4e8f1a2b3d5"
down_revision: str | Sequence[str] | None = "b0d4e6f8a9c1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    columns = _hosted_runtime_state_columns()
    has_engine_after_upgrade = "egress_engine" in columns or "mitmproxy" in columns
    if "mitmproxy" in columns and "egress_engine" not in columns:
        op.alter_column(
            "hosted_runtime_states",
            "mitmproxy",
            new_column_name="egress_engine",
        )
    if "mitm_profiles" in columns and "egress_profiles" not in columns:
        op.alter_column(
            "hosted_runtime_states",
            "mitm_profiles",
            new_column_name="egress_profiles",
        )
    if has_engine_after_upgrade:
        _backfill_egress_engine_type()


def downgrade() -> None:
    columns = _hosted_runtime_state_columns()
    if "egress_engine" in columns and "mitmproxy" not in columns:
        op.alter_column(
            "hosted_runtime_states",
            "egress_engine",
            new_column_name="mitmproxy",
        )
    if "egress_profiles" in columns and "mitm_profiles" not in columns:
        op.alter_column(
            "hosted_runtime_states",
            "egress_profiles",
            new_column_name="mitm_profiles",
        )


def _hosted_runtime_state_columns() -> set[str]:
    inspector = sa.inspect(op.get_bind())
    return {column["name"] for column in inspector.get_columns("hosted_runtime_states")}


def _backfill_egress_engine_type() -> None:
    op.execute(
        sa.text(
            """
            UPDATE hosted_runtime_states
            SET egress_engine = jsonb_set(
                egress_engine,
                '{type}',
                to_jsonb('mitmproxy'::text),
                true
            )
            WHERE egress_engine IS NOT NULL
              AND jsonb_typeof(egress_engine) = 'object'
              AND NOT (egress_engine ? 'type')
            """
        )
    )
