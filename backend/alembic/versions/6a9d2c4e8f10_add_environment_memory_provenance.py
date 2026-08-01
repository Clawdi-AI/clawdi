"""Add environment memory provenance and hosted MCP scopes.

Revision ID: 6a9d2c4e8f10
Revises: e8f4a1c9d2b7
Create Date: 2026-08-01 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "6a9d2c4e8f10"
down_revision: str | Sequence[str] | None = "e8f4a1c9d2b7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_STRICT_PREVIOUS_SCOPES = (
    "connectors:read",
    "connectors:invoke",
    "runtime-observations:write",
    "sessions:read",
    "sessions:write",
    "skills:read",
    "skills:write",
)
_STRICT_SCOPES = (
    "connectors:read",
    "connectors:invoke",
    "memories:read",
    "memories:write",
    "projects:read",
    "runtime-observations:write",
    "sessions:read",
    "sessions:write",
    "skills:read",
    "skills:write",
    "vault:metadata:read",
)
_PLATFORM_PREVIOUS_SCOPES = (
    "sessions:write",
    "skills:read",
    "skills:write",
)
_PLATFORM_SCOPES = (
    "connectors:read",
    "connectors:invoke",
    "memories:read",
    "memories:write",
    "projects:read",
    "sessions:read",
    "sessions:write",
    "skills:read",
    "skills:write",
    "vault:metadata:read",
)


def _scope_array(scopes: tuple[str, ...]) -> str:
    return "ARRAY[" + ",".join(f"'{scope}'" for scope in scopes) + "]::varchar[]"


def _canonicalize_with_forward_scopes(base: tuple[str, ...], removed: tuple[str, ...]) -> str:
    base_array = _scope_array(base)
    removed_array = _scope_array(removed)
    return (
        f"{base_array} || ARRAY("
        "SELECT scope FROM ("
        "SELECT scope, min(ordinality) AS first_position "
        "FROM unnest(COALESCE(api_keys.scopes, ARRAY[]::varchar[])) "
        "WITH ORDINALITY AS existing(scope, ordinality) "
        f"WHERE scope <> ALL({removed_array}) "
        "GROUP BY scope"
        ") preserved ORDER BY first_position"
        ")"
    )


def upgrade() -> None:
    op.add_column(
        "memories",
        sa.Column("source_environment_id", sa.UUID(), nullable=True),
    )
    op.create_foreign_key(
        "fk_memories_source_environment_id_agent_environments",
        "memories",
        "agent_environments",
        ["source_environment_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_memories_source_environment_id",
        "memories",
        ["source_environment_id"],
        unique=False,
    )

    # Strict-v2 keys carry an issuer-owned bundle. Canonicalize the known
    # portion while preserving unknown future scopes already present.
    op.execute(
        sa.text(
            "UPDATE api_keys SET scopes = "
            + _canonicalize_with_forward_scopes(_STRICT_SCOPES, _STRICT_SCOPES)
            + " WHERE runtime_deployment_id IS NOT NULL"
        )
    )

    # Legacy platform keys allowed caller-selected subsets. Broaden only rows
    # that exactly match the former default bundle; deliberately narrow keys
    # retain their original least-privilege contract.
    previous_platform = _scope_array(_PLATFORM_PREVIOUS_SCOPES)
    op.execute(
        sa.text(
            f"UPDATE api_keys SET scopes = {_scope_array(_PLATFORM_SCOPES)} "
            "WHERE managed AND environment_id IS NOT NULL "
            "AND runtime_deployment_id IS NULL "
            f"AND scopes @> {previous_platform} AND scopes <@ {previous_platform} "
            f"AND cardinality(scopes) = {len(_PLATFORM_PREVIOUS_SCOPES)}"
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE api_keys SET scopes = "
            + _canonicalize_with_forward_scopes(_STRICT_PREVIOUS_SCOPES, _STRICT_SCOPES)
            + " WHERE runtime_deployment_id IS NOT NULL"
        )
    )
    current_platform = _scope_array(_PLATFORM_SCOPES)
    op.execute(
        sa.text(
            f"UPDATE api_keys SET scopes = {_scope_array(_PLATFORM_PREVIOUS_SCOPES)} "
            "WHERE managed AND environment_id IS NOT NULL "
            "AND runtime_deployment_id IS NULL "
            f"AND scopes @> {current_platform} AND scopes <@ {current_platform} "
            f"AND cardinality(scopes) = {len(_PLATFORM_SCOPES)}"
        )
    )

    op.drop_index("ix_memories_source_environment_id", table_name="memories")
    op.drop_constraint(
        "fk_memories_source_environment_id_agent_environments",
        "memories",
        type_="foreignkey",
    )
    op.drop_column("memories", "source_environment_id")
