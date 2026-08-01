from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import re
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from time import monotonic
from typing import Any
from uuid import UUID, uuid4

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import HTTPException, status
from sqlalchemy import and_, delete, func, or_, select
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
    CHANNEL_PROVIDER_IMESSAGE,
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
    ChannelAgentCredential,
    ChannelAgentReference,
    ChannelBinding,
    ChannelBindingAlias,
    ChannelBotAgentLink,
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
from app.services.imessage_routing import (
    list_imessage_outbound_chat_guids,
    resolve_imessage_send_chat_guid,
)
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

PAIR_COMMAND = "/bot_pair"
TELEGRAM_PAIR_COMMAND = "/clawdi_pair"
UNPAIR_COMMAND = "/bot_unpair"
TELEGRAM_UNPAIR_COMMAND = "/clawdi_unpair"
DISCORD_PAIR_COMMAND_NAME = "clawdi_pair"
DISCORD_UNPAIR_COMMAND_NAME = "clawdi_unpair"
DISCORD_RESERVED_COMMAND_NAMES = frozenset(
    {
        DISCORD_PAIR_COMMAND_NAME,
        DISCORD_UNPAIR_COMMAND_NAME,
    }
)
DISCORD_LEGACY_RESERVED_COMMAND_NAMES = frozenset({"bot_pair", "bot_unpair"})
PAIR_CODE_PATTERN = re.compile(r"^PAIR[A-Z0-9]{8,}$")
PAIR_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
PAIR_CODE_SUFFIX_LENGTH = 16
TELEGRAM_BOT_USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_]{5,32}bot$", re.IGNORECASE)
DEFAULT_CHANNEL_COMMANDS: tuple[dict[str, Any], ...] = (
    {
        "name": "bot_pair",
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
        "name": "bot_unpair",
        "description": "Disconnect this chat from Clawdi.",
        "options": [],
    },
)
DISCORD_ADMINISTRATOR_PERMISSION = 1 << 3
DISCORD_MANAGE_GUILD_PERMISSION = 1 << 5
DISCORD_GUILD_INSTALL = 0
DISCORD_USER_INSTALL = 1
DISCORD_GUILD_INTERACTION_CONTEXT = 0
DISCORD_BOT_DM_INTERACTION_CONTEXT = 1
DISCORD_RESERVED_COMMAND_VERSION = 3
DISCORD_RESERVED_COMMAND_VERSION_CONFIG_KEY = "discord_reserved_command_version"
DISCORD_INSTALL_CONFIG_VERSION = 1
DISCORD_INSTALL_CONFIG_VERSION_CONFIG_KEY = "discord_install_config_version"
DISCORD_USER_INSTALL_SUPPORTED_CONFIG_KEY = "discord_user_install_supported"
# Discord API docs baseline 07c83a8f1c54accd8e8d13072a5e08d1b1be7ac3.
# ADD_REACTIONS, VIEW_CHANNEL, SEND_MESSAGES, EMBED_LINKS, ATTACH_FILES,
# READ_MESSAGE_HISTORY, and SEND_MESSAGES_IN_THREADS. Never request
# ADMINISTRATOR or MANAGE_GUILD for the bot; pair mutation authority is the
# invoking member's computed permissions. The managed OpenClaw projection
# disables advanced actions that need excluded role permissions; Gateway
# intents are a separate capability and never widen the bot role. The default
# install deliberately excludes CONNECT, SPEAK, MANAGE_MESSAGES, MANAGE_EVENTS,
# and MANAGE_GUILD_EXPRESSIONS.
DISCORD_MINIMAL_BOT_PERMISSIONS = 274_878_024_768
DISCORD_GUILD_PERMISSION_DENIED = "discord_guild_permission_denied"
DISCORD_GUILD_USE_INTERACTION = "discord_guild_use_interaction"
DISCORD_GUILD_INSTALL_REQUIRED = "discord_guild_install_required"
DISCORD_USER_INSTALL_REQUIRED = "discord_user_install_required"
DISCORD_BOT_GUILD_MEMBERSHIP_REQUIRED = "discord_bot_guild_membership_required"
DISCORD_BOT_GUILD_MEMBERSHIP_UNAVAILABLE = "discord_bot_guild_membership_unavailable"
DISCORD_DM_CHAT_TYPES = frozenset({"dm", "direct_messages", "group_dm", "private"})
DELIVERY_LINK_LOCK_CONTENTION_ERROR = "channel agent link is being updated"
DELIVERY_LINK_LOCK_CONTENTION_MAX_DELAY_SECONDS = 30
HERMES_AGENT_TYPE = "hermes"
OPENCLAW_AGENT_TYPE = "openclaw"
HOSTED_RUNTIME_AGENT_TYPES = frozenset({HERMES_AGENT_TYPE, OPENCLAW_AGENT_TYPE})
HOSTED_RUNTIME_SINGLE_ACCOUNT_PROVIDERS = frozenset(
    {CHANNEL_PROVIDER_TELEGRAM, CHANNEL_PROVIDER_DISCORD}
)
STRICT_V2_AGENT_LINK_DETAIL = "Only Cloud Agents can be linked or paired with channels."
WHATSAPP_COMING_SOON_DETAIL = (
    "WhatsApp channels are coming soon for hosted agents. Telegram and Discord are available now."
)


def hosted_agent_provider_link_limit_detail(provider: str, *, duplicate: bool = False) -> str:
    label = {
        CHANNEL_PROVIDER_TELEGRAM: "Telegram",
        CHANNEL_PROVIDER_DISCORD: "Discord",
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


@dataclass(frozen=True)
class DiscordRoutingKey:
    chat_id: str
    scope_id: str | None
    channel_id: str | None
    chat_type: str


@dataclass(frozen=True)
class ChannelPairCommand:
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


def channel_runtime_placeholder_token(provider: str, account_key: str) -> str:
    suffix = hashlib.sha256(f"{provider}:{account_key}".encode()).hexdigest()[:32]
    if provider == CHANNEL_PROVIDER_TELEGRAM:
        return f"999999999:{suffix}"
    return f"clawdi_{suffix}"


def verify_hashed_token(raw: str, expected_hash: str) -> bool:
    return hmac.compare_digest(hash_token(raw), expected_hash)


def generate_webhook_secret() -> str:
    return secrets.token_urlsafe(32)


def generate_pair_code() -> str:
    suffix = "".join(secrets.choice(PAIR_CODE_ALPHABET) for _ in range(PAIR_CODE_SUFFIX_LENGTH))
    return f"PAIR{suffix}"


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
    if provider == CHANNEL_PROVIDER_IMESSAGE:
        return f"im_{secrets.token_urlsafe(36)}"
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


def normalize_telegram_bot_username(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    username = value.strip().lstrip("@")
    return username if TELEGRAM_BOT_USERNAME_PATTERN.fullmatch(username) else None


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
) -> tuple[ChannelBotAgentLink, str | None]:
    link_user_id = user_id or account.user_id
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
            await archive_bot_agent_link(db, link=link)
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
    )
    await ensure_bot_agent_link_capacity(db, account=account)
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
    runtimes = state.runtimes
    if not isinstance(runtimes, dict) or list(runtimes) != [agent.agent_type]:
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
            .where(AgentEnvironment.user_id == user_id)
            .order_by(AgentEnvironment.created_at, AgentEnvironment.id)
        )
    ).all()
    eligible: list[UUID] = []
    for agent, state, fence in rows:
        if not is_strict_v2_hosted_channel_agent(agent, state, fence):
            continue
        if provider == CHANNEL_PROVIDER_WHATSAPP:
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
) -> None:
    agent = (
        await db.execute(
            select(AgentEnvironment)
            .where(
                AgentEnvironment.id == agent_id,
                AgentEnvironment.user_id == user_id,
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if agent is None:
        return

    if (
        account.provider == CHANNEL_PROVIDER_WHATSAPP
        and agent.agent_type in HOSTED_RUNTIME_AGENT_TYPES
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=WHATSAPP_COMING_SOON_DETAIL,
        )

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
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=hosted_agent_provider_link_limit_detail(account.provider),
    )


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
    raw_code = generate_pair_code()
    pair_code = ChannelPairCode(
        account_id=account.id,
        bot_agent_link_id=link.id,
        user_id=link.user_id,
        code_hash=hash_token(raw_code),
        expires_at=datetime.now(UTC) + timedelta(seconds=ttl_seconds),
    )
    db.add(pair_code)
    await db.flush()
    return PairCodeCreateResult(
        pair_code=pair_code,
        code=raw_code,
        link=link,
        agent_token=agent_token,
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
) -> list[tuple[ChannelBotAgentLink, ChannelAccount]]:
    result = await db.execute(
        select(ChannelBotAgentLink, ChannelAccount)
        .join(ChannelAccount, ChannelAccount.id == ChannelBotAgentLink.account_id)
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
    return [(link, account) for link, account in result.all()]


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
    for binding in bindings_result.scalars().all():
        binding.status = BINDING_STATUS_ARCHIVED

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
        _fail_delivery(delivery, "channel agent link archived")

    await db.flush()


async def get_owned_private_channel_account(
    db: AsyncSession,
    *,
    account_id: UUID,
    user_id: UUID,
) -> ChannelAccount:
    """Resolve a user-owned mutable channel account.

    Public channel accounts are Clawdi-managed infrastructure even when their
    database owner is a target user row. User-facing mutable operations must
    only apply to private accounts created by that user.
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
                ChannelAccount.user_id == user_id,
                and_(
                    ChannelAccount.visibility == CHANNEL_VISIBILITY_PUBLIC,
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
                ChannelAccount.user_id == user_id,
                ChannelAccount.visibility == CHANNEL_VISIBILITY_PUBLIC,
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
    for binding in bindings_result.scalars().all():
        binding.status = BINDING_STATUS_ARCHIVED

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
        _fail_delivery(delivery, "channel account archived")

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
        binding.external_chat_name = external_chat_name
        binding.paired_external_user_id = external_user_id
        binding.status = BINDING_STATUS_ACTIVE
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
        alias_filters.append(ChannelBindingAlias.bot_agent_link_id == bot_agent_link_id)
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


async def find_imessage_binding_for_send(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    requested_chat_guid: str,
    bot_agent_link_id: UUID | None = None,
) -> ChannelBinding | None:
    for candidate in list_imessage_outbound_chat_guids(to=requested_chat_guid):
        binding = await find_binding(
            db,
            account=account,
            external_chat_id=candidate,
            bot_agent_link_id=bot_agent_link_id,
        )
        if binding is not None:
            return binding
    return await find_binding(
        db,
        account=account,
        external_chat_id=requested_chat_guid,
        bot_agent_link_id=bot_agent_link_id,
    )


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


async def resolve_inbound_binding(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    external_chat_id: str,
    external_chat_type: str | None,
    external_chat_name: str | None,
    external_user_id: str | None,
    text: str | None,
    command: ChannelPairCommand | None = None,
    command_denied_reason: str | None = None,
    command_actor_required: bool = False,
) -> InboundBindingResult:
    parsed = command if command is not None else parse_pair_command(text)
    if parsed is not None and parsed.kind in {"pair", "unpair"}:
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


def parse_pair_command(text: str | None) -> ChannelPairCommand | None:
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
            return ChannelPairCommand(kind="pair", code=code)
        return None
    if not trimmed.startswith(("/bot_", "/clawdi_")):
        return None
    head, separator, rest = trimmed.partition(" ")
    command = head.split("@", 1)[0]
    if command in {PAIR_COMMAND, TELEGRAM_PAIR_COMMAND}:
        code = _single_command_arg(rest) if separator else ""
        if code is None:
            code = ""
        return ChannelPairCommand(kind="pair", code=code)
    if command in {UNPAIR_COMMAND, TELEGRAM_UNPAIR_COMMAND}:
        if separator and rest.strip():
            return ChannelPairCommand(kind="unknown", command=command)
        return ChannelPairCommand(kind="unpair")
    return ChannelPairCommand(kind="unknown", command=command)


def _single_command_arg(rest: str) -> str | None:
    stripped = rest.strip()
    if not stripped:
        return ""
    parts = stripped.split()
    if len(parts) != 1:
        return None
    return parts[0]


def pairing_reply_for_command(
    command: ChannelPairCommand | None,
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
    if command.kind == "unknown" and command.command:
        return f"Unknown command: {command.command}. Use {pair_command} <code> or {unpair_command}."
    return "Message received."


def discord_guild_command_denied_reason(
    payload: dict[str, Any],
    *,
    command: ChannelPairCommand | None,
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
    is_interaction = payload.get("type") == 2 or payload.get("t") == "INTERACTION_CREATE"
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
    payload: dict[str, Any],
    *,
    command: ChannelPairCommand | None,
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
    payload: dict[str, Any],
    *,
    command: ChannelPairCommand | None,
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
    is_gateway_interaction = payload.get("t") == "INTERACTION_CREATE" and data is not payload
    is_application_command = (
        isinstance(interaction_type, int)
        and not isinstance(interaction_type, bool)
        and interaction_type == 2
        and isinstance(interaction_data, dict)
        and (is_http_interaction or is_gateway_interaction)
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
        owners: dict[str, Any] = {}
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


async def discord_bot_guild_membership_denied_reason(
    account: ChannelAccount,
    *,
    guild_id: str,
) -> str | None:
    """Verify bot membership with Discord before a guild pair code is claimed."""
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
    decision = discord_rate_limiter.check("GET", path)
    if not decision.allowed:
        return DISCORD_BOT_GUILD_MEMBERSHIP_UNAVAILABLE
    try:
        with track_proxy_latency(CHANNEL_PROVIDER_DISCORD, "GET"):
            async with httpx.AsyncClient(timeout=20.0) as client:
                discord_rate_limiter.consume("GET", path)
                response = await client.get(
                    f"{base_url.rstrip('/')}{path}",
                    headers={"Authorization": f"Bot {token}"},
                )
                discord_rate_limiter.observe(
                    "GET",
                    path,
                    _discord_rate_limit_response_headers(response),
                    response.status_code,
                )
    except httpx.HTTPError:
        outbound_errors.labels(channel=CHANNEL_PROVIDER_DISCORD, method="GET").inc()
        return DISCORD_BOT_GUILD_MEMBERSHIP_UNAVAILABLE
    outbound_messages.labels(channel=CHANNEL_PROVIDER_DISCORD, method="GET").inc()
    if response.status_code in {status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND}:
        outbound_errors.labels(channel=CHANNEL_PROVIDER_DISCORD, method="GET").inc()
        return DISCORD_BOT_GUILD_MEMBERSHIP_REQUIRED
    if not 200 <= response.status_code < 300:
        outbound_errors.labels(channel=CHANNEL_PROVIDER_DISCORD, method="GET").inc()
        return DISCORD_BOT_GUILD_MEMBERSHIP_UNAVAILABLE
    response_payload = _response_json_or_text(response)
    if _read_optional_str(response_payload.get("id")) != guild_id:
        return DISCORD_BOT_GUILD_MEMBERSHIP_UNAVAILABLE
    return None


async def discord_pairing_command_denied_reason(
    account: ChannelAccount,
    payload: dict[str, Any],
    *,
    command: ChannelPairCommand | None,
    guild_id: str | None,
    external_user_id: str | None,
    trusted_interaction: bool,
) -> str | None:
    install_reason, cleanup_owner_missing = _discord_pair_install_admission(
        payload,
        command=command,
        guild_id=guild_id,
        external_user_id=external_user_id,
        trusted_interaction=trusted_interaction,
    )
    if install_reason is not None:
        return install_reason
    if not cleanup_owner_missing:
        permission_reason = discord_guild_command_denied_reason(
            payload,
            command=command,
            guild_id=guild_id,
        )
        if permission_reason is not None:
            return permission_reason
    if command is not None and command.kind == "pair" and guild_id is not None:
        return await discord_bot_guild_membership_denied_reason(account, guild_id=guild_id)
    return None


def discord_pairing_reply_for_command(
    command: ChannelPairCommand | None,
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
        return f"Unknown command: {command.command}. Use /clawdi_pair <code> or /clawdi_unpair."
    return pairing_reply_for_command(command, result)


def extract_pair_code(text: str | None) -> str | None:
    command = parse_pair_command(text)
    return command.code if command is not None and command.kind == "pair" else None


async def send_pairing_command_reply(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    external_chat_id: str,
    send_external_chat_id: str | None = None,
    telegram_message_thread_id: int | None = None,
    telegram_direct_messages_topic_id: int | None = None,
    command: ChannelPairCommand | None,
    binding_result: InboundBindingResult,
    reply: str | None = None,
) -> ChannelMessage | None:
    if not binding_result.command_handled:
        return None
    is_telegram = account.provider == CHANNEL_PROVIDER_TELEGRAM
    pair_command = TELEGRAM_PAIR_COMMAND if is_telegram else PAIR_COMMAND
    unpair_command = TELEGRAM_UNPAIR_COMMAND if is_telegram else UNPAIR_COMMAND
    reply_text = reply or pairing_reply_for_command(
        command,
        binding_result,
        pair_command=pair_command,
        unpair_command=unpair_command,
    )
    reply_link_id = (
        binding_result.binding.bot_agent_link_id
        if binding_result.binding is not None and (binding_result.paired or binding_result.unpaired)
        else None
    )
    bind_reply_to_existing = reply_link_id is not None
    try:
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


def telegram_chat_from_update(payload: dict[str, Any]) -> tuple[str, str | None, str | None] | None:
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


def telegram_text_from_update(payload: dict[str, Any]) -> str | None:
    callback_query = payload.get("callback_query")
    if isinstance(callback_query, dict):
        data = _read_optional_str(callback_query.get("data"))
        if data is not None:
            return data
    message = _telegram_message_from_update(payload)
    if not isinstance(message, dict):
        return None
    return _read_optional_str(message.get("text"))


def telegram_message_id_from_update(payload: dict[str, Any]) -> str | None:
    message = _telegram_message_from_update(payload)
    if not isinstance(message, dict):
        return None
    message_id = message.get("message_id")
    return str(message_id) if message_id is not None else None


def telegram_message_thread_id_from_update(payload: dict[str, Any]) -> int | None:
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
        return message_thread_id
    return None


def telegram_direct_messages_topic_id_from_update(payload: dict[str, Any]) -> int | None:
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


def telegram_event_id_from_update(payload: dict[str, Any]) -> str | None:
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


def telegram_event_scope_from_update(payload: dict[str, Any]) -> str:
    update_id = payload.get("update_id")
    if isinstance(update_id, (int, str)) and str(update_id).strip():
        return PROVIDER_EVENT_SCOPE_ACCOUNT
    callback_query = payload.get("callback_query")
    if isinstance(callback_query, dict):
        callback_id = callback_query.get("id")
        if isinstance(callback_id, (int, str)) and str(callback_id).strip():
            return PROVIDER_EVENT_SCOPE_ACCOUNT
    return PROVIDER_EVENT_SCOPE_CHAT


def telegram_external_user_id_from_update(payload: dict[str, Any]) -> str | None:
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


def _telegram_message_from_update(payload: dict[str, Any]) -> dict[str, Any] | None:
    message = payload.get("message") or payload.get("edited_message")
    if isinstance(message, dict):
        return message
    callback_query = payload.get("callback_query")
    if isinstance(callback_query, dict) and isinstance(callback_query.get("message"), dict):
        return callback_query["message"]
    return None


def _telegram_chat_object_from_update(payload: dict[str, Any]) -> dict[str, Any] | None:
    message = _telegram_message_from_update(payload)
    if isinstance(message, dict) and isinstance(message.get("chat"), dict):
        return message["chat"]

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
        if isinstance(update_value, dict) and isinstance(update_value.get("chat"), dict):
            return update_value["chat"]

    return None


async def record_inbound_message(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    binding: ChannelBinding | None,
    external_chat_id: str,
    provider_message_id: str | None,
    text: str | None,
    payload: dict[str, Any],
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
    payload: dict[str, Any],
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
    owner_user_id = binding.user_id if binding is not None else account.user_id
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


async def discord_pairing_command_event_was_handled(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    external_chat_id: str,
    provider_event_id: str | None,
    command: ChannelPairCommand | None,
) -> bool:
    """Serialize pairing mutations and reject a previously handled Discord event."""
    if provider_event_id is None or command is None or command.kind not in {"pair", "unpair"}:
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
    )
    return existing is not None


async def record_inbound_messages_for_bindings(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    binding_result: InboundBindingResult,
    external_chat_id: str,
    provider_message_id: str | None,
    text: str | None,
    payload: dict[str, Any],
    provider_event_id: str | None = None,
    provider_event_scope: str = PROVIDER_EVENT_SCOPE_CHAT,
    suppress_duplicate_event: bool = False,
) -> list[tuple[ChannelMessage, ChannelBinding | None]]:
    target_bindings: tuple[ChannelBinding | None, ...]
    if binding_result.bindings:
        target_bindings = binding_result.bindings
    elif binding_result.binding is not None:
        target_bindings = (binding_result.binding,)
    else:
        target_bindings = (None,)

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


async def record_inactive_bot_agent_link_event(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    binding: ChannelBinding | None,
    link: ChannelBotAgentLink | None = None,
) -> None:
    if binding is None or binding.bot_agent_link_id is None:
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
    metadata: dict[str, Any] | None = None,
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
    owner_user_id = next(iter(owner_user_ids), account.user_id)

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
    payload: dict[str, Any],
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


def _telegram_update_references(payload: dict[str, Any]) -> set[tuple[str, str]]:
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


def telegram_file_ids(payload: Any) -> set[str]:
    file_ids: set[str] = set()
    for node in _walk_json_dicts(payload):
        file_id = node.get("file_id")
        if isinstance(file_id, str) and file_id:
            file_ids.add(file_id)
    return file_ids


def _walk_json_dicts(value: Any) -> list[dict[str, Any]]:
    nodes: list[dict[str, Any]] = []
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
    payload: dict[str, Any],
) -> None:
    data = _discord_event_data(payload)
    interaction_id = _read_optional_str(data.get("id"))
    token = _read_optional_str(data.get("token"))
    if interaction_id is None or token is None:
        return
    application_id = _read_optional_str(data.get("application_id"))
    metadata = {"application_id": application_id} if application_id is not None else None
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


def telegram_update_payload(message: ChannelMessage) -> dict[str, Any]:
    payload = dict(message.payload) if isinstance(message.payload, dict) else {}
    payload.setdefault("update_id", telegram_update_id(message))
    _virtualize_telegram_direct_message_topics(payload)
    return payload


def _virtualize_telegram_direct_message_topics(payload: dict[str, Any]) -> None:
    for container_key in ("message", "edited_message"):
        value = payload.get(container_key)
        if isinstance(value, dict):
            payload[container_key] = _virtualized_telegram_direct_message(value)
    callback_query = payload.get("callback_query")
    if isinstance(callback_query, dict) and isinstance(callback_query.get("message"), dict):
        callback_copy = dict(callback_query)
        callback_copy["message"] = _virtualized_telegram_direct_message(callback_query["message"])
        payload["callback_query"] = callback_copy


def _virtualized_telegram_direct_message(message: dict[str, Any]) -> dict[str, Any]:
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
) -> list[dict[str, Any]]:
    filters = [
        ChannelMessage.account_id == account.id,
        ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
        ChannelMessage.binding_id.is_not(None),
        ChannelMessage.delivered_at.is_(None),
    ]
    if bot_agent_link_id is not None:
        filters.append(ChannelMessage.bot_agent_link_id == bot_agent_link_id)
    result = await db.execute(
        select(ChannelMessage)
        .where(*filters)
        .order_by(ChannelMessage.inbox_sequence, ChannelMessage.created_at)
        .limit(max(limit * 4, limit))
    )
    updates: list[dict[str, Any]] = []
    now = datetime.now(UTC)
    for message in result.scalars().all():
        update = telegram_update_payload(message)
        update_id = telegram_update_id(message)
        if offset is not None and update_id < offset:
            message.delivered_at = now
            continue
        if allowed_updates and not _telegram_update_allowed(update, allowed_updates):
            message.delivered_at = now
            continue
        updates.append(update)
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
) -> list[dict[str, Any]]:
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
        delivered_retention or timedelta(days=settings.channel_message_retention_days)
    )
    unbound_cutoff = current_time - (
        unbound_retention or timedelta(hours=settings.channel_unbound_message_retention_hours)
    )
    result = await db.execute(
        select(ChannelMessage)
        .where(
            or_(
                and_(
                    ChannelMessage.delivered_at.is_not(None),
                    ChannelMessage.delivered_at < delivered_cutoff,
                ),
                and_(
                    ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
                    ChannelMessage.binding_id.is_(None),
                    ChannelMessage.created_at < unbound_cutoff,
                ),
            )
        )
        .order_by(ChannelMessage.created_at, ChannelMessage.id)
        .limit(batch_limit)
    )
    messages = list(result.scalars().all())
    for message in messages:
        await db.delete(message)
    await db.flush()
    return len(messages)


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
) -> int:
    filters = [
        ChannelMessage.account_id == account.id,
        ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
        ChannelMessage.binding_id.is_not(None),
        ChannelMessage.delivered_at.is_(None),
    ]
    if bot_agent_link_id is not None:
        filters.append(ChannelMessage.bot_agent_link_id == bot_agent_link_id)
    result = await db.execute(select(ChannelMessage.id).where(*filters))
    return len(result.scalars().all())


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
    owner_user_id = binding.user_id if binding is not None else account.user_id
    message = ChannelMessage(
        account_id=account.id,
        bot_agent_link_id=binding.bot_agent_link_id if binding else None,
        binding_id=binding.id if binding else None,
        user_id=owner_user_id,
        direction=MESSAGE_DIRECTION_OUTBOUND,
        external_chat_id=external_chat_id,
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
        provider_message_id, provider_response = await send_provider_outbound_payload(
            account=account,
            external_chat_id=message.external_chat_id,
            text=message.text or "",
            provider_payload=_channel_message_provider_payload(message),
        )
    except HTTPException as exc:
        error = _http_exception_detail(exc)
        if _is_delivery_link_lock_contention(exc, error=error):
            _schedule_delivery_link_contention_retry(delivery, error)
        elif exc.status_code < status.HTTP_500_INTERNAL_SERVER_ERROR:
            _fail_delivery(delivery, error)
        else:
            _schedule_delivery_retry(delivery, error)
        await db.flush()
        return delivery

    message.provider_message_id = provider_message_id
    message.payload = _delivery_success_payload(message.payload, provider_response)
    delivery.status = DELIVERY_STATUS_SUCCEEDED
    delivery.locked_at = None
    delivery.locked_by = None
    delivery.last_error = None
    delivery.provider_response = provider_response
    await db.flush()
    return delivery


def _channel_message_provider_payload(message: ChannelMessage) -> dict[str, Any] | None:
    payload = message.payload
    if not isinstance(payload, dict):
        return None
    provider_payload = payload.get("providerPayload")
    if not isinstance(provider_payload, dict):
        return None
    return provider_payload


def _delivery_success_payload(
    existing_payload: Any,
    provider_response: dict[str, Any],
) -> dict[str, Any]:
    if not isinstance(existing_payload, dict):
        return provider_response
    if "delivery" not in existing_payload and "providerPayload" not in existing_payload:
        return provider_response
    payload = dict(existing_payload)
    payload["delivery"] = DELIVERY_STATUS_SUCCEEDED
    payload["providerResponse"] = provider_response
    return payload


async def send_provider_outbound_payload(
    *,
    account: ChannelAccount,
    external_chat_id: str,
    text: str,
    provider_payload: dict[str, Any] | None = None,
) -> tuple[str | None, dict[str, Any]]:
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
        )
    if account.provider == CHANNEL_PROVIDER_WHATSAPP:
        return await _send_whatsapp_provider_payload(
            account=account,
            external_chat_id=external_chat_id,
            text=text,
            provider_payload=provider_payload,
        )
    if account.provider == CHANNEL_PROVIDER_IMESSAGE:
        return await _send_imessage_provider_payload(
            account=account,
            external_chat_id=external_chat_id,
            text=text,
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
    if account.provider == CHANNEL_PROVIDER_IMESSAGE:
        return await send_imessage_message(
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


async def sync_channel_commands(
    *,
    account: ChannelAccount,
    commands: list[dict[str, Any]] | None = None,
    guild_id: str | None = None,
    use_configured_discord_guild: bool | None = None,
) -> list[dict[str, Any]]:
    using_default_commands = commands is None
    command_specs = commands or [dict(command) for command in DEFAULT_CHANNEL_COMMANDS]
    if account.provider == CHANNEL_PROVIDER_TELEGRAM:
        telegram_command_names = {
            PAIR_COMMAND.removeprefix("/"): TELEGRAM_PAIR_COMMAND.removeprefix("/"),
            UNPAIR_COMMAND.removeprefix("/"): TELEGRAM_UNPAIR_COMMAND.removeprefix("/"),
        }
        command_specs = [
            {
                **command,
                "name": telegram_command_names.get(_command_name(command), _command_name(command)),
            }
            for command in command_specs
        ]
        return await sync_telegram_commands(account=account, commands=command_specs)
    if account.provider == CHANNEL_PROVIDER_DISCORD:
        if using_default_commands:
            discord_names = {
                "bot_pair": DISCORD_PAIR_COMMAND_NAME,
                "bot_unpair": DISCORD_UNPAIR_COMMAND_NAME,
            }
            command_specs = [
                {
                    **command,
                    "name": discord_names.get(
                        _command_name(command),
                        _command_name(command),
                    ),
                }
                for command in command_specs
            ]
        else:
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


async def configure_discord_application(account: ChannelAccount) -> dict[str, Any]:
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
    )
    raw_integration_config = identity.get("integration_types_config")
    integration_config = (
        {
            str(key): dict(value)
            for key, value in raw_integration_config.items()
            if isinstance(key, str) and isinstance(value, dict)
        }
        if isinstance(raw_integration_config, dict)
        else {}
    )
    guild_install_params = {
        "scopes": ["applications.commands", "bot"],
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
        method="PATCH",
        url=url,
        headers=headers,
        json_payload={
            "interactions_endpoint_url": channel_webhook_url(account.id, account.provider),
            "install_params": guild_install_params,
            "integration_types_config": integration_config,
        },
    )
    _verify_discord_application_identity(configured, expected_application_id=application_id)
    verified_user_install = _verify_discord_install_configuration(configured)
    config = dict(account.config) if isinstance(account.config, dict) else {}
    config[DISCORD_INSTALL_CONFIG_VERSION_CONFIG_KEY] = DISCORD_INSTALL_CONFIG_VERSION
    config[DISCORD_USER_INSTALL_SUPPORTED_CONFIG_KEY] = verified_user_install
    account.config = config
    return configured


def _verify_discord_install_configuration(payload: dict[str, Any]) -> bool:
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
    config: Any,
    *,
    expected_scopes: set[str],
    expected_permissions: str,
) -> bool:
    if not isinstance(config, dict):
        return False
    install_params = config.get("oauth2_install_params")
    if not isinstance(install_params, dict):
        return False
    scopes = install_params.get("scopes")
    return (
        isinstance(scopes, list)
        and len(scopes) == len(expected_scopes)
        and all(isinstance(scope, str) for scope in scopes)
        and set(scopes) == expected_scopes
        and install_params.get("permissions") == expected_permissions
    )


async def verify_discord_application_token_identity(
    *,
    application_id: str,
    provider_token: str,
    config: dict[str, Any] | None,
) -> dict[str, Any]:
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
        method="GET",
        url=f"{base_url.rstrip('/')}/applications/@me",
        headers={
            "Authorization": f"Bot {provider_token}",
            "Content-Type": "application/json",
        },
    )
    _verify_discord_application_identity(identity, expected_application_id=application_id)
    return identity


def discord_application_id_from_config(config: dict[str, Any] | None) -> str | None:
    if not isinstance(config, dict):
        return None
    return _read_optional_str(config.get("application_id")) or _read_optional_str(
        config.get("app_id")
    )


def require_unchanged_discord_application_identity(
    account: ChannelAccount,
    config: dict[str, Any] | None,
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
    if not isinstance(account.config, dict):
        return False
    version = account.config.get(DISCORD_INSTALL_CONFIG_VERSION_CONFIG_KEY)
    return (
        isinstance(version, int)
        and not isinstance(version, bool)
        and version == DISCORD_INSTALL_CONFIG_VERSION
        and isinstance(
            account.config.get(DISCORD_USER_INSTALL_SUPPORTED_CONFIG_KEY),
            bool,
        )
    )


def discord_user_install_is_supported(account: ChannelAccount) -> bool:
    return (
        discord_install_config_is_current(account)
        and isinstance(account.config, dict)
        and account.config.get(DISCORD_USER_INSTALL_SUPPORTED_CONFIG_KEY) is True
    )


def discord_config_without_unverified_install_state(
    config: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Remove Discord capability state that only provider verification may set."""
    if not isinstance(config, dict):
        return None
    sanitized = dict(config)
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
            if isinstance(guild_id, str) and isinstance(retry, dict)
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
            config["discord_command_retries"] = retries
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


async def _discord_application_request(
    *,
    method: str,
    url: str,
    headers: dict[str, str],
    json_payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    path = "/applications/@me"
    decision = discord_rate_limiter.check(method, path)
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
                discord_rate_limiter.consume(method, path)
                response = await client.request(
                    method,
                    url,
                    headers=headers,
                    json=json_payload,
                )
                discord_rate_limiter.observe(
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
    payload = _response_json_or_text(response)
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Discord returned an invalid application response.",
        )
    return payload


def _verify_discord_application_identity(
    payload: dict[str, Any],
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
    provider_message_id, payload = await _send_telegram_provider_payload(
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
        payload=payload if isinstance(payload, dict) else None,
    )


async def _send_telegram_provider_payload(
    *,
    account: ChannelAccount,
    external_chat_id: str,
    text: str,
    message_thread_id: int | None = None,
    direct_messages_topic_id: int | None = None,
) -> tuple[str | None, dict[str, Any]]:
    token = decrypt_provider_token(account)
    base_url = settings.channel_telegram_api_base_url.strip()
    url = f"{base_url.rstrip('/')}/bot{token}/sendMessage"
    request_payload: dict[str, Any] = {"chat_id": external_chat_id, "text": text}
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
    return _telegram_sent_message_id(payload), payload


async def sync_telegram_commands(
    *,
    account: ChannelAccount,
    commands: list[dict[str, Any]],
) -> list[dict[str, Any]]:
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
    request_payload = {
        "commands": [
            {
                "command": _command_name(command),
                "description": _command_description(command),
            }
            for command in commands
        ],
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(url, json=request_payload)
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="telegram api unreachable",
        ) from exc
    response_payload = _response_json_or_text(response)
    if response.status_code >= 400 or response_payload.get("ok") is False:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="telegram api rejected commands",
        )
    return request_payload["commands"]


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
    provider_message_id, response_payload = await _send_discord_provider_payload(
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
        payload=response_payload,
    )


async def record_discord_outbound_message(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    binding: ChannelBinding,
    external_chat_id: str,
    provider_response: dict[str, Any],
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
    )


async def _send_discord_provider_payload(
    *,
    account: ChannelAccount,
    external_chat_id: str,
    text: str,
) -> tuple[str | None, dict[str, Any]]:
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
    payload = {
        "content": text,
        "allowed_mentions": {"parse": []},
    }
    decision = discord_rate_limiter.check("POST", path)
    if not decision.allowed:
        rate_limit_rejects.labels(
            channel=CHANNEL_PROVIDER_DISCORD,
            scope="bot" if decision.global_limit else "route",
        ).inc()
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "message": "discord route is rate limited",
                "retry_after": decision.retry_after_seconds,
                "global": decision.global_limit,
            },
        )
    try:
        with track_proxy_latency(CHANNEL_PROVIDER_DISCORD, "POST"):
            async with httpx.AsyncClient(timeout=20.0) as client:
                discord_rate_limiter.consume("POST", path)
                response = await client.post(
                    url,
                    headers={"Authorization": f"Bot {token}"},
                    json=payload,
                )
                discord_rate_limiter.observe("POST", path, response.headers, response.status_code)
    except httpx.HTTPError as exc:
        outbound_errors.labels(channel=CHANNEL_PROVIDER_DISCORD, method="POST").inc()
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="discord api unreachable",
        ) from exc
    outbound_messages.labels(channel=CHANNEL_PROVIDER_DISCORD, method="POST").inc()
    if response.status_code >= 400:
        outbound_errors.labels(channel=CHANNEL_PROVIDER_DISCORD, method="POST").inc()
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="discord api rejected message",
        )
    response_payload = _response_json_or_text(response)
    return _read_optional_str(response_payload.get("id")), response_payload


async def sync_discord_commands(
    *,
    account: ChannelAccount,
    commands: list[dict[str, Any]],
    guild_id: str | None,
    reconcile_reserved_commands: bool = False,
    use_configured_guild: bool = True,
) -> list[dict[str, Any]]:
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
    synced: list[dict[str, Any]] = []
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
                    method="GET",
                    url=url,
                    path=f"{path}/commands",
                    headers=headers,
                )
                _raise_for_discord_command_sync_response(response)
                existing_commands = _response_json_or_text(response).get("data")
                if not isinstance(existing_commands, list) or not all(
                    isinstance(command, dict) for command in existing_commands
                ):
                    raise HTTPException(
                        status_code=status.HTTP_502_BAD_GATEWAY,
                        detail="discord api returned invalid commands",
                    )
                legacy_command_ids: list[str] = []
                for existing_command in existing_commands:
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
                        method="POST",
                        url=url,
                        path=f"{path}/commands",
                        headers=headers,
                        json_payload=command_payload,
                    )
                    _raise_for_discord_command_sync_response(response)
                    synced_command = _response_json_or_text(response)
                    synced_command_id = _read_optional_str(synced_command.get("id"))
                    if (
                        _read_optional_str(synced_command.get("name")) != command_payload["name"]
                        or synced_command.get("type") != 1
                        or synced_command_id is None
                        or not valid_discord_application_id(synced_command_id)
                    ):
                        raise HTTPException(
                            status_code=status.HTTP_502_BAD_GATEWAY,
                            detail="discord api returned invalid commands",
                        )
                    synced.append(synced_command)
                for command_id in legacy_command_ids:
                    response = await _discord_command_request(
                        client,
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
                synced.append(_response_json_or_text(response))
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="discord api unreachable",
        ) from exc
    return synced


async def _discord_command_request(
    client: httpx.AsyncClient,
    *,
    method: str,
    url: str,
    path: str,
    headers: dict[str, str],
    json_payload: dict[str, Any] | None = None,
) -> httpx.Response:
    decision = discord_rate_limiter.check(method, path)
    if not decision.allowed:
        retry_after = decision.retry_after_seconds
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="discord command sync is rate limited",
            headers={"Retry-After": str(retry_after)} if retry_after is not None else None,
        )
    discord_rate_limiter.consume(method, path)
    if json_payload is None:
        response = await client.request(method, url, headers=headers)
    else:
        response = await client.request(method, url, headers=headers, json=json_payload)
    discord_rate_limiter.observe(
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
    provider_message_id, response_payload = await _send_whatsapp_provider_payload(
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
        payload=response_payload,
    )


async def _send_whatsapp_provider_payload(
    *,
    account: ChannelAccount,
    external_chat_id: str,
    text: str,
    provider_payload: dict[str, Any] | None = None,
) -> tuple[str | None, dict[str, Any]]:
    token = decrypt_provider_token(account)
    phone_number_id = _require_account_config_str(account, "phone_number_id")
    base_url = (
        _account_config_str(account, "graph_api_base_url")
        or settings.channel_whatsapp_graph_api_base_url.strip()
    )
    await _validate_provider_endpoint_url(
        base_url,
        channel=CHANNEL_PROVIDER_WHATSAPP,
        method="messages",
        label="whatsapp graph api base url",
    )
    url = f"{base_url.rstrip('/')}/{phone_number_id}/messages"
    request_payload = _whatsapp_cloud_request_payload(
        external_chat_id=external_chat_id,
        text=text,
        provider_payload=provider_payload,
    )
    response_payload = await _post_provider_json(
        channel=CHANNEL_PROVIDER_WHATSAPP,
        method="messages",
        url=url,
        headers={"Authorization": f"Bearer {token}"},
        json_payload=request_payload,
        timeout_seconds=20.0,
        unreachable_detail="whatsapp api unreachable",
        rejected_detail="whatsapp api rejected message",
    )
    message_id = None
    messages = response_payload.get("messages")
    if isinstance(messages, list) and messages and isinstance(messages[0], dict):
        message_id = _read_optional_str(messages[0].get("id"))
    return message_id, response_payload


def _whatsapp_cloud_request_payload(
    *,
    external_chat_id: str,
    text: str,
    provider_payload: dict[str, Any] | None,
) -> dict[str, Any]:
    if provider_payload is None:
        return _whatsapp_cloud_text_payload(
            to=_whatsapp_cloud_recipient_id(external_chat_id),
            text=text,
            context=None,
        )

    message_type = _read_optional_str(provider_payload.get("type"))
    if message_type == "text":
        text_payload = provider_payload.get("text")
        if not isinstance(text_payload, dict):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="invalid whatsapp text payload",
            )
        body = _read_optional_str(text_payload.get("body"))
        if body is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="invalid whatsapp text body",
            )
        return _whatsapp_cloud_text_payload(
            to=_whatsapp_cloud_recipient_id(external_chat_id),
            text=body,
            context=_whatsapp_cloud_context_payload(provider_payload),
        )

    if message_type in {"image", "audio"}:
        return _whatsapp_cloud_media_payload(
            external_chat_id=external_chat_id,
            provider_payload=provider_payload,
            media_type=message_type,
        )

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="unsupported whatsapp outbound payload type",
    )


def _whatsapp_cloud_text_payload(
    *,
    to: str,
    text: str,
    context: dict[str, str] | None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "messaging_product": "whatsapp",
        "to": to,
        "type": "text",
        "text": {"body": text},
    }
    if context is not None:
        payload["context"] = context
    return payload


def _whatsapp_cloud_media_payload(
    *,
    external_chat_id: str,
    provider_payload: dict[str, Any],
    media_type: str,
) -> dict[str, Any]:
    media_payload = provider_payload.get(media_type)
    if not isinstance(media_payload, dict):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"invalid whatsapp {media_type} payload",
        )
    media_id = _read_optional_str(media_payload.get("id"))
    media_link = _read_optional_str(media_payload.get("link"))
    if (media_id is None and media_link is None) or (
        media_id is not None and media_link is not None
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"whatsapp {media_type} payload requires exactly one of id or link",
        )
    if media_id is not None:
        media: dict[str, str] = {"id": media_id}
    elif media_link is not None:
        media = {"link": media_link}
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"whatsapp {media_type} payload requires exactly one of id or link",
        )
    caption = _read_optional_str(media_payload.get("caption"))
    if media_type == "image" and caption is not None:
        media["caption"] = caption
    payload: dict[str, Any] = {
        "messaging_product": "whatsapp",
        "to": _whatsapp_cloud_recipient_id(external_chat_id),
        "type": media_type,
        media_type: media,
    }
    context = _whatsapp_cloud_context_payload(provider_payload)
    if context is not None:
        payload["context"] = context
    return payload


def _whatsapp_cloud_context_payload(provider_payload: dict[str, Any]) -> dict[str, str] | None:
    context = provider_payload.get("context")
    if not isinstance(context, dict):
        return None
    message_id = _read_optional_str(context.get("message_id"))
    if message_id is None:
        return None
    return {"message_id": message_id}


def _whatsapp_cloud_recipient_id(external_chat_id: str) -> str:
    if "@" not in external_chat_id:
        return external_chat_id
    user_part, server = external_chat_id.rsplit("@", 1)
    if server not in {"s.whatsapp.net", "c.us"}:
        return external_chat_id
    if ":" in user_part:
        user_part, _device = user_part.split(":", 1)
    return user_part or external_chat_id


async def send_imessage_message(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    external_chat_id: str,
    text: str,
    bot_agent_link_id: UUID | None = None,
    bind_to_existing: bool = True,
) -> ChannelMessage:
    _require_channel_provider(account, CHANNEL_PROVIDER_IMESSAGE)
    binding = (
        await find_imessage_binding_for_send(
            db,
            account=account,
            requested_chat_guid=external_chat_id,
            bot_agent_link_id=bot_agent_link_id,
        )
        if bind_to_existing
        else None
    )
    bound_chat_guid = binding.external_chat_id if binding is not None else external_chat_id
    provider_chat_guid = resolve_imessage_send_chat_guid(
        requested_chat_guid=external_chat_id,
        bound_chat_guid=bound_chat_guid,
    )
    provider_message_id, response_payload = await _send_imessage_provider_payload(
        account=account,
        external_chat_id=provider_chat_guid,
        text=text,
    )
    return await _record_outbound_channel_message(
        db,
        account=account,
        binding=binding,
        external_chat_id=bound_chat_guid,
        provider_message_id=provider_message_id,
        text=text,
        payload=response_payload,
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
    payload: dict[str, Any] | None,
) -> ChannelMessage:
    owner_user_id = binding.user_id if binding is not None else account.user_id
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
    )
    db.add(message)
    await db.flush()
    return message


async def _send_imessage_provider_payload(
    *,
    account: ChannelAccount,
    external_chat_id: str,
    text: str,
) -> tuple[str | None, dict[str, Any]]:
    server_url = _require_account_config_str(account, "server_url")
    await _validate_provider_endpoint_url(
        server_url,
        channel=CHANNEL_PROVIDER_IMESSAGE,
        method="message/text",
        label="imessage server url",
    )
    token = decrypt_provider_token(account)
    auth_mode = _account_config_str(account, "auth_mode") or "password_query"
    headers: dict[str, str] = {"Content-Type": "application/json"}
    params: dict[str, str] = {}
    if auth_mode == "x_api_key":
        headers["X-API-Key"] = token
    elif auth_mode == "bearer":
        headers["Authorization"] = f"Bearer {token}"
    else:
        params["password"] = token
    request_payload = {
        "chatGuid": external_chat_id,
        "message": text,
        "text": text,
        "method": _account_config_str(account, "send_method") or "private-api",
    }
    response_payload = await _post_provider_json(
        channel=CHANNEL_PROVIDER_IMESSAGE,
        method="message/text",
        url=f"{server_url.rstrip('/')}/api/v1/message/text",
        params=params,
        headers=headers,
        json_payload=request_payload,
        timeout_seconds=30.0,
        unreachable_detail="imessage api unreachable",
        rejected_detail="imessage api rejected message",
    )
    data = response_payload.get("data")
    provider_message_id = None
    if isinstance(data, dict):
        provider_message_id = _read_optional_str(data.get("guid")) or _read_optional_str(
            data.get("messageId")
        )
    return provider_message_id, response_payload


async def _post_provider_json(
    *,
    channel: str,
    method: str,
    url: str,
    json_payload: dict[str, Any],
    timeout_seconds: float,
    unreachable_detail: str,
    rejected_detail: str,
    headers: dict[str, str] | None = None,
    params: dict[str, str] | None = None,
) -> dict[str, Any]:
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
    if response.status_code >= 400:
        outbound_errors.labels(channel=channel, method=method).inc()
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=rejected_detail,
        )
    return _response_json_or_text(response)


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
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc


def _telegram_sent_message_id(payload: dict[str, Any]) -> str | None:
    result = payload.get("result")
    if not isinstance(result, dict):
        return None
    message_id = result.get("message_id")
    return str(message_id) if message_id is not None else None


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


def verify_hub_signature(*, body: bytes, header: str | None, secret: str | None) -> bool:
    if not header or not secret:
        return False
    prefix = "sha256="
    if not header.startswith(prefix):
        return False
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(header[len(prefix) :], digest)


def discord_chat_from_payload(payload: dict[str, Any]) -> tuple[str, str | None, str | None] | None:
    data = _discord_event_data(payload)
    channel_id = data.get("channel_id")
    if channel_id is None:
        channel = data.get("channel")
        if isinstance(channel, dict):
            channel_id = channel.get("id")
    guild_id = _read_optional_str(data.get("guild_id"))
    if guild_id is not None:
        return (guild_id, "guild_text", guild_id)
    if channel_id is None:
        return None
    channel = data.get("channel")
    channel_name = channel.get("name") if isinstance(channel, dict) else None
    return (
        str(channel_id),
        "dm",
        _read_optional_str(channel_name),
    )


def discord_text_from_payload(payload: dict[str, Any]) -> str | None:
    data = _discord_event_data(payload)
    content = _read_optional_str(data.get("content"))
    if content is not None:
        return content
    if payload.get("type") == 2:
        code = discord_pair_code_from_payload(payload)
        if code is not None:
            return f"/{DISCORD_PAIR_COMMAND_NAME} {code}"
    return None


def discord_pair_code_from_payload(payload: dict[str, Any]) -> str | None:
    command = discord_pair_command_from_payload(payload)
    return command.code if command is not None and command.kind == "pair" else None


def discord_pair_command_from_payload(payload: dict[str, Any]) -> ChannelPairCommand | None:
    data = _discord_event_data(payload)
    text_command = _parse_discord_pair_command(_read_optional_str(data.get("content")))
    if text_command is not None:
        return text_command
    interaction_command = data.get("data")
    if not isinstance(interaction_command, dict):
        return None
    name = interaction_command.get("name")
    if name == DISCORD_UNPAIR_COMMAND_NAME:
        return ChannelPairCommand(kind="unpair")
    if name != DISCORD_PAIR_COMMAND_NAME:
        return None
    options = interaction_command.get("options")
    if not isinstance(options, list):
        return ChannelPairCommand(kind="pair", code="")
    for option in options:
        if not isinstance(option, dict):
            continue
        if option.get("name") in {"code", "pair_code"}:
            return ChannelPairCommand(kind="pair", code=_read_optional_str(option.get("value")))
    return ChannelPairCommand(kind="pair", code="")


def _parse_discord_pair_command(text: str | None) -> ChannelPairCommand | None:
    if not text:
        return None
    trimmed = text.lstrip()
    if not trimmed.startswith("/"):
        return None
    head, separator, rest = trimmed.partition(" ")
    name = head.split("@", 1)[0].removeprefix("/")
    if name == DISCORD_UNPAIR_COMMAND_NAME:
        if separator and rest.strip():
            return ChannelPairCommand(kind="unknown", command=f"/{name}")
        return ChannelPairCommand(kind="unpair")
    if name != DISCORD_PAIR_COMMAND_NAME:
        return None
    code = _single_command_arg(rest) if separator else ""
    return ChannelPairCommand(kind="pair", code=code or "")


def discord_message_id_from_payload(payload: dict[str, Any]) -> str | None:
    return _read_optional_str(_discord_event_data(payload).get("id"))


def discord_external_user_id_from_payload(payload: dict[str, Any]) -> str | None:
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


def discord_channel_scope_from_payload(payload: dict[str, Any]) -> tuple[str | None, str | None]:
    data = _discord_event_data(payload)
    channel_id = _read_optional_str(data.get("channel_id"))
    if channel_id is None:
        channel = data.get("channel")
        if isinstance(channel, dict):
            channel_id = _read_optional_str(channel.get("id"))
    return channel_id, _read_optional_str(data.get("guild_id"))


def extract_discord_routing_key(frame: dict[str, Any]) -> DiscordRoutingKey | None:
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
    frame: dict[str, Any],
) -> bool:
    key = extract_discord_routing_key(frame)
    chat = discord_chat_from_payload(frame)
    if key is not None:
        external_chat_id = key.chat_id
        external_chat_type = key.chat_type
        external_chat_name = chat[2] if chat is not None else key.scope_id
        guild_id = key.scope_id
    elif chat is not None:
        external_chat_id = chat[0]
        external_chat_type = chat[1]
        external_chat_name = chat[2]
        guild_id = discord_channel_scope_from_payload(frame)[1]
    else:
        return False
    command = discord_pair_command_from_payload(frame)
    provider_event_id = discord_message_id_from_payload(frame)
    if await discord_pairing_command_event_was_handled(
        db,
        account=account,
        external_chat_id=external_chat_id,
        provider_event_id=provider_event_id,
        command=command,
    ):
        return True
    external_user_id = discord_external_user_id_from_payload(frame)
    binding_result = await resolve_inbound_binding(
        db,
        account=account,
        external_chat_id=external_chat_id,
        external_chat_type=external_chat_type,
        external_chat_name=external_chat_name,
        external_user_id=external_user_id,
        text=discord_text_from_payload(frame),
        command=command,
        command_denied_reason=await discord_pairing_command_denied_reason(
            account,
            frame,
            command=command,
            guild_id=guild_id,
            external_user_id=external_user_id,
            trusted_interaction=True,
        ),
        command_actor_required=True,
    )
    if binding_result.binding is None and not binding_result.command_handled:
        return False
    data = frame.get("d")
    payload = frame if isinstance(data, dict) else {"d": data}
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
        reply = discord_pairing_reply_for_command(command, binding_result, guild_id=guild_id)
        await send_pairing_command_reply(
            db,
            account=account,
            external_chat_id=external_chat_id,
            send_external_chat_id=key.channel_id if key is not None else None,
            command=command,
            binding_result=binding_result,
            reply=reply,
        )
    return True


def imessage_chat_from_payload(
    payload: dict[str, Any],
) -> tuple[str, str | None, str | None] | None:
    data = _imessage_event_data(payload)
    chat_guid = _read_optional_str(data.get("chatGuid")) or _read_optional_str(
        data.get("chat_guid")
    )
    chat_name = _read_optional_str(data.get("displayName")) or _read_optional_str(
        data.get("chatIdentifier")
    )
    chats = data.get("chats")
    if not chat_guid and isinstance(chats, list) and chats and isinstance(chats[0], dict):
        chat_guid = _read_optional_str(chats[0].get("guid"))
        chat_name = chat_name or _read_optional_str(chats[0].get("displayName"))
    if not chat_guid:
        chat = data.get("chat")
        if isinstance(chat, dict):
            chat_guid = _read_optional_str(chat.get("guid"))
            chat_name = chat_name or _read_optional_str(chat.get("displayName"))
    if not chat_guid:
        return None
    chat_type = "group" if "chat" in chat_guid.lower() else "dm"
    return chat_guid, chat_type, chat_name


def imessage_text_from_payload(payload: dict[str, Any]) -> str | None:
    data = _imessage_event_data(payload)
    return _read_optional_str(data.get("text")) or _read_optional_str(data.get("message"))


def imessage_message_id_from_payload(payload: dict[str, Any]) -> str | None:
    data = _imessage_event_data(payload)
    return _read_optional_str(data.get("guid")) or _read_optional_str(data.get("messageGuid"))


def imessage_external_user_id_from_payload(payload: dict[str, Any]) -> str | None:
    data = _imessage_event_data(payload)
    for key in (
        "sender",
        "from",
        "fromAddress",
        "handleAddress",
        "handleId",
        "handleGuid",
        "address",
    ):
        actor_id = _read_optional_identifier(data.get(key))
        if actor_id is not None:
            return actor_id

    for key in ("handle", "sender", "from"):
        actor = data.get(key)
        actor_id = (
            _dict_identifier(actor, "address")
            or _dict_identifier(actor, "id")
            or _dict_identifier(actor, "guid")
            or _dict_identifier(actor, "uncanonicalizedId")
        )
        if actor_id is not None:
            return actor_id

    chat = imessage_chat_from_payload(payload)
    if chat is not None and chat[1] == "dm":
        return chat[0]
    return None


def whatsapp_chat_from_payload(
    payload: dict[str, Any],
) -> tuple[str, str | None, str | None] | None:
    message, value = _whatsapp_message_and_value(payload)
    if message is None:
        return None
    chat_id = message.get("from")
    if chat_id is None:
        key = message.get("key")
        if isinstance(key, dict):
            chat_id = key.get("remoteJid")
    if chat_id is None:
        return None
    name = None
    contacts = value.get("contacts") if isinstance(value, dict) else None
    if isinstance(contacts, list) and contacts and isinstance(contacts[0], dict):
        profile = contacts[0].get("profile")
        if isinstance(profile, dict):
            name = _read_optional_str(profile.get("name"))
    chat_id_str = str(chat_id)
    chat_type = "group" if chat_id_str.endswith("@g.us") else "dm"
    return chat_id_str, chat_type, name


def whatsapp_jids_from_payload(payload: dict[str, Any]) -> tuple[str | None, str | None]:
    message, _value = _whatsapp_message_and_value(payload)
    if message is None:
        return None, None
    remote_jid: Any = message.get("from")
    alt_jid: Any = None
    key = message.get("key")
    if isinstance(key, dict):
        remote_jid = remote_jid or key.get("remoteJid")
        alt_jid = key.get("remoteJidAlt") or key.get("participantAlt")
    return _read_optional_str(remote_jid), _read_optional_str(alt_jid)


def whatsapp_text_from_payload(payload: dict[str, Any]) -> str | None:
    message, _value = _whatsapp_message_and_value(payload)
    if message is None:
        return None
    text = message.get("text")
    if isinstance(text, dict):
        return _read_optional_str(text.get("body"))
    msg = message.get("message")
    if isinstance(msg, dict):
        return _whatsapp_text_from_message_tree(msg)
    return None


def whatsapp_message_id_from_payload(payload: dict[str, Any]) -> str | None:
    message, _value = _whatsapp_message_and_value(payload)
    if message is None:
        return None
    key = message.get("key")
    if isinstance(key, dict):
        return _read_optional_str(key.get("id"))
    return _read_optional_str(message.get("id"))


def whatsapp_external_user_id_from_payload(payload: dict[str, Any]) -> str | None:
    message, _value = _whatsapp_message_and_value(payload)
    if message is None:
        return None

    for key_name in (
        "participant",
        "author",
        "sender",
        "senderJid",
        "senderPnJid",
        "senderLidJid",
    ):
        actor_id = _read_optional_identifier(message.get(key_name))
        if actor_id is not None:
            return actor_id

    key = message.get("key")
    if isinstance(key, dict):
        for key_name in (
            "participant",
            "participantAlt",
            "senderPnJid",
            "senderLidJid",
            "participantPnJid",
            "participantLidJid",
        ):
            actor_id = _read_optional_identifier(key.get(key_name))
            if actor_id is not None:
                return actor_id

    from_id = _read_optional_identifier(message.get("from"))
    remote_jid = _read_optional_identifier(key.get("remoteJid")) if isinstance(key, dict) else None
    for fallback in (from_id, remote_jid):
        if fallback is not None and not fallback.endswith("@g.us"):
            return fallback
    return None


def whatsapp_from_me_from_payload(payload: dict[str, Any]) -> bool:
    message, _value = _whatsapp_message_and_value(payload)
    if message is None:
        return False
    key = message.get("key")
    return isinstance(key, dict) and key.get("fromMe") is True


def _telegram_update_allowed(update: dict[str, Any], allowed_updates: set[str]) -> bool:
    if not allowed_updates:
        return True
    for update_type in allowed_updates:
        if update_type in update:
            return True
    return False


def _discord_event_data(payload: dict[str, Any]) -> dict[str, Any]:
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


def _optional_int(value: Any) -> int | None:
    return value if isinstance(value, int) else None


def _imessage_event_data(payload: dict[str, Any]) -> dict[str, Any]:
    data = payload.get("data")
    if isinstance(data, dict):
        return data
    return payload


def _whatsapp_message_and_value(
    payload: dict[str, Any],
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    entry = payload.get("entry")
    if isinstance(entry, list) and entry:
        first_entry = entry[0]
        if isinstance(first_entry, dict):
            changes = first_entry.get("changes")
            if isinstance(changes, list) and changes:
                first_change = changes[0]
                if isinstance(first_change, dict):
                    value = first_change.get("value")
                    if isinstance(value, dict):
                        messages = value.get("messages")
                        if (
                            isinstance(messages, list)
                            and messages
                            and isinstance(messages[0], dict)
                        ):
                            return messages[0], value
    message = payload.get("message")
    if isinstance(message, dict):
        return message, payload
    messages = payload.get("messages")
    if isinstance(messages, list) and messages and isinstance(messages[0], dict):
        return messages[0], payload
    return None, payload


def _nested_dict_value(data: dict[str, Any], *path: str) -> Any:
    current: Any = data
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _whatsapp_text_from_message_tree(message: dict[str, Any]) -> str | None:
    stack: list[Any] = [message]
    visited = 0
    while stack and visited < 512:
        current = stack.pop()
        visited += 1
        if isinstance(current, dict):
            conversation = _read_optional_str(current.get("conversation"))
            if conversation is not None:
                return conversation
            extended_text = current.get("extendedTextMessage")
            if isinstance(extended_text, dict):
                text = _read_optional_str(extended_text.get("text"))
                if text is not None:
                    return text
            for value in reversed(list(current.values())):
                if isinstance(value, (dict, list)):
                    stack.append(value)
        elif isinstance(current, list):
            stack.extend(reversed(current))
    return None


def _response_json_or_text(response: httpx.Response) -> dict[str, Any]:
    try:
        payload = response.json()
    except ValueError:
        return {"raw": response.text}
    return payload if isinstance(payload, dict) else {"data": payload}


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


def _schedule_delivery_retry(delivery: ChannelDelivery, error: str) -> None:
    delivery.locked_at = None
    delivery.locked_by = None
    delivery.last_error = error[:1000]
    if delivery.attempts >= delivery.max_attempts:
        delivery.status = DELIVERY_STATUS_FAILED
        return
    delay_seconds = min(2 ** max(delivery.attempts - 1, 0), 300)
    delivery.status = DELIVERY_STATUS_PENDING
    delivery.next_attempt_at = datetime.now(UTC) + timedelta(seconds=delay_seconds)


def _schedule_delivery_link_contention_retry(delivery: ChannelDelivery, error: str) -> None:
    refunded_attempts = max(delivery.attempts - 1, 0)
    delay_seconds = min(
        2 ** max(refunded_attempts, 0),
        DELIVERY_LINK_LOCK_CONTENTION_MAX_DELAY_SECONDS,
    )
    delivery.attempts = refunded_attempts
    delivery.locked_at = None
    delivery.locked_by = None
    delivery.last_error = error[:1000]
    delivery.status = DELIVERY_STATUS_PENDING
    delivery.next_attempt_at = datetime.now(UTC) + timedelta(seconds=delay_seconds)


def _fail_delivery(delivery: ChannelDelivery, error: str) -> None:
    delivery.locked_at = None
    delivery.locked_by = None
    delivery.last_error = error[:1000]
    delivery.status = DELIVERY_STATUS_FAILED


def _is_delivery_link_lock_contention(exc: HTTPException, *, error: str) -> bool:
    return (
        exc.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
        and error == DELIVERY_LINK_LOCK_CONTENTION_ERROR
    )


def _http_exception_detail(exc: HTTPException) -> str:
    return exc.detail if isinstance(exc.detail, str) else "channel delivery failed"


def _command_name(command: dict[str, Any]) -> str:
    value = command.get("name")
    return value if isinstance(value, str) and value else "command"


def _command_description(command: dict[str, Any]) -> str:
    value = command.get("description")
    return value if isinstance(value, str) and value else _command_name(command)


def _discord_command_payload(
    command: dict[str, Any],
    *,
    account: ChannelAccount,
    global_command: bool,
) -> dict[str, Any]:
    name = _command_name(command)
    payload: dict[str, Any] = {
        "name": name,
        "description": _command_description(command),
        "type": 1,
    }
    if name in DISCORD_RESERVED_COMMAND_NAMES:
        # Discord's provider-specific default keeps Telegram's command payload
        # byte-for-byte unchanged. Server-side interaction checks remain the
        # authority; this only makes Discord hide the commands by default from
        # guild members without MANAGE_GUILD.
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
            payload["integration_types"] = [DISCORD_GUILD_INSTALL]
            payload["contexts"] = [DISCORD_GUILD_INTERACTION_CONTEXT]
            if discord_user_install_is_supported(account):
                payload["integration_types"].append(DISCORD_USER_INSTALL)
                payload["contexts"].append(DISCORD_BOT_DM_INTERACTION_CONTEXT)
    options = command.get("options")
    if isinstance(options, list):
        payload["options"] = [option for option in options if isinstance(option, dict)]
    return payload


def _account_config_str(account: ChannelAccount, key: str) -> str | None:
    if not isinstance(account.config, dict):
        return None
    return _read_optional_str(account.config.get(key))


def _require_account_config_str(account: ChannelAccount, key: str) -> str:
    value = _account_config_str(account, key)
    if value is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"channel account config.{key} is required",
        )
    return value


def _read_optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _read_optional_identifier(value: Any) -> str | None:
    if isinstance(value, str):
        return value or None
    if isinstance(value, int):
        return str(value)
    return None


def _dict_identifier(value: Any, key: str) -> str | None:
    if not isinstance(value, dict):
        return None
    return _read_optional_identifier(value.get(key))


def _nested_identifier(data: dict[str, Any], *path: str) -> str | None:
    return _read_optional_identifier(_nested_dict_value(data, *path))
