"""Expand the strict-v2 hosted runtime capability bundle.

Revision ID: f4c8a1d7e2b9
Revises: e2a7c9f4b6d1
Create Date: 2026-07-28 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f4c8a1d7e2b9"
down_revision: str | Sequence[str] | None = "e2a7c9f4b6d1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_FULL_SCOPES = (
    "connectors:read",
    "connectors:invoke",
    "runtime-observations:write",
    "sessions:read",
    "sessions:write",
    "skills:read",
    "skills:write",
)
_NARROW_SCOPES = (
    "runtime-observations:write",
    "sessions:write",
    "skills:read",
    "skills:write",
)


def _scope_array(scopes: tuple[str, ...]) -> str:
    return "ARRAY[" + ",".join(f"'{scope}'" for scope in scopes) + "]::varchar[]"


_IDENTITY_CHECK = "runtime_deployment_id IS NULL OR (managed AND environment_id IS NOT NULL)"


def _previous_check() -> str:
    scope_array = _scope_array(_NARROW_SCOPES)
    return (
        "runtime_deployment_id IS NULL OR (managed AND environment_id IS NOT NULL "
        "AND scopes IS NOT NULL AND cardinality(scopes) > 0 "
        f"AND scopes <@ {scope_array} "
        "AND 'runtime-observations:write' = ANY(scopes))"
    )


def upgrade() -> None:
    op.drop_constraint("ck_api_keys_runtime_deployment_binding", "api_keys", type_="check")
    op.execute(
        sa.text(
            f"UPDATE api_keys SET scopes = {_scope_array(_FULL_SCOPES)} "
            "WHERE runtime_deployment_id IS NOT NULL"
        )
    )
    op.create_check_constraint(
        "ck_api_keys_runtime_deployment_binding", "api_keys", _IDENTITY_CHECK
    )


def downgrade() -> None:
    op.drop_constraint("ck_api_keys_runtime_deployment_binding", "api_keys", type_="check")
    op.execute(
        sa.text(
            f"UPDATE api_keys SET scopes = {_scope_array(_NARROW_SCOPES)} "
            "WHERE runtime_deployment_id IS NOT NULL"
        )
    )
    op.create_check_constraint(
        "ck_api_keys_runtime_deployment_binding", "api_keys", _previous_check()
    )
