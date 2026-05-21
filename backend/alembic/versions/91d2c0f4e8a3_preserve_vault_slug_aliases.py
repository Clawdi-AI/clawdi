"""preserve vault slug aliases for migrated project references

Revision ID: 91d2c0f4e8a3
Revises: 4f7b2d9c8a11
Create Date: 2026-05-20 14:30:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "91d2c0f4e8a3"
down_revision: str | Sequence[str] | None = "4f7b2d9c8a11"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Idempotent by design: fresh deploys create and backfill this table in
    # 4f7b2d9c8a11 before duplicate slugs are renamed, while developer and
    # staging databases may already have that earlier migration applied.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS vault_project_slug_aliases (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
            project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            slug VARCHAR(200) NOT NULL,
            is_legacy BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_vault_project_slug_alias_project_slug
                UNIQUE (project_id, slug)
        )
        """
    )
    op.execute(
        """
        ALTER TABLE vault_project_slug_aliases
        ADD COLUMN IF NOT EXISTS is_legacy BOOLEAN NOT NULL DEFAULT FALSE
        """
    )
    op.execute(
        """
        UPDATE vault_project_slug_aliases
        SET is_legacy = TRUE
        WHERE is_legacy IS FALSE
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_vault_project_slug_aliases_vault_id
        ON vault_project_slug_aliases (vault_id)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_vault_project_slug_aliases_project_id
        ON vault_project_slug_aliases (project_id)
        """
    )
    op.execute(
        """
        INSERT INTO vault_project_slug_aliases (vault_id, project_id, slug, is_legacy)
        SELECT attachments.vault_id, attachments.project_id, vaults.slug, false
        FROM vault_project_attachments AS attachments
        JOIN vaults ON vaults.id = attachments.vault_id
        ON CONFLICT (project_id, slug) DO NOTHING
        """
    )


def downgrade() -> None:
    # Keep aliases in place when stepping back one revision; the previous
    # migration owns dropping the table during a full downgrade.
    pass
