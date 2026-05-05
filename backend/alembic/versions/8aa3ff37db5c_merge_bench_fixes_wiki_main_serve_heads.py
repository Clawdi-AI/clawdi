"""merge bench-fixes wiki + main serve heads

Revision ID: 8aa3ff37db5c
Revises: d2f9e1a0c4b3, e8f5b3c9a2d1
Create Date: 2026-05-04 19:35:13.877862

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '8aa3ff37db5c'
down_revision: Union[str, Sequence[str], None] = ('d2f9e1a0c4b3', 'e8f5b3c9a2d1')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
