"""Add platform workload OAuth authorization-server state.

Revision ID: c7e4a9b2d6f1
Revises: f3a1c7d9e2b4
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "c7e4a9b2d6f1"
down_revision: str | Sequence[str] | None = "f1a7c3d9e2b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_APPROVED_SCOPES_SQL = (
    "ARRAY["
    + ",".join(
        f"'{scope}'"
        for scope in (
            "platform:agents:create",
            "platform:agents:delete",
            "platform:runtime-state:write",
            "platform:keys:mint",
            "platform:keys:revoke",
        )
    )
    + "]::varchar[]"
)


def upgrade() -> None:
    op.create_table(
        "platform_workload_clients",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("client_id", sa.String(length=200), nullable=False),
        sa.Column("assertion_kid", sa.String(length=200), nullable=False),
        sa.Column("assertion_algorithm", sa.String(length=16), nullable=False),
        sa.Column("public_jwk", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("status", sa.String(length=32), server_default="active", nullable=False),
        sa.Column("allowed_scopes", postgresql.ARRAY(sa.String(length=64)), nullable=False),
        sa.Column("token_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("revoked_before", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "status IN ('active', 'disabled', 'revoked')",
            name="ck_platform_workload_clients_status",
        ),
        sa.CheckConstraint(
            "token_version >= 1",
            name="ck_platform_workload_clients_token_version",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(public_jwk) = 'object'",
            name="ck_platform_workload_clients_public_jwk_object",
        ),
        sa.CheckConstraint(
            "NOT (public_jwk ?| ARRAY['d','p','q','dp','dq','qi','oth','k']::text[])",
            name="ck_platform_workload_clients_public_jwk_only",
        ),
        sa.CheckConstraint(
            "public_jwk ?& ARRAY['kid','alg','kty']::text[] "
            "AND public_jwk ->> 'kid' = assertion_kid "
            "AND public_jwk ->> 'alg' = assertion_algorithm",
            name="ck_platform_workload_clients_public_jwk_identity",
        ),
        sa.CheckConstraint(
            "(assertion_algorithm = 'RS256' AND public_jwk ->> 'kty' = 'RSA') "
            "OR (assertion_algorithm = 'ES256' AND public_jwk ->> 'kty' = 'EC')",
            name="ck_platform_workload_clients_public_jwk_key_type",
        ),
        sa.CheckConstraint(
            "assertion_algorithm IN ('RS256', 'ES256')",
            name="ck_platform_workload_clients_assertion_algorithm",
        ),
        sa.CheckConstraint(
            f"cardinality(allowed_scopes) > 0 AND allowed_scopes <@ {_APPROVED_SCOPES_SQL}",
            name="ck_platform_workload_clients_allowed_scopes",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("client_id", name="uq_platform_workload_clients_client_id"),
    )
    op.create_index(
        "ix_platform_workload_clients_status",
        "platform_workload_clients",
        ["status"],
    )

    op.create_table(
        "platform_workload_signing_keys",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("kid", sa.String(length=200), nullable=False),
        sa.Column("algorithm", sa.String(length=16), nullable=False),
        sa.Column("private_key_ref", sa.String(length=500), nullable=False),
        sa.Column("status", sa.String(length=32), server_default="active", nullable=False),
        sa.Column("not_before", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "status IN ('active', 'retired', 'revoked')",
            name="ck_platform_workload_signing_keys_status",
        ),
        sa.CheckConstraint(
            "algorithm IN ('RS256', 'ES256')",
            name="ck_platform_workload_signing_keys_algorithm",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("kid", name="uq_platform_workload_signing_keys_kid"),
        sa.UniqueConstraint(
            "private_key_ref",
            name="uq_platform_workload_signing_keys_private_key_ref",
        ),
    )
    op.create_index(
        "ix_platform_workload_signing_keys_status",
        "platform_workload_signing_keys",
        ["status"],
    )

    op.create_table(
        "platform_workload_assertion_replays",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("client_id", sa.String(length=200), nullable=False),
        sa.Column("jti", sa.String(length=200), nullable=False),
        sa.Column("assertion_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["client_id"],
            ["platform_workload_clients.client_id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "client_id",
            "jti",
            name="uq_platform_workload_assertion_replays_client_jti",
        ),
    )
    op.create_index(
        "ix_platform_workload_assertion_replays_client_id",
        "platform_workload_assertion_replays",
        ["client_id"],
    )
    op.create_index(
        "ix_platform_workload_assertion_replays_assertion_expires_at",
        "platform_workload_assertion_replays",
        ["assertion_expires_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_platform_workload_assertion_replays_assertion_expires_at",
        table_name="platform_workload_assertion_replays",
    )
    op.drop_index(
        "ix_platform_workload_assertion_replays_client_id",
        table_name="platform_workload_assertion_replays",
    )
    op.drop_table("platform_workload_assertion_replays")
    op.drop_index(
        "ix_platform_workload_signing_keys_status",
        table_name="platform_workload_signing_keys",
    )
    op.drop_table("platform_workload_signing_keys")
    op.drop_index(
        "ix_platform_workload_clients_status",
        table_name="platform_workload_clients",
    )
    op.drop_table("platform_workload_clients")
