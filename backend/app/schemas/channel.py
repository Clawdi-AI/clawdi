from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

ChannelProvider = Literal["telegram", "discord", "whatsapp", "imessage"]
ChannelVisibility = Literal["private", "public"]
ChannelBotPoolAccess = Literal["owner", "public"]
ChannelHealthStatus = Literal["ok", "warning", "error"]


class ChannelAccountCreate(BaseModel):
    provider: ChannelProvider
    name: str = Field(min_length=1, max_length=120)
    agent_id: UUID | None = None
    provider_token: str | None = Field(default=None, min_length=1, max_length=2000)
    config: dict[str, Any] | None = None
    secrets: dict[str, str] | None = None

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("name cannot be blank")
        return stripped

    @field_validator("secrets")
    @classmethod
    def _validate_secrets(cls, value: dict[str, str] | None) -> dict[str, str] | None:
        if value is None:
            return None
        cleaned: dict[str, str] = {}
        for key, secret in value.items():
            name = key.strip()
            if not name or len(name) > 80 or not name.replace("_", "").isalnum():
                raise ValueError("secret names must be alphanumeric or underscore")
            if not isinstance(secret, str) or not secret:
                raise ValueError("secret values cannot be blank")
            cleaned[name] = secret
        return cleaned


class ChannelAccountResponse(BaseModel):
    id: UUID
    provider: str
    name: str
    status: str
    visibility: ChannelVisibility = "private"
    has_provider_token: bool
    webhook_url: str
    created_at: datetime


class ChannelRuntimeAgentLinkResponse(BaseModel):
    id: UUID
    account_id: UUID
    agent_id: UUID
    status: str
    created_at: datetime
    agent_token: str | None = None


class ChannelRuntimeAccountResponse(ChannelAccountResponse):
    runtime_links: list[ChannelRuntimeAgentLinkResponse] = Field(default_factory=list)


class ChannelBotPoolCapabilities(BaseModel):
    link_agent: bool
    pair_chat: bool
    send_message: bool
    manage_account: bool
    sync_commands: bool


class ChannelBotPoolItem(ChannelAccountResponse):
    access: ChannelBotPoolAccess
    capabilities: ChannelBotPoolCapabilities


class ChannelBotPoolResponse(BaseModel):
    providers: dict[str, list[ChannelBotPoolItem]]


class ChannelAccountCreatedResponse(ChannelAccountResponse):
    webhook_secret: str
    agent_link_id: UUID | None = None
    agent_id: UUID | None = None
    agent_token: str | None = None


class ChannelAgentLinkCreate(BaseModel):
    agent_id: UUID | None = None


class ChannelAgentLinkResponse(BaseModel):
    id: UUID
    account_id: UUID
    agent_id: UUID
    status: str
    created_at: datetime
    agent_token: str | None = None


class ChannelPairCodeCreate(BaseModel):
    agent_id: UUID | None = None
    agent_link_id: UUID | None = None
    ttl_seconds: int = Field(default=900, ge=60, le=86_400)


class ChannelPairCodeResponse(BaseModel):
    id: UUID
    agent_link_id: UUID
    agent_id: UUID
    agent_token: str | None = None
    code: str
    expires_at: datetime


class ChannelCommandSpec(BaseModel):
    name: str = Field(min_length=1, max_length=32)
    description: str = Field(min_length=1, max_length=100)
    options: list[dict[str, Any]] | None = None

    @field_validator("name")
    @classmethod
    def _clean_name(cls, value: str) -> str:
        name = value.strip().lstrip("/").replace("-", "_")
        if not name or not name.replace("_", "").isalnum():
            raise ValueError("command names must be alphanumeric or underscore")
        return name.lower()

    @field_validator("description")
    @classmethod
    def _clean_description(cls, value: str) -> str:
        description = value.strip()
        if not description:
            raise ValueError("description cannot be blank")
        return description


class ChannelCommandSyncRequest(BaseModel):
    commands: list[ChannelCommandSpec] | None = None
    guild_id: str | None = Field(default=None, min_length=1, max_length=64)

    @field_validator("guild_id")
    @classmethod
    def _strip_guild_id(cls, value: str | None) -> str | None:
        return value.strip() if isinstance(value, str) else value


class ChannelCommandSyncResponse(BaseModel):
    provider: str
    commands: list[dict[str, Any]]


class ChannelBindingResponse(BaseModel):
    id: UUID
    account_id: UUID
    agent_link_id: UUID | None
    external_chat_id: str
    external_chat_type: str | None
    external_chat_name: str | None
    status: str
    created_at: datetime


class ChannelSendMessageRequest(BaseModel):
    binding_id: UUID | None = None
    external_chat_id: str | None = Field(default=None, min_length=1, max_length=300)
    text: str = Field(min_length=1, max_length=4096)

    @field_validator("external_chat_id")
    @classmethod
    def _strip_chat_id(cls, value: str | None) -> str | None:
        return value.strip() if isinstance(value, str) else value


class ChannelMessageResponse(BaseModel):
    id: UUID
    direction: str
    external_chat_id: str
    provider_message_id: str | None
    delivery_id: UUID | None = None
    delivery_status: str | None = None
    text: str | None
    created_at: datetime


class ChannelActivityItemResponse(BaseModel):
    kind: Literal["message", "debug_event"]
    id: UUID
    account_id: UUID
    provider: str
    direction: str | None = None
    external_chat_id: str | None = None
    message_id: UUID | None = None
    delivery_id: UUID | None = None
    delivery_status: str | None = None
    delivery_attempts: int | None = None
    delivery_max_attempts: int | None = None
    delivery_next_attempt_at: datetime | None = None
    delivery_last_error: str | None = None
    provider_message_id: str | None = None
    text: str | None = None
    stage: str | None = None
    outcome: str | None = None
    status_code: int | None = None
    error: str | None = None
    details: dict[str, Any] | None = None
    created_at: datetime
    updated_at: datetime


class ChannelActivityListResponse(BaseModel):
    items: list[ChannelActivityItemResponse]


class ChannelHealthItemResponse(BaseModel):
    account_id: UUID
    provider: str
    name: str
    visibility: ChannelVisibility
    channel_status: str
    health_status: ChannelHealthStatus
    reasons: list[str] = Field(default_factory=list)
    pending_inbox: int = 0
    pending_deliveries: int = 0
    in_progress_deliveries: int = 0
    failed_deliveries: int = 0
    last_message_at: datetime | None = None
    last_event_at: datetime | None = None
    last_error_at: datetime | None = None
    last_error: str | None = None
    last_error_stage: str | None = None
    last_error_outcome: str | None = None
    native_transport: dict[str, Any] | None = None


class ChannelHealthListResponse(BaseModel):
    items: list[ChannelHealthItemResponse]


class TelegramWebhookResponse(BaseModel):
    ok: bool = True
    paired: bool = False
    unpaired: bool = False
    binding_id: UUID | None = None


class WhatsAppSelfIdentity(BaseModel):
    id: str = Field(min_length=1, max_length=300)
    lid: str | None = Field(default=None, min_length=1, max_length=300)
    name: str | None = Field(default=None, min_length=1, max_length=120)


class WhatsAppTenantCredentialCreate(BaseModel):
    agent_id: UUID | None = None
    agent_link_id: UUID | None = None
    phone_user: str | None = Field(default=None, min_length=1, max_length=20)
    device: int = Field(default=1, ge=0, le=255)
    name: str | None = Field(default=None, min_length=1, max_length=120)
    self_identity: WhatsAppSelfIdentity | None = None

    @field_validator("phone_user")
    @classmethod
    def _validate_phone_user(cls, value: str | None) -> str | None:
        if value is None:
            return None
        phone_user = value.strip()
        if not phone_user.isdigit():
            raise ValueError("phone_user must contain only digits")
        return phone_user

    @field_validator("name")
    @classmethod
    def _strip_optional_name(cls, value: str | None) -> str | None:
        return value.strip() if isinstance(value, str) else value


class WhatsAppTenantCredentialResponse(BaseModel):
    channel: str = "whatsapp"
    credential_id: UUID
    agent_link_id: UUID
    agent_id: UUID
    jid: str
    identity_pub_key_hex: str
    creds: dict[str, Any]
    auth_cert: dict[str, Any]
    websocket_url: str
    media_proxy_base_url: str


class WhatsAppTenantCredentialMetadata(BaseModel):
    credential_id: UUID
    agent_link_id: UUID
    agent_id: UUID
    jid: str
    identity_pub_key_hex: str
    created_at: datetime
