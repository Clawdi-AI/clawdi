"""Add durable retired runtime-state cleanup receipts.

Revision ID: e5c8a1d7f2b9
Revises: b7e1c4a9d2f6
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "e5c8a1d7f2b9"
down_revision: str | Sequence[str] | None = "b7e1c4a9d2f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "v2_runtime_environment_fences",
        sa.Column("runtime_state_cleanup_id", sa.String(length=200), nullable=True),
    )
    op.add_column(
        "v2_runtime_environment_fences",
        sa.Column(
            "runtime_state_cleanup_receipt",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )
    op.create_check_constraint(
        "ck_v2_runtime_environment_fences_runtime_state_cleanup",
        "v2_runtime_environment_fences",
        "(runtime_state_cleanup_id IS NULL AND runtime_state_cleanup_receipt IS NULL) "
        "OR (state = 'retired' AND runtime_state_cleanup_id IS NOT NULL "
        "AND runtime_state_cleanup_receipt IS NOT NULL "
        "AND jsonb_typeof(runtime_state_cleanup_receipt) = 'object')",
    )
    op.execute(
        sa.text(
            """
            CREATE FUNCTION enforce_v2_runtime_state_cleanup_immutability()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
                IF OLD.runtime_state_cleanup_id IS NOT NULL
                   AND (OLD.runtime_state_cleanup_id
                            IS DISTINCT FROM NEW.runtime_state_cleanup_id
                        OR OLD.runtime_state_cleanup_receipt
                            IS DISTINCT FROM NEW.runtime_state_cleanup_receipt) THEN
                    RAISE EXCEPTION
                        'v2 runtime state cleanup identity and receipt are immutable';
                END IF;
                RETURN NEW;
            END;
            $$;

            CREATE TRIGGER trg_v2_runtime_state_cleanup_immutability
            BEFORE UPDATE ON v2_runtime_environment_fences
            FOR EACH ROW EXECUTE FUNCTION enforce_v2_runtime_state_cleanup_immutability();
            """
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            """
            DROP TRIGGER IF EXISTS trg_v2_runtime_state_cleanup_immutability
                ON v2_runtime_environment_fences;
            DROP FUNCTION IF EXISTS enforce_v2_runtime_state_cleanup_immutability();
            """
        )
    )
    op.drop_constraint(
        "ck_v2_runtime_environment_fences_runtime_state_cleanup",
        "v2_runtime_environment_fences",
        type_="check",
    )
    op.drop_column("v2_runtime_environment_fences", "runtime_state_cleanup_receipt")
    op.drop_column("v2_runtime_environment_fences", "runtime_state_cleanup_id")
