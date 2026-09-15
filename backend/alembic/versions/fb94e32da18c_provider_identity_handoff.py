"""Persist an operator-authorized provider identity handoff until every consumer acknowledges."""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "fb94e32da18c"
down_revision = "fa83d21c907b"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("ai_providers", sa.Column("identity_handoff", postgresql.JSONB(), nullable=True))

    op.create_check_constraint(
        "ck_ai_providers_identity_handoff",
        "ai_providers",
        "identity_handoff IS NULL OR (jsonb_typeof(identity_handoff) = 'object' "
        "AND COALESCE(identity_handoff ->> 'state', '') "
        "IN ('prepared', 'completed'))",
    )


def downgrade() -> None:
    connection = op.get_bind()
    connection.execute(sa.text("LOCK TABLE ai_providers IN ACCESS EXCLUSIVE MODE"))
    if connection.execute(
        sa.text("SELECT 1 FROM ai_providers WHERE identity_handoff IS NOT NULL LIMIT 1")
    ).first():
        raise RuntimeError("Provider identity handoffs require the identity-capable schema")
    op.drop_constraint("ck_ai_providers_identity_handoff", "ai_providers", type_="check")
    op.drop_column("ai_providers", "identity_handoff")
