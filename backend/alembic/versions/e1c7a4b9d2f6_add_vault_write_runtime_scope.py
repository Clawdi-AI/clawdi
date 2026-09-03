"""Grant Vault writes to existing runtime credentials.

Revision ID: e1c7a4b9d2f6
Revises: b6d1e4c9f2a7
Create Date: 2026-09-03 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e1c7a4b9d2f6"
down_revision: str | Sequence[str] | None = "b6d1e4c9f2a7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_PREVIOUS_RUNTIME_MCP_SCOPES = (
    "connectors:read",
    "connectors:invoke",
    "memories:read",
    "memories:write",
    "projects:read",
    "sessions:read",
    "sessions:write",
    "skills:read",
    "skills:write",
    "vault:read",
)


def _scope_array(scopes: tuple[str, ...]) -> str:
    return "ARRAY[" + ",".join(f"'{scope}'" for scope in scopes) + "]::varchar[]"


def upgrade() -> None:
    previous_runtime_scopes = _scope_array(_PREVIOUS_RUNTIME_MCP_SCOPES)
    op.execute(
        sa.text(
            "UPDATE api_keys "
            "SET scopes = array_append(scopes, 'vault:write') "
            "WHERE runtime_deployment_id IS NOT NULL "
            "AND scopes IS NOT NULL "
            f"AND scopes @> {previous_runtime_scopes} "
            "AND NOT ('vault:write' = ANY(scopes))"
        )
    )
    op.execute(
        sa.text(
            "UPDATE api_keys "
            "SET scopes = array_append(scopes, 'vault:write') "
            "WHERE runtime_deployment_id IS NULL "
            "AND managed "
            "AND environment_id IS NOT NULL "
            "AND scopes IS NOT NULL "
            f"AND scopes @> {previous_runtime_scopes} "
            "AND NOT ('vault:write' = ANY(scopes))"
        )
    )


def downgrade() -> None:
    previous_runtime_scopes = _scope_array(_PREVIOUS_RUNTIME_MCP_SCOPES)
    op.execute(
        sa.text(
            "UPDATE api_keys "
            "SET scopes = array_remove(scopes, 'vault:write') "
            "WHERE runtime_deployment_id IS NOT NULL "
            "AND scopes IS NOT NULL "
            f"AND scopes @> {previous_runtime_scopes} "
            "AND 'vault:write' = ANY(scopes)"
        )
    )
    op.execute(
        sa.text(
            "UPDATE api_keys "
            "SET scopes = array_remove(scopes, 'vault:write') "
            "WHERE runtime_deployment_id IS NULL "
            "AND managed "
            "AND environment_id IS NOT NULL "
            "AND scopes IS NOT NULL "
            f"AND scopes @> {previous_runtime_scopes} "
            "AND 'vault:write' = ANY(scopes)"
        )
    )
