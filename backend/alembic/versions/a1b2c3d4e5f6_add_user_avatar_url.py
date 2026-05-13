"""add users.avatar_url

Revision ID: a1b2c3d4e5f6
Revises: d2f9e1a0c4b3
Create Date: 2026-05-12

Stores the user's profile picture URL pulled from the Clerk JWT's
`picture` claim. Captured at sign-in for new users; refreshed
opportunistically for existing users every time they sign in.

Used by the public session-share page so visitors see the owner's
avatar in the message stream, mirroring the dashboard's client-side
Clerk `useUser().imageUrl` rendering.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "a1b2c3d4e5f6"
down_revision: str | Sequence[str] | None = "d2f9e1a0c4b3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("avatar_url", sa.String(512), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "avatar_url")
