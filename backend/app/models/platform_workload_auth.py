import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin

PLATFORM_WORKLOAD_CLIENT_ACTIVE = "active"
PLATFORM_WORKLOAD_CLIENT_DISABLED = "disabled"
PLATFORM_WORKLOAD_CLIENT_REVOKED = "revoked"

PLATFORM_WORKLOAD_SIGNING_KEY_ACTIVE = "active"
PLATFORM_WORKLOAD_SIGNING_KEY_RETIRED = "retired"
PLATFORM_WORKLOAD_SIGNING_KEY_REVOKED = "revoked"


class PlatformWorkloadClient(Base, TimestampMixin):
    __tablename__ = "platform_workload_clients"
    __table_args__ = (
        CheckConstraint(
            "status IN ('active', 'disabled', 'revoked')",
            name="ck_platform_workload_clients_status",
        ),
        CheckConstraint(
            "token_version >= 1",
            name="ck_platform_workload_clients_token_version",
        ),
        CheckConstraint(
            "jsonb_typeof(public_jwk) = 'object'",
            name="ck_platform_workload_clients_public_jwk_object",
        ),
        CheckConstraint(
            "NOT (public_jwk ?| ARRAY['d','p','q','dp','dq','qi','oth','k']::text[])",
            name="ck_platform_workload_clients_public_jwk_only",
        ),
        CheckConstraint(
            "public_jwk ?& ARRAY['kid','alg','kty']::text[] "
            "AND public_jwk ->> 'kid' = assertion_kid "
            "AND public_jwk ->> 'alg' = assertion_algorithm",
            name="ck_platform_workload_clients_public_jwk_identity",
        ),
        CheckConstraint(
            "(assertion_algorithm = 'RS256' AND public_jwk ->> 'kty' = 'RSA') "
            "OR (assertion_algorithm = 'ES256' AND public_jwk ->> 'kty' = 'EC')",
            name="ck_platform_workload_clients_public_jwk_key_type",
        ),
        CheckConstraint(
            "assertion_algorithm IN ('RS256', 'ES256')",
            name="ck_platform_workload_clients_assertion_algorithm",
        ),
        CheckConstraint(
            "cardinality(allowed_scopes) > 0 AND allowed_scopes <@ "
            "ARRAY['platform:agents:create','platform:agents:delete',"
            "'platform:runtime-state:write','platform:keys:mint',"
            "'platform:keys:revoke']::varchar[]",
            name="ck_platform_workload_clients_allowed_scopes",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    client_id: Mapped[str] = mapped_column(String(200), unique=True, nullable=False)
    assertion_kid: Mapped[str] = mapped_column(String(200), nullable=False)
    assertion_algorithm: Mapped[str] = mapped_column(String(16), nullable=False)
    public_jwk: Mapped[dict] = mapped_column(JSONB(none_as_null=True), nullable=False)
    status: Mapped[str] = mapped_column(
        String(32),
        default=PLATFORM_WORKLOAD_CLIENT_ACTIVE,
        server_default=PLATFORM_WORKLOAD_CLIENT_ACTIVE,
        nullable=False,
        index=True,
    )
    allowed_scopes: Mapped[list[str]] = mapped_column(ARRAY(String(64)), nullable=False)
    token_version: Mapped[int] = mapped_column(
        Integer,
        default=1,
        server_default="1",
        nullable=False,
    )
    revoked_before: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PlatformWorkloadAssertionReplay(Base, TimestampMixin):
    __tablename__ = "platform_workload_assertion_replays"
    __table_args__ = (
        UniqueConstraint(
            "client_id",
            "jti",
            name="uq_platform_workload_assertion_replays_client_jti",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    client_id: Mapped[str] = mapped_column(
        String(200),
        ForeignKey("platform_workload_clients.client_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    jti: Mapped[str] = mapped_column(String(200), nullable=False)
    assertion_expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )


class PlatformWorkloadSigningKey(Base, TimestampMixin):
    __tablename__ = "platform_workload_signing_keys"
    __table_args__ = (
        CheckConstraint(
            "status IN ('active', 'retired', 'revoked')",
            name="ck_platform_workload_signing_keys_status",
        ),
        CheckConstraint(
            "algorithm IN ('RS256', 'ES256')",
            name="ck_platform_workload_signing_keys_algorithm",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    kid: Mapped[str] = mapped_column(String(200), unique=True, nullable=False)
    algorithm: Mapped[str] = mapped_column(String(16), nullable=False)
    private_key_ref: Mapped[str] = mapped_column(String(500), unique=True, nullable=False)
    status: Mapped[str] = mapped_column(
        String(32),
        default=PLATFORM_WORKLOAD_SIGNING_KEY_ACTIVE,
        server_default=PLATFORM_WORKLOAD_SIGNING_KEY_ACTIVE,
        nullable=False,
        index=True,
    )
    not_before: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
