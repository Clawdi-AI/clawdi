"""Add global typed application settings.

Revision ID: 3e7a9c1d5b82
Revises: f4c8a1d7e2b9
Create Date: 2026-07-28 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "3e7a9c1d5b82"
down_revision: str | Sequence[str] | None = "f4c8a1d7e2b9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CLERK_CLI_OAUTH_SETTING_KEY = "clerk_cli_oauth"


def upgrade() -> None:
    app_settings = op.create_table(
        "app_settings",
        sa.Column("key", sa.String(length=128), primary_key=True),
        sa.Column("value_json", JSONB(none_as_null=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.bulk_insert(
        app_settings,
        [
            {
                "key": CLERK_CLI_OAUTH_SETTING_KEY,
                "value_json": {
                    "enabled": False,
                    "schema_version": 1,
                    "issuer": "",
                    "client_id": "",
                    "application_id": "",
                    "redirect_uri": "",
                    "audience": "",
                    "authorized_parties": [],
                },
            }
        ],
    )


def downgrade() -> None:
    op.drop_table("app_settings")
