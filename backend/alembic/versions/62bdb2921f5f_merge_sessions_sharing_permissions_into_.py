"""merge sessions/sharing-permissions into main

Revision ID: 62bdb2921f5f
Revises: a7f4c2b9d031, d4e5f6a7b8c9
Create Date: 2026-05-12 23:06:24.311663

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "62bdb2921f5f"
down_revision: Union[str, Sequence[str], None] = ("a7f4c2b9d031", "d4e5f6a7b8c9")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
