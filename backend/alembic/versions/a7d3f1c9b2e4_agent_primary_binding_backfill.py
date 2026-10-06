"""Materialize every Agent's primary Project binding and drop unreadable links.

Listing an Agent's Project bindings used to repair them on read. Registration
now creates the primary binding, and membership removal, unsharing and
archiving remove context links, so the read path is read-only. This revision
applies the former read repair once to existing rows.
"""

import sqlalchemy as sa

from alembic import op

revision = "a7d3f1c9b2e4"
down_revision = "fca5e43eb29d"
branch_labels = None
depends_on = None


def upgrade() -> None:
    connection = op.get_bind()
    # Context links to Projects the Agent owner can no longer read. Runtime
    # manifests already exclude these sources, so no Agent needs a refresh.
    connection.execute(
        sa.text(
            """
            DELETE FROM agent_project_bindings AS binding
            USING agent_environments AS agent, projects AS project
            WHERE binding.agent_id = agent.id
              AND binding.project_id = project.id
              AND binding.binding_type = 'context'
              AND (
                project.archived_at IS NOT NULL
                OR (
                  project.user_id <> agent.user_id
                  AND NOT EXISTS (
                    SELECT 1 FROM project_memberships AS membership
                    WHERE membership.project_id = project.id
                      AND membership.member_user_id = agent.user_id
                  )
                )
              )
            """
        )
    )
    # Older clients could make another Project primary. Keep it as the last
    # context link; each Agent has at most one primary row.
    connection.execute(
        sa.text(
            """
            UPDATE agent_project_bindings AS binding
            SET binding_type = 'context',
                default_write_enabled = false,
                priority = COALESCE(
                  (
                    SELECT max(context.priority) FROM agent_project_bindings AS context
                    WHERE context.agent_id = binding.agent_id
                      AND context.binding_type = 'context'
                  ),
                  0
                ) + 1,
                updated_at = now()
            FROM agent_environments AS agent
            WHERE binding.agent_id = agent.id
              AND binding.binding_type = 'primary'
              AND binding.project_id <> agent.default_project_id
            """
        )
    )
    connection.execute(
        sa.text(
            """
            UPDATE agent_project_bindings AS binding
            SET binding_type = 'primary',
                priority = 0,
                default_write_enabled = true,
                updated_at = now()
            FROM agent_environments AS agent
            WHERE binding.agent_id = agent.id
              AND binding.project_id = agent.default_project_id
              AND binding.binding_type = 'context'
            """
        )
    )
    connection.execute(
        sa.text(
            """
            INSERT INTO agent_project_bindings (
              id, agent_id, project_id, binding_type, priority,
              default_write_enabled, created_by_user_id
            )
            SELECT gen_random_uuid(), agent.id, agent.default_project_id, 'primary', 0,
                   true, agent.user_id
            FROM agent_environments AS agent
            WHERE agent.default_project_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM agent_project_bindings AS binding
                WHERE binding.agent_id = agent.id
                  AND binding.project_id = agent.default_project_id
              )
            ON CONFLICT DO NOTHING
            """
        )
    )


def downgrade() -> None:
    # Data-only repair. The previous code reads these rows unchanged, and the
    # deleted links were unreadable, so there is nothing to restore.
    pass
