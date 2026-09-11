"""Permit explicit workload grants for native provider environment restoration.

Revision ID: d03f6a9b2e51
Revises: c92e8b3d104f
"""

import sqlalchemy as sa

from alembic import op

revision = "d03f6a9b2e51"
down_revision = "c92e8b3d104f"
branch_labels = None
depends_on = None

_SCOPES = (
    "platform:agents:create",
    "platform:agents:delete",
    "platform:runtime-state:write",
    "platform:keys:mint",
    "platform:keys:revoke",
    "platform:runtime-observations:consume",
    "platform:runtime-environments:retire",
)
_SCOPE = "platform:provider-environment:repair"


def _constraint(scopes):
    op.create_check_constraint(
        "ck_platform_workload_clients_allowed_scopes",
        "platform_workload_clients",
        "cardinality(allowed_scopes) > 0 AND allowed_scopes <@ ARRAY["
        + ",".join("'" + scope + "'" for scope in scopes)
        + "]::varchar[]",
    )


def upgrade():
    op.drop_constraint("ck_platform_workload_clients_allowed_scopes", "platform_workload_clients")
    _constraint((*_SCOPES, _SCOPE))
    # Existing credentials are deliberately not granted the new authority.


def downgrade():
    granted = op.get_bind().scalar(
        sa.text(
            "SELECT count(*) FROM platform_workload_clients "
            "WHERE 'platform:provider-environment:repair' = ANY(allowed_scopes)"
        )
    )
    if granted:
        raise RuntimeError("Revoke provider-environment repair grants before downgrade")
    op.drop_constraint("ck_platform_workload_clients_allowed_scopes", "platform_workload_clients")
    _constraint(_SCOPES)
