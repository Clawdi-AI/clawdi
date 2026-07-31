import secrets
import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.session import AgentEnvironment  # noqa: F401 - register FK target
from app.models.user import User  # noqa: F401 - register users table for FK resolution


class AiProvider(Base, TimestampMixin):
    __tablename__ = "ai_providers"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    provider_id: Mapped[str] = mapped_column(String(80), nullable=False)
    type: Mapped[str] = mapped_column(String(80), nullable=False)
    label: Mapped[str | None] = mapped_column(String(200))
    base_url: Mapped[str] = mapped_column(String(1000), nullable=False)
    api_mode: Mapped[str | None] = mapped_column(String(80))
    capabilities: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    models: Mapped[list[dict] | None] = mapped_column(JSONB(none_as_null=True))
    auth_type: Mapped[str] = mapped_column(String(80), nullable=False)
    auth_ref: Mapped[str | None] = mapped_column(String(1000))
    auth_metadata: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    managed_by: Mapped[str] = mapped_column(String(80), nullable=False, server_default="user")
    runtime_env_name: Mapped[str | None] = mapped_column(String(128))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint("owner_user_id", "provider_id", name="uq_ai_providers_owner_provider_id"),
    )


class AiProviderAuthPayload(Base, TimestampMixin):
    __tablename__ = "ai_provider_auth_payloads"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    provider_id: Mapped[str] = mapped_column(String(80), nullable=False)
    auth_profile: Mapped[str] = mapped_column(String(120), nullable=False, server_default="default")
    kind: Mapped[str] = mapped_column(String(80), nullable=False)
    source: Mapped[str] = mapped_column(String(80), nullable=False)
    encrypted_payload: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    nonce: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    payload_metadata: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    credential_revision: Mapped[str] = mapped_column(
        String(64), nullable=False, default=lambda: secrets.token_hex(16)
    )
    consumer_environment_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agent_environments.id", ondelete="RESTRICT"),
        index=True,
    )
    consumer_runtime: Mapped[str | None] = mapped_column(String(32))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint(
            "owner_user_id",
            "provider_id",
            "auth_profile",
            name="uq_ai_provider_auth_payloads_owner_provider_profile",
        ),
        CheckConstraint(
            "(consumer_environment_id IS NULL AND consumer_runtime IS NULL) OR "
            "(consumer_environment_id IS NOT NULL AND consumer_runtime IS NOT NULL AND "
            "consumer_runtime IN ('codex', 'hermes', 'openclaw'))",
            name="ck_ai_provider_auth_payloads_consumer",
        ),
    )


class AiProviderOAuthAttempt(Base, TimestampMixin):
    __tablename__ = "ai_provider_oauth_attempts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    flow_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False, unique=True, default=uuid.uuid4
    )
    owner_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    provider_row_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("ai_providers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    provider_id: Mapped[str] = mapped_column(String(80), nullable=False)
    oauth_provider: Mapped[str] = mapped_column(String(80), nullable=False)
    auth_profile: Mapped[str] = mapped_column(String(120), nullable=False)
    flow_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, server_default="pending")
    base_credential_revision: Mapped[str | None] = mapped_column(String(64))
    state_sha256: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    encrypted_flow_payload: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    flow_payload_nonce: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    receipt: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    exchange_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(
            "flow_kind IN ('authorization_code', 'device_code')",
            name="ck_ai_provider_oauth_attempts_flow_kind",
        ),
        CheckConstraint(
            "status IN ('pending', 'exchanging', 'committed', 'failed')",
            name="ck_ai_provider_oauth_attempts_status",
        ),
    )


class AiProviderOAuthRevokeTombstone(Base, TimestampMixin):
    __tablename__ = "ai_provider_oauth_revoke_tombstones"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Deliberately not an FK: compensation must survive provider/attempt cascade deletion.
    oauth_attempt_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        index=True,
    )
    provider_id: Mapped[str] = mapped_column(String(80), nullable=False)
    oauth_provider: Mapped[str] = mapped_column(String(80), nullable=False)
    token_type: Mapped[str] = mapped_column(String(32), nullable=False)
    token_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    encrypted_token: Mapped[bytes | None] = mapped_column(LargeBinary)
    token_nonce: Mapped[bytes | None] = mapped_column(LargeBinary)
    status: Mapped[str] = mapped_column(String(32), nullable=False, server_default="pending")
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    claim_id: Mapped[str | None] = mapped_column(String(64))
    last_error: Mapped[str | None] = mapped_column(String(500))

    __table_args__ = (
        UniqueConstraint(
            "owner_user_id",
            "oauth_provider",
            "token_type",
            "token_sha256",
            name="uq_ai_provider_oauth_revoke_token",
        ),
        CheckConstraint(
            "token_type IN ('refresh_token', 'access_token')",
            name="ck_ai_provider_oauth_revoke_token_type",
        ),
        CheckConstraint(
            "status IN ('pending', 'processing', 'revoked', 'cancelled')",
            name="ck_ai_provider_oauth_revoke_status",
        ),
        CheckConstraint(
            "((status IN ('pending', 'processing')) AND encrypted_token IS NOT NULL AND "
            "token_nonce IS NOT NULL) OR ((status IN ('revoked', 'cancelled')) AND "
            "encrypted_token IS NULL AND token_nonce IS NULL)",
            name="ck_ai_provider_oauth_revoke_material",
        ),
    )
