"""Treat connected WhatsApp pairing sessions as completed history.

Revision ID: d7f3a1c9e5b2
Revises: c2f8a4d6e9b1
Create Date: 2026-08-03 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d7f3a1c9e5b2"
down_revision: str | Sequence[str] | None = "c2f8a4d6e9b1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_PAIRING_STATES = "'generating', 'ready', 'scanned', 'error'"
_LEGACY_ACTIVE_STATES = "'generating', 'ready', 'scanned', 'connected', 'error'"


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text("LOCK TABLE channel_whatsapp_onboarding_sessions IN ACCESS EXCLUSIVE MODE")
    )
    _replace_indexes(_PAIRING_STATES)


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text("LOCK TABLE channel_whatsapp_onboarding_sessions IN ACCESS EXCLUSIVE MODE")
    )
    duplicate = bind.execute(
        sa.text(
            """
            SELECT 1
            FROM channel_whatsapp_onboarding_sessions
            WHERE state IN ('generating', 'ready', 'scanned', 'connected', 'error')
            GROUP BY sidecar_account_id
            HAVING count(*) > 1
            UNION ALL
            SELECT 1
            FROM channel_whatsapp_onboarding_sessions
            WHERE ownership_kind = 'custom'
              AND state IN ('generating', 'ready', 'scanned', 'connected', 'error')
            GROUP BY user_id, name
            HAVING count(*) > 1
            UNION ALL
            SELECT 1
            FROM channel_whatsapp_onboarding_sessions
            WHERE ownership_kind = 'platform'
              AND state IN ('generating', 'ready', 'scanned', 'connected', 'error')
            GROUP BY name
            HAVING count(*) > 1
            LIMIT 1
            """
        )
    ).first()
    if duplicate is not None:
        raise RuntimeError(
            "cannot restore legacy WhatsApp pairing indexes while completed sessions overlap"
        )
    _replace_indexes(_LEGACY_ACTIVE_STATES)


def _replace_indexes(states: str) -> None:
    op.drop_index(
        "uq_channel_whatsapp_onboarding_active_sidecar_account",
        table_name="channel_whatsapp_onboarding_sessions",
    )
    op.drop_index(
        "uq_channel_whatsapp_onboarding_active_custom_user_name",
        table_name="channel_whatsapp_onboarding_sessions",
    )
    op.drop_index(
        "uq_channel_whatsapp_onboarding_active_platform_name",
        table_name="channel_whatsapp_onboarding_sessions",
    )
    op.create_index(
        "uq_channel_whatsapp_onboarding_active_sidecar_account",
        "channel_whatsapp_onboarding_sessions",
        ["sidecar_account_id"],
        unique=True,
        postgresql_where=sa.text(f"state IN ({states})"),
    )
    op.create_index(
        "uq_channel_whatsapp_onboarding_active_custom_user_name",
        "channel_whatsapp_onboarding_sessions",
        ["user_id", "name"],
        unique=True,
        postgresql_where=sa.text(f"ownership_kind = 'custom' AND state IN ({states})"),
    )
    op.create_index(
        "uq_channel_whatsapp_onboarding_active_platform_name",
        "channel_whatsapp_onboarding_sessions",
        ["name"],
        unique=True,
        postgresql_where=sa.text(f"ownership_kind = 'platform' AND state IN ({states})"),
    )
