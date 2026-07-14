"""Add principal-aware users.

Revision ID: a26c40c6965e
Revises: d8f2a1c4b6e9
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "a26c40c6965e"
down_revision: str | Sequence[str] | None = "d8f2a1c4b6e9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "principal_kind",
            sa.String(length=32),
            server_default="clerk",
            nullable=False,
        ),
    )
    op.add_column(
        "users",
        sa.Column("partner_tenant_ref", sa.String(length=255), nullable=True),
    )
    op.alter_column(
        "users",
        "clerk_id",
        existing_type=sa.String(length=200),
        nullable=True,
    )
    op.create_unique_constraint(
        "uq_users_partner_tenant_ref",
        "users",
        ["partner_tenant_ref"],
    )
    op.create_check_constraint(
        "ck_users_principal_identity",
        "users",
        "(principal_kind = 'clerk' AND clerk_id IS NOT NULL "
        "AND partner_tenant_ref IS NULL) OR "
        "(principal_kind = 'partner_tenant' AND clerk_id IS NULL "
        "AND partner_tenant_ref IS NOT NULL)",
    )


def downgrade() -> None:
    bind = op.get_bind()
    tenant_user_count = bind.execute(
        sa.text("SELECT count(*) FROM users WHERE clerk_id IS NULL")
    ).scalar_one()
    if tenant_user_count:
        raise RuntimeError(
            "cannot downgrade principal-aware users while partner tenant users exist"
        )

    op.drop_constraint("ck_users_principal_identity", "users", type_="check")
    op.drop_constraint("uq_users_partner_tenant_ref", "users", type_="unique")
    op.alter_column(
        "users",
        "clerk_id",
        existing_type=sa.String(length=200),
        nullable=False,
    )
    op.drop_column("users", "partner_tenant_ref")
    op.drop_column("users", "principal_kind")
