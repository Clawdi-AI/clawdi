"""add device_authorizations

Revision ID: f972e0fac9ef
Revises: b4c2e9a7d131
Create Date: 2026-04-24 19:08:55.322166

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f972e0fac9ef'
down_revision: Union[str, Sequence[str], None] = 'b4c2e9a7d131'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'device_authorizations',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('device_code', sa.String(length=64), nullable=False),
        sa.Column('user_code', sa.String(length=16), nullable=False),
        sa.Column('client_label', sa.String(length=200), nullable=True),
        sa.Column('status', sa.String(length=16), server_default='pending', nullable=False),
        sa.Column('user_id', sa.UUID(), nullable=True),
        sa.Column('api_key_id', sa.UUID(), nullable=True),
        sa.Column('api_key_raw', sa.Text(), nullable=True),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        op.f('ix_device_authorizations_device_code'),
        'device_authorizations',
        ['device_code'],
        unique=True,
    )
    op.create_index(
        op.f('ix_device_authorizations_user_code'),
        'device_authorizations',
        ['user_code'],
        unique=True,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(
        op.f('ix_device_authorizations_user_code'),
        table_name='device_authorizations',
    )
    op.drop_index(
        op.f('ix_device_authorizations_device_code'),
        table_name='device_authorizations',
    )
    op.drop_table('device_authorizations')
