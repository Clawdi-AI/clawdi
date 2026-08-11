from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import re
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from time import monotonic
from typing import TypeGuard
from uuid import UUID, uuid4

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import HTTPException, status
from pydantic import JsonValue, StrictStr, TypeAdapter, ValidationError
from sqlalchemy import and_, delete, exists, func, or_, select, union_all, update
from sqlalchemy import text as sql_text
from sqlalchemy.dialects.postgresql import insert as postgresql_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.channel import (
    BINDING_STATUS_ACTIVE,
    BINDING_STATUS_ARCHIVED,
    BOT_AGENT_LINK_STATUS_ACTIVE,
    BOT_AGENT_LINK_STATUS_ARCHIVED,
    CHANNEL_PROVIDER_DISCORD,
    CHANNEL_PROVIDER_TELEGRAM,
    CHANNEL_PROVIDER_WHATSAPP,
    CHANNEL_STATUS_ACTIVE,
    CHANNEL_STATUS_DISABLED,
    CHANNEL_VISIBILITY_PRIVATE,
    CHANNEL_VISIBILITY_PUBLIC,
    DELIVERY_STATUS_FAILED,
    DELIVERY_STATUS_IN_PROGRESS,
    DELIVERY_STATUS_PENDING,
    DELIVERY_STATUS_SUCCEEDED,
    MESSAGE_DIRECTION_INBOUND,
    MESSAGE_DIRECTION_OUTBOUND,
    PAIR_CODE_STATUS_CLAIMED,
    PAIR_CODE_STATUS_PENDING,
    PAIR_CODE_STATUS_REVOKED,
    PROVIDER_EVENT_SCOPE_ACCOUNT,
    PROVIDER_EVENT_SCOPE_CHAT,
    ChannelAccount,
    ChannelAccountRuntimeMarker,
    ChannelAgentCredential,
    ChannelAgentReference,
    ChannelBinding,
    ChannelBindingAlias,
    ChannelBotAgentLink,
    ChannelDebugEvent,
    ChannelDelivery,
    ChannelMessage,
    ChannelPairCode,
    ChannelSecret,
)
from app.models.hosted_runtime import HostedRuntimeState
from app.models.runtime_observation import (
    RUNTIME_ENVIRONMENT_ACTIVE,
    V2RuntimeEnvironmentFence,
)
from app.models.session import AgentEnvironment
from app.schemas.runtime import validate_hosted_runtime_desired_state
from app.services.channel_config import (
    valid_discord_application_id,
    validate_required_discord_interactions_config,
)
from app.services.channel_debug_events import record_channel_debug_event
from app.services.discord_rate_limiter import discord_rate_limiter
from app.services.metrics import (
    inbound_messages,
    outbound_errors,
    outbound_messages,
    rate_limit_rejects,
    track_proxy_latency,
)
from app.services.url_security import UnsafeOutboundUrlError, validate_channel_http_url
from app.services.vault_crypto import decrypt, encrypt

log = logging.getLogger(__name__)
type JsonObject = dict[str, JsonValue]
_JSON_OBJECT_ADAPTER: TypeAdapter[JsonObject] = TypeAdapter(dict[str, JsonValue])


def _is_object_dict(value: object) -> TypeGuard[dict[object, object]]:
    return isinstance(value, dict)


_JSON_VALUE_ADAPTER: TypeAdapter[JsonValue] = TypeAdapter(JsonValue)
_HTTP_EXCEPTION_DETAIL_ADAPTER: TypeAdapter[str] = TypeAdapter(StrictStr)

PAIR_COMMAND = "/clawdi_pair"
UNPAIR_COMMAND = "/clawdi_unpair"
HELP_COMMAND = "/clawdi_help"
CHANNEL_CONTROL_HELP_REPLY_TEMPLATE = (
    "To connect this chat to an agent:\n"
    "1. Open {web_origin}.\n"
    "2. Choose your agent, open Channels, and select Pair.\n"
    "3. Send /clawdi_pair <code> here.\n\n"
    "To disconnect this chat, send /clawdi_unpair."
)
DISCORD_PAIR_COMMAND_NAME = "clawdi_pair"
DISCORD_UNPAIR_COMMAND_NAME = "clawdi_unpair"
DISCORD_HELP_COMMAND_NAME = "clawdi_help"
DISCORD_RESERVED_COMMAND_NAMES = frozenset(
    {
        DISCORD_PAIR_COMMAND_NAME,
        DISCORD_UNPAIR_COMMAND_NAME,
        DISCORD_HELP_COMMAND_NAME,
    }
)
DISCORD_LEGACY_RESERVED_COMMAND_NAMES = frozenset({"bot_pair", "bot_unpair"})
_DISCORD_UNPAIRED_TUTORIAL_KIND = "discord_unpaired_tutorial"
_DISCORD_UNPAIRED_TUTORIAL_SUCCESS_COOLDOWN = timedelta(minutes=10)
_DISCORD_UNPAIRED_TUTORIAL_FAILURE_BACKOFF = timedelta(seconds=30)
PAIR_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
PAIR_CODE_LENGTH = 10
PAIR_CODE_GENERATION_ATTEMPTS = 5
PAIR_CODE_PATTERN = re.compile(
    rf"^(?:[{PAIR_CODE_ALPHABET}]{{{PAIR_CODE_LENGTH}}}|PAIR[A-Z0-9]{{8,}})$"
)
TELEGRAM_BOT_USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_]{5,32}bot$", re.IGNORECASE)
DEFAULT_CHANNEL_COMMANDS: tuple[JsonObject, ...] = (
    {
        "name": "clawdi_pair",
        "description": "Pair this chat with Clawdi.",
        "options": [
            {
                "name": "code",
                "description": "Pair code from Clawdi.",
                "type": 3,
                "required": True,
            }
        ],
    },
    {
        "name": "clawdi_unpair",
        "description": "Disconnect this chat from Clawdi.",
        "options": [],
    },
    {
        "name": "clawdi_help",
        "description": "Show safe Clawdi pairing instructions.",
        "options": [],
    },
)
DISCORD_ADMINISTRATOR_PERMISSION = 1 << 3
DISCORD_MANAGE_GUILD_PERMISSION = 1 << 5
DISCORD_GUILD_INSTALL = 0
DISCORD_USER_INSTALL = 1
DISCORD_GUILD_INTERACTION_CONTEXT = 0
DISCORD_BOT_DM_INTERACTION_CONTEXT = 1
DISCORD_RESERVED_COMMAND_VERSION = 4
DISCORD_RESERVED_COMMAND_VERSION_CONFIG_KEY = "discord_reserved_command_version"
TELEGRAM_RESERVED_COMMAND_VERSION = 1
TELEGRAM_RESERVED_COMMAND_VERSION_CONFIG_KEY = "telegram_reserved_command_version"
DISCORD_INSTALL_CONFIG_VERSION = 2
DISCORD_INSTALL_CONFIG_VERSION_CONFIG_KEY = "discord_install_config_version"
DISCORD_USER_INSTALL_SUPPORTED_CONFIG_KEY = "discord_user_install_supported"
DISCORD_GATEWAY_MESSAGE_CONTENT_FLAG = 1 << 18
DISCORD_GATEWAY_MESSAGE_CONTENT_LIMITED_FLAG = 1 << 19
# Discord API docs baseline 07c83a8f1c54accd8e8d13072a5e08d1b1be7ac3.
# ADD_REACTIONS, VIEW_CHANNEL, SEND_MESSAGES, EMBED_LINKS, ATTACH_FILES,
# READ_MESSAGE_HISTORY, CREATE_PUBLIC_THREADS, and SEND_MESSAGES_IN_THREADS.
# CREATE_PUBLIC_THREADS is required by Hermes' /thread and auto-thread paths
# (including its create-from-message fallback) and by the transparent Discord
# transport's pinned thread-create contract. Private-thread creation and thread
# moderation are not part of the managed surface. Never request
# ADMINISTRATOR or MANAGE_GUILD for the bot; pair mutation authority is the
# invoking member's computed permissions. The managed OpenClaw projection
# disables advanced actions that need excluded role permissions; Gateway
# intents are a separate capability and never widen the bot role. The default
# install deliberately excludes CONNECT, SPEAK, MANAGE_MESSAGES, MANAGE_EVENTS,
# and MANAGE_GUILD_EXPRESSIONS.
DISCORD_MINIMAL_BOT_PERMISSIONS = 309_237_763_136
DISCORD_GUILD_PERMISSION_DENIED = "discord_guild_permission_denied"
DISCORD_GUILD_USE_INTERACTION = "discord_guild_use_interaction"
DISCORD_GUILD_INSTALL_REQUIRED = "discord_guild_install_required"
DISCORD_USER_INSTALL_REQUIRED = "discord_user_install_required"
DISCORD_BOT_GUILD_MEMBERSHIP_REQUIRED = "discord_bot_guild_membership_required"
DISCORD_BOT_GUILD_MEMBERSHIP_UNAVAILABLE = "discord_bot_guild_membership_unavailable"
DISCORD_DM_CHAT_TYPES = frozenset({"dm", "direct_messages", "group_dm", "private"})
DELIVERY_LINK_LOCK_CONTENTION_ERROR = "channel agent link is being updated"
DELIVERY_LINK_LOCK_CONTENTION_MAX_DELAY_SECONDS = 30
DELIVERY_ERROR_ACCOUNT_INACTIVE = "channel_account_inactive"
DELIVERY_ERROR_BINDING_INACTIVE = "channel_binding_inactive"
DELIVERY_ERROR_FAILED = "channel_delivery_failed"
DELIVERY_ERROR_LINK_ARCHIVED = "channel_agent_link_archived"
DELIVERY_ERROR_LINK_AUTHORITY = "channel_agent_link_authority_missing"
DELIVERY_ERROR_LINK_CONTENTION = "channel_agent_link_update_contended"
DELIVERY_ERROR_MESSAGE_MISSING = "channel_message_missing"
DELIVERY_ERROR_PROVIDER_CREDENTIAL = "channel_provider_credential_unavailable"
DELIVERY_ERROR_PROVIDER_RATE_LIMITED = "channel_provider_rate_limited"
DELIVERY_ERROR_PROVIDER_REJECTED = "channel_provider_rejected"
DELIVERY_ERROR_PROVIDER_UNREACHABLE = "channel_provider_unreachable"
HERMES_AGENT_TYPE = "hermes"
OPENCLAW_AGENT_TYPE = "openclaw"
HOSTED_RUNTIME_AGENT_TYPES = frozenset({HERMES_AGENT_TYPE, OPENCLAW_AGENT_TYPE})
RUNTIME_CHANNEL_PROVIDERS = frozenset(
    {
        CHANNEL_PROVIDER_TELEGRAM,
        CHANNEL_PROVIDER_DISCORD,
        CHANNEL_PROVIDER_WHATSAPP,
    }
)
HOSTED_RUNTIME_SINGLE_ACCOUNT_PROVIDERS = frozenset(
    {
        CHANNEL_PROVIDER_TELEGRAM,
        CHANNEL_PROVIDER_DISCORD,
        CHANNEL_PROVIDER_WHATSAPP,
    }
)
STRICT_V2_AGENT_LINK_DETAIL = "Only Cloud Agents can be linked or paired with channels."
TELEGRAM_UPDATE_RETENTION = timedelta(hours=24)


def hosted_agent_provider_link_limit_detail(provider: str, *, duplicate: bool = False) -> str:
    label = {
        CHANNEL_PROVIDER_TELEGRAM: "Telegram",
        CHANNEL_PROVIDER_DISCORD: "Discord",
        CHANNEL_PROVIDER_WHATSAPP: "WhatsApp",
    }.get(provider, provider.title())
    if duplicate:
        return (
            f"This Agent has multiple active {label} bots. "
            "Unlink the extras until only one remains."
        )
    return f"This Agent already has a {label} bot. Unlink it before connecting another."


TELEGRAM_REF_CALLBACK_QUERY_ID = "telegram_callback_query_id"
TELEGRAM_REF_FILE_ID = "telegram_file_id"
TELEGRAM_REF_FILE_PATH = "telegram_file_path"
TELEGRAM_REF_MESSAGE_ID = "telegram_message_id"
DISCORD_REF_INTERACTION_ID_TOKEN = "discord_interaction_id_token"
DISCORD_REF_INTERACTION_TOKEN = "discord_interaction_token"
CHANNEL_RETENTION_PROVIDERS = (
    CHANNEL_PROVIDER_TELEGRAM,
    CHANNEL_PROVIDER_DISCORD,
    CHANNEL_PROVIDER_WHATSAPP,
)
DISCORD_EPHEMERAL_REFERENCE_KINDS = (
    DISCORD_REF_INTERACTION_ID_TOKEN,
    DISCORD_REF_INTERACTION_TOKEN,
)
# Discord interaction tokens are valid for 15 minutes. Keep a five-minute
# grace period for clock skew and in-flight follow-ups, then remove the exact
# credential fields independently of the message retention horizon.
DISCORD_INTERACTION_SECRET_RETENTION = timedelta(minutes=20)
CHANNEL_RETENTION_CANDIDATE_MULTIPLIER = 2


@dataclass(frozen=True)
class ChannelQueueSnapshot:
    provider: str
    queue: str
    pending_count: int
    stuck_count: int
    oldest_pending_at: datetime | None


@dataclass(frozen=True)
class ChannelRetentionBatch:
    telegram_delivery_expirations: int = 0
    messages: int = 0
    debug_events: int = 0
    pair_codes: int = 0
    agent_references: int = 0
    discord_interaction_payloads: int = 0

    @property
    def total(self) -> int:
        return (
            self.telegram_delivery_expirations
            + self.messages
            + self.debug_events
            + self.pair_codes
            + self.agent_references
            + self.discord_interaction_payloads
        )

    def saturated_kinds(self, limit: int) -> tuple[str, ...]:
        return tuple(
            kind
            for kind, count in (
                ("telegram_delivery_expirations", self.telegram_delivery_expirations),
                ("messages", self.messages),
                ("debug_events", self.debug_events),
                ("pair_codes", self.pair_codes),
                ("agent_references", self.agent_references),
                ("discord_interaction_payloads", self.discord_interaction_payloads),
            )
            if count == limit
        )


@dataclass(frozen=True)
class DiscordRoutingKey:
    chat_id: str
    scope_id: str | None
    channel_id: str | None
    chat_type: str


@dataclass(frozen=True)
class DiscordGuildMembershipCheck:
    denied_reason: str | None = None
    guild_name: str | None = None


@dataclass(frozen=True)
class DiscordPairingCommandAdmission:
    denied_reason: str | None = None
    external_chat_name: str | None = None


@dataclass(frozen=True)
class ChannelControlCommand:
    kind: str
    code: str | None = None
    command: str | None = None


@dataclass(frozen=True)
class InboundBindingResult:
    binding: ChannelBinding | None
    bindings: tuple[ChannelBinding, ...] = ()
    paired: bool = False
    unpaired: bool = False
    command_handled: bool = False
    pair_failed_reason: str | None = None


@dataclass(frozen=True)
class PairCodeClaimResult:
    binding: ChannelBinding | None = None
    reason: str | None = None


@dataclass(frozen=True)
class PairCodeCreateResult:
    pair_code: ChannelPairCode
    code: str
    link: ChannelBotAgentLink
    agent_token: str | None = None


@dataclass(frozen=True)
class ChannelAgentContext:
    account: ChannelAccount
    link: ChannelBotAgentLink


PAIRING_REPLY_PAIRED = "Paired! This chat is now connected to your agent."
PAIRING_REPLY_UNPAIRED = "Unpaired. This chat is no longer connected to an agent."
PAIRING_REPLY_NOT_PAIRED = "This chat is not paired."
PAIRING_REPLY_FORBIDDEN = "Only the user who paired this chat can change its pairing."


class BindingActorMismatchError(Exception):
    pass


class BindingAgentLinkMismatchError(Exception):
    pass


def hash_token(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def channel_runtime_account_key(account_id: UUID) -> str:
    return f"clawdi_{account_id.hex}"


def channel_runtime_placeholder_token(
    provider: str,
    account_key: str,
    *,
    link_id: UUID | None = None,
) -> str:
    if provider == CHANNEL_PROVIDER_WHATSAPP and link_id is None:
        raise ValueError("WhatsApp runtime capability requires a Link id")
    identity = (
        f"{provider}:{account_key}:{link_id}"
        if provider == CHANNEL_PROVIDER_WHATSAPP
        else f"{provider}:{account_key}"
    )
    suffix = hashlib.sha256(identity.encode()).hexdigest()[:32]
    if provider == CHANNEL_PROVIDER_TELEGRAM:
        return f"999999999:{suffix}"
    return f"clawdi_{suffix}"


def verify_hashed_token(raw: str, expected_hash: str) -> bool:
    return hmac.compare_digest(hash_token(raw), expected_hash)


def generate_webhook_secret() -> str:
    return secrets.token_urlsafe(32)


def generate_pair_code() -> str:
    return "".join(secrets.choice(PAIR_CODE_ALPHABET) for _ in range(PAIR_CODE_LENGTH))


def generate_agent_token(provider: str) -> str:
    secret = secrets.token_urlsafe(32).replace("-", "").replace("_", "")
    if provider == CHANNEL_PROVIDER_TELEGRAM:
        # Keep Telegram agent tokens Bot API-shaped for SDKs that validate or
        # interpolate tokens into `/bot{token}/...` paths.
        bot_id = secrets.randbelow(900_000_000) + 100_000_000
        return f"{bot_id}:{secret}"
    if provider == CHANNEL_PROVIDER_DISCORD:
        return secrets.token_urlsafe(48)
    if provider == CHANNEL_PROVIDER_WHATSAPP:
        return f"wa_{secrets.token_urlsafe(36)}"
    return secrets.token_urlsafe(48)


def encrypt_optional_token(token: str | None) -> tuple[bytes | None, bytes | None]:
    if not token:
        return None, None
    return encrypt(token)


def decrypt_provider_token(account: ChannelAccount) -> str:
    if not account.encrypted_provider_token or not account.provider_token_nonce:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="channel account has no provider token configured",
        )
    return decrypt(account.encrypted_provider_token, account.provider_token_nonce)


def store_agent_link_token(link: ChannelBotAgentLink, raw_token: str) -> None:
    ciphertext, nonce = encrypt(raw_token)
    link.agent_token_hash = hash_token(raw_token)
    link.encrypted_agent_token = ciphertext
    link.agent_token_nonce = nonce


def scrub_agent_link_token(link: ChannelBotAgentLink) -> None:
    link.agent_token_hash = None
    link.encrypted_agent_token = None
    link.agent_token_nonce = None


def decrypt_agent_link_token(link: ChannelBotAgentLink) -> str | None:
    if not link.encrypted_agent_token or not link.agent_token_nonce:
        return None
    return decrypt(link.encrypted_agent_token, link.agent_token_nonce)


def channel_webhook_url(account_id: UUID, provider: str) -> str:
    return f"{settings.public_api_url.rstrip('/')}/v1/channels/{provider}/{account_id}/webhook"


async def configure_telegram_provider_webhook(
    *,
    provider_token: str,
    webhook_url: str,
    webhook_secret: str,
) -> str | None:
    # Telegram requires an HTTPS webhook. Local development keeps the default
    # localhost URL and can still exercise inbound routes directly.
    if not webhook_url.lower().startswith("https://"):
        return None
    username = await get_telegram_bot_username(provider_token)
    base_url = settings.channel_telegram_api_base_url.strip().rstrip("/")
    payload = await _post_provider_json(
        channel=CHANNEL_PROVIDER_TELEGRAM,
        method="setWebhook",
        url=f"{base_url}/bot{provider_token}/setWebhook",
        json_payload={
            "url": webhook_url,
            "secret_token": webhook_secret,
        },
        timeout_seconds=20.0,
        unreachable_detail="telegram api unreachable",
        rejected_detail="telegram bot token or webhook was rejected",
    )
    if payload.get("ok") is not True:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="telegram bot token or webhook was rejected",
        )
    return username


async def get_telegram_bot_username(provider_token: str) -> str:
    base_url = settings.channel_telegram_api_base_url.strip().rstrip("/")
    identity = await _post_provider_json(
        channel=CHANNEL_PROVIDER_TELEGRAM,
        method="getMe",
        url=f"{base_url}/bot{provider_token}/getMe",
        json_payload={},
        timeout_seconds=20.0,
        unreachable_detail="telegram api unreachable",
        rejected_detail="telegram bot token was rejected",
    )
    if identity.get("ok") is not True:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="telegram bot token was rejected",
        )
    identity_result = identity.get("result")
    username = identity_result.get("username") if isinstance(identity_result, dict) else None
    normalized = normalize_telegram_bot_username(username)
    if normalized is None:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="telegram bot identity has no valid bot username",
        )
    return normalized


def normalize_telegram_bot_username(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    username = value.strip().lstrip("@")
    return username if TELEGRAM_BOT_USERNAME_PATTERN.fullmatch(username) else None


def build_channel_account(
    *,
    owner_user_id: UUID | None,
    provider: str,
    name: str,
    visibility: str,
    webhook_secret_hash: str,
    account_id: UUID | None = None,
    status_value: str = CHANNEL_STATUS_ACTIVE,
    encrypted_provider_token: bytes | None = None,
    provider_token_nonce: bytes | None = None,
    config: JsonObject | None = None,
) -> ChannelAccount:
    """Build an account while enforcing the inventory ownership boundary."""

    if visibility == CHANNEL_VISIBILITY_PRIVATE:
        if owner_user_id is None:
            raise ValueError("private channel accounts require a tenant owner")
    elif visibility == CHANNEL_VISIBILITY_PUBLIC:
        if owner_user_id is not None:
            raise ValueError("public channel accounts are platform-owned")
    else:
        raise ValueError("unsupported channel visibility")
    values: dict[str, object] = {
        "user_id": owner_user_id,
        "provider": provider,
        "name": name,
        "status": status_value,
        "visibility": visibility,
        "encrypted_provider_token": encrypted_provider_token,
        "provider_token_nonce": provider_token_nonce,
        "webhook_secret_hash": webhook_secret_hash,
        "config": config,
    }
    if account_id is not None:
        values["id"] = account_id
    return ChannelAccount(**values)


def require_channel_tenant_user_id(
    account: ChannelAccount,
    *,
    tenant_user_id: UUID | None = None,
) -> UUID:
    """Resolve tenant-scoped child ownership without borrowing platform inventory ownership."""

    if account.visibility == CHANNEL_VISIBILITY_PRIVATE:
        if account.user_id is None or (
            tenant_user_id is not None and tenant_user_id != account.user_id
        ):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="channel tenant authority does not match",
            )
        return account.user_id
    if account.visibility == CHANNEL_VISIBILITY_PUBLIC:
        if account.user_id is not None or tenant_user_id is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="channel tenant authority is required",
            )
        return tenant_user_id
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail="channel ownership state is invalid",
    )


async def store_channel_secrets(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    secrets_by_name: dict[str, str] | None,
) -> None:
    if not secrets_by_name:
        return
    for name, value in secrets_by_name.items():
        ciphertext, nonce = encrypt(value)
        db.add(
            ChannelSecret(
                account_id=account.id,
                user_id=account.user_id,
                name=name,
                encrypted_value=ciphertext,
                value_nonce=nonce,
            )
        )


async def upsert_channel_secrets(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    secrets_by_name: dict[str, str] | None,
) -> None:
    if not secrets_by_name:
        return
    for name, value in secrets_by_name.items():
        ciphertext, nonce = encrypt(value)
        existing = (
            await db.execute(
                select(ChannelSecret).where(
                    ChannelSecret.account_id == account.id,
                    ChannelSecret.name == name,
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            existing.user_id = account.user_id
            existing.encrypted_value = ciphertext
            existing.value_nonce = nonce
            continue
        db.add(
            ChannelSecret(
                account_id=account.id,
                user_id=account.user_id,
                name=name,
                encrypted_value=ciphertext,
                value_nonce=nonce,
            )
        )


async def get_channel_secret(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    name: str,
) -> str | None:
    result = await db.execute(
        select(ChannelSecret).where(
            ChannelSecret.account_id == account.id,
            ChannelSecret.name == name,
        )
    )
    secret = result.scalar_one_or_none()
    if secret is None:
        return None
    return decrypt(secret.encrypted_value, secret.value_nonce)


async def get_or_create_bot_agent_link(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    agent_id: UUID,
    user_id: UUID | None = None,
    agent_token: str | None = None,
    replace_existing_provider_link: bool = False,
) -> tuple[ChannelBotAgentLink, str | None]:
    link_user_id = require_channel_tenant_user_id(account, tenant_user_id=user_id)
    # Serialize against both Link creation and runtime retirement. The fence is
    # the retirement authority; locking only AgentEnvironment leaves a window
    # where retirement can commit before this transaction creates a Link.
    row = (
        await db.execute(
            select(AgentEnvironment, HostedRuntimeState, V2RuntimeEnvironmentFence)
            .join(
                HostedRuntimeState,
                HostedRuntimeState.environment_id == AgentEnvironment.id,
            )
            .join(
                V2RuntimeEnvironmentFence,
                V2RuntimeEnvironmentFence.environment_id == AgentEnvironment.id,
            )
            .where(
                AgentEnvironment.id == agent_id,
                AgentEnvironment.user_id == link_user_id,
                AgentEnvironment.archived_at.is_(None),
            )
            .execution_options(populate_existing=True)
            .with_for_update(of=(AgentEnvironment, V2RuntimeEnvironmentFence))
        )
    ).one_or_none()
    if row is None or not is_strict_v2_hosted_channel_agent(*row):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=STRICT_V2_AGENT_LINK_DETAIL,
        )

    # A competing request may have created the same Link while this request
    # waited for the authority locks. Return that active Link idempotently.
    link = (
        await db.execute(
            select(ChannelBotAgentLink)
            .where(
                ChannelBotAgentLink.account_id == account.id,
                ChannelBotAgentLink.agent_id == agent_id,
                ChannelBotAgentLink.user_id == link_user_id,
                ChannelBotAgentLink.archived_at.is_(None),
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if link is not None:
        if link.status != BOT_AGENT_LINK_STATUS_ACTIVE:
            # Older rows can carry an archived status without archived_at even
            # though the partial unique index keys only on archived_at. Finish
            # that interrupted archive before inserting its replacement.
            await archive_bot_agent_link(db, link=link, account=account)
        else:
            if not await bot_agent_link_has_strict_v2_authority(db, link=link):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=STRICT_V2_AGENT_LINK_DETAIL,
                )
            # Ensuring the exact same Bot -> Agent Link is idempotent, even for
            # historical duplicate state that must remain visible for cleanup.
            return link, None

    await ensure_hosted_agent_provider_link_available(
        db,
        account=account,
        agent_id=agent_id,
        user_id=link_user_id,
        replace_existing_provider_link=replace_existing_provider_link,
    )
    await ensure_bot_agent_link_capacity(db, account=account)
    if replace_existing_provider_link:
        await archive_existing_hosted_agent_provider_links(
            db,
            account=account,
            agent_id=agent_id,
            user_id=link_user_id,
        )
    raw_token = agent_token or generate_agent_token(account.provider)
    link = ChannelBotAgentLink(
        account_id=account.id,
        user_id=link_user_id,
        agent_id=agent_id,
    )
    store_agent_link_token(link, raw_token)
    db.add(link)
    await db.flush()
    return link, raw_token


def is_strict_v2_hosted_channel_agent(
    agent: AgentEnvironment,
    state: HostedRuntimeState | None,
    fence: V2RuntimeEnvironmentFence | None,
) -> bool:
    if (
        state is None
        or fence is None
        or fence.owner_id != agent.user_id
        or fence.deployment_id != state.deployment_id
        or fence.state != RUNTIME_ENVIRONMENT_ACTIVE
        or agent.agent_type not in HOSTED_RUNTIME_AGENT_TYPES
    ):
        return False
    runtimes: object = state.runtimes
    if not _is_object_dict(runtimes) or list(runtimes) != [agent.agent_type]:
        return False
    try:
        validate_hosted_runtime_desired_state(runtimes[agent.agent_type])
    except ValueError:
        return False
    return True


async def get_strict_v2_hosted_channel_agent_or_409(
    db: AsyncSession,
    *,
    agent_id: UUID,
    user_id: UUID,
    lock_runtime_fence: bool = False,
) -> AgentEnvironment:
    query = (
        select(AgentEnvironment, HostedRuntimeState, V2RuntimeEnvironmentFence)
        .join(
            HostedRuntimeState,
            HostedRuntimeState.environment_id == AgentEnvironment.id,
        )
        .join(
            V2RuntimeEnvironmentFence,
            V2RuntimeEnvironmentFence.environment_id == AgentEnvironment.id,
        )
        .where(
            AgentEnvironment.id == agent_id,
            AgentEnvironment.user_id == user_id,
            AgentEnvironment.archived_at.is_(None),
        )
        .execution_options(populate_existing=True)
    )
    if lock_runtime_fence:
        # Match get_or_create_bot_agent_link's lock set so provider preflight,
        # Link admission, and retirement cannot acquire Agent/fence rows in
        # conflicting orders.
        query = query.with_for_update(of=(AgentEnvironment, V2RuntimeEnvironmentFence))
    row = (await db.execute(query)).one_or_none()
    if row is None or not is_strict_v2_hosted_channel_agent(*row):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=STRICT_V2_AGENT_LINK_DETAIL,
        )
    agent, _state, _fence = row
    return agent


async def bot_agent_link_allows_new_pairing(
    db: AsyncSession,
    *,
    account_id: UUID,
    link_id: UUID,
    user_id: UUID,
) -> bool:
    row = (
        await db.execute(
            select(
                ChannelAccount,
                ChannelBotAgentLink,
                AgentEnvironment,
                HostedRuntimeState,
                V2RuntimeEnvironmentFence,
            )
            .join(ChannelAccount, ChannelAccount.id == ChannelBotAgentLink.account_id)
            .join(AgentEnvironment, AgentEnvironment.id == ChannelBotAgentLink.agent_id)
            .join(
                HostedRuntimeState,
                HostedRuntimeState.environment_id == AgentEnvironment.id,
            )
            .join(
                V2RuntimeEnvironmentFence,
                V2RuntimeEnvironmentFence.environment_id == AgentEnvironment.id,
            )
            .where(
                ChannelBotAgentLink.id == link_id,
                ChannelBotAgentLink.account_id == account_id,
                ChannelBotAgentLink.user_id == user_id,
                ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
                ChannelBotAgentLink.archived_at.is_(None),
                ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
                ChannelAccount.archived_at.is_(None),
                AgentEnvironment.user_id == user_id,
                AgentEnvironment.archived_at.is_(None),
            )
            .execution_options(populate_existing=True)
            .with_for_update(of=(ChannelBotAgentLink, V2RuntimeEnvironmentFence))
        )
    ).one_or_none()
    if row is None:
        return False
    account, link, agent, state, fence = row
    if not is_strict_v2_hosted_channel_agent(agent, state, fence):
        return False
    if not await bot_agent_link_has_strict_v2_authority(db, link=link):
        return False
    return await bot_agent_link_has_provider_cardinality_capability(
        db,
        account=account,
        link=link,
    )


async def bot_agent_link_has_strict_v2_authority(
    db: AsyncSession,
    *,
    link: ChannelBotAgentLink | None,
) -> bool:
    if link is None or link.status != BOT_AGENT_LINK_STATUS_ACTIVE or link.archived_at is not None:
        return False
    row = (
        await db.execute(
            select(
                AgentEnvironment,
                HostedRuntimeState,
                V2RuntimeEnvironmentFence,
            )
            .select_from(ChannelBotAgentLink)
            .join(ChannelAccount, ChannelAccount.id == ChannelBotAgentLink.account_id)
            .join(AgentEnvironment, AgentEnvironment.id == ChannelBotAgentLink.agent_id)
            .join(
                HostedRuntimeState,
                HostedRuntimeState.environment_id == AgentEnvironment.id,
            )
            .join(
                V2RuntimeEnvironmentFence,
                V2RuntimeEnvironmentFence.environment_id == AgentEnvironment.id,
            )
            .where(
                ChannelBotAgentLink.id == link.id,
                ChannelBotAgentLink.user_id == link.user_id,
                ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
                ChannelAccount.archived_at.is_(None),
            )
            .execution_options(populate_existing=True)
        )
    ).one_or_none()
    if row is None:
        return False
    agent, state, fence = row
    return is_strict_v2_hosted_channel_agent(agent, state, fence)


async def bot_agent_link_has_provider_cardinality_capability(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    link: ChannelBotAgentLink,
) -> bool:
    """Return whether this Link is the Agent's sole active account for its provider."""
    if account.provider not in HOSTED_RUNTIME_SINGLE_ACCOUNT_PROVIDERS:
        return True
    active_link_ids = await _active_bot_agent_link_ids_for_provider(
        db,
        agent_id=link.agent_id,
        user_id=link.user_id,
        provider=account.provider,
    )
    return active_link_ids == [link.id]


async def _active_bot_agent_link_ids_for_provider(
    db: AsyncSession,
    *,
    agent_id: UUID,
    user_id: UUID,
    provider: str,
) -> list[UUID]:
    result = await db.execute(
        select(ChannelBotAgentLink.id)
        .join(ChannelAccount, ChannelAccount.id == ChannelBotAgentLink.account_id)
        .where(
            ChannelBotAgentLink.agent_id == agent_id,
            ChannelBotAgentLink.user_id == user_id,
            ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
            ChannelBotAgentLink.archived_at.is_(None),
            ChannelAccount.provider == provider,
            ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
            ChannelAccount.archived_at.is_(None),
        )
        .order_by(ChannelBotAgentLink.id)
    )
    return list(result.scalars())


async def ensure_bot_agent_link_provider_cardinality_or_409(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    link: ChannelBotAgentLink,
) -> None:
    if await bot_agent_link_has_provider_cardinality_capability(
        db,
        account=account,
        link=link,
    ):
        return
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=hosted_agent_provider_link_limit_detail(account.provider, duplicate=True),
    )


async def list_strict_v2_hosted_channel_agent_ids(
    db: AsyncSession,
    *,
    user_id: UUID,
    provider: str,
) -> list[UUID]:
    rows = (
        await db.execute(
            select(AgentEnvironment, HostedRuntimeState, V2RuntimeEnvironmentFence)
            .join(
                HostedRuntimeState,
                HostedRuntimeState.environment_id == AgentEnvironment.id,
            )
            .join(
                V2RuntimeEnvironmentFence,
                V2RuntimeEnvironmentFence.environment_id == AgentEnvironment.id,
            )
            .where(
                AgentEnvironment.user_id == user_id,
                AgentEnvironment.archived_at.is_(None),
            )
            .order_by(AgentEnvironment.created_at, AgentEnvironment.id)
        )
    ).all()
    eligible: list[UUID] = []
    for agent, state, fence in rows:
        if not is_strict_v2_hosted_channel_agent(agent, state, fence):
            continue
        if provider in HOSTED_RUNTIME_SINGLE_ACCOUNT_PROVIDERS:
            existing_link_ids = await _active_bot_agent_link_ids_for_provider(
                db,
                agent_id=agent.id,
                user_id=user_id,
                provider=provider,
            )
            if existing_link_ids:
                continue
        eligible.append(agent.id)
    return eligible


async def ensure_hosted_agent_provider_link_available(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    agent_id: UUID,
    user_id: UUID,
    replace_existing_provider_link: bool = False,
) -> None:
    agent = (
        await db.execute(
            select(AgentEnvironment)
            .where(
                AgentEnvironment.id == agent_id,
                AgentEnvironment.user_id == user_id,
                AgentEnvironment.archived_at.is_(None),
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if agent is None:
        return

    if (
        agent.agent_type not in HOSTED_RUNTIME_AGENT_TYPES
        or account.provider not in HOSTED_RUNTIME_SINGLE_ACCOUNT_PROVIDERS
    ):
        return
    existing_link_ids = await _active_bot_agent_link_ids_for_provider(
        db,
        agent_id=agent_id,
        user_id=user_id,
        provider=account.provider,
    )
    if not existing_link_ids:
        return
    if replace_existing_provider_link:
        return
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=hosted_agent_provider_link_limit_detail(account.provider),
    )


async def archive_existing_hosted_agent_provider_links(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    agent_id: UUID,
    user_id: UUID,
) -> None:
    """Archive other active single-provider Links before creating a replacement.

    The caller holds the Agent and runtime-fence locks acquired by
    ``get_or_create_bot_agent_link``. Link row locks and binding identity locks
    serialize this archive with unlink, pairing, and delivery mutations. All
    changes remain in the caller's transaction, so a later failure restores
    the previous Link and its scoped runtime state.
    """
    if account.provider not in HOSTED_RUNTIME_SINGLE_ACCOUNT_PROVIDERS:
        return
    rows = (
        await db.execute(
            select(ChannelBotAgentLink, ChannelAccount)
            .join(ChannelAccount, ChannelAccount.id == ChannelBotAgentLink.account_id)
            .where(
                ChannelBotAgentLink.agent_id == agent_id,
                ChannelBotAgentLink.user_id == user_id,
                ChannelBotAgentLink.account_id != account.id,
                ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
                ChannelBotAgentLink.archived_at.is_(None),
                ChannelAccount.provider == account.provider,
                ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
                ChannelAccount.archived_at.is_(None),
            )
            .order_by(ChannelBotAgentLink.id)
            .with_for_update(of=ChannelBotAgentLink)
        )
    ).all()
    for existing_link, existing_account in rows:
        bindings = list(
            (
                await db.execute(
                    select(ChannelBinding).where(
                        ChannelBinding.bot_agent_link_id == existing_link.id,
                        ChannelBinding.status == BINDING_STATUS_ACTIVE,
                    )
                )
            ).scalars()
        )
        for binding in sorted(bindings, key=lambda item: item.external_chat_id):
            await lock_channel_binding_identity(
                db,
                account_id=existing_account.id,
                external_chat_id=binding.external_chat_id,
            )
        await archive_bot_agent_link(db, link=existing_link, account=existing_account)


def channel_bot_link_limit(account: ChannelAccount) -> int | None:
    config = account.config if isinstance(account.config, dict) else {}
    value = config.get("max_links", config.get("maxLinks"))
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int) and value >= 0:
        return value
    if isinstance(value, str) and value.isdecimal():
        return int(value)
    return None


async def count_active_bot_agent_links(
    db: AsyncSession,
    *,
    account: ChannelAccount,
) -> int:
    result = await db.execute(
        select(func.count())
        .select_from(ChannelBotAgentLink)
        .where(
            ChannelBotAgentLink.account_id == account.id,
            ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
            ChannelBotAgentLink.archived_at.is_(None),
        )
    )
    return int(result.scalar_one())


async def ensure_bot_agent_link_capacity(
    db: AsyncSession,
    *,
    account: ChannelAccount,
) -> None:
    max_links = channel_bot_link_limit(account)
    if max_links is None:
        return
    await db.execute(
        select(ChannelAccount.id).where(ChannelAccount.id == account.id).with_for_update()
    )
    link_count = await count_active_bot_agent_links(db, account=account)
    if link_count >= max_links:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="channel bot link capacity reached",
        )


async def create_pair_code(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    link: ChannelBotAgentLink,
    ttl_seconds: int,
    agent_token: str | None = None,
) -> PairCodeCreateResult:
    expires_at = datetime.now(UTC) + timedelta(seconds=ttl_seconds)
    for _ in range(PAIR_CODE_GENERATION_ATTEMPTS):
        raw_code = generate_pair_code()
        statement = (
            postgresql_insert(ChannelPairCode)
            .values(
                id=uuid4(),
                account_id=account.id,
                bot_agent_link_id=link.id,
                user_id=link.user_id,
                code_hash=hash_token(raw_code),
                expires_at=expires_at,
            )
            .on_conflict_do_nothing(constraint="uq_channel_pair_codes_code_hash")
            .returning(ChannelPairCode)
        )
        pair_code = (await db.execute(statement)).scalar_one_or_none()
        if pair_code is not None:
            return PairCodeCreateResult(
                pair_code=pair_code,
                code=raw_code,
                link=link,
                agent_token=agent_token,
            )
    raise HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail="could not allocate a unique pair code",
    )


async def get_owned_bot_agent_link(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    link_id: UUID,
    user_id: UUID,
) -> ChannelBotAgentLink:
    result = await db.execute(
        select(ChannelBotAgentLink).where(
            ChannelBotAgentLink.id == link_id,
            ChannelBotAgentLink.account_id == account.id,
            ChannelBotAgentLink.user_id == user_id,
            ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
            ChannelBotAgentLink.archived_at.is_(None),
        )
    )
    link = result.scalar_one_or_none()
    if link is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="agent link not found")
    return link


async def list_owned_active_bot_agent_links(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    user_id: UUID,
) -> list[ChannelBotAgentLink]:
    result = await db.execute(
        select(ChannelBotAgentLink)
        .where(
            ChannelBotAgentLink.account_id == account.id,
            ChannelBotAgentLink.user_id == user_id,
            ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
            ChannelBotAgentLink.archived_at.is_(None),
        )
        .order_by(ChannelBotAgentLink.created_at)
    )
    return list(result.scalars().all())


async def list_owned_active_bot_agent_links_for_agent(
    db: AsyncSession,
    *,
    user_id: UUID,
    agent_id: UUID,
) -> list[tuple[ChannelBotAgentLink, ChannelAccount, int]]:
    active_binding_counts = (
        select(
            ChannelBinding.account_id.label("account_id"),
            ChannelBinding.bot_agent_link_id.label("bot_agent_link_id"),
            ChannelBinding.user_id.label("user_id"),
            func.count(ChannelBinding.id).label("binding_count"),
        )
        .where(
            ChannelBinding.status == BINDING_STATUS_ACTIVE,
            ChannelBinding.user_id == user_id,
        )
        .group_by(
            ChannelBinding.account_id,
            ChannelBinding.bot_agent_link_id,
            ChannelBinding.user_id,
        )
        .subquery()
    )
    result = await db.execute(
        select(
            ChannelBotAgentLink,
            ChannelAccount,
            func.coalesce(active_binding_counts.c.binding_count, 0),
        )
        .join(ChannelAccount, ChannelAccount.id == ChannelBotAgentLink.account_id)
        .outerjoin(
            active_binding_counts,
            and_(
                active_binding_counts.c.account_id == ChannelBotAgentLink.account_id,
                active_binding_counts.c.bot_agent_link_id == ChannelBotAgentLink.id,
                active_binding_counts.c.user_id == ChannelBotAgentLink.user_id,
            ),
        )
        .where(
            ChannelBotAgentLink.user_id == user_id,
            ChannelBotAgentLink.agent_id == agent_id,
            ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
            ChannelBotAgentLink.archived_at.is_(None),
            ChannelAccount.archived_at.is_(None),
            ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
        )
        .order_by(
            ChannelAccount.provider,
            ChannelAccount.visibility,
            ChannelAccount.name,
            ChannelAccount.id,
            ChannelBotAgentLink.created_at,
        )
    )
    return [(link, account, int(binding_count)) for link, account, binding_count in result.all()]


async def rotate_bot_agent_link_token(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    link: ChannelBotAgentLink,
) -> str:
    await get_strict_v2_hosted_channel_agent_or_409(
        db,
        agent_id=link.agent_id,
        user_id=link.user_id,
        lock_runtime_fence=True,
    )
    await db.refresh(link, with_for_update=True)
    if not await bot_agent_link_has_strict_v2_authority(db, link=link):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=STRICT_V2_AGENT_LINK_DETAIL,
        )
    await ensure_bot_agent_link_provider_cardinality_or_409(db, account=account, link=link)
    raw_token = generate_agent_token(account.provider)
    store_agent_link_token(link, raw_token)
    await db.flush()
    return raw_token


async def archive_bot_agent_link(
    db: AsyncSession,
    *,
    link: ChannelBotAgentLink,
    account: ChannelAccount | None = None,
) -> None:
    now = datetime.now(UTC)
    link.status = BOT_AGENT_LINK_STATUS_ARCHIVED
    scrub_agent_link_token(link)
    link.archived_at = now

    bindings_result = await db.execute(
        select(ChannelBinding).where(
            ChannelBinding.bot_agent_link_id == link.id,
            ChannelBinding.status == BINDING_STATUS_ACTIVE,
        )
    )
    archived_bindings = list(bindings_result.scalars().all())
    for binding in archived_bindings:
        binding.status = BINDING_STATUS_ARCHIVED
    await consume_pending_inbound_messages_for_bindings(db, bindings=archived_bindings)

    pair_codes_result = await db.execute(
        select(ChannelPairCode).where(
            ChannelPairCode.bot_agent_link_id == link.id,
            ChannelPairCode.status == PAIR_CODE_STATUS_PENDING,
        )
    )
    for pair_code in pair_codes_result.scalars().all():
        pair_code.status = PAIR_CODE_STATUS_REVOKED

    credentials_result = await db.execute(
        select(ChannelAgentCredential).where(
            ChannelAgentCredential.bot_agent_link_id == link.id,
            ChannelAgentCredential.revoked_at.is_(None),
        )
    )
    for credential in credentials_result.scalars().all():
        credential.revoked_at = now

    deliveries_result = await db.execute(
        select(ChannelDelivery).where(
            ChannelDelivery.bot_agent_link_id == link.id,
            ChannelDelivery.status.in_(
                (
                    DELIVERY_STATUS_PENDING,
                    DELIVERY_STATUS_IN_PROGRESS,
                )
            ),
        )
    )
    for delivery in deliveries_result.scalars().all():
        _fail_delivery(
            delivery,
            "channel agent link archived",
            use_safe_diagnostics=(
                account is not None
                and account.provider
                in {
                    CHANNEL_PROVIDER_TELEGRAM,
                    CHANNEL_PROVIDER_DISCORD,
                    CHANNEL_PROVIDER_WHATSAPP,
                }
            ),
        )

    await db.flush()


async def get_owned_private_channel_account(
    db: AsyncSession,
    *,
    account_id: UUID,
    user_id: UUID,
) -> ChannelAccount:
    """Resolve a user-owned mutable channel account.

    Public channel accounts are platform-owned infrastructure. User-facing
    mutable operations apply only to private accounts created by that user.
    """
    result = await db.execute(
        select(ChannelAccount).where(
            ChannelAccount.id == account_id,
            ChannelAccount.user_id == user_id,
            ChannelAccount.visibility == CHANNEL_VISIBILITY_PRIVATE,
            ChannelAccount.archived_at.is_(None),
        )
    )
    account = result.scalar_one_or_none()
    if account is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="channel not found")
    return account


async def get_accessible_channel_account(
    db: AsyncSession,
    *,
    account_id: UUID,
    user_id: UUID,
) -> ChannelAccount:
    result = await db.execute(
        select(ChannelAccount).where(
            ChannelAccount.id == account_id,
            ChannelAccount.archived_at.is_(None),
            or_(
                and_(
                    ChannelAccount.user_id == user_id,
                    ChannelAccount.visibility == CHANNEL_VISIBILITY_PRIVATE,
                ),
                and_(
                    ChannelAccount.visibility == CHANNEL_VISIBILITY_PUBLIC,
                    ChannelAccount.user_id.is_(None),
                    ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
                ),
            ),
        )
    )
    account = result.scalar_one_or_none()
    if account is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="channel not found")
    return account


async def get_usable_channel_account(
    db: AsyncSession,
    *,
    account_id: UUID,
    user_id: UUID,
) -> ChannelAccount:
    result = await db.execute(
        select(ChannelAccount).where(
            ChannelAccount.id == account_id,
            ChannelAccount.archived_at.is_(None),
            ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
            or_(
                and_(
                    ChannelAccount.user_id == user_id,
                    ChannelAccount.visibility == CHANNEL_VISIBILITY_PRIVATE,
                ),
                and_(
                    ChannelAccount.visibility == CHANNEL_VISIBILITY_PUBLIC,
                    ChannelAccount.user_id.is_(None),
                ),
            ),
        )
    )
    account = result.scalar_one_or_none()
    if account is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="channel not found")
    return account


async def get_active_channel_account(db: AsyncSession, *, account_id: UUID) -> ChannelAccount:
    """Resolve an account for provider ingress or agent-facing SDK routes.

    This is intentionally visibility-neutral: private user bots and public bots
    both receive provider webhooks under account-scoped URLs.
    User-facing access checks belong in get_accessible_channel_account.
    """
    result = await db.execute(
        select(ChannelAccount).where(
            ChannelAccount.id == account_id,
            ChannelAccount.archived_at.is_(None),
            ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
        )
    )
    account = result.scalar_one_or_none()
    if account is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="channel not found")
    return account


async def archive_channel_account(db: AsyncSession, *, account: ChannelAccount) -> None:
    now = datetime.now(UTC)
    account.archived_at = now
    account.status = CHANNEL_STATUS_DISABLED
    account.encrypted_provider_token = None
    account.provider_token_nonce = None
    await db.execute(delete(ChannelSecret).where(ChannelSecret.account_id == account.id))

    links_result = await db.execute(
        select(ChannelBotAgentLink).where(
            ChannelBotAgentLink.account_id == account.id,
            ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
            ChannelBotAgentLink.archived_at.is_(None),
        )
    )
    for link in links_result.scalars().all():
        link.status = BOT_AGENT_LINK_STATUS_ARCHIVED
        scrub_agent_link_token(link)
        link.archived_at = now

    bindings_result = await db.execute(
        select(ChannelBinding).where(
            ChannelBinding.account_id == account.id,
            ChannelBinding.status == BINDING_STATUS_ACTIVE,
        )
    )
    archived_bindings = list(bindings_result.scalars().all())
    for binding in archived_bindings:
        binding.status = BINDING_STATUS_ARCHIVED
    await consume_pending_inbound_messages_for_bindings(db, bindings=archived_bindings)

    pair_codes_result = await db.execute(
        select(ChannelPairCode).where(
            ChannelPairCode.account_id == account.id,
            ChannelPairCode.status == PAIR_CODE_STATUS_PENDING,
        )
    )
    for pair_code in pair_codes_result.scalars().all():
        pair_code.status = PAIR_CODE_STATUS_REVOKED

    credentials_result = await db.execute(
        select(ChannelAgentCredential).where(
            ChannelAgentCredential.account_id == account.id,
            ChannelAgentCredential.revoked_at.is_(None),
        )
    )
    for credential in credentials_result.scalars().all():
        credential.revoked_at = now

    deliveries_result = await db.execute(
        select(ChannelDelivery).where(
            ChannelDelivery.account_id == account.id,
            ChannelDelivery.status.in_(
                (
                    DELIVERY_STATUS_PENDING,
                    DELIVERY_STATUS_IN_PROGRESS,
                )
            ),
        )
    )
    for delivery in deliveries_result.scalars().all():
        _fail_delivery(
            delivery,
            "channel account archived",
            use_safe_diagnostics=account.provider
            in {
                CHANNEL_PROVIDER_TELEGRAM,
                CHANNEL_PROVIDER_DISCORD,
                CHANNEL_PROVIDER_WHATSAPP,
            },
        )

    await db.flush()


async def resolve_channel_agent_by_token(
    db: AsyncSession,
    *,
    provider: str,
    token: str,
) -> ChannelAgentContext:
    result = await db.execute(
        select(
            ChannelAccount,
            ChannelBotAgentLink,
            AgentEnvironment,
            HostedRuntimeState,
            V2RuntimeEnvironmentFence,
        )
        .join(ChannelBotAgentLink, ChannelBotAgentLink.account_id == ChannelAccount.id)
        .join(AgentEnvironment, AgentEnvironment.id == ChannelBotAgentLink.agent_id)
        .join(HostedRuntimeState, HostedRuntimeState.environment_id == AgentEnvironment.id)
        .join(
            V2RuntimeEnvironmentFence,
            V2RuntimeEnvironmentFence.environment_id == AgentEnvironment.id,
        )
        .where(
            ChannelAccount.provider == provider,
            ChannelBotAgentLink.agent_token_hash == hash_token(token),
            ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
            ChannelBotAgentLink.archived_at.is_(None),
            ChannelAccount.archived_at.is_(None),
            ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
            AgentEnvironment.user_id == ChannelBotAgentLink.user_id,
            AgentEnvironment.archived_at.is_(None),
        )
        .execution_options(populate_existing=True)
    )
    row = result.one_or_none()
    if row is None or not is_strict_v2_hosted_channel_agent(*row[2:]):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid bot token")
    account, link, _agent, _state, _fence = row
    if not await bot_agent_link_has_strict_v2_authority(db, link=link):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid bot token")
    await ensure_bot_agent_link_provider_cardinality_or_409(db, account=account, link=link)
    return ChannelAgentContext(account=account, link=link)


async def resolve_channel_agent_by_identity(
    db: AsyncSession,
    *,
    provider: str,
    account_id: UUID,
    link_id: UUID,
    agent_token_hash: str,
) -> ChannelAgentContext:
    result = await db.execute(
        select(
            ChannelAccount,
            ChannelBotAgentLink,
            AgentEnvironment,
            HostedRuntimeState,
            V2RuntimeEnvironmentFence,
        )
        .join(ChannelBotAgentLink, ChannelBotAgentLink.account_id == ChannelAccount.id)
        .join(AgentEnvironment, AgentEnvironment.id == ChannelBotAgentLink.agent_id)
        .join(HostedRuntimeState, HostedRuntimeState.environment_id == AgentEnvironment.id)
        .join(
            V2RuntimeEnvironmentFence,
            V2RuntimeEnvironmentFence.environment_id == AgentEnvironment.id,
        )
        .where(
            ChannelAccount.id == account_id,
            ChannelAccount.provider == provider,
            ChannelBotAgentLink.id == link_id,
            ChannelBotAgentLink.agent_token_hash == agent_token_hash,
            ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
            ChannelBotAgentLink.archived_at.is_(None),
            ChannelAccount.archived_at.is_(None),
            ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
            AgentEnvironment.user_id == ChannelBotAgentLink.user_id,
            AgentEnvironment.archived_at.is_(None),
        )
        .execution_options(populate_existing=True)
    )
    row = result.one_or_none()
    if row is None or not is_strict_v2_hosted_channel_agent(*row[2:]):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid bot identity")
    account, link, _agent, _state, _fence = row
    if not await bot_agent_link_has_strict_v2_authority(db, link=link):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid bot identity")
    await ensure_bot_agent_link_provider_cardinality_or_409(db, account=account, link=link)
    return ChannelAgentContext(account=account, link=link)


async def claim_pair_code(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    raw_code: str,
    external_chat_id: str,
    external_chat_type: str | None,
    external_chat_name: str | None,
    external_user_id: str | None,
) -> PairCodeClaimResult:
    await lock_channel_binding_identity(
        db,
        account_id=account.id,
        external_chat_id=external_chat_id,
    )
    result = await db.execute(
        select(ChannelPairCode)
        .where(
            ChannelPairCode.account_id == account.id,
            ChannelPairCode.code_hash == hash_token(raw_code),
        )
        .with_for_update()
    )
    pair_code = result.scalar_one_or_none()
    if pair_code is None:
        return PairCodeClaimResult(reason="invalid")
    if pair_code.status != PAIR_CODE_STATUS_PENDING:
        return PairCodeClaimResult(reason="already_used")
    if pair_code.expires_at <= datetime.now(UTC):
        return PairCodeClaimResult(reason="expired")
    if not await bot_agent_link_allows_new_pairing(
        db,
        account_id=account.id,
        link_id=pair_code.bot_agent_link_id,
        user_id=pair_code.user_id,
    ):
        # Historical pair codes must not let an ineligible Link expand into a
        # new chat binding. Revoke the code while preserving list/unpair/unlink
        # cleanup for any state that already exists.
        pair_code.status = PAIR_CODE_STATUS_REVOKED
        return PairCodeClaimResult(reason="invalid")

    try:
        async with db.begin_nested():
            binding = await get_or_create_binding(
                db,
                account=account,
                bot_agent_link_id=pair_code.bot_agent_link_id,
                user_id=pair_code.user_id,
                external_chat_id=external_chat_id,
                external_chat_type=external_chat_type,
                external_chat_name=external_chat_name,
                external_user_id=external_user_id,
            )
    except BindingAgentLinkMismatchError:
        return PairCodeClaimResult(reason="already_paired")
    except (BindingActorMismatchError, IntegrityError):
        return PairCodeClaimResult(reason="forbidden")
    pair_code.status = PAIR_CODE_STATUS_CLAIMED
    pair_code.claimed_at = datetime.now(UTC)
    pair_code.claimed_external_chat_id = external_chat_id
    pair_code.claimed_external_user_id = external_user_id
    return PairCodeClaimResult(binding=binding)


async def get_or_create_binding(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID,
    user_id: UUID,
    external_chat_id: str,
    external_chat_type: str | None,
    external_chat_name: str | None,
    external_user_id: str | None,
) -> ChannelBinding:
    await lock_channel_binding_identity(
        db,
        account_id=account.id,
        external_chat_id=external_chat_id,
    )
    result = await db.execute(
        select(ChannelBinding)
        .where(
            ChannelBinding.account_id == account.id,
            ChannelBinding.external_chat_id == external_chat_id,
        )
        .order_by(
            (ChannelBinding.status == BINDING_STATUS_ACTIVE).desc(),
            ChannelBinding.created_at.desc(),
        )
        .limit(1)
        .execution_options(populate_existing=True)
        .with_for_update()
    )
    binding = result.scalars().first()
    if binding is not None:
        if binding.status == BINDING_STATUS_ACTIVE:
            if not binding_is_controlled_by_actor(
                binding,
                external_user_id=external_user_id,
            ):
                raise BindingActorMismatchError
            if account.provider == CHANNEL_PROVIDER_DISCORD:
                if binding.bot_agent_link_id != bot_agent_link_id:
                    # One active Discord guild/DM scope cannot be silently
                    # moved between AgentLinks. Explicit unpair archives the
                    # scope first, after which a new Link may claim it.
                    raise BindingAgentLinkMismatchError
                if not discord_binding_matches_chat_type(
                    binding,
                    external_chat_type=external_chat_type,
                ):
                    raise BindingActorMismatchError
        binding.bot_agent_link_id = bot_agent_link_id
        binding.user_id = user_id
        binding.external_chat_type = external_chat_type
        candidate_name = _read_optional_display_name(external_chat_name)
        if candidate_name is not None and candidate_name != external_chat_id:
            binding.external_chat_name = candidate_name
        binding.paired_external_user_id = external_user_id
        binding.status = BINDING_STATUS_ACTIVE
        await db.execute(
            update(ChannelBindingAlias)
            .where(ChannelBindingAlias.binding_id == binding.id)
            .values(
                bot_agent_link_id=bot_agent_link_id,
                user_id=user_id,
            )
        )
        return binding

    binding = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=bot_agent_link_id,
        user_id=user_id,
        external_chat_id=external_chat_id,
        external_chat_type=external_chat_type,
        external_chat_name=external_chat_name,
        paired_external_user_id=external_user_id,
    )
    db.add(binding)
    await db.flush()
    return binding


async def lock_channel_binding_identity(
    db: AsyncSession,
    *,
    account_id: UUID,
    external_chat_id: str,
) -> None:
    """Serialize mutations and provider cleanup for one physical chat."""
    # The binding row is not a stable lock target: it can be absent on first
    # pair and an archived row can change visibility while another transaction
    # waits. Use the same transaction lock for pair, unpair, and unlink cleanup.
    lock_name = f"channel-binding:{account_id}:{external_chat_id}"
    await db.execute(select(func.pg_advisory_xact_lock(func.hashtextextended(lock_name, 0))))


async def lock_active_discord_binding_lease(
    db: AsyncSession,
    *,
    account_id: UUID,
    bot_agent_link_id: UUID,
    binding_id: UUID,
    external_chat_id: str,
) -> ChannelBinding | None:
    """Hold active Discord authority through the caller's transaction."""
    lock_name = f"channel-binding:{account_id}:{external_chat_id}"
    await db.execute(select(func.pg_advisory_xact_lock_shared(func.hashtextextended(lock_name, 0))))
    return (
        await db.execute(
            select(ChannelBinding)
            .join(ChannelAccount, ChannelAccount.id == ChannelBinding.account_id)
            .join(ChannelBotAgentLink, ChannelBotAgentLink.id == ChannelBinding.bot_agent_link_id)
            .where(
                ChannelBinding.id == binding_id,
                ChannelBinding.account_id == account_id,
                ChannelBinding.bot_agent_link_id == bot_agent_link_id,
                ChannelBinding.external_chat_id == external_chat_id,
                ChannelBinding.status == BINDING_STATUS_ACTIVE,
                ChannelAccount.provider == CHANNEL_PROVIDER_DISCORD,
                ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
                ChannelAccount.archived_at.is_(None),
                ChannelBotAgentLink.account_id == ChannelBinding.account_id,
                ChannelBotAgentLink.user_id == ChannelBinding.user_id,
                ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
                ChannelBotAgentLink.archived_at.is_(None),
            )
            .with_for_update(
                read=True,
                of=(ChannelAccount, ChannelBotAgentLink, ChannelBinding),
            )
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()


def binding_is_controlled_by_actor(
    binding: ChannelBinding,
    *,
    external_user_id: str | None,
) -> bool:
    if binding.paired_external_user_id is None:
        return external_user_id is None
    return binding.paired_external_user_id == external_user_id


def discord_binding_matches_chat_type(
    binding: ChannelBinding,
    *,
    external_chat_type: str | None,
) -> bool:
    binding_is_dm = (binding.external_chat_type or "").lower() in DISCORD_DM_CHAT_TYPES
    incoming_is_dm = (external_chat_type or "").lower() in DISCORD_DM_CHAT_TYPES
    return binding_is_dm == incoming_is_dm


async def find_binding(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    external_chat_id: str,
    bot_agent_link_id: UUID | None = None,
) -> ChannelBinding | None:
    filters = [
        ChannelBinding.account_id == account.id,
        ChannelBinding.external_chat_id == external_chat_id,
        ChannelBinding.status == BINDING_STATUS_ACTIVE,
    ]
    if bot_agent_link_id is not None:
        filters.append(ChannelBinding.bot_agent_link_id == bot_agent_link_id)
    result = await db.execute(
        select(ChannelBinding).where(*filters).order_by(ChannelBinding.created_at)
    )
    binding = result.scalars().first()
    if binding is not None:
        return binding
    alias_filters = [
        ChannelBinding.account_id == account.id,
        ChannelBindingAlias.account_id == account.id,
        ChannelBindingAlias.alias_external_chat_id == external_chat_id,
        ChannelBinding.status == BINDING_STATUS_ACTIVE,
    ]
    if bot_agent_link_id is not None:
        alias_filters.append(ChannelBinding.bot_agent_link_id == bot_agent_link_id)
    alias_result = await db.execute(
        select(ChannelBinding)
        .join(ChannelBindingAlias, ChannelBindingAlias.binding_id == ChannelBinding.id)
        .where(*alias_filters)
        .order_by(ChannelBinding.created_at)
    )
    return alias_result.scalars().first()


async def find_bindings(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    external_chat_id: str,
) -> list[ChannelBinding]:
    result = await db.execute(
        select(ChannelBinding)
        .where(
            ChannelBinding.account_id == account.id,
            ChannelBinding.external_chat_id == external_chat_id,
            ChannelBinding.status == BINDING_STATUS_ACTIVE,
        )
        .order_by(ChannelBinding.created_at)
    )
    bindings = list(result.scalars().all())
    alias_result = await db.execute(
        select(ChannelBinding)
        .join(ChannelBindingAlias, ChannelBindingAlias.binding_id == ChannelBinding.id)
        .where(
            ChannelBinding.account_id == account.id,
            ChannelBindingAlias.account_id == account.id,
            ChannelBindingAlias.alias_external_chat_id == external_chat_id,
            ChannelBinding.status == BINDING_STATUS_ACTIVE,
        )
        .order_by(ChannelBinding.created_at)
    )
    seen = {binding.id for binding in bindings}
    for binding in alias_result.scalars().all():
        if binding.id not in seen:
            bindings.append(binding)
            seen.add(binding.id)
    return bindings


async def upsert_binding_alias(
    db: AsyncSession,
    *,
    binding: ChannelBinding,
    alias_external_chat_id: str,
    alias_kind: str,
    require_same_binding: bool = False,
) -> ChannelBindingAlias:
    result = await db.execute(
        select(ChannelBindingAlias).where(
            ChannelBindingAlias.account_id == binding.account_id,
            ChannelBindingAlias.alias_external_chat_id == alias_external_chat_id,
        )
    )
    alias = result.scalar_one_or_none()
    if alias is not None:
        if require_same_binding and alias.binding_id != binding.id:
            existing_binding = await db.get(ChannelBinding, alias.binding_id)
            if existing_binding is not None and existing_binding.status == BINDING_STATUS_ACTIVE:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="channel binding alias does not match",
                )
        alias.binding_id = binding.id
        alias.alias_kind = alias_kind
        alias.user_id = binding.user_id
        alias.bot_agent_link_id = binding.bot_agent_link_id
        await db.flush()
        return alias
    alias = ChannelBindingAlias(
        account_id=binding.account_id,
        bot_agent_link_id=binding.bot_agent_link_id,
        binding_id=binding.id,
        user_id=binding.user_id,
        alias_external_chat_id=alias_external_chat_id,
        alias_kind=alias_kind,
    )
    db.add(alias)
    await db.flush()
    return alias


async def lock_active_binding_authority(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    binding: ChannelBinding,
    bot_agent_link_id: UUID,
) -> ChannelBinding | None:
    """Lock Account -> Link -> Binding authority through the caller's transaction."""
    locked_account = await _lock_active_account_authority(db, account_id=account.id)
    if locked_account is None:
        return None
    link = await _lock_active_link_for_account(
        db,
        account=locked_account,
        bot_agent_link_id=bot_agent_link_id,
    )
    if link is None or binding.user_id != link.user_id:
        return None
    return (
        await db.execute(
            select(ChannelBinding)
            .where(
                ChannelBinding.id == binding.id,
                ChannelBinding.account_id == locked_account.id,
                ChannelBinding.bot_agent_link_id == link.id,
                ChannelBinding.user_id == link.user_id,
                ChannelBinding.status == BINDING_STATUS_ACTIVE,
            )
            .execution_options(populate_existing=True)
            .with_for_update(read=True, of=ChannelBinding)
        )
    ).scalar_one_or_none()


async def lock_active_link_authority(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID,
) -> ChannelBotAgentLink | None:
    """Hold Account -> Link authority through the caller's transaction."""
    locked_account = await _lock_active_account_authority(db, account_id=account.id)
    if locked_account is None:
        return None
    return await _lock_active_link_for_account(
        db,
        account=locked_account,
        bot_agent_link_id=bot_agent_link_id,
    )


async def _lock_active_account_authority(
    db: AsyncSession,
    *,
    account_id: UUID,
) -> ChannelAccount | None:
    return (
        await db.execute(
            select(ChannelAccount)
            .where(
                ChannelAccount.id == account_id,
                ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
                ChannelAccount.archived_at.is_(None),
            )
            .execution_options(populate_existing=True)
            .with_for_update(read=True, of=ChannelAccount)
        )
    ).scalar_one_or_none()


async def _lock_active_link_for_account(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID,
) -> ChannelBotAgentLink | None:
    link_owner_filter = None
    if account.visibility == CHANNEL_VISIBILITY_PRIVATE:
        if account.user_id is None:
            return None
        link_owner_filter = ChannelBotAgentLink.user_id == account.user_id
    elif account.visibility == CHANNEL_VISIBILITY_PUBLIC:
        if account.user_id is not None:
            return None
    else:
        return None
    filters = [
        ChannelBotAgentLink.id == bot_agent_link_id,
        ChannelBotAgentLink.account_id == account.id,
        ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
        ChannelBotAgentLink.archived_at.is_(None),
    ]
    if link_owner_filter is not None:
        filters.append(link_owner_filter)
    return (
        await db.execute(
            select(ChannelBotAgentLink)
            .where(*filters)
            .with_for_update(read=True, of=ChannelBotAgentLink)
        )
    ).scalar_one_or_none()


async def resolve_inbound_binding(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    external_chat_id: str,
    external_chat_type: str | None,
    external_chat_name: str | None,
    external_user_id: str | None,
    text: str | None,
    command: ChannelControlCommand | None = None,
    command_denied_reason: str | None = None,
    command_actor_required: bool = False,
) -> InboundBindingResult:
    parsed = command if command is not None else parse_channel_control_command(text)
    pairing_mutation = parsed is not None and parsed.kind in {"pair", "unpair"}
    if pairing_mutation:
        await lock_channel_binding_identity(
            db,
            account_id=account.id,
            external_chat_id=external_chat_id,
        )
    bindings = await find_bindings(db, account=account, external_chat_id=external_chat_id)
    if account.provider == CHANNEL_PROVIDER_DISCORD:
        bindings = [
            active_binding
            for active_binding in bindings
            if discord_binding_matches_chat_type(
                active_binding,
                external_chat_type=external_chat_type,
            )
        ]
        if not pairing_mutation:
            leased_bindings: list[ChannelBinding] = []
            for candidate in sorted(bindings, key=lambda value: value.id):
                leased = await lock_active_discord_binding_lease(
                    db,
                    account_id=account.id,
                    bot_agent_link_id=candidate.bot_agent_link_id,
                    binding_id=candidate.id,
                    external_chat_id=external_chat_id,
                )
                if leased is None:
                    await record_inactive_bot_agent_link_event(
                        db,
                        account=account,
                        binding=candidate,
                    )
                else:
                    leased_bindings.append(leased)
            bindings = leased_bindings
    binding = bindings[0] if bindings else None
    if parsed is None:
        authorized_bindings: list[ChannelBinding] = []
        for active_binding in bindings:
            if external_chat_type == "direct_messages" and not binding_is_controlled_by_actor(
                active_binding,
                external_user_id=external_user_id,
            ):
                continue
            link = await db.get(ChannelBotAgentLink, active_binding.bot_agent_link_id)
            inactive = (
                link is None
                or link.status != BOT_AGENT_LINK_STATUS_ACTIVE
                or link.archived_at is not None
            )
            authorized = False
            if link is not None and not inactive:
                authorized = await bot_agent_link_has_strict_v2_authority(
                    db,
                    link=link,
                ) and await bot_agent_link_has_provider_cardinality_capability(
                    db,
                    account=account,
                    link=link,
                )
            if inactive or authorized:
                # Preserve the binding for inactive-link health reporting. An
                # active historical Link without runtime authority remains
                # unbound and cannot reach a runtime.
                authorized_bindings.append(active_binding)
        return InboundBindingResult(
            binding=authorized_bindings[0] if authorized_bindings else None,
            bindings=tuple(authorized_bindings),
        )
    if command_denied_reason is not None:
        return InboundBindingResult(
            binding=binding,
            bindings=tuple(bindings),
            command_handled=True,
            pair_failed_reason=command_denied_reason,
        )
    if parsed.kind == "help":
        return InboundBindingResult(
            binding=binding,
            bindings=tuple(bindings),
            command_handled=True,
        )
    if external_user_id is None and (
        command_actor_required or pairing_command_requires_actor(external_chat_type)
    ):
        return InboundBindingResult(
            binding=binding,
            bindings=tuple(bindings),
            command_handled=True,
            pair_failed_reason="forbidden",
        )
    if parsed.kind == "pair":
        if not parsed.code:
            return InboundBindingResult(
                binding=binding,
                bindings=tuple(bindings),
                command_handled=True,
                pair_failed_reason="usage",
            )
        claim = await claim_pair_code(
            db,
            account=account,
            raw_code=parsed.code,
            external_chat_id=external_chat_id,
            external_chat_type=external_chat_type,
            external_chat_name=external_chat_name,
            external_user_id=external_user_id,
        )
        return InboundBindingResult(
            binding=claim.binding or binding,
            bindings=(claim.binding,) if claim.binding is not None else tuple(bindings),
            paired=claim.binding is not None and claim.reason is None,
            command_handled=True,
            pair_failed_reason=claim.reason,
        )
    if parsed.kind == "unpair":
        if not bindings:
            return InboundBindingResult(binding=None, command_handled=True)
        authorized_bindings = [
            active_binding
            for active_binding in bindings
            if binding_is_controlled_by_actor(
                active_binding,
                external_user_id=external_user_id,
            )
        ]
        if not authorized_bindings:
            return InboundBindingResult(
                binding=binding,
                bindings=tuple(bindings),
                command_handled=True,
                pair_failed_reason="forbidden",
            )
        for active_binding in authorized_bindings:
            active_binding.status = BINDING_STATUS_ARCHIVED
        await consume_pending_inbound_messages_for_bindings(
            db,
            bindings=authorized_bindings,
        )
        return InboundBindingResult(
            binding=binding,
            bindings=tuple(authorized_bindings),
            unpaired=True,
            command_handled=True,
        )
    return InboundBindingResult(binding=binding, bindings=tuple(bindings), command_handled=True)


def pairing_command_requires_actor(external_chat_type: str | None) -> bool:
    if external_chat_type is None:
        return False
    return external_chat_type.lower() not in {"private", "dm"}


def parse_channel_control_command(text: str | None) -> ChannelControlCommand | None:
    if not text:
        return None
    trimmed = text.lstrip()
    if trimmed.startswith("/start"):
        head, separator, rest = trimmed.partition(" ")
        command = head.split("@", 1)[0]
        if command != "/start" or not separator:
            return None
        code = _single_command_arg(rest)
        if code is not None and PAIR_CODE_PATTERN.fullmatch(code):
            return ChannelControlCommand(kind="pair", code=code)
        return None
    if not trimmed.startswith("/clawdi_"):
        return None
    head, separator, rest = trimmed.partition(" ")
    command = head.split("@", 1)[0]
    if command == PAIR_COMMAND:
        code = _single_command_arg(rest) if separator else ""
        if code is None:
            code = ""
        return ChannelControlCommand(kind="pair", code=code)
    if command == UNPAIR_COMMAND:
        if separator and rest.strip():
            return ChannelControlCommand(kind="unknown", command=command)
        return ChannelControlCommand(kind="unpair")
    if command == HELP_COMMAND:
        if separator and rest.strip():
            return ChannelControlCommand(kind="unknown", command=command)
        return ChannelControlCommand(kind="help")
    return ChannelControlCommand(kind="unknown", command=command)


def _single_command_arg(rest: str) -> str | None:
    stripped = rest.strip()
    if not stripped:
        return ""
    parts = stripped.split()
    if len(parts) != 1:
        return None
    return parts[0]


def pairing_reply_for_command(
    command: ChannelControlCommand | None,
    result: InboundBindingResult,
    *,
    pair_command: str = PAIR_COMMAND,
    unpair_command: str = UNPAIR_COMMAND,
) -> str:
    if result.paired:
        return PAIRING_REPLY_PAIRED
    if result.unpaired:
        return PAIRING_REPLY_UNPAIRED
    if command is None:
        return "Message received."
    if command.kind == "pair":
        if result.pair_failed_reason == "usage":
            return f"Usage: {pair_command} <code>"
        if result.pair_failed_reason == "forbidden":
            return PAIRING_REPLY_FORBIDDEN
        reason = result.pair_failed_reason or "invalid"
        return f"Pairing failed: {reason}."
    if command.kind == "unpair":
        if result.pair_failed_reason == "forbidden":
            return PAIRING_REPLY_FORBIDDEN
        return PAIRING_REPLY_NOT_PAIRED
    if command.kind == "help":
        return channel_control_help_reply()
    if command.kind == "unknown" and command.command:
        return f"Unknown command: {command.command}. Use {HELP_COMMAND} for instructions."
    return "Message received."


def channel_control_help_reply() -> str:
    return CHANNEL_CONTROL_HELP_REPLY_TEMPLATE.format(
        web_origin=settings.web_origin.rstrip("/"),
    )


def discord_guild_command_denied_reason(
    payload: JsonObject,
    *,
    command: ChannelControlCommand | None,
    guild_id: str | None,
) -> str | None:
    """Require Discord-computed guild permissions for pairing mutations.

    Discord interaction ``member.permissions`` is the authoritative computed
    decimal-string bitfield. The installation admission check separately
    requires an application-command interaction, so MESSAGE_CREATE cannot
    manufacture authority by copying this field. Discord API docs baseline:
    07c83a8f1c54accd8e8d13072a5e08d1b1be7ac3.
    """
    if command is None or command.kind not in {"pair", "unpair"} or guild_id is None:
        return None
    data = _discord_event_data(payload)
    member = data.get("member")
    raw_permissions = member.get("permissions") if isinstance(member, dict) else None
    is_interaction = payload.get("type") == 2
    if not isinstance(raw_permissions, str) or re.fullmatch(r"[0-9]+", raw_permissions) is None:
        return DISCORD_GUILD_PERMISSION_DENIED if is_interaction else DISCORD_GUILD_USE_INTERACTION
    try:
        permissions = int(raw_permissions, 10)
    except ValueError:
        return DISCORD_GUILD_PERMISSION_DENIED if is_interaction else DISCORD_GUILD_USE_INTERACTION
    required = DISCORD_MANAGE_GUILD_PERMISSION | DISCORD_ADMINISTRATOR_PERMISSION
    if permissions & required:
        return None
    return DISCORD_GUILD_PERMISSION_DENIED


def discord_pair_install_denied_reason(
    payload: JsonObject,
    *,
    command: ChannelControlCommand | None,
    guild_id: str | None,
    external_user_id: str | None,
    trusted_interaction: bool,
) -> str | None:
    """Require the Discord installation that owns a pairing mutation.

    ``authorizing_integration_owners`` is Discord's authoritative mapping from
    installation context to owner. Both pair and unpair require an authentic
    application-command interaction in the matching context. For backward
    compatible cleanup after an uninstall, unpair alone may proceed when the
    required owner key is absent; the binding resolver still requires an exact
    active scope and the original pairing actor. A present-but-mismatched owner
    is never accepted.
    """
    denied_reason, _cleanup_owner_missing = _discord_pair_install_admission(
        payload,
        command=command,
        guild_id=guild_id,
        external_user_id=external_user_id,
        trusted_interaction=trusted_interaction,
    )
    return denied_reason


def _discord_pair_install_admission(
    payload: JsonObject,
    *,
    command: ChannelControlCommand | None,
    guild_id: str | None,
    external_user_id: str | None,
    trusted_interaction: bool,
) -> tuple[str | None, bool]:
    if command is None or command.kind not in {"pair", "unpair"}:
        return None, False
    data = _discord_event_data(payload)
    interaction_type = data.get("type")
    interaction_data = data.get("data")
    is_http_interaction = data is payload
    is_application_command = (
        isinstance(interaction_type, int)
        and not isinstance(interaction_type, bool)
        and interaction_type == 2
        and isinstance(interaction_data, dict)
        and is_http_interaction
    )
    expected_context = (
        DISCORD_GUILD_INTERACTION_CONTEXT
        if guild_id is not None
        else DISCORD_BOT_DM_INTERACTION_CONTEXT
    )
    raw_context = data.get("context")
    if (
        not trusted_interaction
        or not is_application_command
        or not isinstance(raw_context, int)
        or isinstance(raw_context, bool)
        or raw_context != expected_context
    ):
        return (
            (
                DISCORD_GUILD_INSTALL_REQUIRED
                if guild_id is not None
                else DISCORD_USER_INSTALL_REQUIRED
            ),
            False,
        )
    raw_owners = data.get("authorizing_integration_owners")
    if raw_owners is None and "authorizing_integration_owners" not in data:
        owners: JsonObject = {}
    elif isinstance(raw_owners, dict):
        owners = raw_owners
    else:
        return (
            (
                DISCORD_GUILD_INSTALL_REQUIRED
                if guild_id is not None
                else DISCORD_USER_INSTALL_REQUIRED
            ),
            False,
        )
    if guild_id is not None:
        owner_key = str(DISCORD_GUILD_INSTALL)
        if owner_key not in owners:
            return (
                (None, True)
                if command.kind == "unpair"
                else (DISCORD_GUILD_INSTALL_REQUIRED, False)
            )
        raw_guild_owner = owners.get(owner_key)
        guild_owner = raw_guild_owner.strip() if isinstance(raw_guild_owner, str) else None
        return (None, False) if guild_owner == guild_id else (DISCORD_GUILD_INSTALL_REQUIRED, False)
    owner_key = str(DISCORD_USER_INSTALL)
    if owner_key not in owners:
        return (None, True) if command.kind == "unpair" else (DISCORD_USER_INSTALL_REQUIRED, False)
    raw_user_owner = owners.get(owner_key)
    user_owner = raw_user_owner.strip() if isinstance(raw_user_owner, str) else None
    if external_user_id is not None and user_owner == external_user_id:
        return None, False
    return DISCORD_USER_INSTALL_REQUIRED, False


async def discord_bot_guild_membership_check(
    account: ChannelAccount,
    *,
    guild_id: str,
) -> DiscordGuildMembershipCheck:
    """Verify bot membership and return Discord-owned guild display metadata."""
    token = decrypt_provider_token(account)
    base_url = (
        _account_config_str(account, "api_base_url")
        or settings.channel_discord_api_base_url.strip()
    )
    await _validate_provider_endpoint_url(
        base_url,
        channel=CHANNEL_PROVIDER_DISCORD,
        method="GET",
        label="discord api base url",
    )
    path = f"/guilds/{guild_id}"
    account_scope = str(account.id)
    decision = discord_rate_limiter.check(account_scope, "GET", path)
    if not decision.allowed:
        return DiscordGuildMembershipCheck(denied_reason=DISCORD_BOT_GUILD_MEMBERSHIP_UNAVAILABLE)
    try:
        with track_proxy_latency(CHANNEL_PROVIDER_DISCORD, "GET"):
            async with httpx.AsyncClient(timeout=20.0) as client:
                discord_rate_limiter.consume(account_scope, "GET", path)
                response = await client.get(
                    f"{base_url.rstrip('/')}{path}",
                    headers={"Authorization": f"Bot {token}"},
                )
                discord_rate_limiter.observe(
                    account_scope,
                    "GET",
                    path,
                    _discord_rate_limit_response_headers(response),
                    response.status_code,
                )
    except httpx.HTTPError:
        outbound_errors.labels(channel=CHANNEL_PROVIDER_DISCORD, method="GET").inc()
        return DiscordGuildMembershipCheck(denied_reason=DISCORD_BOT_GUILD_MEMBERSHIP_UNAVAILABLE)
    outbound_messages.labels(channel=CHANNEL_PROVIDER_DISCORD, method="GET").inc()
    if response.status_code in {status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND}:
        outbound_errors.labels(channel=CHANNEL_PROVIDER_DISCORD, method="GET").inc()
        return DiscordGuildMembershipCheck(denied_reason=DISCORD_BOT_GUILD_MEMBERSHIP_REQUIRED)
    if not 200 <= response.status_code < 300:
        outbound_errors.labels(channel=CHANNEL_PROVIDER_DISCORD, method="GET").inc()
        return DiscordGuildMembershipCheck(denied_reason=DISCORD_BOT_GUILD_MEMBERSHIP_UNAVAILABLE)
    response_payload = _response_json_or_text(response)
    if _read_optional_str(response_payload.get("id")) != guild_id:
        return DiscordGuildMembershipCheck(denied_reason=DISCORD_BOT_GUILD_MEMBERSHIP_UNAVAILABLE)
    return DiscordGuildMembershipCheck(
        guild_name=_read_optional_display_name(response_payload.get("name"))
    )


async def discord_control_command_admission(
    account: ChannelAccount,
    payload: JsonObject,
    *,
    command: ChannelControlCommand | None,
    guild_id: str | None,
    external_user_id: str | None,
    trusted_interaction: bool,
) -> DiscordPairingCommandAdmission:
    install_reason, cleanup_owner_missing = _discord_pair_install_admission(
        payload,
        command=command,
        guild_id=guild_id,
        external_user_id=external_user_id,
        trusted_interaction=trusted_interaction,
    )
    if install_reason is not None:
        return DiscordPairingCommandAdmission(denied_reason=install_reason)
    if not cleanup_owner_missing:
        permission_reason = discord_guild_command_denied_reason(
            payload,
            command=command,
            guild_id=guild_id,
        )
        if permission_reason is not None:
            return DiscordPairingCommandAdmission(denied_reason=permission_reason)
    if command is not None and command.kind == "pair" and guild_id is not None:
        membership = await discord_bot_guild_membership_check(account, guild_id=guild_id)
        return DiscordPairingCommandAdmission(
            denied_reason=membership.denied_reason,
            external_chat_name=membership.guild_name,
        )
    if trusted_interaction and command is not None and command.kind == "pair" and guild_id is None:
        return DiscordPairingCommandAdmission(
            external_chat_name=discord_user_display_name_from_payload(
                payload,
                external_user_id=external_user_id,
            )
        )
    return DiscordPairingCommandAdmission()


def discord_control_reply_for_command(
    command: ChannelControlCommand | None,
    result: InboundBindingResult,
    *,
    guild_id: str | None,
) -> str:
    if guild_id is None:
        scope = "direct message"
        scope_title = "Direct message"
    else:
        scope = "server"
        scope_title = "Server"
    if result.paired:
        return f"{scope_title} paired. This Discord {scope} is now connected to your agent."
    if result.unpaired:
        return f"{scope_title} unpaired. This Discord {scope} is no longer connected to an agent."
    if result.pair_failed_reason == DISCORD_GUILD_USE_INTERACTION:
        return (
            "Use the /clawdi_pair or /clawdi_unpair slash command; "
            "pairing a server requires Manage Server permission."
        )
    if result.pair_failed_reason == DISCORD_GUILD_PERMISSION_DENIED:
        return "You need Manage Server permission to pair or unpair this server."
    if result.pair_failed_reason == DISCORD_GUILD_INSTALL_REQUIRED:
        return "Discord could not verify this app installation for this server command."
    if result.pair_failed_reason == DISCORD_USER_INSTALL_REQUIRED:
        return "Discord could not verify User Install for this direct-message command."
    if result.pair_failed_reason == DISCORD_BOT_GUILD_MEMBERSHIP_REQUIRED:
        return "Add the Discord bot to this server before pairing it."
    if result.pair_failed_reason == DISCORD_BOT_GUILD_MEMBERSHIP_UNAVAILABLE:
        return "Discord could not verify that the bot is in this server. Try again."
    if result.pair_failed_reason == "forbidden":
        return f"Only the user who paired this {scope} can change its pairing."
    if result.pair_failed_reason == "already_paired":
        return f"This {scope} is already paired to another Agent. Unpair it first."
    if command is not None and command.kind == "unpair" and not result.unpaired:
        return f"This {scope} is not paired."
    if command is not None and command.kind == "pair" and result.pair_failed_reason == "usage":
        return "Usage: /clawdi_pair <code>"
    if command is not None and command.kind == "unknown" and command.command:
        return f"Unknown command: {command.command}. Use {HELP_COMMAND} for instructions."
    return pairing_reply_for_command(command, result)


def extract_pair_code(text: str | None) -> str | None:
    command = parse_channel_control_command(text)
    return command.code if command is not None and command.kind == "pair" else None


async def send_control_command_reply(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    external_chat_id: str,
    send_external_chat_id: str | None = None,
    telegram_message_thread_id: int | None = None,
    telegram_direct_messages_topic_id: int | None = None,
    command: ChannelControlCommand | None,
    binding_result: InboundBindingResult,
    reply: str | None = None,
) -> ChannelMessage | None:
    if not binding_result.command_handled:
        return None
    reply_text = reply or pairing_reply_for_command(
        command,
        binding_result,
    )
    reply_link_id = (
        binding_result.binding.bot_agent_link_id
        if binding_result.binding is not None and (binding_result.paired or binding_result.unpaired)
        else None
    )
    bind_reply_to_existing = reply_link_id is not None
    try:
        if (
            reply_link_id is None
            and account.visibility == CHANNEL_VISIBILITY_PUBLIC
            and account.user_id is None
        ):
            await send_platform_unbound_channel_message(
                account=account,
                external_chat_id=send_external_chat_id or external_chat_id,
                text=reply_text,
                telegram_message_thread_id=telegram_message_thread_id,
                telegram_direct_messages_topic_id=telegram_direct_messages_topic_id,
            )
            return None
        return await send_channel_outbound_message(
            db,
            account=account,
            external_chat_id=send_external_chat_id or external_chat_id,
            text=reply_text,
            bot_agent_link_id=reply_link_id,
            bind_to_existing=bind_reply_to_existing,
            telegram_message_thread_id=telegram_message_thread_id,
            telegram_direct_messages_topic_id=telegram_direct_messages_topic_id,
        )
    except HTTPException as exc:
        log.warning(
            "channel_pairing_reply_failed provider=%s account_id=%s chat_id=%s status=%s detail=%s",
            account.provider,
            account.id,
            external_chat_id,
            exc.status_code,
            exc.detail,
        )
    except Exception:
        log.exception(
            "channel_pairing_reply_failed provider=%s account_id=%s chat_id=%s",
            account.provider,
            account.id,
            external_chat_id,
        )
    return None


async def send_platform_unbound_channel_message(
    *,
    account: ChannelAccount,
    external_chat_id: str,
    text: str,
    telegram_message_thread_id: int | None = None,
    telegram_direct_messages_topic_id: int | None = None,
) -> None:
    """Send an account-level provider reply without inventing tenant Message state."""

    if account.visibility != CHANNEL_VISIBILITY_PUBLIC or account.user_id is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="platform channel ownership is required",
        )
    if account.provider == CHANNEL_PROVIDER_TELEGRAM:
        await _send_telegram_provider_payload(
            account=account,
            external_chat_id=external_chat_id,
            text=text,
            message_thread_id=telegram_message_thread_id,
            direct_messages_topic_id=telegram_direct_messages_topic_id,
        )
        return
    await send_provider_outbound_payload(
        account=account,
        external_chat_id=external_chat_id,
        text=text,
    )


async def find_platform_channel_runtime_marker(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    kind: str,
    scope: str,
) -> ChannelAccountRuntimeMarker | None:
    if account.visibility != CHANNEL_VISIBILITY_PUBLIC or account.user_id is not None:
        raise ValueError("platform channel ownership is required")
    return await db.scalar(
        select(ChannelAccountRuntimeMarker).where(
            ChannelAccountRuntimeMarker.account_id == account.id,
            ChannelAccountRuntimeMarker.kind == kind,
            ChannelAccountRuntimeMarker.scope == scope,
        )
    )


def record_platform_channel_runtime_marker(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    marker: ChannelAccountRuntimeMarker | None,
    kind: str,
    scope: str,
    outcome: str,
    occurred_at: datetime,
) -> ChannelAccountRuntimeMarker:
    if account.visibility != CHANNEL_VISIBILITY_PUBLIC or account.user_id is not None:
        raise ValueError("platform channel ownership is required")
    if marker is None:
        marker = ChannelAccountRuntimeMarker(
            account_id=account.id,
            kind=kind,
            scope=scope,
            outcome=outcome,
            updated_at=occurred_at,
        )
        db.add(marker)
    else:
        marker.outcome = outcome
        marker.updated_at = occurred_at
    return marker


def telegram_chat_from_update(payload: JsonObject) -> tuple[str, str | None, str | None] | None:
    chat = _telegram_chat_object_from_update(payload)
    if isinstance(chat, dict):
        chat_id = chat.get("id")
        if chat_id is None:
            return None
        title = chat.get("title") or chat.get("username") or chat.get("first_name")
        chat_type = _read_optional_str(chat.get("type"))
        if chat_type == "supergroup" and chat.get("is_direct_messages") is True:
            chat_type = "direct_messages"
        return str(chat_id), chat_type, _read_optional_str(title)

    business_connection = payload.get("business_connection")
    if isinstance(business_connection, dict):
        user_chat_id = business_connection.get("user_chat_id")
        if user_chat_id is not None:
            return str(user_chat_id), "private", None

    return None


def telegram_text_from_update(payload: JsonObject) -> str | None:
    callback_query = payload.get("callback_query")
    if isinstance(callback_query, dict):
        data = _read_optional_str(callback_query.get("data"))
        if data is not None:
            return data
    message = _telegram_message_from_update(payload)
    if not isinstance(message, dict):
        return None
    return _read_optional_str(message.get("text"))


def telegram_message_id_from_update(payload: JsonObject) -> str | None:
    message = _telegram_message_from_update(payload)
    if not isinstance(message, dict):
        return None
    message_id = message.get("message_id")
    return str(message_id) if message_id is not None else None


def telegram_message_thread_id_from_update(payload: JsonObject) -> int | None:
    """Return a true Telegram topic for replies, never as binding identity."""
    message = _telegram_message_from_update(payload)
    if not isinstance(message, dict):
        return None
    message_thread_id = message.get("message_thread_id")
    if isinstance(message_thread_id, bool) or not isinstance(message_thread_id, int):
        return None
    if message_thread_id <= 0 or message.get("is_topic_message") is not True:
        return None
    chat = message.get("chat")
    if not isinstance(chat, dict):
        return None
    chat_type = _read_optional_str(chat.get("type"))
    if chat_type == "private":
        return message_thread_id
    if chat_type in {"group", "supergroup"} and chat.get("is_forum") is True:
        # Telegram's General forum topic uses thread id 1, but normal sends to
        # that topic omit message_thread_id. Preserve the original update for
        # runtimes; this helper only selects the target for core replies.
        if message_thread_id == 1:
            return None
        return message_thread_id
    return None


def telegram_direct_messages_topic_id_from_update(payload: JsonObject) -> int | None:
    """Return a channel direct-message topic for replies, never as binding identity."""
    message = _telegram_message_from_update(payload)
    if not isinstance(message, dict):
        return None
    chat = message.get("chat")
    if (
        not isinstance(chat, dict)
        or _read_optional_str(chat.get("type")) != "supergroup"
        or chat.get("is_direct_messages") is not True
    ):
        return None
    topic = message.get("direct_messages_topic")
    if not isinstance(topic, dict):
        return None
    topic_id = topic.get("topic_id")
    if isinstance(topic_id, bool) or not isinstance(topic_id, int) or topic_id <= 0:
        return None
    return topic_id


def telegram_event_id_from_update(payload: JsonObject) -> str | None:
    update_id = payload.get("update_id")
    if isinstance(update_id, (int, str)) and str(update_id).strip():
        return f"update:{str(update_id).strip()}"
    callback_query = payload.get("callback_query")
    if isinstance(callback_query, dict):
        callback_id = callback_query.get("id")
        if isinstance(callback_id, (int, str)) and str(callback_id).strip():
            return f"callback:{str(callback_id).strip()}"
    message_id = telegram_message_id_from_update(payload)
    return f"message:{message_id}" if message_id is not None else None


def telegram_event_scope_from_update(payload: JsonObject) -> str:
    update_id = payload.get("update_id")
    if isinstance(update_id, (int, str)) and str(update_id).strip():
        return PROVIDER_EVENT_SCOPE_ACCOUNT
    callback_query = payload.get("callback_query")
    if isinstance(callback_query, dict):
        callback_id = callback_query.get("id")
        if isinstance(callback_id, (int, str)) and str(callback_id).strip():
            return PROVIDER_EVENT_SCOPE_ACCOUNT
    return PROVIDER_EVENT_SCOPE_CHAT


def telegram_external_user_id_from_update(payload: JsonObject) -> str | None:
    # The Bot API server defines a channel direct-message topic id as the
    # topic user's id. Use that stable topic owner instead of the immediate
    # message sender so one chat-level Binding cannot cross DM actors.
    direct_messages_topic_id = telegram_direct_messages_topic_id_from_update(payload)
    if direct_messages_topic_id is not None:
        return str(direct_messages_topic_id)

    callback_query = payload.get("callback_query")
    if isinstance(callback_query, dict):
        actor_id = _dict_identifier(callback_query.get("from"), "id")
        if actor_id is not None:
            return actor_id

    message = _telegram_message_from_update(payload)
    if isinstance(message, dict):
        actor_id = _dict_identifier(message.get("from"), "id") or _dict_identifier(
            message.get("sender_chat"),
            "id",
        )
        if actor_id is not None:
            return actor_id

    for update_key in (
        "my_chat_member",
        "chat_member",
        "chat_join_request",
        "message_reaction",
        "business_message",
        "edited_business_message",
    ):
        update_value = payload.get(update_key)
        if not isinstance(update_value, dict):
            continue
        actor_id = (
            _dict_identifier(update_value.get("from"), "id")
            or _dict_identifier(update_value.get("user"), "id")
            or _dict_identifier(update_value.get("sender_chat"), "id")
        )
        if actor_id is not None:
            return actor_id

    chat = telegram_chat_from_update(payload)
    if chat is not None and chat[1] == "private":
        return chat[0]
    return None


def _telegram_message_from_update(payload: JsonObject) -> JsonObject | None:
    message = payload.get("message") or payload.get("edited_message")
    if isinstance(message, dict):
        return message
    callback_query = payload.get("callback_query")
    if isinstance(callback_query, dict):
        callback_message = callback_query.get("message")
        if isinstance(callback_message, dict):
            return callback_message
    return None


def _telegram_chat_object_from_update(payload: JsonObject) -> JsonObject | None:
    message = _telegram_message_from_update(payload)
    if isinstance(message, dict):
        message_chat = message.get("chat")
        if isinstance(message_chat, dict):
            return message_chat

    for update_key in (
        "channel_post",
        "edited_channel_post",
        "my_chat_member",
        "chat_member",
        "chat_join_request",
        "chat_boost",
        "removed_chat_boost",
        "message_reaction",
        "message_reaction_count",
        "business_message",
        "edited_business_message",
        "deleted_business_messages",
    ):
        update_value = payload.get(update_key)
        if isinstance(update_value, dict):
            update_chat = update_value.get("chat")
            if isinstance(update_chat, dict):
                return update_chat

    return None


async def record_inbound_message(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    binding: ChannelBinding | None,
    external_chat_id: str,
    provider_message_id: str | None,
    text: str | None,
    payload: JsonObject,
    provider_event_id: str | None = None,
    provider_event_scope: str = PROVIDER_EVENT_SCOPE_CHAT,
) -> ChannelMessage:
    message, _created = await _record_inbound_message_with_status(
        db,
        account=account,
        binding=binding,
        external_chat_id=external_chat_id,
        provider_message_id=provider_message_id,
        text=text,
        payload=payload,
        provider_event_id=provider_event_id,
        provider_event_scope=provider_event_scope,
    )
    return message


async def _record_inbound_message_with_status(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    binding: ChannelBinding | None,
    external_chat_id: str,
    provider_message_id: str | None,
    text: str | None,
    payload: JsonObject,
    provider_event_id: str | None = None,
    provider_event_scope: str = PROVIDER_EVENT_SCOPE_CHAT,
) -> tuple[ChannelMessage, bool]:
    event_id = provider_event_id or provider_message_id
    if event_id is not None:
        existing = await _find_existing_inbound_message(
            db,
            account=account,
            external_chat_id=external_chat_id,
            provider_event_id=event_id,
            provider_event_scope=provider_event_scope,
        )
        if existing is not None:
            return existing, False
    owner_user_id = require_channel_tenant_user_id(
        account,
        tenant_user_id=binding.user_id if binding is not None else None,
    )
    message = ChannelMessage(
        account_id=account.id,
        bot_agent_link_id=binding.bot_agent_link_id if binding else None,
        binding_id=binding.id if binding else None,
        user_id=owner_user_id,
        direction=MESSAGE_DIRECTION_INBOUND,
        external_chat_id=external_chat_id,
        provider_message_id=provider_message_id,
        provider_event_id=event_id,
        provider_event_scope=provider_event_scope,
        text=text,
        payload=payload,
    )
    try:
        async with db.begin_nested():
            db.add(message)
            await db.flush()
    except IntegrityError:
        existing = await _find_existing_inbound_message(
            db,
            account=account,
            external_chat_id=external_chat_id,
            provider_event_id=event_id,
            provider_event_scope=provider_event_scope,
        )
        if existing is not None:
            return existing, False
        raise
    inbound_messages.labels(channel=account.provider).inc()
    return message, True


async def _find_existing_inbound_message(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    external_chat_id: str,
    provider_event_id: str | None,
    provider_event_scope: str,
) -> ChannelMessage | None:
    if provider_event_id is None:
        return None
    filters = [
        ChannelMessage.account_id == account.id,
        ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
        ChannelMessage.provider_event_scope == provider_event_scope,
        ChannelMessage.provider_event_id == provider_event_id,
    ]
    if provider_event_scope == PROVIDER_EVENT_SCOPE_CHAT:
        filters.append(ChannelMessage.external_chat_id == external_chat_id)
    result = await db.execute(
        select(ChannelMessage)
        .where(*filters)
        .order_by(ChannelMessage.created_at.asc(), ChannelMessage.id.asc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def find_existing_inbound_provider_event(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    external_chat_id: str,
    provider_event_id: str | None,
    provider_event_scope: str = PROVIDER_EVENT_SCOPE_CHAT,
) -> ChannelMessage | None:
    if provider_event_id is None:
        return None
    filters = [
        ChannelMessage.account_id == account.id,
        ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
        ChannelMessage.provider_event_scope == provider_event_scope,
        ChannelMessage.provider_event_id == provider_event_id,
    ]
    if provider_event_scope == PROVIDER_EVENT_SCOPE_CHAT:
        filters.append(ChannelMessage.external_chat_id == external_chat_id)
    result = await db.execute(
        select(ChannelMessage)
        .where(*filters)
        .order_by(ChannelMessage.created_at.asc(), ChannelMessage.id.asc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def channel_control_command_event_was_handled(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    external_chat_id: str,
    provider_event_id: str | None,
    provider_event_scope: str = PROVIDER_EVENT_SCOPE_CHAT,
    command: ChannelControlCommand | None,
) -> bool:
    """Serialize control commands and reject a previously handled provider event."""
    if provider_event_id is None or command is None:
        return False
    # The same transaction-level scope lock is acquired again by
    # resolve_inbound_binding. Taking it before the event lookup closes the
    # replay race where a duplicate unpair waits behind a new pair and then
    # archives the replacement binding.
    await lock_channel_binding_identity(
        db,
        account_id=account.id,
        external_chat_id=external_chat_id,
    )
    existing = await find_existing_inbound_provider_event(
        db,
        account=account,
        external_chat_id=external_chat_id,
        provider_event_id=provider_event_id,
        provider_event_scope=provider_event_scope,
    )
    return existing is not None


async def consume_pending_inbound_messages_for_bindings(
    db: AsyncSession,
    *,
    bindings: list[ChannelBinding],
) -> int:
    """Revoke queued adapter delivery when binding authority is archived."""
    binding_ids = {binding.id for binding in bindings}
    if not binding_ids:
        return 0
    result = await db.execute(
        select(ChannelMessage)
        .where(
            ChannelMessage.binding_id.in_(binding_ids),
            ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
            ChannelMessage.delivered_at.is_(None),
        )
        .with_for_update()
    )
    messages = list(result.scalars().all())
    delivered_at = datetime.now(UTC)
    for message in messages:
        message.delivered_at = delivered_at
    await db.flush()
    return len(messages)


async def record_inbound_messages_for_bindings(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    binding_result: InboundBindingResult,
    external_chat_id: str,
    provider_message_id: str | None,
    text: str | None,
    payload: JsonObject,
    provider_event_id: str | None = None,
    provider_event_scope: str = PROVIDER_EVENT_SCOPE_CHAT,
    suppress_duplicate_event: bool = False,
    require_active_authority: bool = False,
) -> list[tuple[ChannelMessage, ChannelBinding | None]]:
    target_bindings: tuple[ChannelBinding | None, ...]
    if binding_result.bindings:
        target_bindings = binding_result.bindings
    elif binding_result.binding is not None:
        target_bindings = (binding_result.binding,)
    else:
        target_bindings = (None,)

    if (
        target_bindings == (None,)
        and account.visibility == CHANNEL_VISIBILITY_PUBLIC
        and account.user_id is None
    ):
        # Unbound provider traffic has no tenant authority. Keep platform
        # inventory free of fake tenant-owned Message rows.
        return []

    if require_active_authority:
        bound_targets = tuple(binding for binding in target_bindings if binding is not None)
        if bound_targets:
            active_bindings = await _lock_active_inbound_bindings(
                db,
                account=account,
                bindings=bound_targets,
            )
            # Preserve the provider event as unbound idempotency evidence when
            # authority retired after resolution. Never leave late pending work
            # attached to an archived Binding.
            if active_bindings is None:
                for binding in bound_targets:
                    await record_inactive_bot_agent_link_event(
                        db,
                        account=account,
                        binding=binding,
                    )
                target_bindings = (None,)
            else:
                target_bindings = active_bindings

    messages: list[tuple[ChannelMessage, ChannelBinding | None]] = []
    for binding in target_bindings:
        message, created = await _record_inbound_message_with_status(
            db,
            account=account,
            binding=binding,
            external_chat_id=external_chat_id,
            provider_message_id=provider_message_id,
            text=text,
            payload=payload,
            provider_event_id=provider_event_id,
            provider_event_scope=provider_event_scope,
        )
        if suppress_duplicate_event and not created:
            return []
        messages.append((message, binding))
    if binding_result.command_handled:
        _mark_inbound_messages_delivered(messages)
    return messages


async def _lock_active_inbound_bindings(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bindings: tuple[ChannelBinding, ...],
) -> tuple[ChannelBinding, ...] | None:
    expected = {binding.id: (binding.bot_agent_link_id, binding.user_id) for binding in bindings}
    authority_filters = [
        and_(
            ChannelBinding.id == binding_id,
            ChannelBinding.bot_agent_link_id == bot_agent_link_id,
            ChannelBinding.user_id == user_id,
        )
        for binding_id, (bot_agent_link_id, user_id) in expected.items()
    ]
    result = await db.execute(
        select(ChannelBinding)
        .join(
            ChannelBotAgentLink,
            and_(
                ChannelBotAgentLink.id == ChannelBinding.bot_agent_link_id,
                ChannelBotAgentLink.account_id == ChannelBinding.account_id,
            ),
        )
        .join(ChannelAccount, ChannelAccount.id == ChannelBinding.account_id)
        .where(
            or_(*authority_filters),
            ChannelBinding.account_id == account.id,
            ChannelBinding.status == BINDING_STATUS_ACTIVE,
            ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
            ChannelBotAgentLink.archived_at.is_(None),
            ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
            ChannelAccount.archived_at.is_(None),
        )
        .order_by(ChannelBinding.id)
        .execution_options(populate_existing=True)
        # Account and Link retirement archive their Bindings in the same
        # transaction. A shared Binding lease therefore linearizes every
        # authority retirement without inverting the parent lock order.
        .with_for_update(read=True, of=ChannelBinding)
    )
    active_bindings = tuple(result.scalars().all())
    if len(active_bindings) != len(expected):
        return None
    return active_bindings


async def record_inactive_bot_agent_link_event(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    binding: ChannelBinding | None,
    link: ChannelBotAgentLink | None = None,
) -> None:
    if binding is None:
        return
    if link is None:
        link = await db.get(ChannelBotAgentLink, binding.bot_agent_link_id)
    if (
        link is not None
        and link.status == BOT_AGENT_LINK_STATUS_ACTIVE
        and link.archived_at is None
    ):
        return
    if link is None:
        reason = "link_missing"
    elif link.archived_at is not None:
        reason = "link_archived"
    else:
        reason = "link_disabled"
    await record_channel_debug_event(
        db,
        account=account,
        user_id=binding.user_id,
        provider=account.provider,
        direction=MESSAGE_DIRECTION_INBOUND,
        stage="agent_webhook",
        outcome="failure",
        external_chat_id=binding.external_chat_id,
        error="bot agent link inactive",
        details={
            "reason": reason,
            "binding_id": str(binding.id),
            "bot_agent_link_id": str(binding.bot_agent_link_id),
            "bot_agent_link_status": link.status if link is not None else None,
        },
    )


def _mark_inbound_messages_delivered(
    messages: list[tuple[ChannelMessage, ChannelBinding | None]],
    *,
    delivered_at: datetime | None = None,
) -> datetime:
    delivered_at = delivered_at or datetime.now(UTC)
    for message, _binding in messages:
        message.delivered_at = delivered_at
    return delivered_at


async def record_channel_agent_reference(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    ref_kind: str,
    ref_value: str,
    binding: ChannelBinding | None = None,
    message: ChannelMessage | None = None,
    bot_agent_link_id: UUID | None = None,
    metadata: JsonObject | None = None,
) -> ChannelAgentReference:
    if binding is not None and binding.account_id != account.id:
        raise ValueError("channel binding does not belong to channel account")
    if message is not None and message.account_id != account.id:
        raise ValueError("channel message does not belong to channel account")

    link_ids = {
        link_id
        for link_id in (
            binding.bot_agent_link_id if binding is not None else None,
            message.bot_agent_link_id if message is not None else None,
            bot_agent_link_id,
        )
        if link_id is not None
    }
    if len(link_ids) > 1:
        raise ValueError("channel reference link context does not match")
    scoped_link_id = next(iter(link_ids), None)

    owner_user_ids = {
        owner_user_id
        for owner_user_id in (
            binding.user_id if binding is not None else None,
            message.user_id if message is not None else None,
        )
        if owner_user_id is not None
    }
    if len(owner_user_ids) > 1:
        raise ValueError("channel reference owner context does not match")
    owner_user_id = next(iter(owner_user_ids), None)

    if bot_agent_link_id is not None:
        link_user_id = (
            await db.execute(
                select(ChannelBotAgentLink.user_id).where(
                    ChannelBotAgentLink.id == bot_agent_link_id,
                    ChannelBotAgentLink.account_id == account.id,
                )
            )
        ).scalar_one_or_none()
        if link_user_id is None:
            raise ValueError("bot agent link does not belong to channel account")
        if owner_user_ids and link_user_id != owner_user_id:
            raise ValueError("channel reference owner context does not match")
        if not owner_user_ids:
            owner_user_id = link_user_id

    owner_user_id = require_channel_tenant_user_id(
        account,
        tenant_user_id=owner_user_id,
    )

    if scoped_link_id is None:
        # PostgreSQL NULLs do not conflict under the Link-scoped constraint.
        # Lock the stable parent so all service writes share one serialization point.
        locked_account_id = (
            await db.execute(
                select(ChannelAccount.id).where(ChannelAccount.id == account.id).with_for_update()
            )
        ).scalar_one_or_none()
        if locked_account_id is None:
            raise ValueError("channel account does not exist")

        existing = (
            await db.execute(
                select(ChannelAgentReference)
                .where(
                    ChannelAgentReference.account_id == account.id,
                    ChannelAgentReference.bot_agent_link_id.is_(None),
                    ChannelAgentReference.ref_kind == ref_kind,
                    ChannelAgentReference.ref_value == ref_value,
                )
                .order_by(
                    ChannelAgentReference.updated_at.desc(),
                    ChannelAgentReference.created_at.desc(),
                    ChannelAgentReference.id.desc(),
                )
                .limit(1)
            )
        ).scalar_one_or_none()
        if existing is not None:
            existing.binding_id = binding.id if binding else existing.binding_id
            existing.message_id = message.id if message else existing.message_id
            existing.metadata_ = metadata or existing.metadata_
            await db.flush()
            return existing

        reference = ChannelAgentReference(
            account_id=account.id,
            bot_agent_link_id=None,
            binding_id=binding.id if binding else None,
            message_id=message.id if message else None,
            user_id=owner_user_id,
            provider=account.provider,
            ref_kind=ref_kind,
            ref_value=ref_value,
            metadata_=metadata,
        )
        db.add(reference)
        await db.flush()
        return reference

    insert_statement = postgresql_insert(ChannelAgentReference).values(
        id=uuid4(),
        account_id=account.id,
        bot_agent_link_id=scoped_link_id,
        binding_id=binding.id if binding else None,
        message_id=message.id if message else None,
        user_id=owner_user_id,
        provider=account.provider,
        ref_kind=ref_kind,
        ref_value=ref_value,
        metadata_=metadata,
    )
    reference_table = ChannelAgentReference.__table__
    update_values = {
        "binding_id": (
            insert_statement.excluded.binding_id
            if binding is not None
            else reference_table.c.binding_id
        ),
        "message_id": (
            insert_statement.excluded.message_id
            if message is not None
            else reference_table.c.message_id
        ),
        "metadata": insert_statement.excluded.metadata if metadata else reference_table.c.metadata,
    }
    upsert_statement = insert_statement.on_conflict_do_update(
        constraint="uq_channel_agent_references_account_link_kind_value",
        set_={**update_values, "user_id": insert_statement.excluded.user_id},
    )
    result = await db.execute(
        upsert_statement.returning(ChannelAgentReference).execution_options(populate_existing=True)
    )
    return result.scalar_one()


async def channel_agent_reference_exists(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    ref_kind: str,
    ref_value: str,
    bot_agent_link_id: UUID | None = None,
) -> bool:
    filters = [
        ChannelAgentReference.account_id == account.id,
        (
            ChannelAgentReference.bot_agent_link_id == bot_agent_link_id
            if bot_agent_link_id is not None
            else ChannelAgentReference.bot_agent_link_id.is_(None)
        ),
        ChannelAgentReference.ref_kind == ref_kind,
        ChannelAgentReference.ref_value == ref_value,
    ]
    result = await db.execute(select(ChannelAgentReference.id).where(*filters).limit(1))
    return result.scalar_one_or_none() is not None


async def get_channel_agent_reference(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    ref_kind: str,
    ref_value: str,
    bot_agent_link_id: UUID | None = None,
) -> ChannelAgentReference | None:
    filters = [
        ChannelAgentReference.account_id == account.id,
        (
            ChannelAgentReference.bot_agent_link_id == bot_agent_link_id
            if bot_agent_link_id is not None
            else ChannelAgentReference.bot_agent_link_id.is_(None)
        ),
        ChannelAgentReference.ref_kind == ref_kind,
        ChannelAgentReference.ref_value == ref_value,
    ]
    result = await db.execute(
        select(ChannelAgentReference)
        .where(*filters)
        .order_by(
            ChannelAgentReference.updated_at.desc(),
            ChannelAgentReference.created_at.desc(),
            ChannelAgentReference.id.desc(),
        )
        .limit(1)
    )
    return result.scalar_one_or_none()


async def record_telegram_update_references(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    binding: ChannelBinding | None,
    message: ChannelMessage,
    payload: JsonObject,
) -> None:
    if account.provider != CHANNEL_PROVIDER_TELEGRAM or binding is None:
        return
    if message.provider_message_id is not None:
        await record_channel_agent_reference(
            db,
            account=account,
            binding=binding,
            message=message,
            ref_kind=TELEGRAM_REF_MESSAGE_ID,
            ref_value=telegram_message_reference_value(
                message.external_chat_id,
                message.provider_message_id,
            ),
        )
    for ref_kind, ref_value in _telegram_update_references(payload):
        await record_channel_agent_reference(
            db,
            account=account,
            binding=binding,
            message=message,
            ref_kind=ref_kind,
            ref_value=ref_value,
        )


def telegram_message_reference_value(chat_id: str, message_id: str | int) -> str:
    return json.dumps([str(chat_id), str(message_id)], separators=(",", ":"))


def _telegram_update_references(payload: JsonObject) -> set[tuple[str, str]]:
    references: set[tuple[str, str]] = set()
    callback_query = payload.get("callback_query")
    if isinstance(callback_query, dict):
        callback_id = callback_query.get("id")
        if isinstance(callback_id, str) and callback_id:
            references.add((TELEGRAM_REF_CALLBACK_QUERY_ID, callback_id))

    for file_id in telegram_file_ids(payload):
        references.add((TELEGRAM_REF_FILE_ID, file_id))
    for node in _walk_json_dicts(payload):
        file_path = node.get("file_path")
        if isinstance(file_path, str) and file_path:
            references.add((TELEGRAM_REF_FILE_PATH, file_path))
    return references


def telegram_file_ids(payload: JsonValue) -> set[str]:
    file_ids: set[str] = set()
    for node in _walk_json_dicts(payload):
        file_id = node.get("file_id")
        if isinstance(file_id, str) and file_id:
            file_ids.add(file_id)
    return file_ids


def _walk_json_dicts(value: JsonValue) -> list[JsonObject]:
    nodes: list[JsonObject] = []
    stack = [value]
    while stack:
        current = stack.pop()
        if isinstance(current, dict):
            nodes.append(current)
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)
    return nodes


async def record_discord_interaction_references(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    binding: ChannelBinding | None,
    message: ChannelMessage,
    payload: JsonObject,
) -> None:
    data = _discord_event_data(payload)
    interaction_id = _read_optional_str(data.get("id"))
    token = _read_optional_str(data.get("token"))
    if interaction_id is None or token is None:
        return
    application_id = _read_optional_str(data.get("application_id"))
    metadata: JsonObject | None = (
        {"application_id": application_id} if application_id is not None else None
    )
    await record_channel_agent_reference(
        db,
        account=account,
        binding=binding,
        message=message,
        ref_kind=DISCORD_REF_INTERACTION_ID_TOKEN,
        ref_value=f"{interaction_id}:{token}",
        metadata=metadata,
    )
    await record_channel_agent_reference(
        db,
        account=account,
        binding=binding,
        message=message,
        ref_kind=DISCORD_REF_INTERACTION_TOKEN,
        ref_value=token,
        metadata=metadata,
    )


def telegram_update_id(message: ChannelMessage) -> int:
    payload = message.payload if isinstance(message.payload, dict) else {}
    update_id = payload.get("update_id")
    if isinstance(update_id, int):
        return update_id
    if isinstance(update_id, str) and update_id.isdigit():
        return int(update_id)
    return int(message.inbox_sequence)


def telegram_update_payload(message: ChannelMessage) -> JsonObject:
    payload = dict(message.payload) if isinstance(message.payload, dict) else {}
    payload.setdefault("update_id", telegram_update_id(message))
    _virtualize_telegram_direct_message_topics(payload)
    return payload


def _virtualize_telegram_direct_message_topics(payload: JsonObject) -> None:
    for container_key in ("message", "edited_message"):
        value = payload.get(container_key)
        if isinstance(value, dict):
            payload[container_key] = _virtualized_telegram_direct_message(value)
    callback_query = payload.get("callback_query")
    if isinstance(callback_query, dict):
        callback_message = callback_query.get("message")
        if isinstance(callback_message, dict):
            callback_copy: JsonObject = {key: value for key, value in callback_query.items()}
            callback_copy["message"] = _virtualized_telegram_direct_message(callback_message)
            payload["callback_query"] = callback_copy


def _virtualized_telegram_direct_message(message: JsonObject) -> JsonObject:
    chat = message.get("chat")
    topic = message.get("direct_messages_topic")
    if (
        not isinstance(chat, dict)
        or chat.get("type") != "supergroup"
        or chat.get("is_direct_messages") is not True
        or not isinstance(topic, dict)
    ):
        return message
    topic_id = topic.get("topic_id")
    if isinstance(topic_id, bool) or not isinstance(topic_id, int) or topic_id <= 0:
        return message
    projected = dict(message)
    projected.setdefault("message_thread_id", topic_id)
    projected["is_topic_message"] = True
    return projected


async def dequeue_telegram_updates(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID | None = None,
    offset: int | None,
    limit: int,
    allowed_updates: set[str] | None = None,
) -> list[JsonObject]:
    now = datetime.now(UTC)
    filters = [
        ChannelMessage.account_id == account.id,
        ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
        ChannelMessage.binding_id.is_not(None),
        ChannelMessage.delivered_at.is_(None),
    ]
    if bot_agent_link_id is not None:
        filters.append(ChannelMessage.bot_agent_link_id == bot_agent_link_id)
    # Telegram's hosted Bot API retains incoming updates for no longer than
    # 24 hours. A managed polling client must not see a more durable history
    # merely because Clawdi stores its inbox in PostgreSQL.
    await db.execute(
        update(ChannelMessage)
        .where(
            *filters,
            ChannelMessage.created_at < now - TELEGRAM_UPDATE_RETENTION,
        )
        .values(delivered_at=now)
        .execution_options(synchronize_session=False)
    )
    result = await db.execute(
        select(ChannelMessage)
        .join(
            ChannelBinding,
            and_(
                ChannelBinding.id == ChannelMessage.binding_id,
                ChannelBinding.account_id == ChannelMessage.account_id,
                ChannelBinding.bot_agent_link_id == ChannelMessage.bot_agent_link_id,
                ChannelBinding.user_id == ChannelMessage.user_id,
            ),
        )
        .join(
            ChannelBotAgentLink,
            and_(
                ChannelBotAgentLink.id == ChannelMessage.bot_agent_link_id,
                ChannelBotAgentLink.account_id == ChannelMessage.account_id,
            ),
        )
        .join(ChannelAccount, ChannelAccount.id == ChannelMessage.account_id)
        .where(*filters)
        .where(
            ChannelBinding.status == BINDING_STATUS_ACTIVE,
            ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
            ChannelBotAgentLink.archived_at.is_(None),
            ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
            ChannelAccount.archived_at.is_(None),
        )
        .order_by(ChannelMessage.inbox_sequence, ChannelMessage.created_at)
        .limit(max(limit * 4, limit))
        .with_for_update(
            read=True,
            of=ChannelBinding,
        )
    )
    updates: list[JsonObject] = []
    for message in result.scalars().all():
        update_payload = telegram_update_payload(message)
        update_id = telegram_update_id(message)
        if offset is not None and update_id < offset:
            message.delivered_at = now
            continue
        if allowed_updates and not _telegram_update_allowed(
            update_payload,
            allowed_updates,
        ):
            message.delivered_at = now
            continue
        updates.append(update_payload)
        if len(updates) >= limit:
            break
    await db.flush()
    return updates


async def wait_for_telegram_updates(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID | None = None,
    offset: int | None,
    limit: int,
    allowed_updates: set[str] | None = None,
    timeout_seconds: int | float | None = None,
    poll_interval_seconds: float | None = None,
) -> list[JsonObject]:
    timeout = max(0.0, min(float(timeout_seconds or 0), 30.0))
    poll_interval = _channel_long_poll_interval(poll_interval_seconds)
    deadline = monotonic() + timeout
    while True:
        updates = await dequeue_telegram_updates(
            db,
            account=account,
            bot_agent_link_id=bot_agent_link_id,
            offset=offset,
            limit=limit,
            allowed_updates=allowed_updates,
        )
        if updates or timeout == 0 or monotonic() >= deadline:
            return updates
        await asyncio.sleep(min(poll_interval, max(0.0, deadline - monotonic())))


async def dequeue_channel_inbox_events(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID | None = None,
    after_sequence: int,
    limit: int,
) -> list[ChannelMessage]:
    filters = [
        ChannelMessage.account_id == account.id,
        ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
        ChannelMessage.binding_id.is_not(None),
        ChannelMessage.delivered_at.is_(None),
        ChannelMessage.inbox_sequence > after_sequence,
    ]
    if bot_agent_link_id is not None:
        filters.append(ChannelMessage.bot_agent_link_id == bot_agent_link_id)
    result = await db.execute(
        select(ChannelMessage)
        .where(*filters)
        .order_by(ChannelMessage.inbox_sequence, ChannelMessage.created_at)
        .limit(max(0, limit))
    )
    return list(result.scalars().all())


async def ack_channel_inbox_events(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID | None = None,
    through_sequence: int,
) -> int:
    filters = [
        ChannelMessage.account_id == account.id,
        ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
        ChannelMessage.binding_id.is_not(None),
        ChannelMessage.delivered_at.is_(None),
        ChannelMessage.inbox_sequence <= through_sequence,
    ]
    if bot_agent_link_id is not None:
        filters.append(ChannelMessage.bot_agent_link_id == bot_agent_link_id)
    result = await db.execute(select(ChannelMessage).where(*filters))
    messages = list(result.scalars().all())
    now = datetime.now(UTC)
    for message in messages:
        message.delivered_at = now
    await db.flush()
    return len(messages)


async def ack_discord_gateway_messages(
    db: AsyncSession,
    *,
    account_id: UUID,
    bot_agent_link_id: UUID,
    message_ids: list[UUID],
) -> int:
    """Acknowledge only durable messages dispatched by one Gateway session."""
    if not message_ids:
        return 0
    result = await db.execute(
        select(ChannelMessage)
        .where(
            ChannelMessage.id.in_(message_ids),
            ChannelMessage.account_id == account_id,
            ChannelMessage.bot_agent_link_id == bot_agent_link_id,
            ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
            ChannelMessage.delivered_at.is_(None),
        )
        .with_for_update(of=ChannelMessage)
    )
    messages = list(result.scalars().all())
    delivered_at = datetime.now(UTC)
    for message in messages:
        message.delivered_at = delivered_at
    await db.flush()
    return len(messages)


async def drain_channel_inbox(
    db: AsyncSession,
    *,
    account: ChannelAccount,
) -> int:
    result = await db.execute(
        select(ChannelMessage).where(
            ChannelMessage.account_id == account.id,
            ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
            ChannelMessage.binding_id.is_not(None),
            ChannelMessage.delivered_at.is_(None),
        )
    )
    messages = list(result.scalars().all())
    now = datetime.now(UTC)
    for message in messages:
        message.delivered_at = now
    await db.flush()
    return len(messages)


async def prune_channel_messages(
    db: AsyncSession,
    *,
    now: datetime | None = None,
    delivered_retention: timedelta | None = None,
    unbound_retention: timedelta | None = None,
    limit: int | None = None,
) -> int:
    batch_limit = max(
        0,
        settings.channel_message_cleanup_batch_size if limit is None else limit,
    )
    if batch_limit == 0:
        return 0
    current_time = now or datetime.now(UTC)
    delivered_cutoff = current_time - (
        delivered_retention
        if delivered_retention is not None
        else timedelta(days=settings.channel_message_retention_days)
    )
    unbound_cutoff = current_time - (
        unbound_retention
        if unbound_retention is not None
        else timedelta(hours=settings.channel_unbound_message_retention_hours)
    )
    candidate_limit = batch_limit * CHANNEL_RETENTION_CANDIDATE_MULTIPLIER
    unbound_candidates = (
        select(
            ChannelMessage.id.label("message_id"),
            ChannelMessage.created_at.label("retained_at"),
        )
        .where(
            sql_text("direction = 'inbound' AND binding_id IS NULL"),
            ChannelMessage.created_at < unbound_cutoff,
        )
        .order_by(ChannelMessage.created_at, ChannelMessage.id)
        .limit(candidate_limit)
    )
    delivered_candidates = (
        select(
            ChannelMessage.id.label("message_id"),
            ChannelMessage.delivered_at.label("retained_at"),
        )
        .where(
            ChannelMessage.delivered_at.is_not(None),
            ChannelMessage.delivered_at < delivered_cutoff,
            ~and_(
                ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
                ChannelMessage.binding_id.is_(None),
            ),
        )
        .order_by(ChannelMessage.delivered_at, ChannelMessage.id)
        .limit(candidate_limit)
    )
    terminal_outbound_candidates = (
        select(
            ChannelMessage.id.label("message_id"),
            ChannelDelivery.updated_at.label("retained_at"),
        )
        .select_from(ChannelDelivery)
        .join(ChannelAccount, ChannelAccount.id == ChannelDelivery.account_id)
        .join(ChannelMessage, ChannelMessage.id == ChannelDelivery.message_id)
        .where(
            ChannelMessage.direction == MESSAGE_DIRECTION_OUTBOUND,
            ChannelMessage.delivered_at.is_(None),
            ChannelAccount.provider.in_(CHANNEL_RETENTION_PROVIDERS),
            sql_text("channel_deliveries.status IN ('succeeded', 'failed')"),
            ChannelDelivery.updated_at < delivered_cutoff,
        )
        .order_by(ChannelDelivery.updated_at, ChannelDelivery.id)
        .limit(candidate_limit)
    )
    candidate_rows = union_all(
        unbound_candidates,
        delivered_candidates,
        terminal_outbound_candidates,
    ).subquery()
    candidates = (
        select(
            candidate_rows.c.message_id,
            func.min(candidate_rows.c.retained_at).label("retained_at"),
        )
        .group_by(candidate_rows.c.message_id)
        .subquery()
    )
    result = await db.execute(
        select(ChannelMessage)
        .join(candidates, candidates.c.message_id == ChannelMessage.id)
        .order_by(candidates.c.retained_at, ChannelMessage.id)
        .limit(batch_limit)
        .with_for_update(skip_locked=True, of=ChannelMessage)
    )
    messages = list(result.scalars().all())
    for message in messages:
        await db.delete(message)
    await db.flush()
    return len(messages)


async def expire_stale_telegram_inbox_messages(
    db: AsyncSession,
    *,
    now: datetime | None = None,
    retention: timedelta | None = None,
    limit: int | None = None,
) -> int:
    """Terminally consume Telegram updates outside the provider replay horizon.

    This is delivery expiry, not physical retention deletion. Rows remain
    available for the ordinary delivered-message retention horizon.
    """
    batch_limit = max(
        0,
        settings.channel_message_cleanup_batch_size if limit is None else limit,
    )
    if batch_limit == 0:
        return 0
    current_time = now or datetime.now(UTC)
    cutoff = current_time - (retention or TELEGRAM_UPDATE_RETENTION)
    result = await db.execute(
        select(ChannelMessage)
        .join(ChannelAccount, ChannelAccount.id == ChannelMessage.account_id)
        .where(
            ChannelAccount.provider == CHANNEL_PROVIDER_TELEGRAM,
            ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
            ChannelAccount.archived_at.is_(None),
            ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
            ChannelMessage.binding_id.is_not(None),
            ChannelMessage.delivered_at.is_(None),
            ChannelMessage.created_at < cutoff,
        )
        .order_by(ChannelMessage.created_at, ChannelMessage.id)
        .limit(batch_limit)
        .with_for_update(skip_locked=True, of=ChannelMessage)
    )
    messages = list(result.scalars().all())
    for message in messages:
        message.delivered_at = current_time
    await db.flush()
    return len(messages)


async def prune_channel_debug_events(
    db: AsyncSession,
    *,
    now: datetime | None = None,
    retention: timedelta | None = None,
    limit: int | None = None,
) -> int:
    batch_limit = max(
        0,
        settings.channel_message_cleanup_batch_size if limit is None else limit,
    )
    if batch_limit == 0:
        return 0
    current_time = now or datetime.now(UTC)
    cutoff = current_time - (
        retention
        if retention is not None
        else timedelta(days=settings.channel_message_retention_days)
    )
    result = await db.execute(
        select(ChannelDebugEvent)
        .where(
            sql_text("channel_debug_events.provider IN ('telegram', 'discord', 'whatsapp')"),
            ChannelDebugEvent.created_at < cutoff,
        )
        .order_by(ChannelDebugEvent.created_at, ChannelDebugEvent.id)
        .limit(batch_limit)
        .with_for_update(skip_locked=True, of=ChannelDebugEvent)
    )
    events = list(result.scalars().all())
    for event in events:
        await db.delete(event)
    await db.flush()
    return len(events)


async def prune_channel_pair_codes(
    db: AsyncSession,
    *,
    now: datetime | None = None,
    retention: timedelta | None = None,
    limit: int | None = None,
) -> int:
    batch_limit = max(
        0,
        settings.channel_message_cleanup_batch_size if limit is None else limit,
    )
    if batch_limit == 0:
        return 0
    current_time = now or datetime.now(UTC)
    cutoff = current_time - (
        retention
        if retention is not None
        else timedelta(hours=settings.channel_unbound_message_retention_hours)
    )
    candidate_limit = batch_limit * CHANNEL_RETENTION_CANDIDATE_MULTIPLIER
    terminal_candidates = (
        select(
            ChannelPairCode.id.label("pair_code_id"),
            ChannelPairCode.updated_at.label("retained_at"),
        )
        .select_from(ChannelPairCode)
        .join(ChannelAccount, ChannelAccount.id == ChannelPairCode.account_id)
        .where(
            ChannelAccount.provider.in_(CHANNEL_RETENTION_PROVIDERS),
            sql_text("channel_pair_codes.status IN ('claimed', 'revoked')"),
            ChannelPairCode.updated_at < cutoff,
        )
        .order_by(ChannelPairCode.updated_at, ChannelPairCode.id)
        .limit(candidate_limit)
    )
    expired_candidates = (
        select(
            ChannelPairCode.id.label("pair_code_id"),
            ChannelPairCode.expires_at.label("retained_at"),
        )
        .select_from(ChannelPairCode)
        .join(ChannelAccount, ChannelAccount.id == ChannelPairCode.account_id)
        .where(
            ChannelAccount.provider.in_(CHANNEL_RETENTION_PROVIDERS),
            sql_text("channel_pair_codes.status = 'pending'"),
            ChannelPairCode.expires_at < cutoff,
        )
        .order_by(ChannelPairCode.expires_at, ChannelPairCode.id)
        .limit(candidate_limit)
    )
    candidate_rows = union_all(terminal_candidates, expired_candidates).subquery()
    candidates = (
        select(
            candidate_rows.c.pair_code_id,
            func.min(candidate_rows.c.retained_at).label("retained_at"),
        )
        .group_by(candidate_rows.c.pair_code_id)
        .subquery()
    )
    result = await db.execute(
        select(ChannelPairCode)
        .join(candidates, candidates.c.pair_code_id == ChannelPairCode.id)
        .order_by(candidates.c.retained_at, ChannelPairCode.id)
        .limit(batch_limit)
        .with_for_update(skip_locked=True, of=ChannelPairCode)
    )
    pair_codes = list(result.scalars().all())
    for pair_code in pair_codes:
        await db.delete(pair_code)
    await db.flush()
    return len(pair_codes)


async def prune_channel_agent_references(
    db: AsyncSession,
    *,
    now: datetime | None = None,
    retention: timedelta | None = None,
    limit: int | None = None,
) -> int:
    batch_limit = max(
        0,
        settings.channel_message_cleanup_batch_size if limit is None else limit,
    )
    if batch_limit == 0:
        return 0
    current_time = now or datetime.now(UTC)
    inactive_cutoff = current_time - (
        retention
        if retention is not None
        else timedelta(days=settings.channel_message_retention_days)
    )
    secret_cutoff = current_time - DISCORD_INTERACTION_SECRET_RETENTION
    candidate_limit = batch_limit * CHANNEL_RETENTION_CANDIDATE_MULTIPLIER
    inactive_link_has_expired_reference = exists(
        select(ChannelAgentReference.id).where(
            ChannelAgentReference.bot_agent_link_id == ChannelBotAgentLink.id,
            sql_text("channel_agent_references.provider IN ('telegram', 'discord')"),
            ChannelAgentReference.updated_at < inactive_cutoff,
        )
    )
    inactive_link_ids = tuple(
        (
            await db.scalars(
                select(ChannelBotAgentLink.id)
                .where(
                    sql_text("status <> 'active' OR archived_at IS NOT NULL"),
                    inactive_link_has_expired_reference,
                )
                .order_by(ChannelBotAgentLink.id)
                .limit(candidate_limit)
            )
        ).all()
    )
    secret_candidates = (
        select(
            ChannelAgentReference.id.label("reference_id"),
            ChannelAgentReference.created_at.label("retained_at"),
        )
        .where(
            sql_text(
                "channel_agent_references.provider = 'discord' AND "
                "channel_agent_references.ref_kind IN "
                "('discord_interaction_id_token', 'discord_interaction_token')"
            ),
            ChannelAgentReference.created_at < secret_cutoff,
        )
        .order_by(ChannelAgentReference.created_at, ChannelAgentReference.id)
        .limit(candidate_limit)
    )
    orphaned_candidates = (
        select(
            ChannelAgentReference.id.label("reference_id"),
            ChannelAgentReference.updated_at.label("retained_at"),
        )
        .where(
            sql_text(
                "channel_agent_references.provider IN ('telegram', 'discord') AND "
                "channel_agent_references.bot_agent_link_id IS NULL"
            ),
            ChannelAgentReference.updated_at < inactive_cutoff,
        )
        .order_by(ChannelAgentReference.updated_at, ChannelAgentReference.id)
        .limit(candidate_limit)
    )
    inactive_link_candidates = (
        select(
            ChannelAgentReference.id.label("reference_id"),
            ChannelAgentReference.updated_at.label("retained_at"),
        )
        .where(
            sql_text(
                "channel_agent_references.provider IN ('telegram', 'discord') AND "
                "channel_agent_references.bot_agent_link_id IS NOT NULL"
            ),
            ChannelAgentReference.bot_agent_link_id.in_(inactive_link_ids),
            ChannelAgentReference.updated_at < inactive_cutoff,
        )
        .order_by(ChannelAgentReference.updated_at, ChannelAgentReference.id)
        .limit(candidate_limit)
    )
    candidate_rows = union_all(
        secret_candidates,
        orphaned_candidates,
        inactive_link_candidates,
    ).subquery()
    candidates = (
        select(
            candidate_rows.c.reference_id,
            func.min(candidate_rows.c.retained_at).label("retained_at"),
        )
        .group_by(candidate_rows.c.reference_id)
        .subquery()
    )
    result = await db.execute(
        select(ChannelAgentReference)
        .join(candidates, candidates.c.reference_id == ChannelAgentReference.id)
        .order_by(candidates.c.retained_at, ChannelAgentReference.id)
        .limit(batch_limit)
        .with_for_update(skip_locked=True, of=ChannelAgentReference)
    )
    references = list(result.scalars().all())
    for reference in references:
        await db.delete(reference)
    await db.flush()
    return len(references)


async def scrub_discord_interaction_payload_tokens(
    db: AsyncSession,
    *,
    now: datetime | None = None,
    retention: timedelta | None = None,
    limit: int | None = None,
) -> int:
    batch_limit = max(
        0,
        settings.channel_message_cleanup_batch_size if limit is None else limit,
    )
    if batch_limit == 0:
        return 0
    current_time = now or datetime.now(UTC)
    cutoff = current_time - (
        retention if retention is not None else DISCORD_INTERACTION_SECRET_RETENTION
    )
    result = await db.execute(
        select(ChannelMessage)
        .join(ChannelAccount, ChannelAccount.id == ChannelMessage.account_id)
        .where(
            ChannelAccount.provider == CHANNEL_PROVIDER_DISCORD,
            ChannelMessage.created_at < cutoff,
            sql_text(
                "((payload ? 'token' AND payload ? 'application_id') OR "
                "(payload ->> 't' = 'INTERACTION_CREATE' AND (payload -> 'd') ? 'token'))"
            ),
        )
        .order_by(ChannelMessage.created_at, ChannelMessage.id)
        .limit(batch_limit)
        .with_for_update(skip_locked=True, of=ChannelMessage)
    )
    messages = list(result.scalars().all())
    scrubbed = 0
    for message in messages:
        payload = message.payload
        if not isinstance(payload, dict):
            continue
        scrubbed_payload = _without_discord_interaction_token(payload)
        if scrubbed_payload is payload:
            continue
        message.payload = scrubbed_payload
        scrubbed += 1
    await db.flush()
    return scrubbed


def _without_discord_interaction_token(payload: JsonObject) -> JsonObject:
    scrubbed_payload: JsonObject | None = None
    if "token" in payload and "application_id" in payload:
        scrubbed_payload = dict(payload)
        scrubbed_payload.pop("token", None)

    data = payload.get("d")
    if payload.get("t") == "INTERACTION_CREATE" and isinstance(data, dict) and "token" in data:
        if scrubbed_payload is None:
            scrubbed_payload = dict(payload)
        scrubbed_data = dict(data)
        scrubbed_data.pop("token", None)
        scrubbed_payload["d"] = scrubbed_data
    return payload if scrubbed_payload is None else scrubbed_payload


async def prune_channel_retention_batch(
    db: AsyncSession,
    *,
    now: datetime | None = None,
    limit: int | None = None,
) -> ChannelRetentionBatch:
    current_time = now or datetime.now(UTC)
    return ChannelRetentionBatch(
        telegram_delivery_expirations=await expire_stale_telegram_inbox_messages(
            db,
            now=current_time,
            limit=limit,
        ),
        messages=await prune_channel_messages(db, now=current_time, limit=limit),
        debug_events=await prune_channel_debug_events(db, now=current_time, limit=limit),
        pair_codes=await prune_channel_pair_codes(db, now=current_time, limit=limit),
        discord_interaction_payloads=await scrub_discord_interaction_payload_tokens(
            db, now=current_time, limit=limit
        ),
        agent_references=await prune_channel_agent_references(db, now=current_time, limit=limit),
    )


async def channel_queue_snapshots(
    db: AsyncSession,
    *,
    now: datetime | None = None,
    stuck_after: timedelta | None = None,
) -> tuple[ChannelQueueSnapshot, ...]:
    current_time = now or datetime.now(UTC)
    stuck_cutoff = current_time - (
        stuck_after
        if stuck_after is not None
        else timedelta(hours=settings.channel_message_stuck_pending_hours)
    )
    snapshots: list[ChannelQueueSnapshot] = []
    for provider in CHANNEL_RETENTION_PROVIDERS:
        inbox_row = (
            await db.execute(
                select(
                    func.count(ChannelMessage.id),
                    func.count(ChannelMessage.id).filter(ChannelMessage.created_at < stuck_cutoff),
                    func.min(ChannelMessage.created_at),
                )
                .join(
                    ChannelBinding,
                    and_(
                        ChannelBinding.id == ChannelMessage.binding_id,
                        ChannelBinding.account_id == ChannelMessage.account_id,
                        ChannelBinding.bot_agent_link_id == ChannelMessage.bot_agent_link_id,
                        ChannelBinding.user_id == ChannelMessage.user_id,
                        ChannelBinding.external_chat_id == ChannelMessage.external_chat_id,
                    ),
                )
                .join(
                    ChannelBotAgentLink,
                    and_(
                        ChannelBotAgentLink.id == ChannelMessage.bot_agent_link_id,
                        ChannelBotAgentLink.account_id == ChannelMessage.account_id,
                        ChannelBotAgentLink.user_id == ChannelMessage.user_id,
                    ),
                )
                .join(ChannelAccount, ChannelAccount.id == ChannelMessage.account_id)
                .where(
                    ChannelAccount.provider == provider,
                    ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
                    ChannelAccount.archived_at.is_(None),
                    ChannelBinding.status == BINDING_STATUS_ACTIVE,
                    ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
                    ChannelBotAgentLink.archived_at.is_(None),
                    ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
                    ChannelMessage.binding_id.is_not(None),
                    ChannelMessage.delivered_at.is_(None),
                )
            )
        ).one()
        snapshots.append(
            ChannelQueueSnapshot(
                provider=provider,
                queue="inbox",
                pending_count=int(inbox_row[0]),
                stuck_count=int(inbox_row[1]),
                oldest_pending_at=inbox_row[2],
            )
        )
        outbox_row = (
            await db.execute(
                select(
                    func.count(ChannelDelivery.id),
                    func.count(ChannelDelivery.id).filter(
                        ChannelDelivery.created_at < stuck_cutoff
                    ),
                    func.min(ChannelDelivery.created_at),
                )
                .join(
                    ChannelMessage,
                    and_(
                        ChannelMessage.id == ChannelDelivery.message_id,
                        ChannelMessage.account_id == ChannelDelivery.account_id,
                        ChannelMessage.user_id == ChannelDelivery.user_id,
                    ),
                )
                .join(ChannelAccount, ChannelAccount.id == ChannelDelivery.account_id)
                .outerjoin(
                    ChannelBotAgentLink,
                    and_(
                        ChannelBotAgentLink.id == ChannelDelivery.bot_agent_link_id,
                        ChannelBotAgentLink.account_id == ChannelDelivery.account_id,
                        ChannelBotAgentLink.user_id == ChannelDelivery.user_id,
                    ),
                )
                .outerjoin(
                    ChannelBinding,
                    and_(
                        ChannelBinding.id == ChannelMessage.binding_id,
                        ChannelBinding.account_id == ChannelDelivery.account_id,
                        ChannelBinding.bot_agent_link_id == ChannelDelivery.bot_agent_link_id,
                        ChannelBinding.user_id == ChannelDelivery.user_id,
                        ChannelBinding.external_chat_id == ChannelMessage.external_chat_id,
                    ),
                )
                .where(
                    ChannelAccount.provider == provider,
                    ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
                    ChannelAccount.archived_at.is_(None),
                    ChannelDelivery.status == DELIVERY_STATUS_PENDING,
                    ChannelMessage.direction == MESSAGE_DIRECTION_OUTBOUND,
                    or_(
                        and_(
                            ChannelDelivery.bot_agent_link_id.is_(None),
                            ChannelMessage.bot_agent_link_id.is_(None),
                            ChannelMessage.binding_id.is_(None),
                        ),
                        and_(
                            ChannelDelivery.bot_agent_link_id.is_not(None),
                            ChannelMessage.bot_agent_link_id == ChannelDelivery.bot_agent_link_id,
                            ChannelMessage.binding_id.is_not(None),
                            ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
                            ChannelBotAgentLink.archived_at.is_(None),
                            ChannelBinding.status == BINDING_STATUS_ACTIVE,
                        ),
                    ),
                )
            )
        ).one()
        snapshots.append(
            ChannelQueueSnapshot(
                provider=provider,
                queue="outbox",
                pending_count=int(outbox_row[0]),
                stuck_count=int(outbox_row[1]),
                oldest_pending_at=outbox_row[2],
            )
        )
    return tuple(snapshots)


async def wait_for_channel_inbox_events(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID | None = None,
    after_sequence: int,
    limit: int,
    timeout_seconds: int | float | None = None,
    poll_interval_seconds: float | None = None,
) -> list[ChannelMessage]:
    timeout = max(0.0, min(float(timeout_seconds or 0), 30.0))
    poll_interval = _channel_long_poll_interval(poll_interval_seconds)
    deadline = monotonic() + timeout
    while True:
        events = await dequeue_channel_inbox_events(
            db,
            account=account,
            bot_agent_link_id=bot_agent_link_id,
            after_sequence=after_sequence,
            limit=limit,
        )
        if events or timeout == 0 or monotonic() >= deadline:
            return events
        await asyncio.sleep(min(poll_interval, max(0.0, deadline - monotonic())))


def _channel_long_poll_interval(value: float | None) -> float:
    configured = settings.channel_long_poll_interval_seconds if value is None else value
    return max(0.001, float(configured))


async def pending_channel_inbox_count(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID | None = None,
    user_id: UUID | None = None,
) -> int:
    count, _oldest_pending_at = await pending_channel_inbox_stats(
        db,
        account=account,
        bot_agent_link_id=bot_agent_link_id,
        user_id=user_id,
    )
    return count


async def pending_channel_inbox_stats(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID | None = None,
    user_id: UUID | None = None,
) -> tuple[int, datetime | None]:
    filters = [
        ChannelMessage.account_id == account.id,
        ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
        ChannelMessage.binding_id.is_not(None),
        ChannelMessage.delivered_at.is_(None),
    ]
    if bot_agent_link_id is not None:
        filters.append(ChannelMessage.bot_agent_link_id == bot_agent_link_id)
    if user_id is not None:
        filters.append(ChannelMessage.user_id == user_id)
    result = await db.execute(
        select(func.count(ChannelMessage.id), func.min(ChannelMessage.created_at))
        .join(
            ChannelBinding,
            and_(
                ChannelBinding.id == ChannelMessage.binding_id,
                ChannelBinding.account_id == ChannelMessage.account_id,
                ChannelBinding.bot_agent_link_id == ChannelMessage.bot_agent_link_id,
                ChannelBinding.user_id == ChannelMessage.user_id,
            ),
        )
        .join(
            ChannelBotAgentLink,
            and_(
                ChannelBotAgentLink.id == ChannelMessage.bot_agent_link_id,
                ChannelBotAgentLink.account_id == ChannelMessage.account_id,
            ),
        )
        .join(ChannelAccount, ChannelAccount.id == ChannelMessage.account_id)
        .where(*filters)
        .where(
            ChannelBinding.status == BINDING_STATUS_ACTIVE,
            ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
            ChannelBotAgentLink.archived_at.is_(None),
            ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
            ChannelAccount.archived_at.is_(None),
        )
    )
    count, oldest_pending_at = result.one()
    return int(count), oldest_pending_at


async def drop_pending_telegram_updates(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID | None = None,
) -> None:
    filters = [
        ChannelMessage.account_id == account.id,
        ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
        ChannelMessage.binding_id.is_not(None),
        ChannelMessage.delivered_at.is_(None),
    ]
    if bot_agent_link_id is not None:
        filters.append(ChannelMessage.bot_agent_link_id == bot_agent_link_id)
    result = await db.execute(select(ChannelMessage).where(*filters))
    now = datetime.now(UTC)
    for message in result.scalars().all():
        message.delivered_at = now
    await db.flush()


async def dequeue_discord_gateway_events(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID | None = None,
    after_sequence: int,
    limit: int,
) -> list[ChannelMessage]:
    filters = [
        ChannelMessage.account_id == account.id,
        ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
        ChannelMessage.binding_id.is_not(None),
        ChannelMessage.delivered_at.is_(None),
        ChannelMessage.inbox_sequence > after_sequence,
    ]
    if bot_agent_link_id is not None:
        filters.append(ChannelMessage.bot_agent_link_id == bot_agent_link_id)
    result = await db.execute(
        select(ChannelMessage)
        .where(*filters)
        .order_by(ChannelMessage.inbox_sequence, ChannelMessage.created_at)
        .limit(limit)
    )
    return list(result.scalars().all())


async def enqueue_channel_outbound_message(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    external_chat_id: str,
    text: str,
    bot_agent_link_id: UUID | None = None,
) -> tuple[ChannelMessage, ChannelDelivery]:
    binding = await _resolve_outbound_binding(
        db,
        account=account,
        external_chat_id=external_chat_id,
        bot_agent_link_id=bot_agent_link_id,
    )
    owner_user_id = require_channel_tenant_user_id(
        account,
        tenant_user_id=binding.user_id if binding is not None else None,
    )
    message = ChannelMessage(
        account_id=account.id,
        bot_agent_link_id=binding.bot_agent_link_id if binding else None,
        binding_id=binding.id if binding else None,
        user_id=owner_user_id,
        direction=MESSAGE_DIRECTION_OUTBOUND,
        external_chat_id=binding.external_chat_id if binding is not None else external_chat_id,
        provider_message_id=None,
        text=text,
        payload={"delivery": DELIVERY_STATUS_PENDING},
    )
    db.add(message)
    await db.flush()
    delivery = ChannelDelivery(
        account_id=account.id,
        bot_agent_link_id=message.bot_agent_link_id,
        message_id=message.id,
        user_id=owner_user_id,
        status=DELIVERY_STATUS_PENDING,
        next_attempt_at=datetime.now(UTC),
    )
    db.add(delivery)
    await db.flush()
    return message, delivery


async def _resolve_outbound_binding(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    external_chat_id: str,
    bot_agent_link_id: UUID | None,
) -> ChannelBinding | None:
    if bot_agent_link_id is not None:
        binding = await find_binding(
            db,
            account=account,
            external_chat_id=external_chat_id,
            bot_agent_link_id=bot_agent_link_id,
        )
        if binding is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="chat is not paired with this agent link",
            )
        return binding

    return await find_binding(db, account=account, external_chat_id=external_chat_id)


async def claim_next_channel_delivery(
    db: AsyncSession,
    *,
    worker_id: str,
) -> ChannelDelivery | None:
    now = datetime.now(UTC)
    result = await db.execute(
        select(ChannelDelivery)
        .join(ChannelAccount, ChannelAccount.id == ChannelDelivery.account_id)
        .outerjoin(
            ChannelBotAgentLink,
            ChannelBotAgentLink.id == ChannelDelivery.bot_agent_link_id,
        )
        .where(
            ChannelDelivery.status == DELIVERY_STATUS_PENDING,
            ChannelDelivery.next_attempt_at <= now,
            ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
            ChannelAccount.archived_at.is_(None),
            or_(
                ChannelDelivery.bot_agent_link_id.is_(None),
                and_(
                    ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
                    ChannelBotAgentLink.archived_at.is_(None),
                ),
            ),
        )
        .order_by(ChannelDelivery.next_attempt_at, ChannelDelivery.created_at)
        .limit(1)
        .with_for_update(skip_locked=True, of=ChannelDelivery)
    )
    delivery = result.scalar_one_or_none()
    if delivery is None:
        return None
    delivery.status = DELIVERY_STATUS_IN_PROGRESS
    delivery.locked_at = now
    delivery.locked_by = worker_id
    delivery.attempts += 1
    await db.flush()
    return delivery


async def deliver_channel_delivery(
    db: AsyncSession,
    *,
    delivery: ChannelDelivery,
) -> ChannelDelivery:
    account: ChannelAccount | None = None
    try:
        account = await _delivery_account(db, delivery)
        link = await _lock_active_delivery_link(db, delivery)
        if link is not None:
            if not await bot_agent_link_has_strict_v2_authority(db, link=link):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="channel agent link has no managed runtime authority",
                )
            if not await bot_agent_link_has_provider_cardinality_capability(
                db,
                account=account,
                link=link,
            ):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=hosted_agent_provider_link_limit_detail(
                        account.provider,
                        duplicate=True,
                    ),
                )
        message = await _delivery_message(db, delivery)
        await _lock_active_delivery_binding(db, delivery=delivery, message=message)
        provider_message_id, _provider_response = await send_provider_outbound_payload(
            account=account,
            external_chat_id=message.external_chat_id,
            text=message.text or "",
            provider_payload=_channel_message_provider_payload(message),
            discord_nonce=(
                _discord_delivery_nonce(message.id)
                if account.provider == CHANNEL_PROVIDER_DISCORD
                else None
            ),
        )
    except HTTPException as exc:
        error = _http_exception_detail(exc)
        delivery_provider = (
            account.provider
            if account is not None
            else await db.scalar(
                select(ChannelAccount.provider).where(ChannelAccount.id == delivery.account_id)
            )
        )
        use_safe_diagnostics = delivery_provider in {
            CHANNEL_PROVIDER_TELEGRAM,
            CHANNEL_PROVIDER_DISCORD,
            CHANNEL_PROVIDER_WHATSAPP,
        }
        if exc.status_code == status.HTTP_429_TOO_MANY_REQUESTS:
            _schedule_delivery_retry(
                delivery,
                error,
                use_safe_diagnostics=use_safe_diagnostics,
                retry_after_seconds=_http_retry_after_seconds(exc),
            )
        elif _is_delivery_link_lock_contention(exc, error=error):
            _schedule_delivery_link_contention_retry(
                delivery,
                error,
                use_safe_diagnostics=use_safe_diagnostics,
            )
        elif exc.status_code < status.HTTP_500_INTERNAL_SERVER_ERROR:
            _fail_delivery(
                delivery,
                error,
                use_safe_diagnostics=use_safe_diagnostics,
            )
        else:
            _schedule_delivery_retry(
                delivery,
                error,
                use_safe_diagnostics=use_safe_diagnostics,
            )
        await db.flush()
        return delivery

    stored_provider_response = (
        _safe_delivery_provider_response(
            provider=account.provider,
            provider_message_id=provider_message_id,
        )
        if account.provider
        in {
            CHANNEL_PROVIDER_TELEGRAM,
            CHANNEL_PROVIDER_DISCORD,
            CHANNEL_PROVIDER_WHATSAPP,
        }
        else _provider_response
    )
    message.provider_message_id = provider_message_id
    message.payload = _delivery_success_payload(message.payload, stored_provider_response)
    if account.provider in CHANNEL_RETENTION_PROVIDERS:
        message.delivered_at = datetime.now(UTC)
    delivery.status = DELIVERY_STATUS_SUCCEEDED
    delivery.locked_at = None
    delivery.locked_by = None
    delivery.last_error = None
    delivery.provider_response = stored_provider_response
    await db.flush()
    return delivery


def _channel_message_provider_payload(message: ChannelMessage) -> JsonObject | None:
    payload = message.payload
    if not isinstance(payload, dict):
        return None
    provider_payload = payload.get("providerPayload")
    if not isinstance(provider_payload, dict):
        return None
    return provider_payload


def _delivery_success_payload(
    existing_payload: object,
    provider_response: JsonObject,
) -> JsonObject:
    try:
        payload = dict(_JSON_OBJECT_ADAPTER.validate_python(existing_payload, strict=True))
    except ValidationError:
        return provider_response
    if "delivery" not in payload and "providerPayload" not in payload:
        return provider_response
    payload["delivery"] = DELIVERY_STATUS_SUCCEEDED
    payload["providerResponse"] = provider_response
    return payload


async def send_provider_outbound_payload(
    *,
    account: ChannelAccount,
    external_chat_id: str,
    text: str,
    provider_payload: JsonObject | None = None,
    discord_nonce: str | None = None,
) -> tuple[str | None, JsonObject]:
    if account.provider == CHANNEL_PROVIDER_TELEGRAM:
        return await _send_telegram_provider_payload(
            account=account,
            external_chat_id=external_chat_id,
            text=text,
        )
    if account.provider == CHANNEL_PROVIDER_DISCORD:
        return await _send_discord_provider_payload(
            account=account,
            external_chat_id=external_chat_id,
            text=text,
            nonce=discord_nonce,
        )
    if account.provider == CHANNEL_PROVIDER_WHATSAPP:
        return await _send_whatsapp_provider_payload(
            account=account,
            external_chat_id=external_chat_id,
            text=text,
            provider_payload=provider_payload,
        )
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail=f"{account.provider} send is not implemented yet",
    )


async def send_channel_outbound_message(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    external_chat_id: str,
    text: str,
    bot_agent_link_id: UUID | None = None,
    bind_to_existing: bool = True,
    telegram_message_thread_id: int | None = None,
    telegram_direct_messages_topic_id: int | None = None,
) -> ChannelMessage:
    if account.provider == CHANNEL_PROVIDER_TELEGRAM:
        return await send_telegram_message(
            db,
            account=account,
            external_chat_id=external_chat_id,
            text=text,
            bot_agent_link_id=bot_agent_link_id,
            bind_to_existing=bind_to_existing,
            message_thread_id=telegram_message_thread_id,
            direct_messages_topic_id=telegram_direct_messages_topic_id,
        )
    if account.provider == CHANNEL_PROVIDER_DISCORD:
        return await send_discord_message(
            db,
            account=account,
            external_chat_id=external_chat_id,
            text=text,
            bot_agent_link_id=bot_agent_link_id,
            bind_to_existing=bind_to_existing,
        )
    if account.provider == CHANNEL_PROVIDER_WHATSAPP:
        return await send_whatsapp_message(
            db,
            account=account,
            external_chat_id=external_chat_id,
            text=text,
            bot_agent_link_id=bot_agent_link_id,
            bind_to_existing=bind_to_existing,
        )
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail=f"{account.provider} send is not implemented yet",
    )


def _telegram_account_command_specs(
    commands: list[JsonObject] | None,
) -> list[JsonObject]:
    merged = [dict(command) for command in DEFAULT_CHANNEL_COMMANDS]
    seen = {_command_name(command) for command in merged}
    for command in commands or []:
        name = _command_name(command)
        if name in seen:
            continue
        seen.add(name)
        merged.append(command)
    if len(merged) > 100:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="telegram merged command list exceeds provider limit of 100",
        )
    return merged


async def sync_channel_commands(
    *,
    account: ChannelAccount,
    commands: list[JsonObject] | None = None,
    guild_id: str | None = None,
    use_configured_discord_guild: bool | None = None,
) -> list[JsonObject]:
    using_default_commands = commands is None
    command_specs = commands or [dict(command) for command in DEFAULT_CHANNEL_COMMANDS]
    if account.provider == CHANNEL_PROVIDER_TELEGRAM:
        return await sync_telegram_commands(
            account=account,
            commands=_telegram_account_command_specs(commands),
        )
    if account.provider == CHANNEL_PROVIDER_DISCORD:
        if not using_default_commands:
            for command in command_specs:
                name = _command_name(command)
                if name.startswith("bot_") or name in DISCORD_RESERVED_COMMAND_NAMES:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="discord command name is reserved",
                    )
        return await sync_discord_commands(
            account=account,
            commands=command_specs,
            guild_id=guild_id,
            reconcile_reserved_commands=using_default_commands,
            use_configured_guild=(
                not using_default_commands
                if use_configured_discord_guild is None
                else use_configured_discord_guild
            ),
        )
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="channel provider command sync is not implemented",
    )


async def configure_discord_application(account: ChannelAccount) -> JsonObject:
    """Configure and validate the account's Discord HTTP interaction endpoint.

    The account row must already be committed before this runs: Discord
    validates the PATCH by sending a signed PING to the generated webhook URL.
    A GET identity check precedes mutation so a token for another application
    can never silently configure the requested application.
    """
    if account.provider != CHANNEL_PROVIDER_DISCORD:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="not a discord channel")
    validate_required_discord_interactions_config(account.config)
    application_id = _account_config_str(account, "application_id")
    if application_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Discord application_id is required.",
        )
    token = decrypt_provider_token(account)
    identity = await verify_discord_application_token_identity(
        application_id=application_id,
        provider_token=token,
        config=account.config,
        rate_limit_scope=str(account.id),
    )
    _require_discord_message_content_intent(identity)
    raw_integration_config = identity.get("integration_types_config")
    integration_config: dict[str, JsonObject] = (
        {
            key: dict(value)
            for key, value in raw_integration_config.items()
            if isinstance(value, dict)
        }
        if isinstance(raw_integration_config, dict)
        else {}
    )
    guild_install_params: JsonObject = {
        "scopes": list[JsonValue](["applications.commands", "bot"]),
        "permissions": str(DISCORD_MINIMAL_BOT_PERMISSIONS),
    }
    guild_install_config = dict(integration_config.get(str(DISCORD_GUILD_INSTALL), {}))
    guild_install_config["oauth2_install_params"] = guild_install_params
    integration_config[str(DISCORD_GUILD_INSTALL)] = guild_install_config
    user_install_supported = str(DISCORD_USER_INSTALL) in integration_config
    if user_install_supported:
        user_install_config = dict(integration_config[str(DISCORD_USER_INSTALL)])
        user_install_config["oauth2_install_params"] = {
            "scopes": ["applications.commands"],
            "permissions": "0",
        }
        integration_config[str(DISCORD_USER_INSTALL)] = user_install_config
    base_url = (
        _account_config_str(account, "api_base_url")
        or settings.channel_discord_api_base_url.strip()
    )
    await _validate_provider_endpoint_url(
        base_url,
        channel=CHANNEL_PROVIDER_DISCORD,
        method="application",
        label="discord api base url",
    )
    url = f"{base_url.rstrip('/')}/applications/@me"
    headers = {
        "Authorization": f"Bot {token}",
        "Content-Type": "application/json",
    }
    configured = await _discord_application_request(
        account_scope=str(account.id),
        method="PATCH",
        url=url,
        headers=headers,
        json_payload={
            "interactions_endpoint_url": channel_webhook_url(account.id, account.provider),
            "install_params": guild_install_params,
            "integration_types_config": _JSON_OBJECT_ADAPTER.validate_python(
                integration_config, strict=True
            ),
        },
    )
    _verify_discord_application_identity(configured, expected_application_id=application_id)
    verified_user_install = _verify_discord_install_configuration(configured)
    config = dict(account.config) if isinstance(account.config, dict) else {}
    config[DISCORD_INSTALL_CONFIG_VERSION_CONFIG_KEY] = DISCORD_INSTALL_CONFIG_VERSION
    config[DISCORD_USER_INSTALL_SUPPORTED_CONFIG_KEY] = verified_user_install
    account.config = config
    return configured


def _verify_discord_install_configuration(payload: JsonObject) -> bool:
    """Verify the exact install defaults Discord persisted after PATCH."""
    integration_types = payload.get("integration_types_config")
    if not isinstance(integration_types, dict):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Discord returned an invalid Guild Install configuration.",
        )
    guild_config = integration_types.get(str(DISCORD_GUILD_INSTALL))
    if not _discord_install_params_match(
        guild_config,
        expected_scopes={"applications.commands", "bot"},
        expected_permissions=str(DISCORD_MINIMAL_BOT_PERMISSIONS),
    ):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Discord returned an invalid Guild Install configuration.",
        )
    user_config = integration_types.get(str(DISCORD_USER_INSTALL))
    if user_config is None:
        return False
    if not _discord_install_params_match(
        user_config,
        expected_scopes={"applications.commands"},
        expected_permissions="0",
    ):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Discord returned an invalid User Install configuration.",
        )
    return True


def _discord_install_params_match(
    config: object,
    *,
    expected_scopes: set[str],
    expected_permissions: str,
) -> bool:
    try:
        config_value = _JSON_OBJECT_ADAPTER.validate_python(config, strict=True)
    except ValidationError:
        return False
    install_params = config_value.get("oauth2_install_params")
    if not isinstance(install_params, dict):
        return False
    scopes = install_params.get("scopes")
    return (
        isinstance(scopes, list)
        and len(scopes) == len(expected_scopes)
        and all(isinstance(scope, str) for scope in scopes)
        and {scope for scope in scopes if isinstance(scope, str)} == expected_scopes
        and install_params.get("permissions") == expected_permissions
    )


async def verify_discord_application_token_identity(
    *,
    application_id: str,
    provider_token: str,
    config: JsonObject | None,
    rate_limit_scope: str | None = None,
) -> JsonObject:
    """Verify a Discord credential without mutating the Developer Portal."""
    raw_base_url = config.get("api_base_url") if isinstance(config, dict) else None
    base_url = (
        raw_base_url.strip()
        if isinstance(raw_base_url, str) and raw_base_url.strip()
        else settings.channel_discord_api_base_url.strip()
    )
    await _validate_provider_endpoint_url(
        base_url,
        channel=CHANNEL_PROVIDER_DISCORD,
        method="application",
        label="discord api base url",
    )
    identity = await _discord_application_request(
        account_scope=rate_limit_scope or f"application:{application_id}",
        method="GET",
        url=f"{base_url.rstrip('/')}/applications/@me",
        headers={
            "Authorization": f"Bot {provider_token}",
            "Content-Type": "application/json",
        },
    )
    _verify_discord_application_identity(identity, expected_application_id=application_id)
    return identity


def discord_application_id_from_config(config: JsonObject | None) -> str | None:
    if not _is_object_dict(config):
        return None
    return _read_optional_str(config.get("application_id")) or _read_optional_str(
        config.get("app_id")
    )


def require_unchanged_discord_application_identity(
    account: ChannelAccount,
    config: JsonObject | None,
) -> None:
    """Prevent replacing an identity whose old projections cannot be retired."""
    current_application_id = discord_application_id_from_config(account.config)
    replacement_application_id = discord_application_id_from_config(config)
    if replacement_application_id != current_application_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "Discord application identity cannot be changed in place; "
                "recreate the channel instead."
            ),
        )


async def ensure_discord_application_identity_available(
    db: AsyncSession,
    *,
    account: ChannelAccount,
) -> None:
    """Fail closed if another verified account owns the same Discord app."""
    application_id = discord_application_id_from_config(account.config)
    if application_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Discord application_id is required.",
        )
    lock_name = f"discord-application-identity:{application_id}"
    await db.execute(select(func.pg_advisory_xact_lock(func.hashtextextended(lock_name, 0))))
    result = await db.execute(
        select(ChannelAccount).where(
            ChannelAccount.provider == CHANNEL_PROVIDER_DISCORD,
            ChannelAccount.id != account.id,
            ChannelAccount.archived_at.is_(None),
        )
    )
    for existing in result.scalars():
        if discord_application_id_from_config(
            existing.config
        ) == application_id and discord_install_config_is_current(existing):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="This Discord application is already connected to another channel.",
            )


def discord_bot_install_url(account: ChannelAccount) -> str | None:
    if account.provider != CHANNEL_PROVIDER_DISCORD:
        return None
    application_id = _account_config_str(account, "application_id")
    if application_id is None or not valid_discord_application_id(application_id):
        return None
    return (
        "https://discord.com/oauth2/authorize"
        f"?client_id={application_id}"
        "&integration_type=0"
        f"&permissions={DISCORD_MINIMAL_BOT_PERMISSIONS}"
        "&scope=bot%20applications.commands"
    )


def discord_user_install_url(account: ChannelAccount) -> str | None:
    if account.provider != CHANNEL_PROVIDER_DISCORD:
        return None
    application_id = _account_config_str(account, "application_id")
    if application_id is None or not valid_discord_application_id(application_id):
        return None
    if not discord_user_install_is_supported(account):
        return None
    # USER_INSTALL supports applications.commands without the bot scope or
    # guild bot permissions. The application owner must enable User Install in
    # Discord's Installation settings for this authorize URL to succeed.
    # https://discord.com/developers/docs/topics/oauth2#authorization-code-grant-authorization-url-example
    return (
        "https://discord.com/oauth2/authorize"
        f"?client_id={application_id}"
        "&integration_type=1"
        "&scope=applications.commands"
    )


def discord_install_config_is_current(account: ChannelAccount) -> bool:
    config: object = account.config
    if not _is_object_dict(config):
        return False
    version = config.get(DISCORD_INSTALL_CONFIG_VERSION_CONFIG_KEY)
    return (
        isinstance(version, int)
        and not isinstance(version, bool)
        and version == DISCORD_INSTALL_CONFIG_VERSION
        and isinstance(
            config.get(DISCORD_USER_INSTALL_SUPPORTED_CONFIG_KEY),
            bool,
        )
    )


def discord_user_install_is_supported(account: ChannelAccount) -> bool:
    config: object = account.config
    if not isinstance(config, dict):
        return False
    return (
        discord_install_config_is_current(account)
        and config.get(DISCORD_USER_INSTALL_SUPPORTED_CONFIG_KEY) is True
    )


def discord_config_without_unverified_install_state(
    config: JsonObject | None,
) -> JsonObject | None:
    """Remove Discord capability state that only provider verification may set."""
    config_value: object = config
    if not _is_object_dict(config_value):
        return None
    sanitized = _JSON_OBJECT_ADAPTER.validate_python(config_value, strict=True)
    sanitized.pop(DISCORD_INSTALL_CONFIG_VERSION_CONFIG_KEY, None)
    sanitized.pop(DISCORD_USER_INSTALL_SUPPORTED_CONFIG_KEY, None)
    return sanitized


async def rearm_discord_command_reconciliation(
    db: AsyncSession,
    *,
    account: ChannelAccount,
) -> int:
    """Make blocked command retries due after verified credential/setup repair."""
    result = await db.execute(
        select(ChannelBotAgentLink).where(ChannelBotAgentLink.account_id == account.id)
    )
    rearmed = 0
    for link in result.scalars():
        config = dict(link.config) if isinstance(link.config, dict) else {}
        raw_retries = config.get("discord_command_retries")
        if not isinstance(raw_retries, dict):
            continue
        retries = {
            guild_id: dict(retry)
            for guild_id, retry in raw_retries.items()
            if isinstance(retry, dict)
        }
        changed = False
        for retry in retries.values():
            if retry.get("blocked") is not True:
                continue
            retry["blocked"] = False
            retry["next_retry_at"] = datetime.now(UTC).isoformat()
            changed = True
            rearmed += 1
        if changed:
            config["discord_command_retries"] = _JSON_OBJECT_ADAPTER.validate_python(
                retries, strict=True
            )
            link.config = config
    return rearmed


def discord_reserved_commands_are_current(account: ChannelAccount) -> bool:
    if not isinstance(account.config, dict):
        return False
    version = account.config.get(DISCORD_RESERVED_COMMAND_VERSION_CONFIG_KEY)
    return (
        isinstance(version, int)
        and not isinstance(version, bool)
        and version == DISCORD_RESERVED_COMMAND_VERSION
    )


def mark_discord_reserved_commands_current(account: ChannelAccount) -> None:
    config = dict(account.config) if isinstance(account.config, dict) else {}
    config[DISCORD_RESERVED_COMMAND_VERSION_CONFIG_KEY] = DISCORD_RESERVED_COMMAND_VERSION
    account.config = config


def telegram_reserved_commands_are_current(account: ChannelAccount) -> bool:
    if not isinstance(account.config, dict):
        return False
    version = account.config.get(TELEGRAM_RESERVED_COMMAND_VERSION_CONFIG_KEY)
    return (
        isinstance(version, int)
        and not isinstance(version, bool)
        and version == TELEGRAM_RESERVED_COMMAND_VERSION
    )


def mark_telegram_reserved_commands_current(account: ChannelAccount) -> None:
    config = dict(account.config) if isinstance(account.config, dict) else {}
    config[TELEGRAM_RESERVED_COMMAND_VERSION_CONFIG_KEY] = TELEGRAM_RESERVED_COMMAND_VERSION
    account.config = config


async def _discord_application_request(
    *,
    account_scope: str,
    method: str,
    url: str,
    headers: dict[str, str],
    json_payload: JsonObject | None = None,
) -> JsonObject:
    path = "/applications/@me"
    decision = discord_rate_limiter.check(account_scope, method, path)
    if not decision.allowed:
        rate_limit_rejects.labels(
            channel=CHANNEL_PROVIDER_DISCORD,
            scope="bot" if decision.global_limit else "route",
        ).inc()
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Discord application configuration is rate limited.",
            headers=(
                {"Retry-After": str(decision.retry_after_seconds)}
                if decision.retry_after_seconds is not None
                else None
            ),
        )
    try:
        with track_proxy_latency(CHANNEL_PROVIDER_DISCORD, method):
            async with httpx.AsyncClient(timeout=20.0) as client:
                discord_rate_limiter.consume(account_scope, method, path)
                response = await client.request(
                    method,
                    url,
                    headers=headers,
                    json=json_payload,
                )
                discord_rate_limiter.observe(
                    account_scope,
                    method,
                    path,
                    _discord_rate_limit_response_headers(response),
                    response.status_code,
                )
    except httpx.HTTPError as exc:
        outbound_errors.labels(channel=CHANNEL_PROVIDER_DISCORD, method=method).inc()
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Discord could not validate the interactions endpoint. Try again.",
        ) from exc
    outbound_messages.labels(channel=CHANNEL_PROVIDER_DISCORD, method=method).inc()
    if response.status_code == status.HTTP_429_TOO_MANY_REQUESTS:
        outbound_errors.labels(channel=CHANNEL_PROVIDER_DISCORD, method=method).inc()
        retry_after = _discord_rate_limit_response_headers(response).get("retry-after")
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Discord application configuration is rate limited.",
            headers={"Retry-After": retry_after} if retry_after is not None else None,
        )
    if response.status_code >= 400:
        outbound_errors.labels(channel=CHANNEL_PROVIDER_DISCORD, method=method).inc()
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=(
                "Discord rejected the interactions endpoint. Check the application ID, "
                "public key, and endpoint, then retry."
            ),
        )
    payload = _response_json_object(
        response,
        detail="Discord returned an invalid application response.",
    )
    return payload


def _verify_discord_application_identity(
    payload: JsonObject,
    *,
    expected_application_id: str,
) -> None:
    returned_id = _read_optional_str(payload.get("id"))
    if returned_id is None:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Discord returned an application response without an ID.",
        )
    if returned_id != expected_application_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Discord bot token belongs to a different application.",
        )


def _require_discord_message_content_intent(payload: JsonObject) -> None:
    """Require the privileged intent that the native Gateway always identifies with."""
    flags = payload.get("flags")
    approved = DISCORD_GATEWAY_MESSAGE_CONTENT_FLAG
    limited = DISCORD_GATEWAY_MESSAGE_CONTENT_LIMITED_FLAG
    enabled_flags = approved | limited
    if not isinstance(flags, int) or isinstance(flags, bool) or flags & enabled_flags == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=("Enable the Message Content Intent for this Discord application, then retry."),
        )


async def send_telegram_message(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    external_chat_id: str,
    text: str,
    bot_agent_link_id: UUID | None = None,
    bind_to_existing: bool = True,
    message_thread_id: int | None = None,
    direct_messages_topic_id: int | None = None,
) -> ChannelMessage:
    _require_channel_provider(account, CHANNEL_PROVIDER_TELEGRAM)
    provider_message_id, _provider_payload = await _send_telegram_provider_payload(
        account=account,
        external_chat_id=external_chat_id,
        text=text,
        message_thread_id=message_thread_id,
        direct_messages_topic_id=direct_messages_topic_id,
    )
    binding = (
        await find_binding(
            db,
            account=account,
            external_chat_id=external_chat_id,
            bot_agent_link_id=bot_agent_link_id,
        )
        if bind_to_existing
        else None
    )
    return await _record_outbound_channel_message(
        db,
        account=account,
        binding=binding,
        external_chat_id=external_chat_id,
        provider_message_id=provider_message_id,
        text=text,
        payload=_safe_delivery_provider_response(
            provider=account.provider,
            provider_message_id=provider_message_id,
        ),
        delivered_at=datetime.now(UTC),
    )


async def _send_telegram_provider_payload(
    *,
    account: ChannelAccount,
    external_chat_id: str,
    text: str,
    message_thread_id: int | None = None,
    direct_messages_topic_id: int | None = None,
) -> tuple[str, JsonObject]:
    token = decrypt_provider_token(account)
    base_url = settings.channel_telegram_api_base_url.strip()
    url = f"{base_url.rstrip('/')}/bot{token}/sendMessage"
    request_payload: JsonObject = {"chat_id": external_chat_id, "text": text}
    if message_thread_id is not None:
        request_payload["message_thread_id"] = message_thread_id
    if direct_messages_topic_id is not None:
        request_payload["direct_messages_topic_id"] = direct_messages_topic_id
    payload = await _post_provider_json(
        channel=CHANNEL_PROVIDER_TELEGRAM,
        method="sendMessage",
        url=url,
        json_payload=request_payload,
        timeout_seconds=20.0,
        unreachable_detail="telegram api unreachable",
        rejected_detail="telegram api rejected message",
    )
    provider_message_id = _telegram_sent_message_id(payload)
    if provider_message_id is None:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="telegram api returned an invalid message",
        )
    return provider_message_id, payload


async def sync_telegram_commands(
    *,
    account: ChannelAccount,
    commands: list[JsonObject],
) -> list[JsonObject]:
    if account.provider != CHANNEL_PROVIDER_TELEGRAM:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="not a telegram channel",
        )
    token = decrypt_provider_token(account)
    base_url = settings.channel_telegram_api_base_url.strip()
    await _validate_provider_endpoint_url(
        base_url,
        channel=CHANNEL_PROVIDER_TELEGRAM,
        method="setMyCommands",
        label="telegram api base url",
    )
    url = f"{base_url.rstrip('/')}/bot{token}/setMyCommands"
    request_commands: list[JsonObject] = [
        {
            "command": _command_name(command),
            "description": _command_description(command),
        }
        for command in commands
    ]
    request_payload = _JSON_OBJECT_ADAPTER.validate_python(
        {"commands": request_commands}, strict=True
    )
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(url, json=request_payload)
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="telegram api unreachable",
        ) from exc
    if response.status_code >= 400:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="telegram api rejected commands",
        )
    response_payload = _response_json_object(
        response,
        detail="telegram api returned invalid commands",
    )
    if response_payload.get("ok") is not True:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="telegram api returned invalid commands",
        )
    return request_commands


async def send_discord_message(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    external_chat_id: str,
    text: str,
    bot_agent_link_id: UUID | None = None,
    bind_to_existing: bool = True,
) -> ChannelMessage:
    _require_channel_provider(account, CHANNEL_PROVIDER_DISCORD)
    provider_message_id, _response_payload = await _send_discord_provider_payload(
        account=account,
        external_chat_id=external_chat_id,
        text=text,
    )
    binding = (
        await find_binding(
            db,
            account=account,
            external_chat_id=external_chat_id,
            bot_agent_link_id=bot_agent_link_id,
        )
        if bind_to_existing
        else None
    )
    return await _record_outbound_channel_message(
        db,
        account=account,
        binding=binding,
        external_chat_id=external_chat_id,
        provider_message_id=provider_message_id,
        text=text,
        payload=_safe_delivery_provider_response(
            provider=account.provider,
            provider_message_id=provider_message_id,
        ),
        delivered_at=datetime.now(UTC),
    )


async def record_discord_outbound_message(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    binding: ChannelBinding,
    external_chat_id: str,
    provider_response: JsonObject,
) -> ChannelMessage:
    _require_channel_provider(account, CHANNEL_PROVIDER_DISCORD)
    if binding.account_id != account.id:
        raise ValueError("channel binding does not belong to channel account")
    provider_message_id = _read_optional_str(provider_response.get("id"))
    if provider_message_id is None:
        raise ValueError("discord message response has no id")
    if _read_optional_str(provider_response.get("channel_id")) != external_chat_id:
        raise ValueError("discord message response channel does not match target")
    return await _record_outbound_channel_message(
        db,
        account=account,
        binding=binding,
        external_chat_id=external_chat_id,
        provider_message_id=provider_message_id,
        text=_read_optional_str(provider_response.get("content")) or "",
        payload=None,
        delivered_at=datetime.now(UTC),
    )


async def _send_discord_provider_payload(
    *,
    account: ChannelAccount,
    external_chat_id: str,
    text: str,
    nonce: str | None = None,
) -> tuple[str, JsonObject]:
    token = decrypt_provider_token(account)
    base_url = (
        _account_config_str(account, "api_base_url")
        or settings.channel_discord_api_base_url.strip()
    )
    await _validate_provider_endpoint_url(
        base_url,
        channel=CHANNEL_PROVIDER_DISCORD,
        method="POST",
        label="discord api base url",
    )
    path = f"/channels/{external_chat_id}/messages"
    url = f"{base_url.rstrip('/')}{path}"
    payload: JsonObject = {
        "content": text,
        "allowed_mentions": {"parse": list[JsonValue]()},
    }
    if nonce is not None:
        payload["nonce"] = nonce
        payload["enforce_nonce"] = True
    account_scope = str(account.id)
    decision = discord_rate_limiter.check(account_scope, "POST", path)
    if not decision.allowed:
        rate_limit_rejects.labels(
            channel=CHANNEL_PROVIDER_DISCORD,
            scope="bot" if decision.global_limit else "route",
        ).inc()
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="discord api rate limited",
            headers={
                "Retry-After": str(decision.retry_after_seconds),
            }
            if decision.retry_after_seconds is not None
            else None,
        )
    try:
        with track_proxy_latency(CHANNEL_PROVIDER_DISCORD, "POST"):
            async with httpx.AsyncClient(timeout=20.0) as client:
                discord_rate_limiter.consume(account_scope, "POST", path)
                response = await client.post(
                    url,
                    headers={"Authorization": f"Bot {token}"},
                    json=payload,
                )
                discord_rate_limiter.observe(
                    account_scope,
                    "POST",
                    path,
                    response.headers,
                    response.status_code,
                )
    except httpx.HTTPError as exc:
        outbound_errors.labels(channel=CHANNEL_PROVIDER_DISCORD, method="POST").inc()
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="discord api unreachable",
        ) from exc
    outbound_messages.labels(channel=CHANNEL_PROVIDER_DISCORD, method="POST").inc()
    if response.status_code == status.HTTP_429_TOO_MANY_REQUESTS:
        outbound_errors.labels(channel=CHANNEL_PROVIDER_DISCORD, method="POST").inc()
        retry_after = _discord_rate_limit_response_headers(response).get("retry-after")
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="discord api rate limited",
            headers={"Retry-After": retry_after} if retry_after is not None else None,
        )
    if response.status_code >= 400:
        outbound_errors.labels(channel=CHANNEL_PROVIDER_DISCORD, method="POST").inc()
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="discord api rejected message",
        )
    response_payload = _response_json_object(
        response,
        detail="discord api returned an invalid message",
    )
    provider_message_id = _read_optional_str(response_payload.get("id"))
    if provider_message_id is None:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="discord api returned an invalid message",
        )
    return provider_message_id, response_payload


async def sync_discord_commands(
    *,
    account: ChannelAccount,
    commands: list[JsonObject],
    guild_id: str | None,
    reconcile_reserved_commands: bool = False,
    use_configured_guild: bool = True,
) -> list[JsonObject]:
    if account.provider != CHANNEL_PROVIDER_DISCORD:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="not a discord channel")
    token = decrypt_provider_token(account)
    application_id = _account_config_str(account, "application_id") or _account_config_str(
        account,
        "app_id",
    )
    if not application_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="discord application_id is required in channel config",
        )
    scoped_guild_id = guild_id
    if scoped_guild_id is None and use_configured_guild:
        scoped_guild_id = _account_config_str(account, "guild_id")
    base_url = (
        _account_config_str(account, "api_base_url")
        or settings.channel_discord_api_base_url.strip()
    )
    await _validate_provider_endpoint_url(
        base_url,
        channel=CHANNEL_PROVIDER_DISCORD,
        method="commands",
        label="discord api base url",
    )
    path = f"/applications/{application_id}"
    if scoped_guild_id:
        path = f"{path}/guilds/{scoped_guild_id}"
    url = f"{base_url.rstrip('/')}{path}/commands"
    command_payloads = [
        _discord_command_payload(
            command,
            account=account,
            global_command=scoped_guild_id is None,
        )
        for command in commands
    ]
    synced: list[JsonObject] = []
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            if reconcile_reserved_commands:
                # Reconcile only Clawdi's reserved namespace. Bulk overwrite
                # would make these two commands the complete scope and delete
                # unrelated application/runtime commands owned elsewhere.
                # Discord POST is an upsert by command name. Validate both new
                # commands before deleting any legacy command so a partial
                # provider failure cannot remove the only usable pair path.
                # DELETE then targets only IDs found by the preceding GET.
                # https://discord.com/developers/docs/interactions/application-commands#get-global-application-commands
                # https://discord.com/developers/docs/interactions/application-commands#delete-global-application-command
                # https://discord.com/developers/docs/interactions/application-commands#create-global-application-command
                headers = {
                    "Authorization": f"Bot {token}",
                    "Content-Type": "application/json",
                }
                response = await _discord_command_request(
                    client,
                    account_scope=str(account.id),
                    method="GET",
                    url=url,
                    path=f"{path}/commands",
                    headers=headers,
                )
                _raise_for_discord_command_sync_response(response)
                existing_commands = _response_json_value(
                    response,
                    detail="discord api returned invalid commands",
                )
                if not isinstance(existing_commands, list) or not all(
                    isinstance(command, dict) for command in existing_commands
                ):
                    raise HTTPException(
                        status_code=status.HTTP_502_BAD_GATEWAY,
                        detail="discord api returned invalid commands",
                    )
                legacy_command_ids: list[str] = []
                for existing_command in existing_commands:
                    if not isinstance(existing_command, dict):
                        raise HTTPException(
                            status_code=status.HTTP_502_BAD_GATEWAY,
                            detail="discord api returned invalid commands",
                        )
                    existing_name = _read_optional_str(existing_command.get("name"))
                    if existing_name not in DISCORD_LEGACY_RESERVED_COMMAND_NAMES:
                        continue
                    existing_type = existing_command.get("type")
                    if isinstance(existing_type, bool) or not isinstance(existing_type, int):
                        raise HTTPException(
                            status_code=status.HTTP_502_BAD_GATEWAY,
                            detail="discord api returned invalid commands",
                        )
                    if existing_type != 1:
                        continue
                    command_id = _read_optional_str(existing_command.get("id"))
                    if command_id is None or not valid_discord_application_id(command_id):
                        raise HTTPException(
                            status_code=status.HTTP_502_BAD_GATEWAY,
                            detail="discord api returned invalid commands",
                        )
                    legacy_command_ids.append(command_id)
                for command_payload in command_payloads:
                    response = await _discord_command_request(
                        client,
                        account_scope=str(account.id),
                        method="POST",
                        url=url,
                        path=f"{path}/commands",
                        headers=headers,
                        json_payload=command_payload,
                    )
                    _raise_for_discord_command_sync_response(response)
                    synced_command = _validated_synced_discord_command(
                        response,
                        expected_name=_command_name(command_payload),
                    )
                    synced.append(synced_command)
                for command_id in legacy_command_ids:
                    response = await _discord_command_request(
                        client,
                        account_scope=str(account.id),
                        method="DELETE",
                        url=f"{url}/{command_id}",
                        path=f"{path}/commands/{command_id}",
                        headers=headers,
                    )
                    # A concurrent reconciliation can delete the exact ID
                    # discovered above before this request reaches Discord.
                    # That 404 means the required absence already converged.
                    _raise_for_discord_command_sync_response(
                        response,
                        allow_not_found=True,
                    )
                return synced
            for command_payload in command_payloads:
                response = await _discord_command_request(
                    client,
                    account_scope=str(account.id),
                    method="POST",
                    url=url,
                    path=f"{path}/commands",
                    headers={
                        "Authorization": f"Bot {token}",
                        "Content-Type": "application/json",
                    },
                    json_payload=command_payload,
                )
                _raise_for_discord_command_sync_response(response)
                synced.append(
                    _validated_synced_discord_command(
                        response,
                        expected_name=_command_name(command_payload),
                    )
                )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="discord api unreachable",
        ) from exc
    return synced


async def _discord_command_request(
    client: httpx.AsyncClient,
    *,
    account_scope: str,
    method: str,
    url: str,
    path: str,
    headers: dict[str, str],
    json_payload: JsonObject | None = None,
) -> httpx.Response:
    decision = discord_rate_limiter.check(account_scope, method, path)
    if not decision.allowed:
        retry_after = decision.retry_after_seconds
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="discord command sync is rate limited",
            headers={"Retry-After": str(retry_after)} if retry_after is not None else None,
        )
    discord_rate_limiter.consume(account_scope, method, path)
    if json_payload is None:
        response = await client.request(method, url, headers=headers)
    else:
        response = await client.request(method, url, headers=headers, json=json_payload)
    discord_rate_limiter.observe(
        account_scope,
        method,
        path,
        _discord_rate_limit_response_headers(response),
        response.status_code,
    )
    return response


def _discord_rate_limit_response_headers(response: httpx.Response) -> dict[str, str]:
    headers = {str(key).lower(): str(value) for key, value in response.headers.items()}
    if response.status_code != status.HTTP_429_TOO_MANY_REQUESTS or "retry-after" in headers:
        return headers
    raw_retry_after = _response_json_or_text(response).get("retry_after")
    if (
        isinstance(raw_retry_after, (int, float))
        and not isinstance(raw_retry_after, bool)
        and raw_retry_after >= 0
    ):
        headers["retry-after"] = str(raw_retry_after)
    return headers


def _raise_for_discord_command_sync_response(
    response: httpx.Response,
    *,
    allow_not_found: bool = False,
) -> None:
    if allow_not_found and response.status_code == status.HTTP_404_NOT_FOUND:
        return
    if response.status_code == status.HTTP_429_TOO_MANY_REQUESTS:
        retry_after = _discord_rate_limit_response_headers(response).get("retry-after")
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="discord command sync is rate limited",
            headers={"Retry-After": retry_after} if retry_after is not None else None,
        )
    if not status.HTTP_200_OK <= response.status_code < status.HTTP_300_MULTIPLE_CHOICES:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="discord api rejected commands",
        )


def _validated_synced_discord_command(
    response: httpx.Response,
    *,
    expected_name: str,
) -> JsonObject:
    command = _response_json_object(
        response,
        detail="discord api returned invalid commands",
    )
    command_id = _read_optional_str(command.get("id"))
    if (
        _read_optional_str(command.get("name")) != expected_name
        or command.get("type") != 1
        or command_id is None
        or not valid_discord_application_id(command_id)
    ):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="discord api returned invalid commands",
        )
    return command


async def send_whatsapp_message(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    external_chat_id: str,
    text: str,
    bot_agent_link_id: UUID | None = None,
    bind_to_existing: bool = True,
) -> ChannelMessage:
    _require_channel_provider(account, CHANNEL_PROVIDER_WHATSAPP)
    binding = (
        await find_binding(
            db,
            account=account,
            external_chat_id=external_chat_id,
            bot_agent_link_id=bot_agent_link_id,
        )
        if bind_to_existing
        else None
    )
    if bot_agent_link_id is not None:
        if (
            binding is None
            or await lock_active_binding_authority(
                db,
                account=account,
                binding=binding,
                bot_agent_link_id=bot_agent_link_id,
            )
            is None
        ):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="chat is not paired with this agent link",
            )
    elif await _lock_active_account_authority(db, account_id=account.id) is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="channel not found",
        )
    provider_external_chat_id = (
        binding.external_chat_id if binding is not None else external_chat_id
    )
    provider_message_id, _response_payload = await _send_whatsapp_provider_payload(
        account=account,
        external_chat_id=provider_external_chat_id,
        text=text,
    )
    return await _record_outbound_channel_message(
        db,
        account=account,
        binding=binding,
        external_chat_id=provider_external_chat_id,
        provider_message_id=provider_message_id,
        text=text,
        payload=_safe_delivery_provider_response(
            provider=CHANNEL_PROVIDER_WHATSAPP,
            provider_message_id=provider_message_id,
        ),
        delivered_at=datetime.now(UTC),
    )


async def _send_whatsapp_provider_payload(
    *,
    account: ChannelAccount,
    external_chat_id: str,
    text: str,
    provider_payload: JsonObject | None = None,
) -> tuple[str | None, JsonObject]:
    from app.services.whatsapp_provider_bridge import relay_whatsapp_provider_payload

    return await relay_whatsapp_provider_payload(
        account=account,
        external_chat_id=external_chat_id,
        text=text,
        provider_payload=provider_payload,
    )


def _require_channel_provider(account: ChannelAccount, expected: str) -> None:
    if account.provider == expected:
        return
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail=f"{account.provider} send is not implemented yet",
    )


async def _record_outbound_channel_message(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    binding: ChannelBinding | None,
    external_chat_id: str,
    provider_message_id: str | None,
    text: str,
    payload: JsonObject | None,
    delivered_at: datetime | None = None,
) -> ChannelMessage:
    owner_user_id = require_channel_tenant_user_id(
        account,
        tenant_user_id=binding.user_id if binding is not None else None,
    )
    message = ChannelMessage(
        account_id=account.id,
        bot_agent_link_id=binding.bot_agent_link_id if binding else None,
        binding_id=binding.id if binding else None,
        user_id=owner_user_id,
        direction=MESSAGE_DIRECTION_OUTBOUND,
        external_chat_id=external_chat_id,
        provider_message_id=provider_message_id,
        text=text,
        payload=payload,
        delivered_at=delivered_at,
    )
    db.add(message)
    await db.flush()
    return message


async def _post_provider_json(
    *,
    channel: str,
    method: str,
    url: str,
    json_payload: JsonObject,
    timeout_seconds: float,
    unreachable_detail: str,
    rejected_detail: str,
    headers: dict[str, str] | None = None,
    params: dict[str, str] | None = None,
) -> JsonObject:
    await _validate_provider_endpoint_url(
        url,
        channel=channel,
        method=method,
        label=f"{channel} provider url",
    )
    try:
        with track_proxy_latency(channel, method):
            async with httpx.AsyncClient(timeout=timeout_seconds) as client:
                response = await client.post(
                    url,
                    params=params,
                    headers=headers,
                    json=json_payload,
                )
    except httpx.HTTPError as exc:
        outbound_errors.labels(channel=channel, method=method).inc()
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=unreachable_detail,
        ) from exc
    outbound_messages.labels(channel=channel, method=method).inc()
    response_payload = _response_json_or_text(response)
    if (
        channel == CHANNEL_PROVIDER_TELEGRAM
        and response.status_code == status.HTTP_429_TOO_MANY_REQUESTS
    ):
        outbound_errors.labels(channel=channel, method=method).inc()
        retry_after = _telegram_retry_after_seconds(response, response_payload)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="telegram api rate limited",
            headers={"Retry-After": str(retry_after)} if retry_after is not None else None,
        )
    if response.status_code >= 400:
        outbound_errors.labels(channel=channel, method=method).inc()
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=rejected_detail,
        )
    response_object = _response_json_object(
        response,
        detail=f"{channel} provider returned an invalid response",
    )
    if channel == CHANNEL_PROVIDER_TELEGRAM and response_object.get("ok") is not True:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=rejected_detail,
        )
    return response_object


def _telegram_retry_after_seconds(
    response: httpx.Response,
    payload: JsonObject,
) -> float | None:
    raw_header = response.headers.get("retry-after")
    parameters = payload.get("parameters")
    raw_parameter = parameters.get("retry_after") if isinstance(parameters, dict) else None
    for value in (raw_header, raw_parameter):
        if value is None:
            continue
        if not isinstance(value, (str, int, float)) or isinstance(value, bool):
            continue
        try:
            seconds = float(value)
        except (TypeError, ValueError):
            continue
        if seconds >= 0:
            return seconds
    return None


async def _validate_provider_endpoint_url(
    url: str,
    *,
    channel: str,
    method: str,
    label: str,
) -> None:
    try:
        await validate_channel_http_url(url, label=label)
    except UnsafeOutboundUrlError as exc:
        outbound_errors.labels(channel=channel, method=method).inc()
        if channel in {CHANNEL_PROVIDER_TELEGRAM, CHANNEL_PROVIDER_DISCORD}:
            detail = f"{channel} provider url must be a public https URL"
        else:
            # Paused provider behavior is intentionally unchanged.
            detail = str(exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=detail,
        ) from exc


def _telegram_sent_message_id(payload: JsonObject) -> str | None:
    result = payload.get("result")
    if not isinstance(result, dict):
        return None
    message_id = result.get("message_id")
    if isinstance(message_id, bool) or not isinstance(message_id, int) or message_id < 1:
        return None
    return str(message_id)


def verify_discord_signature(
    *,
    account: ChannelAccount,
    body: bytes,
    signature: str | None,
    timestamp: str | None,
) -> bool:
    public_key = _account_config_str(account, "public_key")
    if not public_key or not signature or not timestamp:
        return False
    try:
        key = Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_key))
        key.verify(bytes.fromhex(signature), timestamp.encode("utf-8") + body)
    except (InvalidSignature, ValueError):
        return False
    return True


def verify_webhook_secret(raw: str | None, expected_hash: str) -> bool:
    return bool(raw) and verify_hashed_token(raw, expected_hash)


def discord_chat_from_payload(payload: JsonObject) -> tuple[str, str | None, str | None] | None:
    data = _discord_event_data(payload)
    channel_id = data.get("channel_id")
    if channel_id is None:
        channel = data.get("channel")
        if isinstance(channel, dict):
            channel_id = channel.get("id")
    guild_id = _read_optional_str(data.get("guild_id"))
    if guild_id is not None:
        # A guild binding is keyed by the guild ID. Its display name comes
        # from the bot-authenticated membership preflight, not interaction
        # payload metadata or a duplicate numeric ID.
        return (guild_id, "guild", None)
    if channel_id is None:
        return None
    channel = data.get("channel")
    channel_name = channel.get("name") if isinstance(channel, dict) else None
    return (
        str(channel_id),
        "dm",
        _read_optional_str(channel_name),
    )


def discord_text_from_payload(payload: JsonObject) -> str | None:
    data = _discord_event_data(payload)
    content = _read_optional_str(data.get("content"))
    if content is not None:
        return content
    if payload.get("type") == 2:
        code = discord_pair_code_from_payload(payload)
        if code is not None:
            return f"/{DISCORD_PAIR_COMMAND_NAME} {code}"
    return None


def discord_pair_code_from_payload(payload: JsonObject) -> str | None:
    command = discord_control_command_from_payload(payload)
    return command.code if command is not None and command.kind == "pair" else None


def discord_control_command_from_payload(payload: JsonObject) -> ChannelControlCommand | None:
    data = _discord_event_data(payload)
    text_command = _parse_discord_control_command(_read_optional_str(data.get("content")))
    if text_command is not None:
        return text_command
    interaction_command = data.get("data")
    if not isinstance(interaction_command, dict):
        return None
    name = interaction_command.get("name")
    if name == DISCORD_UNPAIR_COMMAND_NAME:
        return ChannelControlCommand(kind="unpair")
    if name == DISCORD_HELP_COMMAND_NAME:
        options = interaction_command.get("options")
        if isinstance(options, list) and options:
            return ChannelControlCommand(kind="unknown", command=HELP_COMMAND)
        return ChannelControlCommand(kind="help")
    if name != DISCORD_PAIR_COMMAND_NAME:
        return None
    options = interaction_command.get("options")
    if not isinstance(options, list):
        return ChannelControlCommand(kind="pair", code="")
    for option in options:
        if not isinstance(option, dict):
            continue
        if option.get("name") in {"code", "pair_code"}:
            return ChannelControlCommand(kind="pair", code=_read_optional_str(option.get("value")))
    return ChannelControlCommand(kind="pair", code="")


def _parse_discord_control_command(text: str | None) -> ChannelControlCommand | None:
    if not text:
        return None
    trimmed = text.lstrip()
    if not trimmed.startswith("/"):
        return None
    head, separator, rest = trimmed.partition(" ")
    name = head.split("@", 1)[0].removeprefix("/")
    if name == DISCORD_UNPAIR_COMMAND_NAME:
        if separator and rest.strip():
            return ChannelControlCommand(kind="unknown", command=f"/{name}")
        return ChannelControlCommand(kind="unpair")
    if name == DISCORD_HELP_COMMAND_NAME:
        if separator and rest.strip():
            return ChannelControlCommand(kind="unknown", command=HELP_COMMAND)
        return ChannelControlCommand(kind="help")
    if name != DISCORD_PAIR_COMMAND_NAME:
        return None
    code = _single_command_arg(rest) if separator else ""
    return ChannelControlCommand(kind="pair", code=code or "")


def discord_message_id_from_payload(payload: JsonObject) -> str | None:
    return _read_optional_str(_discord_event_data(payload).get("id"))


def discord_external_user_id_from_payload(payload: JsonObject) -> str | None:
    data = _discord_event_data(payload)
    return (
        _dict_identifier(data.get("author"), "id")
        or _dict_identifier(data.get("user"), "id")
        or _nested_identifier(data, "member", "user", "id")
        or _dict_identifier(data.get("member"), "user_id")
        or _dict_identifier(payload.get("author"), "id")
        or _dict_identifier(payload.get("user"), "id")
        or _nested_identifier(payload, "member", "user", "id")
    )


def discord_user_display_name_from_payload(
    payload: JsonObject,
    *,
    external_user_id: str | None,
) -> str | None:
    if external_user_id is None:
        return None
    data = _discord_event_data(payload)
    member = data.get("member")
    candidates = [
        data.get("user"),
        member.get("user") if isinstance(member, dict) else None,
        data.get("author"),
    ]
    for candidate in candidates:
        if not isinstance(candidate, dict) or _dict_identifier(candidate, "id") != external_user_id:
            continue
        return _read_optional_display_name(
            candidate.get("global_name")
        ) or _read_optional_display_name(candidate.get("username"))
    return None


def update_discord_binding_display_name_from_trusted_event(
    binding: ChannelBinding,
    *,
    external_chat_id: str,
    external_chat_type: str | None,
    external_chat_name: str | None,
    external_user_id: str | None,
) -> bool:
    """Apply trusted Discord display metadata without changing routing authority."""
    if binding.external_chat_id != external_chat_id or not discord_binding_matches_chat_type(
        binding,
        external_chat_type=external_chat_type,
    ):
        return False
    incoming_is_dm = (external_chat_type or "").lower() in DISCORD_DM_CHAT_TYPES
    if incoming_is_dm and not binding_is_controlled_by_actor(
        binding,
        external_user_id=external_user_id,
    ):
        return False

    changed = False
    if (
        not incoming_is_dm
        and external_chat_type == "guild"
        and binding.external_chat_type != "guild"
    ):
        # Legacy guild rows used guild_text while already keying external_chat_id
        # by the immutable guild ID. Normalize the type before storing a real
        # display name so command reconciliation never mistakes that name for ID.
        binding.external_chat_type = "guild"
        changed = True
    candidate = _read_optional_display_name(external_chat_name)
    if candidate is None or candidate == external_chat_id:
        return changed
    if binding.external_chat_name != candidate:
        binding.external_chat_name = candidate
        changed = True
    return changed


def discord_channel_scope_from_payload(payload: JsonObject) -> tuple[str | None, str | None]:
    data = _discord_event_data(payload)
    channel_id = _read_optional_str(data.get("channel_id"))
    if channel_id is None:
        channel = data.get("channel")
        if isinstance(channel, dict):
            channel_id = _read_optional_str(channel.get("id"))
    return channel_id, _read_optional_str(data.get("guild_id"))


def extract_discord_routing_key(frame: JsonObject) -> DiscordRoutingKey | None:
    data = frame.get("d")
    if not isinstance(data, dict):
        return None
    event_type = frame.get("t")
    channel_id = _read_optional_str(data.get("channel_id"))
    guild_id = _read_optional_str(data.get("guild_id"))
    channel_type = _optional_int(data.get("channel_type"))
    if channel_id:
        return DiscordRoutingKey(
            chat_id=guild_id or channel_id,
            scope_id=guild_id,
            channel_id=channel_id,
            chat_type=_discord_channel_type_name(
                channel_type,
                "guild_text" if guild_id else "dm",
            ),
        )
    if isinstance(event_type, str) and event_type.startswith("THREAD_"):
        thread_id = _read_optional_str(data.get("id"))
        if thread_id:
            return DiscordRoutingKey(
                chat_id=guild_id or thread_id,
                scope_id=guild_id,
                channel_id=thread_id,
                chat_type=_discord_channel_type_name(
                    _optional_int(data.get("type")),
                    "public_thread",
                ),
            )
    if guild_id:
        return DiscordRoutingKey(
            chat_id=guild_id,
            scope_id=guild_id,
            channel_id=None,
            chat_type="guild_text",
        )
    return None


async def record_discord_dispatch(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    frame: JsonObject,
) -> bool:
    if frame.get("t") == "INTERACTION_CREATE":
        return False
    key = extract_discord_routing_key(frame)
    chat = discord_chat_from_payload(frame)
    if key is not None:
        external_chat_id = key.chat_id
        external_chat_type = "guild" if key.scope_id is not None else key.chat_type
        external_chat_name = chat[2] if chat is not None else key.scope_id
        guild_id = key.scope_id
    elif chat is not None:
        external_chat_id = chat[0]
        external_chat_type = chat[1]
        external_chat_name = chat[2]
        guild_id = discord_channel_scope_from_payload(frame)[1]
    else:
        return False
    command = discord_control_command_from_payload(frame)
    provider_event_id = discord_message_id_from_payload(frame)
    if await channel_control_command_event_was_handled(
        db,
        account=account,
        external_chat_id=external_chat_id,
        provider_event_id=provider_event_id,
        command=command,
    ):
        return True
    external_user_id = discord_external_user_id_from_payload(frame)
    trusted_dm_name = (
        discord_user_display_name_from_payload(
            frame,
            external_user_id=external_user_id,
        )
        if guild_id is None
        else None
    )
    if trusted_dm_name is not None:
        external_chat_name = trusted_dm_name
    admission = await discord_control_command_admission(
        account,
        frame,
        command=command,
        guild_id=guild_id,
        external_user_id=external_user_id,
        trusted_interaction=True,
    )
    if admission.external_chat_name is not None:
        external_chat_name = admission.external_chat_name
    binding_result = await resolve_inbound_binding(
        db,
        account=account,
        external_chat_id=external_chat_id,
        external_chat_type=external_chat_type,
        external_chat_name=external_chat_name,
        external_user_id=external_user_id,
        text=discord_text_from_payload(frame),
        command=command,
        command_denied_reason=admission.denied_reason,
        command_actor_required=True,
    )
    if guild_id is None:
        for binding in binding_result.bindings:
            update_discord_binding_display_name_from_trusted_event(
                binding,
                external_chat_id=external_chat_id,
                external_chat_type=external_chat_type,
                external_chat_name=trusted_dm_name,
                external_user_id=external_user_id,
            )
    if binding_result.binding is None and not binding_result.command_handled:
        return await _record_discord_unpaired_message_and_maybe_instruct(
            db,
            account=account,
            frame=frame,
            authority_chat_id=external_chat_id,
            channel_id=key.channel_id if key is not None else None,
            guild_id=guild_id,
            provider_event_id=provider_event_id,
        )
    data = frame.get("d")
    payload: JsonObject = frame if isinstance(data, dict) else {"d": data}
    messages = await record_inbound_messages_for_bindings(
        db,
        account=account,
        binding_result=binding_result,
        external_chat_id=external_chat_id,
        provider_message_id=provider_event_id,
        text=_read_optional_str(data.get("content")) if isinstance(data, dict) else None,
        payload=payload,
    )
    for message, binding in messages:
        if (
            binding is not None
            and key is not None
            and key.scope_id is not None
            and key.channel_id is not None
            and key.channel_id != key.chat_id
        ):
            await upsert_binding_alias(
                db,
                binding=binding,
                alias_external_chat_id=key.channel_id,
                alias_kind="discord_channel",
                require_same_binding=True,
            )
        await record_discord_interaction_references(
            db,
            account=account,
            binding=binding,
            message=message,
            payload=payload,
        )
        await record_inactive_bot_agent_link_event(db, account=account, binding=binding)
    if binding_result.command_handled:
        reply = discord_control_reply_for_command(command, binding_result, guild_id=guild_id)
        await send_control_command_reply(
            db,
            account=account,
            external_chat_id=external_chat_id,
            send_external_chat_id=key.channel_id if key is not None else None,
            command=command,
            binding_result=binding_result,
            reply=reply,
        )
    return True


async def _record_discord_unpaired_message_and_maybe_instruct(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    frame: JsonObject,
    authority_chat_id: str,
    channel_id: str | None,
    guild_id: str | None,
    provider_event_id: str | None,
) -> bool:
    data = frame.get("d")
    if frame.get("t") != "MESSAGE_CREATE" or not isinstance(data, dict) or channel_id is None:
        return False
    message_type = data.get("type", 0)
    author = data.get("author")
    if (
        # DEFAULT and REPLY are the ordinary user-authored message types.
        # https://discord.com/developers/docs/resources/message#message-object-message-types
        message_type not in {0, 19}
        or not isinstance(author, dict)
        or author.get("bot") is True
        or data.get("webhook_id") is not None
    ):
        return False
    if guild_id is not None:
        application_id = discord_application_id_from_config(account.config)
        mentions = data.get("mentions")
        if (
            application_id is None
            or not isinstance(mentions, list)
            or not any(
                isinstance(mention, dict)
                and _read_optional_str(mention.get("id")) == application_id
                for mention in mentions
            )
        ):
            return False

    await lock_channel_binding_identity(
        db,
        account_id=account.id,
        external_chat_id=authority_chat_id,
    )
    if await find_binding(db, account=account, external_chat_id=authority_chat_id) is not None:
        return False

    tutorial = (
        "This Discord server is not paired. Create a Discord pairing code in Clawdi, "
        "then run /clawdi_pair <code>."
        if guild_id is not None
        else "This Discord chat is not paired. Create a Discord pairing code in Clawdi, "
        "then run /clawdi_pair <code>."
    )
    if account.visibility == CHANNEL_VISIBILITY_PUBLIC and account.user_id is None:
        now = datetime.now(UTC)
        runtime_marker = await find_platform_channel_runtime_marker(
            db,
            account=account,
            kind=_DISCORD_UNPAIRED_TUTORIAL_KIND,
            scope=channel_id,
        )
        if runtime_marker is not None:
            cooldown = (
                _DISCORD_UNPAIRED_TUTORIAL_SUCCESS_COOLDOWN
                if runtime_marker.outcome == "sent"
                else _DISCORD_UNPAIRED_TUTORIAL_FAILURE_BACKOFF
            )
            if runtime_marker.updated_at + cooldown > now:
                return True
        try:
            await send_platform_unbound_channel_message(
                account=account,
                external_chat_id=channel_id,
                text=tutorial,
            )
        except HTTPException as exc:
            record_platform_channel_runtime_marker(
                db,
                account=account,
                marker=runtime_marker,
                kind=_DISCORD_UNPAIRED_TUTORIAL_KIND,
                scope=channel_id,
                outcome="failed",
                occurred_at=now,
            )
            log.warning(
                "discord_unpaired_tutorial_failed account_id=%s channel_id=%s status=%s",
                account.id,
                channel_id,
                exc.status_code,
            )
        except Exception:
            record_platform_channel_runtime_marker(
                db,
                account=account,
                marker=runtime_marker,
                kind=_DISCORD_UNPAIRED_TUTORIAL_KIND,
                scope=channel_id,
                outcome="failed",
                occurred_at=now,
            )
            log.exception(
                "discord_unpaired_tutorial_failed account_id=%s channel_id=%s",
                account.id,
                channel_id,
            )
        else:
            record_platform_channel_runtime_marker(
                db,
                account=account,
                marker=runtime_marker,
                kind=_DISCORD_UNPAIRED_TUTORIAL_KIND,
                scope=channel_id,
                outcome="sent",
                occurred_at=now,
            )
        await db.flush()
        return True

    now = datetime.now(UTC)
    marker_result = InboundBindingResult(binding=None, bindings=())
    messages = await record_inbound_messages_for_bindings(
        db,
        account=account,
        binding_result=marker_result,
        external_chat_id=channel_id,
        provider_message_id=provider_event_id,
        text=None,
        payload={"kind": _DISCORD_UNPAIRED_TUTORIAL_KIND, "outcome": "pending"},
        suppress_duplicate_event=True,
    )
    if not messages:
        return True
    marker = messages[0][0]
    marker.delivered_at = now
    previous = (
        await db.execute(
            select(ChannelMessage)
            .where(
                ChannelMessage.account_id == account.id,
                ChannelMessage.external_chat_id == channel_id,
                ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
                ChannelMessage.id != marker.id,
                func.jsonb_extract_path_text(ChannelMessage.payload, "kind")
                == _DISCORD_UNPAIRED_TUTORIAL_KIND,
                func.jsonb_extract_path_text(ChannelMessage.payload, "outcome").in_(
                    ("sent", "failed")
                ),
            )
            .order_by(ChannelMessage.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if previous is not None:
        previous_payload = previous.payload if isinstance(previous.payload, dict) else {}
        cooldown = (
            _DISCORD_UNPAIRED_TUTORIAL_SUCCESS_COOLDOWN
            if previous_payload.get("outcome") == "sent"
            else _DISCORD_UNPAIRED_TUTORIAL_FAILURE_BACKOFF
        )
        if previous.created_at + cooldown > now:
            marker.payload = {"kind": _DISCORD_UNPAIRED_TUTORIAL_KIND, "outcome": "suppressed"}
            return True

    try:
        await send_discord_message(
            db,
            account=account,
            external_chat_id=channel_id,
            text=tutorial,
            bind_to_existing=False,
        )
    except HTTPException as exc:
        marker.payload = {"kind": _DISCORD_UNPAIRED_TUTORIAL_KIND, "outcome": "failed"}
        log.warning(
            "discord_unpaired_tutorial_failed account_id=%s channel_id=%s status=%s",
            account.id,
            channel_id,
            exc.status_code,
        )
    except Exception:
        marker.payload = {"kind": _DISCORD_UNPAIRED_TUTORIAL_KIND, "outcome": "failed"}
        log.exception(
            "discord_unpaired_tutorial_failed account_id=%s channel_id=%s",
            account.id,
            channel_id,
        )
    else:
        marker.payload = {"kind": _DISCORD_UNPAIRED_TUTORIAL_KIND, "outcome": "sent"}
    return True


def _telegram_update_allowed(update: JsonObject, allowed_updates: set[str]) -> bool:
    if not allowed_updates:
        return True
    for update_type in allowed_updates:
        if update_type in update:
            return True
    return False


def _discord_event_data(payload: JsonObject) -> JsonObject:
    data = payload.get("d")
    if isinstance(data, dict):
        return data
    return payload


def _discord_channel_type_name(value: int | None, fallback: str) -> str:
    if value is None:
        return fallback
    return {
        0: "guild_text",
        1: "dm",
        2: "guild_voice",
        3: "group_dm",
        5: "announcement",
        10: "announcement_thread",
        11: "public_thread",
        12: "private_thread",
        13: "guild_stage_voice",
        15: "guild_forum",
        16: "guild_media",
    }.get(value, fallback)


def _optional_int(value: object) -> int | None:
    return value if isinstance(value, int) else None


def _nested_dict_value(data: JsonObject, *path: str) -> JsonValue:
    current: JsonValue = data
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _response_json_or_text(response: httpx.Response) -> JsonObject:
    try:
        payload = _JSON_VALUE_ADAPTER.validate_json(response.content, strict=True)
    except ValidationError:
        return {"raw": response.text}
    return payload if isinstance(payload, dict) else {"data": payload}


def _response_json_value(response: httpx.Response, *, detail: str) -> JsonValue:
    try:
        return _JSON_VALUE_ADAPTER.validate_json(response.content, strict=True)
    except ValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=detail,
        ) from exc


def _response_json_object(response: httpx.Response, *, detail: str) -> JsonObject:
    payload = _response_json_value(response, detail=detail)
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=detail,
        )
    return payload


async def _delivery_account(db: AsyncSession, delivery: ChannelDelivery) -> ChannelAccount:
    result = await db.execute(
        select(ChannelAccount).where(
            ChannelAccount.id == delivery.account_id,
            ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
            ChannelAccount.archived_at.is_(None),
        )
    )
    account = result.scalar_one_or_none()
    if account is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="channel account is not active",
        )
    return account


async def _delivery_message(db: AsyncSession, delivery: ChannelDelivery) -> ChannelMessage:
    result = await db.execute(
        select(ChannelMessage).where(ChannelMessage.id == delivery.message_id)
    )
    message = result.scalar_one_or_none()
    if message is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="channel message not found",
        )
    return message


async def _lock_active_delivery_link(
    db: AsyncSession,
    delivery: ChannelDelivery,
) -> ChannelBotAgentLink | None:
    if delivery.bot_agent_link_id is None:
        return None

    result = await db.execute(
        select(ChannelBotAgentLink)
        .where(
            ChannelBotAgentLink.id == delivery.bot_agent_link_id,
            ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
            ChannelBotAgentLink.archived_at.is_(None),
        )
        .with_for_update(of=ChannelBotAgentLink, skip_locked=True)
    )
    link = result.scalar_one_or_none()
    if link is not None:
        return link

    state_result = await db.execute(
        select(ChannelBotAgentLink.status, ChannelBotAgentLink.archived_at).where(
            ChannelBotAgentLink.id == delivery.bot_agent_link_id
        )
    )
    state_row = state_result.one_or_none()
    if (
        state_row is not None
        and state_row.status == BOT_AGENT_LINK_STATUS_ACTIVE
        and state_row.archived_at is None
    ):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=DELIVERY_LINK_LOCK_CONTENTION_ERROR,
        )
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="channel agent link archived",
    )


async def _lock_active_delivery_binding(
    db: AsyncSession,
    *,
    delivery: ChannelDelivery,
    message: ChannelMessage,
) -> ChannelBinding | None:
    if delivery.bot_agent_link_id is None:
        return None
    if message.binding_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="channel delivery has no active binding",
        )
    binding = (
        await db.execute(
            select(ChannelBinding)
            .where(
                ChannelBinding.id == message.binding_id,
                ChannelBinding.account_id == delivery.account_id,
                ChannelBinding.bot_agent_link_id == delivery.bot_agent_link_id,
                ChannelBinding.external_chat_id == message.external_chat_id,
            )
            .execution_options(populate_existing=True)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if binding is None or binding.status != BINDING_STATUS_ACTIVE:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="channel binding archived",
        )
    return binding


def _schedule_delivery_retry(
    delivery: ChannelDelivery,
    error: str,
    *,
    use_safe_diagnostics: bool = False,
    retry_after_seconds: float | None = None,
) -> None:
    delivery.locked_at = None
    delivery.locked_by = None
    delivery.last_error = _delivery_error_code(error) if use_safe_diagnostics else error[:1000]
    if delivery.attempts >= delivery.max_attempts:
        delivery.status = DELIVERY_STATUS_FAILED
        return
    delay_seconds = (
        min(max(retry_after_seconds, 0.1), 3600)
        if retry_after_seconds is not None
        else min(2 ** max(delivery.attempts - 1, 0), 300)
    )
    delivery.status = DELIVERY_STATUS_PENDING
    delivery.next_attempt_at = datetime.now(UTC) + timedelta(seconds=delay_seconds)


def _schedule_delivery_link_contention_retry(
    delivery: ChannelDelivery,
    error: str,
    *,
    use_safe_diagnostics: bool = False,
) -> None:
    refunded_attempts = max(delivery.attempts - 1, 0)
    delay_seconds = min(
        2 ** max(refunded_attempts, 0),
        DELIVERY_LINK_LOCK_CONTENTION_MAX_DELAY_SECONDS,
    )
    delivery.attempts = refunded_attempts
    delivery.locked_at = None
    delivery.locked_by = None
    delivery.last_error = _delivery_error_code(error) if use_safe_diagnostics else error[:1000]
    delivery.status = DELIVERY_STATUS_PENDING
    delivery.next_attempt_at = datetime.now(UTC) + timedelta(seconds=delay_seconds)


def _fail_delivery(
    delivery: ChannelDelivery,
    error: str,
    *,
    use_safe_diagnostics: bool = False,
) -> None:
    delivery.locked_at = None
    delivery.locked_by = None
    delivery.last_error = _delivery_error_code(error) if use_safe_diagnostics else error[:1000]
    delivery.status = DELIVERY_STATUS_FAILED


def _is_delivery_link_lock_contention(exc: HTTPException, *, error: str) -> bool:
    return (
        exc.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
        and error == DELIVERY_LINK_LOCK_CONTENTION_ERROR
    )


def _http_exception_detail(exc: HTTPException) -> str:
    try:
        return _HTTP_EXCEPTION_DETAIL_ADAPTER.validate_python(exc.detail, strict=True)
    except ValidationError:
        return "channel delivery failed"


def _http_retry_after_seconds(exc: HTTPException) -> float | None:
    raw = (exc.headers or {}).get("Retry-After")
    if raw is None:
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if value >= 0 else None


def _delivery_error_code(error: str) -> str:
    codes = {
        "channel account archived": DELIVERY_ERROR_ACCOUNT_INACTIVE,
        "channel account is not active": DELIVERY_ERROR_ACCOUNT_INACTIVE,
        "channel agent link archived": DELIVERY_ERROR_LINK_ARCHIVED,
        "channel agent link has no managed runtime authority": DELIVERY_ERROR_LINK_AUTHORITY,
        DELIVERY_LINK_LOCK_CONTENTION_ERROR: DELIVERY_ERROR_LINK_CONTENTION,
        "channel binding archived": DELIVERY_ERROR_BINDING_INACTIVE,
        "channel delivery has no active binding": DELIVERY_ERROR_BINDING_INACTIVE,
        "channel message not found": DELIVERY_ERROR_MESSAGE_MISSING,
        "channel account has no provider token configured": DELIVERY_ERROR_PROVIDER_CREDENTIAL,
        "telegram api unreachable": DELIVERY_ERROR_PROVIDER_UNREACHABLE,
        "discord api unreachable": DELIVERY_ERROR_PROVIDER_UNREACHABLE,
        "telegram api rate limited": DELIVERY_ERROR_PROVIDER_RATE_LIMITED,
        "discord api rate limited": DELIVERY_ERROR_PROVIDER_RATE_LIMITED,
        "telegram api rejected message": DELIVERY_ERROR_PROVIDER_REJECTED,
        "discord api rejected message": DELIVERY_ERROR_PROVIDER_REJECTED,
        "channel delivery failed": DELIVERY_ERROR_FAILED,
        hosted_agent_provider_link_limit_detail(
            CHANNEL_PROVIDER_TELEGRAM,
            duplicate=True,
        ): DELIVERY_ERROR_LINK_AUTHORITY,
        hosted_agent_provider_link_limit_detail(
            CHANNEL_PROVIDER_DISCORD,
            duplicate=True,
        ): DELIVERY_ERROR_LINK_AUTHORITY,
    }
    return codes.get(error, DELIVERY_ERROR_FAILED)


def _safe_delivery_provider_response(
    *,
    provider: str,
    provider_message_id: str | None,
) -> JsonObject:
    response: JsonObject = {"provider": provider, "accepted": True}
    if provider_message_id is not None:
        response["provider_message_id"] = provider_message_id[:300]
    return response


def _discord_delivery_nonce(message_id: UUID) -> str:
    # Discord accepts at most 25 characters. A UUID is non-secret durable
    # identity; base64url preserves all 128 bits in 22 characters.
    return base64.urlsafe_b64encode(message_id.bytes).rstrip(b"=").decode("ascii")


def _command_name(command: JsonObject) -> str:
    value = command.get("name")
    return value if isinstance(value, str) and value else "command"


def _command_description(command: JsonObject) -> str:
    value = command.get("description")
    return value if isinstance(value, str) and value else _command_name(command)


def _discord_command_payload(
    command: JsonObject,
    *,
    account: ChannelAccount,
    global_command: bool,
) -> JsonObject:
    name = _command_name(command)
    payload: JsonObject = {
        "name": name,
        "description": _command_description(command),
        "type": 1,
    }
    if name in DISCORD_RESERVED_COMMAND_NAMES:
        # Discord's provider-specific default keeps Telegram's command payload
        # byte-for-byte unchanged. Server-side interaction checks remain the
        # authority; this only makes Discord hide the commands by default from
        # guild members without MANAGE_GUILD.
        if name in {DISCORD_PAIR_COMMAND_NAME, DISCORD_UNPAIR_COMMAND_NAME}:
            payload["default_member_permissions"] = str(DISCORD_MANAGE_GUILD_PERMISSION)
            if name == DISCORD_PAIR_COMMAND_NAME:
                payload["description"] = (
                    "Pair this server or direct message with Clawdi."
                    if discord_user_install_is_supported(account)
                    else "Pair this server with Clawdi."
                )
            else:
                payload["description"] = (
                    "Disconnect this server or direct message from Clawdi."
                    if discord_user_install_is_supported(account)
                    else "Disconnect this server from Clawdi."
                )
        if global_command:
            # Guild Install is always configured. USER_INSTALL and BOT_DM are
            # included only after /applications/@me verified that the app
            # supports User Install. Unknown capability fails closed.
            # These are global-command fields and are intentionally omitted
            # from guild-scoped writes.
            # https://discord.com/developers/docs/resources/application#application-object-application-integration-types
            # https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object-interaction-context-types
            integration_types: list[JsonValue] = [DISCORD_GUILD_INSTALL]
            contexts: list[JsonValue] = [DISCORD_GUILD_INTERACTION_CONTEXT]
            if discord_user_install_is_supported(account):
                integration_types.append(DISCORD_USER_INSTALL)
                contexts.append(DISCORD_BOT_DM_INTERACTION_CONTEXT)
            payload["integration_types"] = integration_types
            payload["contexts"] = contexts
    options = command.get("options")
    if isinstance(options, list):
        payload["options"] = [option for option in options if isinstance(option, dict)]
    return payload


def _account_config_str(account: ChannelAccount, key: str) -> str | None:
    config: object = account.config
    if not _is_object_dict(config):
        return None
    return _read_optional_str(config.get(key))


def _read_optional_str(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _read_optional_display_name(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def _read_optional_identifier(value: object) -> str | None:
    if isinstance(value, str):
        return value or None
    if isinstance(value, int):
        return str(value)
    return None


def _dict_identifier(value: object, key: str) -> str | None:
    try:
        data = _JSON_OBJECT_ADAPTER.validate_python(value, strict=True)
    except ValidationError:
        return None
    return _read_optional_identifier(data.get(key))


def _nested_identifier(data: JsonObject, *path: str) -> str | None:
    return _read_optional_identifier(_nested_dict_value(data, *path))
