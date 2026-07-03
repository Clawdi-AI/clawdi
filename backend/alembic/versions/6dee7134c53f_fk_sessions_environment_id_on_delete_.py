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
    # Order matters and the obvious sequence is wrong:
    #
    #   ❌ UPDATE → ALTER nullable → ADD FK
    #      The UPDATE writes NULL into a NOT NULL column → migration fails
    #      before it even gets to the constraint.
    #
    #   ❌ ALTER nullable → UPDATE → ADD FK
    #      Cleanup is correct, but between the UPDATE and the constraint
    #      a concurrent batch insert can land another orphan and the
    #      VALIDATE/CREATE step fails.
    #
    # The right pattern is `NOT VALID` first (immediately enforces against
    # new writes without scanning the table), THEN cleanup, THEN VALIDATE
    # (scans existing rows). This eliminates the race window and keeps the
    # write lock window short on `sessions`.

    # 1. Allow NULL so ON DELETE SET NULL has somewhere to land, and so
    #    the cleanup UPDATE below is legal.
    op.alter_column("sessions", "environment_id", nullable=True)

    # 2. Add the FK in NOT VALID mode — guards new writes immediately.
    op.execute(
        """
        ALTER TABLE sessions
        ADD CONSTRAINT sessions_environment_id_fkey
        FOREIGN KEY (environment_id) REFERENCES agent_environments(id)
        ON DELETE SET NULL NOT VALID
        """
    )

    # 3. Clean up existing orphans. NOT EXISTS instead of NOT IN avoids
    #    the well-known NULL-in-subquery footgun (`x NOT IN (NULL, ...)`
    #    is NULL, not TRUE, so rows would silently survive).
    op.execute(
        """
        UPDATE sessions
        SET environment_id = NULL
        WHERE environment_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM agent_environments WHERE id = sessions.environment_id
          )
        """
    )

    # 4. Validate the constraint against existing data. Only takes a
    #    SHARE UPDATE EXCLUSIVE lock — concurrent reads + writes proceed.
    op.execute("ALTER TABLE sessions VALIDATE CONSTRAINT sessions_environment_id_fkey")


def downgrade() -> None:
    op.drop_constraint("sessions_environment_id_fkey", "sessions", type_="foreignkey")
    # We can't safely restore NOT NULL: rows that became orphaned (either
    # at upgrade-time or via subsequent agent deletes) are now NULL and
    # have no canonical env_id to backfill. Leave the column nullable on
    # downgrade and let the operator decide. If they want a hard floor,
    # they can run their own backfill UPDATE before re-tightening.
