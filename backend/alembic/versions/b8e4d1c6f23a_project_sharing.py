"""scope-to-project rename + project sharing

Revision ID: b8e4d1c6f23a
Revises: 62bdb2921f5f
Create Date: 2026-05-11 21:00:00.000000

Renames serve-v1 scope objects to project terminology, then adds the v1
tables needed for cross-user project sharing and agent-side runtime
composition:
  - project_memberships
  - project_invitations
  - project_share_links
  - agent_project_bindings
  - share_redeem_attempts

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "b8e4d1c6f23a"
down_revision: str | Sequence[str] | None = "62bdb2921f5f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _rename_scopes_to_projects() -> None:
    op.rename_table("scopes", "projects")
    op.alter_column("agent_environments", "default_scope_id", new_column_name="default_project_id")
    op.alter_column("skills", "scope_id", new_column_name="project_id")
    op.alter_column("vaults", "scope_id", new_column_name="project_id")

    op.execute(
        'ALTER TABLE "projects" '
        'RENAME CONSTRAINT "uq_scopes_user_slug" TO "uq_projects_user_slug"'
    )
    op.execute(
        'ALTER TABLE "projects" '
        'RENAME CONSTRAINT "ck_scopes_kind_v1" TO "ck_projects_kind_v1"'
    )
    op.execute('ALTER INDEX "ix_scopes_user_id" RENAME TO "ix_projects_user_id"')
    op.execute(
        'ALTER INDEX "ix_scopes_origin_environment_id" '
        'RENAME TO "ix_projects_origin_environment_id"'
    )
    op.execute(
        'ALTER INDEX "uq_scopes_one_personal_per_user" '
        'RENAME TO "uq_projects_one_personal_per_user"'
    )

    op.execute(
        'ALTER TABLE "agent_environments" '
        'RENAME CONSTRAINT "fk_agent_environments_default_scope_id" '
        'TO "fk_agent_environments_default_project_id"'
    )
    op.execute(
        'ALTER TABLE "skills" '
        'RENAME CONSTRAINT "fk_skills_scope_id" TO "fk_skills_project_id"'
    )
    op.execute('ALTER INDEX "ix_skills_scope_id" RENAME TO "ix_skills_project_id"')
    op.execute(
        'ALTER INDEX "uq_skills_active_user_scope_skill_key" '
        'RENAME TO "uq_skills_active_user_project_skill_key"'
    )

    op.execute(
        'ALTER TABLE "vaults" '
        'RENAME CONSTRAINT "fk_vaults_scope_id" TO "fk_vaults_project_id"'
    )
    op.execute(
        'ALTER TABLE "vaults" '
        'RENAME CONSTRAINT "uq_vault_user_scope_slug" TO "uq_vault_user_project_slug"'
    )
    op.execute('ALTER INDEX "ix_vaults_scope_id" RENAME TO "ix_vaults_project_id"')


def _rename_projects_to_scopes() -> None:
    op.rename_table("projects", "scopes")
    op.alter_column("agent_environments", "default_project_id", new_column_name="default_scope_id")
    op.alter_column("skills", "project_id", new_column_name="scope_id")
    op.alter_column("vaults", "project_id", new_column_name="scope_id")

    op.execute(
        'ALTER TABLE "scopes" '
        'RENAME CONSTRAINT "uq_projects_user_slug" TO "uq_scopes_user_slug"'
    )
    op.execute(
        'ALTER TABLE "scopes" '
        'RENAME CONSTRAINT "ck_projects_kind_v1" TO "ck_scopes_kind_v1"'
    )
    op.execute('ALTER INDEX "ix_projects_user_id" RENAME TO "ix_scopes_user_id"')
    op.execute(
        'ALTER INDEX "ix_projects_origin_environment_id" '
        'RENAME TO "ix_scopes_origin_environment_id"'
    )
    op.execute(
        'ALTER INDEX "uq_projects_one_personal_per_user" '
        'RENAME TO "uq_scopes_one_personal_per_user"'
    )

    op.execute(
        'ALTER TABLE "agent_environments" '
        'RENAME CONSTRAINT "fk_agent_environments_default_project_id" '
        'TO "fk_agent_environments_default_scope_id"'
    )
    op.execute(
        'ALTER TABLE "skills" '
        'RENAME CONSTRAINT "fk_skills_project_id" TO "fk_skills_scope_id"'
    )
    op.execute('ALTER INDEX "ix_skills_project_id" RENAME TO "ix_skills_scope_id"')
    op.execute(
        'ALTER INDEX "uq_skills_active_user_project_skill_key" '
        'RENAME TO "uq_skills_active_user_scope_skill_key"'
    )

    op.execute(
        'ALTER TABLE "vaults" '
        'RENAME CONSTRAINT "fk_vaults_project_id" TO "fk_vaults_scope_id"'
    )
    op.execute(
        'ALTER TABLE "vaults" '
        'RENAME CONSTRAINT "uq_vault_user_project_slug" TO "uq_vault_user_scope_slug"'
    )
    op.execute('ALTER INDEX "ix_vaults_project_id" RENAME TO "ix_vaults_scope_id"')


def upgrade() -> None:
    _rename_scopes_to_projects()

    op.drop_constraint("ck_projects_kind_v1", "projects", type_="check")
    op.create_check_constraint(
        "ck_projects_kind_v2",
        "projects",
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
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
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
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
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
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
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
        "share_redeem_attempts",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "link_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("project_share_links.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("client_key", sa.String(128), nullable=False),
        sa.Column("idempotency_key", sa.String(200)),
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
            "link_id",
            "idempotency_key",
            name="uq_share_redeem_attempts_link_idempotency",
        ),
    )
    op.create_index(
        "ix_share_redeem_attempts_link_client_created",
        "share_redeem_attempts",
        ["link_id", "client_key", "created_at"],
    )
    op.create_index(
        "ix_share_redeem_attempts_created_at",
        "share_redeem_attempts",
        ["created_at"],
    )

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
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
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
    op.drop_index("ix_share_redeem_attempts_created_at", "share_redeem_attempts")
    op.drop_index("ix_share_redeem_attempts_link_client_created", "share_redeem_attempts")
    op.drop_table("share_redeem_attempts")

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

    op.drop_constraint("ck_projects_kind_v2", "projects", type_="check")
    op.create_check_constraint(
        "ck_projects_kind_v1",
        "projects",
        "kind IN ('personal', 'environment')",
    )
    _rename_projects_to_scopes()
