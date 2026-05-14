"""rename legacy constraint names to project names

Revision ID: f4d7b3c8a9e1
Revises: b8e4d1c6f23a
Create Date: 2026-05-14 08:20:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "f4d7b3c8a9e1"
down_revision: str | Sequence[str] | None = "b8e4d1c6f23a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE scopes RENAME CONSTRAINT uq_scopes_user_slug TO uq_projects_user_slug")
    op.execute("ALTER TABLE scopes RENAME CONSTRAINT ck_scopes_kind_v2 TO ck_projects_kind_v2")
    op.execute(
        "ALTER INDEX IF EXISTS uq_scopes_one_personal_per_user "
        "RENAME TO uq_projects_one_personal_per_user"
    )

    op.execute(
        "ALTER INDEX IF EXISTS uq_skills_active_user_scope_skill_key "
        "RENAME TO uq_skills_active_user_project_skill_key"
    )

    op.execute(
        "ALTER TABLE vaults RENAME CONSTRAINT uq_vault_user_scope_slug "
        "TO uq_vault_user_project_slug"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE scopes RENAME CONSTRAINT uq_projects_user_slug TO uq_scopes_user_slug")
    op.execute("ALTER TABLE scopes RENAME CONSTRAINT ck_projects_kind_v2 TO ck_scopes_kind_v2")
    op.execute(
        "ALTER INDEX IF EXISTS uq_projects_one_personal_per_user "
        "RENAME TO uq_scopes_one_personal_per_user"
    )

    op.execute(
        "ALTER INDEX IF EXISTS uq_skills_active_user_project_skill_key "
        "RENAME TO uq_skills_active_user_scope_skill_key"
    )

    op.execute(
        "ALTER TABLE vaults RENAME CONSTRAINT uq_vault_user_project_slug "
        "TO uq_vault_user_scope_slug"
    )
