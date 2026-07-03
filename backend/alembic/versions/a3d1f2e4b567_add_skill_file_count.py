"""add skill file_count

Revision ID: a3d1f2e4b567
Revises: 9f74c827cec3
Create Date: 2026-04-16 21:30:00.000000
"""

from alembic import op
import sqlalchemy as sa

revision = "a3d1f2e4b567"
down_revision = "9f74c827cec3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("skills", sa.Column("file_count", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("skills", "file_count")
