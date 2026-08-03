"""Make shared channel accounts explicit platform inventory.

Revision ID: c2f8a4d6e9b1
Revises: b4e8c1d7a2f9
Create Date: 2026-08-03 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "c2f8a4d6e9b1"
down_revision: str | Sequence[str] | None = "b4e8c1d7a2f9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_ACTIVE_ONBOARDING_STATES = "'generating', 'ready', 'scanned', 'connected', 'error'"


def upgrade() -> None:
    # Lock the ownership roots while the fake tenant owners are removed. Child
    # Link/Binding/Message/Credential rows remain untouched and tenant-scoped.
    bind = op.get_bind()
    bind.execute(sa.text("LOCK TABLE channel_accounts IN ACCESS EXCLUSIVE MODE"))
    bind.execute(
        sa.text("LOCK TABLE channel_whatsapp_onboarding_sessions IN ACCESS EXCLUSIVE MODE")
    )

    op.drop_index(
        "uq_channel_accounts_user_provider_name_active",
        table_name="channel_accounts",
    )
    op.alter_column(
        "channel_accounts",
        "user_id",
        existing_type=postgresql.UUID(as_uuid=True),
        nullable=True,
    )
    op.alter_column(
        "channel_secrets",
        "user_id",
        existing_type=postgresql.UUID(as_uuid=True),
        nullable=True,
    )
    op.alter_column(
        "channel_whatsapp_auth_certs",
        "user_id",
        existing_type=postgresql.UUID(as_uuid=True),
        nullable=True,
    )
    op.alter_column(
        "channel_whatsapp_onboarding_sessions",
        "user_id",
        existing_type=postgresql.UUID(as_uuid=True),
        nullable=True,
    )

    op.drop_constraint(
        "ck_channel_whatsapp_onboarding_ownership_kind",
        "channel_whatsapp_onboarding_sessions",
        type_="check",
    )
    op.drop_constraint(
        "uq_channel_whatsapp_onboarding_kind_user_request",
        "channel_whatsapp_onboarding_sessions",
        type_="unique",
    )
    op.drop_index(
        "uq_channel_whatsapp_onboarding_active_user_name",
        table_name="channel_whatsapp_onboarding_sessions",
    )

    # Public provider credentials stay attached to the same account. Only the
    # bookkeeping owner is removed so deleting that former User cannot cascade
    # platform inventory or account-level secrets/certificates.
    bind.execute(
        sa.text(
            """
            UPDATE channel_secrets AS secret
            SET user_id = NULL
            FROM channel_accounts AS account
            WHERE secret.account_id = account.id
              AND account.visibility = 'public'
            """
        )
    )
    bind.execute(
        sa.text(
            """
            UPDATE channel_whatsapp_auth_certs AS cert
            SET user_id = NULL
            FROM channel_accounts AS account
            WHERE cert.account_id = account.id
              AND account.visibility = 'public'
            """
        )
    )
    bind.execute(
        sa.text(
            """
            UPDATE channel_accounts
            SET user_id = NULL
            WHERE visibility = 'public'
            """
        )
    )
    bind.execute(
        sa.text(
            """
            UPDATE channel_whatsapp_onboarding_sessions
            SET ownership_kind = 'platform', user_id = NULL
            WHERE ownership_kind = 'managed'
            """
        )
    )

    # The old per-tenant uniqueness allowed the same public inventory name or
    # managed request id under different fake owners. Preserve every row and
    # credential, renaming only later collisions before platform-wide indexes.
    _deduplicate_platform_account_names(bind)
    _deduplicate_platform_session_names(bind)
    _deduplicate_platform_request_ids(bind)

    op.create_check_constraint(
        "ck_channel_accounts_visibility_owner",
        "channel_accounts",
        "(visibility = 'private' AND user_id IS NOT NULL) OR "
        "(visibility = 'public' AND user_id IS NULL)",
    )
    op.create_index(
        "uq_channel_accounts_user_provider_name_active",
        "channel_accounts",
        ["user_id", "provider", "name"],
        unique=True,
        postgresql_where=sa.text("visibility = 'private' AND archived_at IS NULL"),
    )
    op.create_index(
        "uq_channel_accounts_platform_provider_name_active",
        "channel_accounts",
        ["provider", "name"],
        unique=True,
        postgresql_where=sa.text(
            "visibility = 'public' AND user_id IS NULL AND archived_at IS NULL"
        ),
    )
    op.create_table(
        "channel_account_runtime_markers",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("account_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("kind", sa.String(length=64), nullable=False),
        sa.Column("scope", sa.String(length=400), nullable=False),
        sa.Column("outcome", sa.String(length=32), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.ForeignKeyConstraint(
            ["account_id"],
            ["channel_accounts.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "account_id",
            "kind",
            "scope",
            name="uq_channel_account_runtime_markers_account_kind_scope",
        ),
    )

    op.create_check_constraint(
        "ck_channel_whatsapp_onboarding_owner",
        "channel_whatsapp_onboarding_sessions",
        "(ownership_kind = 'custom' AND user_id IS NOT NULL) OR "
        "(ownership_kind = 'platform' AND user_id IS NULL)",
    )
    op.create_index(
        "uq_channel_whatsapp_onboarding_custom_user_request",
        "channel_whatsapp_onboarding_sessions",
        ["user_id", "request_id"],
        unique=True,
        postgresql_where=sa.text("ownership_kind = 'custom'"),
    )
    op.create_index(
        "uq_channel_whatsapp_onboarding_platform_request",
        "channel_whatsapp_onboarding_sessions",
        ["request_id"],
        unique=True,
        postgresql_where=sa.text("ownership_kind = 'platform'"),
    )
    op.create_index(
        "uq_channel_whatsapp_onboarding_active_custom_user_name",
        "channel_whatsapp_onboarding_sessions",
        ["user_id", "name"],
        unique=True,
        postgresql_where=sa.text(
            f"ownership_kind = 'custom' AND state IN ({_ACTIVE_ONBOARDING_STATES})"
        ),
    )
    op.create_index(
        "uq_channel_whatsapp_onboarding_active_platform_name",
        "channel_whatsapp_onboarding_sessions",
        ["name"],
        unique=True,
        postgresql_where=sa.text(
            f"ownership_kind = 'platform' AND state IN ({_ACTIVE_ONBOARDING_STATES})"
        ),
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("LOCK TABLE channel_accounts IN ACCESS EXCLUSIVE MODE"))
    bind.execute(
        sa.text("LOCK TABLE channel_whatsapp_onboarding_sessions IN ACCESS EXCLUSIVE MODE")
    )
    has_platform_inventory = bind.scalar(
        sa.text(
            """
            SELECT EXISTS (
                SELECT 1 FROM channel_accounts
                WHERE visibility = 'public' OR user_id IS NULL
                UNION ALL
                SELECT 1 FROM channel_whatsapp_onboarding_sessions
                WHERE ownership_kind = 'platform' OR user_id IS NULL
                UNION ALL
                SELECT 1 FROM channel_secrets WHERE user_id IS NULL
                UNION ALL
                SELECT 1 FROM channel_whatsapp_auth_certs WHERE user_id IS NULL
            )
            """
        )
    )
    if has_platform_inventory:
        raise RuntimeError(
            "Cannot downgrade migration c2f8a4d6e9b1 while platform channel inventory exists; "
            "the previous schema requires an arbitrary tenant owner"
        )

    op.drop_table("channel_account_runtime_markers")

    op.drop_index(
        "uq_channel_whatsapp_onboarding_active_platform_name",
        table_name="channel_whatsapp_onboarding_sessions",
    )
    op.drop_index(
        "uq_channel_whatsapp_onboarding_active_custom_user_name",
        table_name="channel_whatsapp_onboarding_sessions",
    )
    op.drop_index(
        "uq_channel_whatsapp_onboarding_platform_request",
        table_name="channel_whatsapp_onboarding_sessions",
    )
    op.drop_index(
        "uq_channel_whatsapp_onboarding_custom_user_request",
        table_name="channel_whatsapp_onboarding_sessions",
    )
    op.drop_constraint(
        "ck_channel_whatsapp_onboarding_owner",
        "channel_whatsapp_onboarding_sessions",
        type_="check",
    )
    op.create_check_constraint(
        "ck_channel_whatsapp_onboarding_ownership_kind",
        "channel_whatsapp_onboarding_sessions",
        "ownership_kind IN ('custom', 'managed')",
    )
    op.create_unique_constraint(
        "uq_channel_whatsapp_onboarding_kind_user_request",
        "channel_whatsapp_onboarding_sessions",
        ["ownership_kind", "user_id", "request_id"],
    )
    op.create_index(
        "uq_channel_whatsapp_onboarding_active_user_name",
        "channel_whatsapp_onboarding_sessions",
        ["user_id", "name"],
        unique=True,
        postgresql_where=sa.text(f"state IN ({_ACTIVE_ONBOARDING_STATES})"),
    )

    op.drop_index(
        "uq_channel_accounts_platform_provider_name_active",
        table_name="channel_accounts",
    )
    op.drop_index(
        "uq_channel_accounts_user_provider_name_active",
        table_name="channel_accounts",
    )
    op.drop_constraint(
        "ck_channel_accounts_visibility_owner",
        "channel_accounts",
        type_="check",
    )
    op.create_index(
        "uq_channel_accounts_user_provider_name_active",
        "channel_accounts",
        ["user_id", "provider", "name"],
        unique=True,
        postgresql_where=sa.text("archived_at IS NULL"),
    )

    op.alter_column(
        "channel_whatsapp_onboarding_sessions",
        "user_id",
        existing_type=postgresql.UUID(as_uuid=True),
        nullable=False,
    )
    op.alter_column(
        "channel_whatsapp_auth_certs",
        "user_id",
        existing_type=postgresql.UUID(as_uuid=True),
        nullable=False,
    )
    op.alter_column(
        "channel_secrets",
        "user_id",
        existing_type=postgresql.UUID(as_uuid=True),
        nullable=False,
    )
    op.alter_column(
        "channel_accounts",
        "user_id",
        existing_type=postgresql.UUID(as_uuid=True),
        nullable=False,
    )


def _deduplicate_platform_account_names(bind: sa.Connection) -> None:
    bind.execute(
        sa.text(
            """
            WITH ranked AS (
                SELECT id,
                       row_number() OVER (
                           PARTITION BY provider, name
                           ORDER BY created_at, id
                       ) AS duplicate_number
                FROM channel_accounts
                WHERE visibility = 'public' AND archived_at IS NULL
            )
            UPDATE channel_accounts AS account
            SET name = left(account.name, 73) || '-platform-' || account.id::text
            FROM ranked
            WHERE account.id = ranked.id
              AND ranked.duplicate_number > 1
            """
        )
    )


def _deduplicate_platform_session_names(bind: sa.Connection) -> None:
    bind.execute(
        sa.text(
            f"""
            WITH ranked AS (
                SELECT id,
                       row_number() OVER (
                           PARTITION BY name
                           ORDER BY created_at, id
                       ) AS duplicate_number
                FROM channel_whatsapp_onboarding_sessions
                WHERE ownership_kind = 'platform'
                  AND state IN ({_ACTIVE_ONBOARDING_STATES})
            )
            UPDATE channel_whatsapp_onboarding_sessions AS session
            SET name = left(session.name, 73) || '-platform-' || session.id::text
            FROM ranked
            WHERE session.id = ranked.id
              AND ranked.duplicate_number > 1
            """
        )
    )


def _deduplicate_platform_request_ids(bind: sa.Connection) -> None:
    bind.execute(
        sa.text(
            """
            WITH ranked AS (
                SELECT id,
                       row_number() OVER (
                           PARTITION BY request_id
                           ORDER BY created_at, id
                       ) AS duplicate_number
                FROM channel_whatsapp_onboarding_sessions
                WHERE ownership_kind = 'platform'
            )
            UPDATE channel_whatsapp_onboarding_sessions AS session
            SET request_id = md5('platform-pairing:' || session.id::text)::uuid
            FROM ranked
            WHERE session.id = ranked.id
              AND ranked.duplicate_number > 1
            """
        )
    )
