import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    UniqueConstraint,
)
from sqlalchemy import (
    text as sql_text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.session import AgentEnvironment  # noqa: F401 - register table for FK resolution
from app.models.user import User  # noqa: F401 - register table for FK resolution

CHANNEL_PROVIDER_TELEGRAM = "telegram"
CHANNEL_PROVIDER_DISCORD = "discord"
CHANNEL_PROVIDER_WHATSAPP = "whatsapp"
CHANNEL_PROVIDER_IMESSAGE = "imessage"
CHANNEL_PROVIDERS = (
    CHANNEL_PROVIDER_TELEGRAM,
    CHANNEL_PROVIDER_DISCORD,
    CHANNEL_PROVIDER_WHATSAPP,
    CHANNEL_PROVIDER_IMESSAGE,
)

CHANNEL_STATUS_ACTIVE = "active"
CHANNEL_STATUS_DISABLED = "disabled"

CHANNEL_VISIBILITY_PRIVATE = "private"
CHANNEL_VISIBILITY_PUBLIC = "public"

BINDING_STATUS_ACTIVE = "active"
BINDING_STATUS_ARCHIVED = "archived"

BOT_AGENT_LINK_STATUS_ACTIVE = "active"
BOT_AGENT_LINK_STATUS_ARCHIVED = "archived"

PAIR_CODE_STATUS_PENDING = "pending"
PAIR_CODE_STATUS_CLAIMED = "claimed"
PAIR_CODE_STATUS_REVOKED = "revoked"

MESSAGE_DIRECTION_INBOUND = "inbound"
MESSAGE_DIRECTION_OUTBOUND = "outbound"

DELIVERY_STATUS_PENDING = "pending"
DELIVERY_STATUS_IN_PROGRESS = "in_progress"
DELIVERY_STATUS_SUCCEEDED = "succeeded"
DELIVERY_STATUS_FAILED = "failed"


class ChannelAccount(Base, TimestampMixin):
    __tablename__ = "channel_accounts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    status: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        default=CHANNEL_STATUS_ACTIVE,
        server_default=CHANNEL_STATUS_ACTIVE,
    )
    visibility: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        default=CHANNEL_VISIBILITY_PRIVATE,
        server_default=CHANNEL_VISIBILITY_PRIVATE,
        index=True,
    )

    encrypted_provider_token: Mapped[bytes | None] = mapped_column(LargeBinary)
    provider_token_nonce: Mapped[bytes | None] = mapped_column(LargeBinary)
    webhook_secret_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    config: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        Index(
            "uq_channel_accounts_user_provider_name_active",
            "user_id",
            "provider",
            "name",
            unique=True,
            postgresql_where=sql_text("archived_at IS NULL"),
        ),
    )


class ChannelBotAgentLink(Base, TimestampMixin):
    __tablename__ = "channel_bot_agent_links"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("channel_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    agent_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agent_environments.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    agent_token_hash: Mapped[str | None] = mapped_column(String(64), unique=True, index=True)
    encrypted_agent_token: Mapped[bytes | None] = mapped_column(LargeBinary)
    agent_token_nonce: Mapped[bytes | None] = mapped_column(LargeBinary)
    status: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        default=BOT_AGENT_LINK_STATUS_ACTIVE,
        server_default=BOT_AGENT_LINK_STATUS_ACTIVE,
    )
    config: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        Index(
            "uq_channel_bot_agent_links_account_agent_active",
            "account_id",
            "agent_id",
            unique=True,
            postgresql_where=sql_text("archived_at IS NULL"),
        ),
    )


class ChannelSecret(Base, TimestampMixin):
    __tablename__ = "channel_secrets"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("channel_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    encrypted_value: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    value_nonce: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)

    __table_args__ = (
        UniqueConstraint(
            "account_id",
            "name",
            name="uq_channel_secrets_account_name",
        ),
    )


class ChannelBinding(Base, TimestampMixin):
    __tablename__ = "channel_bindings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("channel_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    bot_agent_link_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("channel_bot_agent_links.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    external_chat_id: Mapped[str] = mapped_column(String(300), nullable=False)
    external_chat_type: Mapped[str | None] = mapped_column(String(40))
    external_chat_name: Mapped[str | None] = mapped_column(String(300))
    paired_external_user_id: Mapped[str | None] = mapped_column(String(300))
    status: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        default=BINDING_STATUS_ACTIVE,
        server_default=BINDING_STATUS_ACTIVE,
    )

    __table_args__ = (
        Index(
            "uq_channel_bindings_account_external_chat_active",
            "account_id",
            "external_chat_id",
            unique=True,
            postgresql_where=sql_text("status = 'active'"),
        ),
    )


class ChannelBindingAlias(Base, TimestampMixin):
    __tablename__ = "channel_binding_aliases"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("channel_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    bot_agent_link_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("channel_bot_agent_links.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    binding_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("channel_bindings.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    alias_external_chat_id: Mapped[str] = mapped_column(String(300), nullable=False)
    alias_kind: Mapped[str] = mapped_column(
        String(40),
        nullable=False,
        default="jid_alias",
        server_default="jid_alias",
    )

    __table_args__ = (
        UniqueConstraint(
            "account_id",
            "alias_external_chat_id",
            name="uq_channel_binding_aliases_account_alias",
        ),
    )


class ChannelPairCode(Base, TimestampMixin):
    __tablename__ = "channel_pair_codes"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("channel_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    bot_agent_link_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("channel_bot_agent_links.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        default=PAIR_CODE_STATUS_PENDING,
        server_default=PAIR_CODE_STATUS_PENDING,
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    claimed_external_chat_id: Mapped[str | None] = mapped_column(String(300))
    claimed_external_user_id: Mapped[str | None] = mapped_column(String(300))


class ChannelMessage(Base, TimestampMixin):
    __tablename__ = "channel_messages"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("channel_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    bot_agent_link_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("channel_bot_agent_links.id", ondelete="SET NULL"),
        index=True,
    )
    binding_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("channel_bindings.id", ondelete="SET NULL"),
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    direction: Mapped[str] = mapped_column(String(16), nullable=False)
    inbox_sequence: Mapped[int] = mapped_column(
        BigInteger,
        nullable=False,
        index=True,
        server_default=sql_text("nextval('channel_messages_inbox_sequence_seq'::regclass)"),
    )
    external_chat_id: Mapped[str] = mapped_column(String(300), nullable=False, index=True)
    provider_message_id: Mapped[str | None] = mapped_column(String(300))
    text: Mapped[str | None] = mapped_column(String(4096))
    payload: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)

    __table_args__ = (
        Index(
            "ix_channel_messages_inbox_pending",
            "account_id",
            "direction",
            "delivered_at",
            "inbox_sequence",
        ),
        Index(
            "ux_channel_messages_inbound_provider_message_bound",
            "account_id",
            "external_chat_id",
            "provider_message_id",
            "bot_agent_link_id",
            unique=True,
            postgresql_where=sql_text(
                "direction = 'inbound' "
                "AND provider_message_id IS NOT NULL "
                "AND bot_agent_link_id IS NOT NULL"
            ),
        ),
        Index(
            "ux_channel_messages_inbound_provider_message_unbound",
            "account_id",
            "external_chat_id",
            "provider_message_id",
            unique=True,
            postgresql_where=sql_text(
                "direction = 'inbound' "
                "AND provider_message_id IS NOT NULL "
                "AND bot_agent_link_id IS NULL"
            ),
        ),
    )


class ChannelDebugEvent(Base, TimestampMixin):
    __tablename__ = "channel_debug_events"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("channel_accounts.id", ondelete="CASCADE"),
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    external_chat_id: Mapped[str | None] = mapped_column(String(300), index=True)
    direction: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    stage: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    outcome: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    request_id: Mapped[str | None] = mapped_column(String(120), index=True)
    status_code: Mapped[int | None] = mapped_column(Integer)
    error: Mapped[str | None] = mapped_column(String(500))
    details: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))


class ChannelAttachmentUpload(Base, TimestampMixin):
    __tablename__ = "channel_attachment_uploads"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("channel_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    upload_path: Mapped[str] = mapped_column(String(500), nullable=False)
    file_key: Mapped[str] = mapped_column(String(800), nullable=False)
    file_name: Mapped[str | None] = mapped_column(String(300))
    content_type: Mapped[str | None] = mapped_column(String(120))
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        index=True,
    )
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)

    __table_args__ = (
        UniqueConstraint(
            "account_id",
            "upload_path",
            name="uq_channel_attachment_uploads_account_path",
        ),
    )


class ChannelScheduledMessage(Base, TimestampMixin):
    __tablename__ = "channel_scheduled_messages"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("channel_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    bot_agent_link_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("channel_bot_agent_links.id", ondelete="SET NULL"),
        index=True,
    )
    binding_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("channel_bindings.id", ondelete="SET NULL"),
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    external_chat_id: Mapped[str] = mapped_column(String(300), nullable=False, index=True)
    status: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        default="scheduled",
        server_default="scheduled",
        index=True,
    )
    scheduled_for: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB(none_as_null=True), nullable=False)


class ChannelAgentReference(Base, TimestampMixin):
    __tablename__ = "channel_agent_references"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("channel_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    bot_agent_link_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("channel_bot_agent_links.id", ondelete="SET NULL"),
        index=True,
    )
    binding_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("channel_bindings.id", ondelete="SET NULL"),
        index=True,
    )
    message_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("channel_messages.id", ondelete="SET NULL"),
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    ref_kind: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    ref_value: Mapped[str] = mapped_column(String(800), nullable=False)
    metadata_: Mapped[dict[str, Any] | None] = mapped_column("metadata", JSONB(none_as_null=True))

    __table_args__ = (
        UniqueConstraint(
            "account_id",
            "bot_agent_link_id",
            "ref_kind",
            "ref_value",
            name="uq_channel_agent_references_account_link_kind_value",
        ),
    )


class ChannelDelivery(Base, TimestampMixin):
    __tablename__ = "channel_deliveries"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("channel_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    bot_agent_link_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("channel_bot_agent_links.id", ondelete="SET NULL"),
        index=True,
    )
    message_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("channel_messages.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    status: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        default=DELIVERY_STATUS_PENDING,
        server_default=DELIVERY_STATUS_PENDING,
        index=True,
    )
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    max_attempts: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=5,
        server_default="5",
    )
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    locked_by: Mapped[str | None] = mapped_column(String(120))
    last_error: Mapped[str | None] = mapped_column(String(1000))
    provider_response: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))

    __table_args__ = (
        Index(
            "ix_channel_deliveries_due",
            "status",
            "next_attempt_at",
            "created_at",
        ),
    )


class ChannelAgentCredential(Base, TimestampMixin):
    __tablename__ = "channel_agent_credentials"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("channel_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    bot_agent_link_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("channel_bot_agent_links.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    identity_pub_key_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    identity_public_key: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    synthetic_jid: Mapped[str] = mapped_column(String(300), nullable=False)
    encrypted_credentials: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    credential_nonce: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    config: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)

    __table_args__ = (
        UniqueConstraint(
            "account_id",
            "identity_pub_key_hash",
            name="uq_channel_agent_credentials_account_identity",
        ),
    )


class ChannelWhatsAppAuthCert(Base, TimestampMixin):
    __tablename__ = "channel_whatsapp_auth_certs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("channel_accounts.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    root_public_key: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    encrypted_root_private_key: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    root_private_key_nonce: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    intermediate_public_key: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    encrypted_intermediate_private_key: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    intermediate_private_key_nonce: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    serial: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
