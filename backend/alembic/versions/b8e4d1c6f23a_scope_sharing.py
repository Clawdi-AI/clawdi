"""scope sharing - memberships, invitations, share links, mounts

Revision ID: b8e4d1c6f23a
Revises: 62bdb2921f5f
Create Date: 2026-05-11 21:00:00.000000

Adds the four tables needed for cross-user scope sharing:
  - scope_memberships     : viewers a scope owner has added
  - scope_invitations     : outstanding email invitations
  - scope_share_links     : opaque-token share URLs
  - scope_mounts          : composition edges into owned parent scopes

Also extends scope.kind with `workspace` so users can create explicit
project/team boundaries without pretending they came from an agent
environment. Sharing is still orthogonal to kind; personal,
environment, and workspace scopes can all be shared without kind
mutation.

All four tables ON DELETE CASCADE from scopes(id) and users(id) so
deleting an owner or a scope cleans up rows automatically.
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
        "scope_memberships",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "scope_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("scopes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
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
        sa.UniqueConstraint("scope_id", "user_id", name="uq_scope_memberships_scope_user"),
        sa.CheckConstraint("role IN ('viewer')", name="ck_scope_memberships_role_v1"),
        sa.CheckConstraint(
            "joined_via IN ('invite', 'link')",
            name="ck_scope_memberships_joined_via_v1",
        ),
    )
    op.create_index("ix_scope_memberships_scope_id", "scope_memberships", ["scope_id"])
    op.create_index("ix_scope_memberships_user_id", "scope_memberships", ["user_id"])

    op.create_table(
        "scope_invitations",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "scope_id",
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
            "scope_id",
            "invitee_user_id",
            name="uq_scope_invitations_scope_user",
        ),
    )
    op.create_index("ix_scope_invitations_scope_id", "scope_invitations", ["scope_id"])
    op.create_index(
        "ix_scope_invitations_invitee_user_id",
        "scope_invitations",
        ["invitee_user_id"],
    )
    op.create_index(
        "ix_scope_invitations_invited_by",
        "scope_invitations",
        ["invited_by"],
    )

    op.create_table(
        "scope_share_links",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "scope_id",
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
    op.create_index("ix_scope_share_links_scope_id", "scope_share_links", ["scope_id"])
    op.create_index("ix_scope_share_links_created_by", "scope_share_links", ["created_by"])

    op.create_table(
        "scope_mounts",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "parent_scope_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("scopes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "source_scope_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("scopes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("alias", sa.String(length=80), nullable=False),
        sa.Column(
            "mode",
            sa.String(length=20),
            nullable=False,
            server_default="live",
        ),
        sa.Column(
            "created_by",
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
            "parent_scope_id",
            "source_scope_id",
            name="uq_scope_mounts_parent_source",
        ),
        sa.UniqueConstraint(
            "parent_scope_id",
            "alias",
            name="uq_scope_mounts_parent_alias",
        ),
        sa.CheckConstraint("mode IN ('live')", name="ck_scope_mounts_mode_v2"),
    )
    op.create_index(
        "ix_scope_mounts_parent",
        "scope_mounts",
        ["parent_scope_id"],
    )
    op.create_index(
        "ix_scope_mounts_source",
        "scope_mounts",
        ["source_scope_id"],
    )
    op.create_index(
        "ix_scope_mounts_created_by",
        "scope_mounts",
        ["created_by"],
    )


def downgrade() -> None:
    op.drop_index("ix_scope_mounts_created_by", "scope_mounts")
    op.drop_index("ix_scope_mounts_source", "scope_mounts")
    op.drop_index("ix_scope_mounts_parent", "scope_mounts")
    op.drop_table("scope_mounts")
    op.drop_index("ix_scope_share_links_created_by", "scope_share_links")
    op.drop_index("ix_scope_share_links_scope_id", "scope_share_links")
    op.drop_table("scope_share_links")
    op.drop_index("ix_scope_invitations_invited_by", "scope_invitations")
    op.drop_index("ix_scope_invitations_invitee_user_id", "scope_invitations")
    op.drop_index("ix_scope_invitations_scope_id", "scope_invitations")
    op.drop_table("scope_invitations")
    op.drop_index("ix_scope_memberships_user_id", "scope_memberships")
    op.drop_index("ix_scope_memberships_scope_id", "scope_memberships")
    op.drop_table("scope_memberships")
    op.drop_constraint("ck_scopes_kind_v2", "scopes", type_="check")
    op.create_check_constraint(
        "ck_scopes_kind_v1",
        "scopes",
        "kind IN ('personal', 'environment')",
    )
