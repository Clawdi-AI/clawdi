from __future__ import annotations

import asyncio
import hashlib
import hmac
import re
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from time import monotonic
from typing import Any
from uuid import UUID

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import HTTPException, status
from sqlalchemy import select
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
    DELIVERY_STATUS_FAILED,
    DELIVERY_STATUS_IN_PROGRESS,
    DELIVERY_STATUS_PENDING,
    DELIVERY_STATUS_SUCCEEDED,
    MESSAGE_DIRECTION_INBOUND,
    MESSAGE_DIRECTION_OUTBOUND,
    PAIR_CODE_STATUS_CLAIMED,
    PAIR_CODE_STATUS_PENDING,
    PAIR_CODE_STATUS_REVOKED,
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
from app.services.vault_crypto import decrypt, encrypt

PAIR_COMMAND = "/bot_pair"
UNPAIR_COMMAND = "/bot_unpair"
PAIR_CODE_PATTERN = re.compile(r"^PAIR[A-Z0-9]{8,}$")
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

TELEGRAM_REF_CALLBACK_QUERY_ID = "telegram_callback_query_id"
TELEGRAM_REF_FILE_ID = "telegram_file_id"
TELEGRAM_REF_FILE_PATH = "telegram_file_path"
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
PAIRING_REPLY_USAGE_BOT_PAIR = "Usage: /bot_pair <code>"


def hash_token(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def verify_hashed_token(raw: str, expected_hash: str) -> bool:
    return hmac.compare_digest(hash_token(raw), expected_hash)


def generate_webhook_secret() -> str:
    return secrets.token_urlsafe(32)


def generate_pair_code() -> str:
    return "PAIR" + secrets.token_urlsafe(18).replace("-", "").replace("_", "")[:24].upper()


def generate_agent_token(provider: str) -> str:
    secret = secrets.token_urlsafe(32).replace("-", "").replace("_", "")
    if provider == CHANNEL_PROVIDER_TELEGRAM:
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


def channel_webhook_url(account_id: UUID, provider: str) -> str:
    return f"{settings.public_api_url.rstrip('/')}/api/channels/{provider}/{account_id}/webhook"


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
    agent_token: str | None = None,
) -> tuple[ChannelBotAgentLink, str | None]:
    result = await db.execute(
        select(ChannelBotAgentLink).where(
            ChannelBotAgentLink.account_id == account.id,
            ChannelBotAgentLink.agent_id == agent_id,
            ChannelBotAgentLink.archived_at.is_(None),
        )
    )
    link = result.scalar_one_or_none()
    if link is not None:
        return link, None

    raw_token = agent_token or generate_agent_token(account.provider)
    link = ChannelBotAgentLink(
        account_id=account.id,
        user_id=account.user_id,
        agent_id=agent_id,
        agent_token_hash=hash_token(raw_token),
    )
    db.add(link)
    await db.flush()
    return link, raw_token


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
        user_id=account.user_id,
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
) -> ChannelBotAgentLink:
    result = await db.execute(
        select(ChannelBotAgentLink).where(
            ChannelBotAgentLink.id == link_id,
            ChannelBotAgentLink.account_id == account.id,
            ChannelBotAgentLink.user_id == account.user_id,
            ChannelBotAgentLink.archived_at.is_(None),
        )
    )
    link = result.scalar_one_or_none()
    if link is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="agent link not found")
    return link


async def rotate_bot_agent_link_token(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    link: ChannelBotAgentLink,
) -> str:
    raw_token = generate_agent_token(account.provider)
    link.agent_token_hash = hash_token(raw_token)
    await db.flush()
    return raw_token


async def get_owned_channel_account(
    db: AsyncSession,
    *,
    account_id: UUID,
    user_id: UUID,
) -> ChannelAccount:
    result = await db.execute(
        select(ChannelAccount).where(
            ChannelAccount.id == account_id,
            ChannelAccount.user_id == user_id,
            ChannelAccount.archived_at.is_(None),
        )
    )
    account = result.scalar_one_or_none()
    if account is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="channel not found")
    return account


async def get_public_channel_account(db: AsyncSession, *, account_id: UUID) -> ChannelAccount:
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

    links_result = await db.execute(
        select(ChannelBotAgentLink).where(
            ChannelBotAgentLink.account_id == account.id,
            ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
            ChannelBotAgentLink.archived_at.is_(None),
        )
    )
    for link in links_result.scalars().all():
        link.status = BOT_AGENT_LINK_STATUS_ARCHIVED
        link.agent_token_hash = None
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
        select(ChannelAccount, ChannelBotAgentLink)
        .join(ChannelBotAgentLink, ChannelBotAgentLink.account_id == ChannelAccount.id)
        .where(
            ChannelAccount.provider == provider,
            ChannelBotAgentLink.agent_token_hash == hash_token(token),
            ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
            ChannelBotAgentLink.archived_at.is_(None),
            ChannelAccount.archived_at.is_(None),
            ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
        )
    )
    row = result.one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid bot token")
    account, link = row
    return ChannelAgentContext(account=account, link=link)


async def claim_pair_code(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    raw_code: str,
    external_chat_id: str,
    external_chat_type: str | None,
    external_chat_name: str | None,
) -> PairCodeClaimResult:
    result = await db.execute(
        select(ChannelPairCode).where(
            ChannelPairCode.account_id == account.id,
            ChannelPairCode.code_hash == hash_token(raw_code),
        )
    )
    pair_code = result.scalar_one_or_none()
    if pair_code is None:
        return PairCodeClaimResult(reason="invalid")
    if pair_code.status != PAIR_CODE_STATUS_PENDING:
        return PairCodeClaimResult(reason="already_used")
    if pair_code.expires_at <= datetime.now(UTC):
        return PairCodeClaimResult(reason="expired")

    binding = await get_or_create_binding(
        db,
        account=account,
        bot_agent_link_id=pair_code.bot_agent_link_id,
        external_chat_id=external_chat_id,
        external_chat_type=external_chat_type,
        external_chat_name=external_chat_name,
    )
    pair_code.status = PAIR_CODE_STATUS_CLAIMED
    pair_code.claimed_at = datetime.now(UTC)
    pair_code.claimed_external_chat_id = external_chat_id
    return PairCodeClaimResult(binding=binding)


async def get_or_create_binding(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    bot_agent_link_id: UUID,
    external_chat_id: str,
    external_chat_type: str | None,
    external_chat_name: str | None,
) -> ChannelBinding:
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
    )
    binding = result.scalars().first()
    if binding is not None:
        binding.bot_agent_link_id = bot_agent_link_id
        binding.external_chat_type = external_chat_type
        binding.external_chat_name = external_chat_name
        binding.status = BINDING_STATUS_ACTIVE
        return binding

    binding = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=bot_agent_link_id,
        user_id=account.user_id,
        external_chat_id=external_chat_id,
        external_chat_type=external_chat_type,
        external_chat_name=external_chat_name,
    )
    db.add(binding)
    await db.flush()
    return binding


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
) -> ChannelBindingAlias:
    result = await db.execute(
        select(ChannelBindingAlias).where(
            ChannelBindingAlias.account_id == binding.account_id,
            ChannelBindingAlias.alias_external_chat_id == alias_external_chat_id,
        )
    )
    alias = result.scalar_one_or_none()
    if alias is not None:
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
    text: str | None,
    command: ChannelPairCommand | None = None,
) -> InboundBindingResult:
    bindings = await find_bindings(db, account=account, external_chat_id=external_chat_id)
    binding = bindings[0] if bindings else None
    parsed = command if command is not None else parse_pair_command(text)
    if parsed is None:
        return InboundBindingResult(binding=binding, bindings=tuple(bindings))
    if parsed.kind == "pair":
        if not parsed.code:
            return InboundBindingResult(binding=binding, pair_failed_reason="usage")
        claim = await claim_pair_code(
            db,
            account=account,
            raw_code=parsed.code,
            external_chat_id=external_chat_id,
            external_chat_type=external_chat_type,
            external_chat_name=external_chat_name,
        )
        return InboundBindingResult(
            binding=claim.binding or binding,
            bindings=(claim.binding,) if claim.binding is not None else tuple(bindings),
            paired=claim.binding is not None and claim.reason is None,
            pair_failed_reason=claim.reason,
        )
    if parsed.kind == "unpair":
        if not bindings:
            return InboundBindingResult(binding=None)
        for active_binding in bindings:
            active_binding.status = BINDING_STATUS_ARCHIVED
        return InboundBindingResult(binding=binding, bindings=tuple(bindings), unpaired=True)
    return InboundBindingResult(binding=binding, bindings=tuple(bindings))


def parse_pair_command(text: str | None) -> ChannelPairCommand | None:
    if not text:
        return None
    trimmed = text.lstrip()
    if trimmed.startswith("/start"):
        head, separator, rest = trimmed.partition(" ")
        command = head.split("@", 1)[0]
        if command != "/start" or not separator:
            return None
        code = rest.strip().split(maxsplit=1)[0] if rest.strip() else ""
        if PAIR_CODE_PATTERN.match(code):
            return ChannelPairCommand(kind="pair", code=code)
        return None
    if not trimmed.startswith("/bot_"):
        return None
    head, separator, rest = trimmed.partition(" ")
    command = head.split("@", 1)[0]
    if command == PAIR_COMMAND:
        code = rest.strip().split(maxsplit=1)[0] if separator and rest.strip() else ""
        return ChannelPairCommand(kind="pair", code=code)
    if command == UNPAIR_COMMAND:
        return ChannelPairCommand(kind="unpair")
    return ChannelPairCommand(kind="unknown", command=command)


def pairing_reply_for_command(
    command: ChannelPairCommand | None,
    result: InboundBindingResult,
) -> str:
    if result.paired:
        return PAIRING_REPLY_PAIRED
    if result.unpaired:
        return PAIRING_REPLY_UNPAIRED
    if command is None:
        return "Message received."
    if command.kind == "pair":
        if result.pair_failed_reason == "usage":
            return PAIRING_REPLY_USAGE_BOT_PAIR
        reason = result.pair_failed_reason or "invalid"
        return f"Pairing failed: {reason}."
    if command.kind == "unpair":
        return PAIRING_REPLY_NOT_PAIRED
    if command.kind == "unknown" and command.command:
        return f"Unknown command: {command.command}. Use /bot_pair <code> or /bot_unpair."
    return "Message received."


def extract_pair_code(text: str | None) -> str | None:
    command = parse_pair_command(text)
    return command.code if command is not None and command.kind == "pair" else None


def telegram_chat_from_update(payload: dict[str, Any]) -> tuple[str, str | None, str | None] | None:
    chat = _telegram_chat_object_from_update(payload)
    if isinstance(chat, dict):
        chat_id = chat.get("id")
        if chat_id is None:
            return None
        title = chat.get("title") or chat.get("username") or chat.get("first_name")
        return str(chat_id), _read_optional_str(chat.get("type")), _read_optional_str(title)

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
    callback_query = payload.get("callback_query")
    if isinstance(callback_query, dict):
        callback_id = callback_query.get("id")
        if callback_id is not None:
            return str(callback_id)
    message = _telegram_message_from_update(payload)
    if not isinstance(message, dict):
        return None
    message_id = message.get("message_id")
    return str(message_id) if message_id is not None else None


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
) -> ChannelMessage:
    message = ChannelMessage(
        account_id=account.id,
        bot_agent_link_id=binding.bot_agent_link_id if binding else None,
        binding_id=binding.id if binding else None,
        user_id=account.user_id,
        direction=MESSAGE_DIRECTION_INBOUND,
        external_chat_id=external_chat_id,
        provider_message_id=provider_message_id,
        text=text,
        payload=payload,
    )
    db.add(message)
    await db.flush()
    inbound_messages.labels(channel=account.provider).inc()
    return message


async def record_inbound_messages_for_bindings(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    binding_result: InboundBindingResult,
    external_chat_id: str,
    provider_message_id: str | None,
    text: str | None,
    payload: dict[str, Any],
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
        message = await record_inbound_message(
            db,
            account=account,
            binding=binding,
            external_chat_id=external_chat_id,
            provider_message_id=provider_message_id,
            text=text,
            payload=payload,
        )
        messages.append((message, binding))
    return messages


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
    scoped_link_id = binding.bot_agent_link_id if binding else bot_agent_link_id
    result = await db.execute(
        select(ChannelAgentReference).where(
            ChannelAgentReference.account_id == account.id,
            ChannelAgentReference.bot_agent_link_id == scoped_link_id,
            ChannelAgentReference.ref_kind == ref_kind,
            ChannelAgentReference.ref_value == ref_value,
        )
    )
    existing = result.scalar_one_or_none()
    if existing is not None:
        existing.binding_id = binding.id if binding else existing.binding_id
        existing.message_id = message.id if message else existing.message_id
        existing.metadata_ = metadata or existing.metadata_
        await db.flush()
        return existing

    reference = ChannelAgentReference(
        account_id=account.id,
        bot_agent_link_id=scoped_link_id,
        binding_id=binding.id if binding else None,
        message_id=message.id if message else None,
        user_id=account.user_id,
        provider=account.provider,
        ref_kind=ref_kind,
        ref_value=ref_value,
        metadata_=metadata,
    )
    db.add(reference)
    await db.flush()
    return reference


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
        ChannelAgentReference.ref_kind == ref_kind,
        ChannelAgentReference.ref_value == ref_value,
    ]
    if bot_agent_link_id is not None:
        filters.append(ChannelAgentReference.bot_agent_link_id == bot_agent_link_id)
    result = await db.execute(select(ChannelAgentReference.id).where(*filters))
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
        ChannelAgentReference.ref_kind == ref_kind,
        ChannelAgentReference.ref_value == ref_value,
    ]
    if bot_agent_link_id is not None:
        filters.append(ChannelAgentReference.bot_agent_link_id == bot_agent_link_id)
    result = await db.execute(select(ChannelAgentReference).where(*filters))
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
    for ref_kind, ref_value in _telegram_update_references(payload):
        await record_channel_agent_reference(
            db,
            account=account,
            binding=binding,
            message=message,
            ref_kind=ref_kind,
            ref_value=ref_value,
        )


def _telegram_update_references(payload: dict[str, Any]) -> set[tuple[str, str]]:
    references: set[tuple[str, str]] = set()
    callback_query = payload.get("callback_query")
    if isinstance(callback_query, dict):
        callback_id = callback_query.get("id")
        if isinstance(callback_id, str) and callback_id:
            references.add((TELEGRAM_REF_CALLBACK_QUERY_ID, callback_id))

    for node in _walk_json_dicts(payload):
        file_id = node.get("file_id")
        if isinstance(file_id, str) and file_id:
            references.add((TELEGRAM_REF_FILE_ID, file_id))
        file_path = node.get("file_path")
        if isinstance(file_path, str) and file_path:
            references.add((TELEGRAM_REF_FILE_PATH, file_path))
    return references


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
    return payload


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
    through_sequence: int,
) -> int:
    result = await db.execute(
        select(ChannelMessage).where(
            ChannelMessage.account_id == account.id,
            ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
            ChannelMessage.binding_id.is_not(None),
            ChannelMessage.delivered_at.is_(None),
            ChannelMessage.inbox_sequence <= through_sequence,
        )
    )
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
    message = ChannelMessage(
        account_id=account.id,
        bot_agent_link_id=binding.bot_agent_link_id if binding else None,
        binding_id=binding.id if binding else None,
        user_id=account.user_id,
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
        user_id=account.user_id,
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
        .where(
            ChannelDelivery.status == DELIVERY_STATUS_PENDING,
            ChannelDelivery.next_attempt_at <= now,
            ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
            ChannelAccount.archived_at.is_(None),
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
        message = await _delivery_message(db, delivery)
        provider_message_id, provider_response = await send_provider_outbound_payload(
            account=account,
            external_chat_id=message.external_chat_id,
            text=message.text or "",
            provider_payload=_channel_message_provider_payload(message),
        )
    except HTTPException as exc:
        if exc.status_code < status.HTTP_500_INTERNAL_SERVER_ERROR:
            _fail_delivery(delivery, _http_exception_detail(exc))
        else:
            _schedule_delivery_retry(delivery, _http_exception_detail(exc))
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
) -> ChannelMessage:
    if account.provider == CHANNEL_PROVIDER_TELEGRAM:
        return await send_telegram_message(
            db,
            account=account,
            external_chat_id=external_chat_id,
            text=text,
            bot_agent_link_id=bot_agent_link_id,
        )
    if account.provider == CHANNEL_PROVIDER_DISCORD:
        return await send_discord_message(
            db,
            account=account,
            external_chat_id=external_chat_id,
            text=text,
            bot_agent_link_id=bot_agent_link_id,
        )
    if account.provider == CHANNEL_PROVIDER_WHATSAPP:
        return await send_whatsapp_message(
            db,
            account=account,
            external_chat_id=external_chat_id,
            text=text,
            bot_agent_link_id=bot_agent_link_id,
        )
    if account.provider == CHANNEL_PROVIDER_IMESSAGE:
        return await send_imessage_message(
            db,
            account=account,
            external_chat_id=external_chat_id,
            text=text,
            bot_agent_link_id=bot_agent_link_id,
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
) -> list[dict[str, Any]]:
    command_specs = commands or [dict(command) for command in DEFAULT_CHANNEL_COMMANDS]
    if account.provider == CHANNEL_PROVIDER_TELEGRAM:
        return await sync_telegram_commands(account=account, commands=command_specs)
    if account.provider == CHANNEL_PROVIDER_DISCORD:
        return await sync_discord_commands(
            account=account,
            commands=command_specs,
            guild_id=guild_id,
        )
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="channel provider command sync is not implemented",
    )


async def send_telegram_message(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    external_chat_id: str,
    text: str,
    bot_agent_link_id: UUID | None = None,
) -> ChannelMessage:
    _require_channel_provider(account, CHANNEL_PROVIDER_TELEGRAM)
    provider_message_id, payload = await _send_telegram_provider_payload(
        account=account,
        external_chat_id=external_chat_id,
        text=text,
    )
    binding = await find_binding(
        db,
        account=account,
        external_chat_id=external_chat_id,
        bot_agent_link_id=bot_agent_link_id,
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
) -> tuple[str | None, dict[str, Any]]:
    token = decrypt_provider_token(account)
    url = f"{settings.channel_telegram_api_base_url.rstrip('/')}/bot{token}/sendMessage"
    payload = await _post_provider_json(
        channel=CHANNEL_PROVIDER_TELEGRAM,
        method="sendMessage",
        url=url,
        json_payload={"chat_id": external_chat_id, "text": text},
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
    url = f"{settings.channel_telegram_api_base_url.rstrip('/')}/bot{token}/setMyCommands"
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
) -> ChannelMessage:
    _require_channel_provider(account, CHANNEL_PROVIDER_DISCORD)
    provider_message_id, response_payload = await _send_discord_provider_payload(
        account=account,
        external_chat_id=external_chat_id,
        text=text,
    )
    binding = await find_binding(
        db,
        account=account,
        external_chat_id=external_chat_id,
        bot_agent_link_id=bot_agent_link_id,
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


async def _send_discord_provider_payload(
    *,
    account: ChannelAccount,
    external_chat_id: str,
    text: str,
) -> tuple[str | None, dict[str, Any]]:
    token = decrypt_provider_token(account)
    base_url = _account_config_str(account, "api_base_url") or settings.channel_discord_api_base_url
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
                response_headers = getattr(response, "headers", {})
                discord_rate_limiter.observe("POST", path, response_headers, response.status_code)
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
    scoped_guild_id = guild_id or _account_config_str(account, "guild_id")
    base_url = _account_config_str(account, "api_base_url") or settings.channel_discord_api_base_url
    path = f"/applications/{application_id}"
    if scoped_guild_id:
        path = f"{path}/guilds/{scoped_guild_id}"
    url = f"{base_url.rstrip('/')}{path}/commands"
    synced: list[dict[str, Any]] = []
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            for command in commands:
                response = await client.post(
                    url,
                    headers={
                        "Authorization": f"Bot {token}",
                        "Content-Type": "application/json",
                    },
                    json=_discord_command_payload(command),
                )
                if response.status_code >= 400:
                    raise HTTPException(
                        status_code=status.HTTP_502_BAD_GATEWAY,
                        detail="discord api rejected commands",
                    )
                synced.append(_response_json_or_text(response))
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="discord api unreachable",
        ) from exc
    return synced


async def send_whatsapp_message(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    external_chat_id: str,
    text: str,
    bot_agent_link_id: UUID | None = None,
) -> ChannelMessage:
    _require_channel_provider(account, CHANNEL_PROVIDER_WHATSAPP)
    provider_message_id, response_payload = await _send_whatsapp_provider_payload(
        account=account,
        external_chat_id=external_chat_id,
        text=text,
    )
    binding = await find_binding(
        db,
        account=account,
        external_chat_id=external_chat_id,
        bot_agent_link_id=bot_agent_link_id,
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
        or settings.channel_whatsapp_graph_api_base_url
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
    media: dict[str, str] = {"id": media_id} if media_id is not None else {"link": media_link}
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
) -> ChannelMessage:
    _require_channel_provider(account, CHANNEL_PROVIDER_IMESSAGE)
    binding = await find_imessage_binding_for_send(
        db,
        account=account,
        requested_chat_guid=external_chat_id,
        bot_agent_link_id=bot_agent_link_id,
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
    message = ChannelMessage(
        account_id=account.id,
        bot_agent_link_id=binding.bot_agent_link_id if binding else None,
        binding_id=binding.id if binding else None,
        user_id=account.user_id,
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
            return f"{PAIR_COMMAND} {code}"
    return None


def discord_pair_code_from_payload(payload: dict[str, Any]) -> str | None:
    command = discord_pair_command_from_payload(payload)
    return command.code if command is not None and command.kind == "pair" else None


def discord_pair_command_from_payload(payload: dict[str, Any]) -> ChannelPairCommand | None:
    data = _discord_event_data(payload)
    text_command = parse_pair_command(_read_optional_str(data.get("content")))
    if text_command is not None:
        return text_command
    interaction_command = data.get("data")
    if not isinstance(interaction_command, dict):
        return None
    name = interaction_command.get("name")
    if name in {"bot_unpair", "bot-unpair", "unpair"}:
        return ChannelPairCommand(kind="unpair")
    if name not in {"bot_pair", "bot-pair", "pair"}:
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


def discord_message_id_from_payload(payload: dict[str, Any]) -> str | None:
    return _read_optional_str(_discord_event_data(payload).get("id"))


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
    if key is None and chat is None:
        return False
    external_chat_id = key.chat_id if key is not None else chat[0]
    external_chat_type = key.chat_type if key is not None else chat[1]
    external_chat_name = chat[2] if chat is not None else key.scope_id
    binding_result = await resolve_inbound_binding(
        db,
        account=account,
        external_chat_id=external_chat_id,
        external_chat_type=external_chat_type,
        external_chat_name=external_chat_name,
        text=discord_text_from_payload(frame),
        command=discord_pair_command_from_payload(frame),
    )
    if binding_result.binding is None:
        return False
    data = frame.get("d")
    payload = frame if isinstance(data, dict) else {"d": data}
    messages = await record_inbound_messages_for_bindings(
        db,
        account=account,
        binding_result=binding_result,
        external_chat_id=external_chat_id,
        provider_message_id=_read_optional_str(data.get("id")) if isinstance(data, dict) else None,
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
            )
        await record_discord_interaction_references(
            db,
            account=account,
            binding=binding,
            message=message,
            payload=payload,
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


def _fail_delivery(delivery: ChannelDelivery, error: str) -> None:
    delivery.locked_at = None
    delivery.locked_by = None
    delivery.last_error = error[:1000]
    delivery.status = DELIVERY_STATUS_FAILED


def _http_exception_detail(exc: HTTPException) -> str:
    return exc.detail if isinstance(exc.detail, str) else "channel delivery failed"


def _command_name(command: dict[str, Any]) -> str:
    value = command.get("name")
    return value if isinstance(value, str) and value else "command"


def _command_description(command: dict[str, Any]) -> str:
    value = command.get("description")
    return value if isinstance(value, str) and value else _command_name(command)


def _discord_command_payload(command: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "name": _command_name(command),
        "description": _command_description(command),
        "type": 1,
    }
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
