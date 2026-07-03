"""Reassign Agent default names.

Revision ID: 74d1b8e2c9a3
Revises: e9c3a17d5b42
Create Date: 2026-07-03
"""

from collections.abc import Sequence

from alembic import op

revision: str = "74d1b8e2c9a3"
down_revision: str | Sequence[str] | None = "e9c3a17d5b42"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE agent_environments
        SET default_name = NULL
        WHERE registration_key IS NOT NULL
        """
    )
    op.execute(
        """
        WITH ranked AS (
            SELECT
                id,
                CASE agent_type
                    WHEN 'openclaw' THEN 'OpenClaw'
                    WHEN 'hermes' THEN 'Hermes'
                    WHEN 'claude_code' THEN 'Claude Code'
                    WHEN 'claude-code' THEN 'Claude Code'
                    WHEN 'codex' THEN 'Codex'
                    ELSE NULLIF(TRIM(agent_type), '')
                END AS base_name,
                row_number() OVER (
                    PARTITION BY user_id, agent_type
                    ORDER BY created_at ASC NULLS LAST, id ASC
                ) AS name_index
            FROM agent_environments
            WHERE registration_key IS NULL
        )
        UPDATE agent_environments AS env
        SET default_name = CASE
            WHEN ranked.name_index = 1 THEN ranked.base_name
            ELSE ranked.base_name || ' ' || ranked.name_index::text
        END
        FROM ranked
        WHERE env.id = ranked.id
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE agent_environments
        SET default_name = NULLIF(TRIM(machine_name), '')
        """
    )
