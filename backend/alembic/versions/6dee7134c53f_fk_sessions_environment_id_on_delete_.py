"""fk sessions environment_id on delete set null

Revision ID: 6dee7134c53f
Revises: f972e0fac9ef
Create Date: 2026-04-24 21:30:31.234094

Adds a real FK from `sessions.environment_id` → `agent_environments.id` with
`ON DELETE SET NULL`. Before this, deleting an agent left dangling references
(see issue tracking the orphan-sessions backfill), and a race between
`DELETE /api/environments/{id}` and `POST /api/sessions/batch` could even
create *new* orphans because the batch insert validates env existence at
read-time without a row lock.

`environment_id` becomes nullable so the FK has somewhere to land. The list
query in `app/routes/sessions.py` already uses `outerjoin(AgentEnvironment)`
and `_session_to_response` accepts null `agent_type` / `machine_name`, so
orphan rows render as "unknown agent" rather than 500.

Pre-FK cleanup: any `environment_id` that doesn't match an existing row gets
set to NULL up-front, otherwise the constraint fails to add.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "6dee7134c53f"
down_revision: Union[str, Sequence[str], None] = "f972e0fac9ef"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Clear orphan refs so the FK can attach without violating itself.
    op.execute(
        """
        UPDATE sessions
        SET environment_id = NULL
        WHERE environment_id IS NOT NULL
          AND environment_id NOT IN (SELECT id FROM agent_environments)
        """
    )

    # 2. Allow NULL — needed for ON DELETE SET NULL.
    op.alter_column("sessions", "environment_id", nullable=True)

    # 3. Attach the FK.
    op.create_foreign_key(
        "sessions_environment_id_fkey",
        source_table="sessions",
        referent_table="agent_environments",
        local_cols=["environment_id"],
        remote_cols=["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("sessions_environment_id_fkey", "sessions", type_="foreignkey")
    # Best-effort: if any rows are NULL we can't restore NOT NULL without
    # data invention. Leave the column nullable on downgrade.
