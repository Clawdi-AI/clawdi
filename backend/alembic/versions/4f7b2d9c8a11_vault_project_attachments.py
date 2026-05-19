"""make vault project access explicit

Revision ID: 4f7b2d9c8a11
Revises: b8e4d1c6f23a
Create Date: 2026-05-19 21:30:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "4f7b2d9c8a11"
down_revision: str | Sequence[str] | None = "b8e4d1c6f23a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "vault_project_attachments",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "vault_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("vaults.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
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
            "vault_id",
            "project_id",
            name="uq_vault_project_attachment",
        ),
    )
    op.create_index(
        "ix_vault_project_attachments_vault_id",
        "vault_project_attachments",
        ["vault_id"],
    )
    op.create_index(
        "ix_vault_project_attachments_project_id",
        "vault_project_attachments",
        ["project_id"],
    )

    op.execute(
        """
        INSERT INTO vault_project_attachments (vault_id, project_id)
        SELECT id, project_id
        FROM vaults
        ON CONFLICT (vault_id, project_id) DO NOTHING
        """
    )

    # Existing data allowed duplicate slugs across Projects. Under the
    # corrected model a Vault is account-owned, so duplicate slugs need a
    # stable suffix before the account-level unique constraint is
    # installed. Preserve display names, values, and attachments intact.
    op.execute(
        """
        WITH duplicate_vaults AS (
            SELECT
                id,
                row_number() OVER (
                    PARTITION BY user_id, slug
                    ORDER BY created_at NULLS LAST, id
                ) AS rn
            FROM vaults
        )
        UPDATE vaults
        SET slug = left(vaults.slug, 191) || '-' || left(vaults.id::text, 8)
        FROM duplicate_vaults
        WHERE vaults.id = duplicate_vaults.id
          AND duplicate_vaults.rn > 1
        """
    )

    op.drop_constraint("uq_vault_user_project_slug", "vaults", type_="unique")
    op.drop_index("ix_vaults_project_id", table_name="vaults")
    op.drop_constraint("fk_vaults_project_id", "vaults", type_="foreignkey")
    op.drop_column("vaults", "project_id")
    op.create_unique_constraint("uq_vault_user_slug", "vaults", ["user_id", "slug"])


def downgrade() -> None:
    op.add_column(
        "vaults",
        sa.Column("project_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.execute(
        """
        UPDATE vaults
        SET project_id = first_attachment.project_id
        FROM (
            SELECT DISTINCT ON (vault_id) vault_id, project_id
            FROM vault_project_attachments
            ORDER BY vault_id, created_at NULLS LAST, project_id
        ) AS first_attachment
        WHERE vaults.id = first_attachment.vault_id
        """
    )
    op.execute(
        """
        UPDATE vaults
        SET project_id = projects.id
        FROM projects
        WHERE vaults.project_id IS NULL
          AND projects.user_id = vaults.user_id
          AND projects.kind = 'personal'
        """
    )
    op.alter_column("vaults", "project_id", nullable=False)
    op.create_foreign_key(
        "fk_vaults_project_id",
        "vaults",
        "projects",
        ["project_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index("ix_vaults_project_id", "vaults", ["project_id"])
    op.drop_constraint("uq_vault_user_slug", "vaults", type_="unique")
    op.create_unique_constraint(
        "uq_vault_user_project_slug",
        "vaults",
        ["user_id", "project_id", "slug"],
    )
    op.drop_index("ix_vault_project_attachments_project_id", table_name="vault_project_attachments")
    op.drop_index("ix_vault_project_attachments_vault_id", table_name="vault_project_attachments")
    op.drop_table("vault_project_attachments")
