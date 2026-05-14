"""project sharing + agent project bindings

Revision ID: b8e4d1c6f23a
Revises: 62bdb2921f5f
Create Date: 2026-05-11 21:00:00.000000

Adds the v1 tables needed for cross-user project sharing and agent-side
runtime composition:
  - project_memberships
  - project_invitations
  - project_share_links
  - agent_project_bindings

`scopes` remains the underlying project store in pass 1.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "b8e4d1c6f23a"
down_revision: str | Sequence[str] | None = "62bdb2921f5f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint("ck_scopes_kind_v1", "scopes", type_="check")
    op.create_check_constraint(
        "ck_scopes_kind_v2",
        "scopes",
        "kind IN ('personal', 'environment', 'workspace')",
    )

    op.create_table(
        "project_memberships",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("scopes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "member_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("role", sa.String(32), nullable=False),
        sa.Column("joined_via", sa.String(32), nullable=False),
        sa.Column(
            "joined_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.Column("resolved_owner_handle", sa.String(64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.UniqueConstraint(
            "project_id",
            "member_user_id",
            name="uq_project_memberships_project_user",
        ),
        sa.CheckConstraint("role IN ('viewer')", name="ck_project_memberships_role_v1"),
        sa.CheckConstraint(
            "joined_via IN ('invite', 'link')",
            name="ck_project_memberships_joined_via_v1",
        ),
    )
    op.create_index("ix_project_memberships_project_id", "project_memberships", ["project_id"])
    op.create_index(
        "ix_project_memberships_member_user_id",
        "project_memberships",
        ["member_user_id"],
    )

    op.create_table(
        "project_invitations",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("scopes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "invitee_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("invitee_email", sa.String(320), nullable=False),
        sa.Column(
            "invited_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("resolved_owner_handle", sa.String(64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.UniqueConstraint(
            "project_id",
            "invitee_user_id",
            name="uq_project_invitations_project_user",
        ),
    )
    op.create_index("ix_project_invitations_project_id", "project_invitations", ["project_id"])
    op.create_index(
        "ix_project_invitations_invitee_user_id",
        "project_invitations",
        ["invitee_user_id"],
    )
    op.create_index(
        "ix_project_invitations_invited_by",
        "project_invitations",
        ["invited_by"],
    )

    op.create_table(
        "project_share_links",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("scopes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("token_prefix", sa.String(8), nullable=False),
        sa.Column("label", sa.String(200)),
        sa.Column(
            "created_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("resolved_owner_handle", sa.String(64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True)),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.Column("redeem_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("last_redeemed_at", sa.DateTime(timezone=True)),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
    )
    op.create_index("ix_project_share_links_project_id", "project_share_links", ["project_id"])
    op.create_index("ix_project_share_links_created_by", "project_share_links", ["created_by"])

    op.create_table(
        "agent_project_bindings",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "agent_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("agent_environments.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("scopes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("binding_type", sa.String(length=20), nullable=False),
        sa.Column("priority", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "default_write_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "created_by_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "agent_id",
            "project_id",
            name="uq_agent_project_bindings_agent_project",
        ),
        sa.UniqueConstraint(
            "agent_id",
            "binding_type",
            "priority",
            name="uq_agent_project_bindings_agent_type_priority",
        ),
        sa.CheckConstraint(
            "binding_type IN ('primary', 'context')",
            name="ck_agent_project_bindings_type_v1",
        ),
        sa.CheckConstraint(
            "(binding_type = 'primary' AND default_write_enabled = true AND priority = 0) "
            "OR (binding_type = 'context' AND default_write_enabled = false AND priority >= 1)",
            name="ck_agent_project_bindings_write_priority_v1",
        ),
    )
    op.create_index(
        "ix_agent_project_bindings_agent",
        "agent_project_bindings",
        ["agent_id"],
    )
    op.create_index(
        "ix_agent_project_bindings_project",
        "agent_project_bindings",
        ["project_id"],
    )
    op.create_index(
        "uq_agent_project_bindings_one_primary",
        "agent_project_bindings",
        ["agent_id"],
        unique=True,
        postgresql_where=sa.text("binding_type = 'primary'"),
    )


def downgrade() -> None:
    op.drop_index("uq_agent_project_bindings_one_primary", "agent_project_bindings")
    op.drop_index("ix_agent_project_bindings_project", "agent_project_bindings")
    op.drop_index("ix_agent_project_bindings_agent", "agent_project_bindings")
    op.drop_table("agent_project_bindings")

    op.drop_index("ix_project_share_links_created_by", "project_share_links")
    op.drop_index("ix_project_share_links_project_id", "project_share_links")
    op.drop_table("project_share_links")

    op.drop_index("ix_project_invitations_invited_by", "project_invitations")
    op.drop_index("ix_project_invitations_invitee_user_id", "project_invitations")
    op.drop_index("ix_project_invitations_project_id", "project_invitations")
    op.drop_table("project_invitations")

    op.drop_index("ix_project_memberships_member_user_id", "project_memberships")
    op.drop_index("ix_project_memberships_project_id", "project_memberships")
    op.drop_table("project_memberships")

    op.drop_constraint("ck_scopes_kind_v2", "scopes", type_="check")
    op.create_check_constraint(
        "ck_scopes_kind_v1",
        "scopes",
        "kind IN ('personal', 'environment')",
    )
