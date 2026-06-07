from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID

import httpx
from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel import (
    CHANNEL_PROVIDER_DISCORD,
    CHANNEL_PROVIDER_IMESSAGE,
    CHANNEL_PROVIDER_TELEGRAM,
    CHANNEL_PROVIDER_WHATSAPP,
    CHANNEL_PROVIDERS,
    ChannelAccount,
)
from app.services.channels import (
    decrypt_provider_token,
    encrypt_optional_token,
    generate_agent_token,
    generate_webhook_secret,
    get_channel_secret,
    get_or_create_binding,
    get_or_create_bot_agent_link,
    hash_token,
    store_channel_secrets,
)

MsgRouterMigrationChannel = Literal["telegram", "whatsapp", "discord", "imessage"]
TranslationFailureReason = Literal[
    "discord_dm_lookup_failed",
    "unparseable_route_key",
    "unknown_channel",
]

MIGRATION_AGENT_TOKEN_SECRET = "msg_router_migration_agent_token"
MIGRATION_WEBHOOK_SECRET_SECRET = "msg_router_migration_webhook_secret"
MIGRATION_CONFIG_SOURCE_ID = "migrated_from_msg_router_tenant_id"
MIGRATION_CONFIG_SOURCE_NAME = "migrated_from_msg_router_tenant_name"
MIGRATION_CONFIG_IMPORTED_AT = "msg_router_migrated_at"


@dataclass(frozen=True)
class MuxBinding:
    channel: str
    scope: str
    route_key: str


@dataclass(frozen=True)
class TranslatedMuxBinding:
    channel: MsgRouterMigrationChannel
    chat_id: str
    chat_type: str | None
    scope_id: str | None


@dataclass(frozen=True)
class TranslationFailure:
    entry: MuxBinding
    reason: TranslationFailureReason


@dataclass(frozen=True)
class TranslationPending:
    kind: Literal["discord_dm_lookup"]
    entry: MuxBinding
    user_id: str


@dataclass(frozen=True)
class TranslationResult:
    ok: bool | Literal["pending"]
    translated: TranslatedMuxBinding | None = None
    pending: TranslationPending | None = None
    failure: TranslationFailure | None = None


@dataclass(frozen=True)
class PreparedMigratedBinding:
    source_channel: str
    channel: MsgRouterMigrationChannel
    chat_id: str
    chat_type: str | None
    scope_id: str | None
    route_key: str


@dataclass(frozen=True)
class MsgRouterMigrationSkip:
    channel: str
    route_key: str
    reason: str


@dataclass(frozen=True)
class MigratedChannelAccount:
    account_id: UUID
    provider: MsgRouterMigrationChannel
    agent_token: str
    webhook_secret: str


@dataclass(frozen=True)
class MsgRouterMigrationImportResult:
    channel_accounts: dict[str, MigratedChannelAccount]
    bindings_imported: dict[str, int]
    bindings_skipped: list[MsgRouterMigrationSkip]

    @property
    def channel_tokens(self) -> dict[str, str]:
        return {
            provider: account.agent_token for provider, account in self.channel_accounts.items()
        }

    @property
    def webhook_secrets(self) -> dict[str, str]:
        return {
            provider: account.webhook_secret for provider, account in self.channel_accounts.items()
        }


def translate_mux_binding(entry: MuxBinding | Mapping[str, Any]) -> TranslationResult:
    binding = _coerce_mux_binding(entry)
    if binding.channel == CHANNEL_PROVIDER_TELEGRAM:
        match = re.fullmatch(r"telegram:[^:]+:chat:([^:]+?)(?::topic:[^:]+)?", binding.route_key)
        if match is None:
            return _translation_failure(binding, "unparseable_route_key")
        return TranslationResult(
            ok=True,
            translated=TranslatedMuxBinding(
                channel=CHANNEL_PROVIDER_TELEGRAM,
                chat_id=match.group(1),
                chat_type=None,
                scope_id=None,
            ),
        )

    if binding.channel == CHANNEL_PROVIDER_WHATSAPP:
        match = re.fullmatch(r"whatsapp:[^:]+:chat:(.+)", binding.route_key)
        if match is None:
            return _translation_failure(binding, "unparseable_route_key")
        return TranslationResult(
            ok=True,
            translated=TranslatedMuxBinding(
                channel=CHANNEL_PROVIDER_WHATSAPP,
                chat_id=match.group(1),
                chat_type=None,
                scope_id=None,
            ),
        )

    if binding.channel == CHANNEL_PROVIDER_IMESSAGE:
        match = re.fullmatch(r"imessage:(direct|group):(.+)", binding.route_key)
        if match is None or not match.group(2).strip():
            return _translation_failure(binding, "unparseable_route_key")
        return TranslationResult(
            ok=True,
            translated=TranslatedMuxBinding(
                channel=CHANNEL_PROVIDER_IMESSAGE,
                chat_id=binding.route_key,
                chat_type=match.group(1),
                scope_id=match.group(2).strip(),
            ),
        )

    if binding.channel == CHANNEL_PROVIDER_DISCORD:
        guild_match = re.match(r"^discord:[^:]+:guild:(\d+)", binding.route_key)
        if guild_match is not None:
            guild_id = guild_match.group(1)
            return TranslationResult(
                ok=True,
                translated=TranslatedMuxBinding(
                    channel=CHANNEL_PROVIDER_DISCORD,
                    chat_id=guild_id,
                    chat_type="guild_text",
                    scope_id=guild_id,
                ),
            )
        dm_match = re.fullmatch(r"discord:[^:]+:dm:user:(\d+)", binding.route_key)
        if dm_match is not None:
            return TranslationResult(
                ok="pending",
                pending=TranslationPending(
                    kind="discord_dm_lookup",
                    entry=binding,
                    user_id=dm_match.group(1),
                ),
            )
        return _translation_failure(binding, "unparseable_route_key")

    return _translation_failure(binding, "unknown_channel")


def validate_migration_dump(body: Any) -> str | None:
    if not isinstance(body, Mapping):
        return "body must be an object"
    if body.get("schemaVersion") != 1:
        return "unsupported schemaVersion (expected 1)"
    tenant = body.get("tenant")
    if not isinstance(tenant, Mapping):
        return "tenant required"
    tenant_id = tenant.get("id")
    if not isinstance(tenant_id, str) or not tenant_id.strip():
        return "tenant.id required"
    if not isinstance(body.get("bindings"), list):
        return "bindings must be an array"
    return None


async def resolve_discord_dm_channel_id(
    *,
    discord_base_url: str,
    bot_token: str,
    user_id: str,
    client: httpx.AsyncClient | None = None,
) -> str | None:
    url = f"{discord_base_url.rstrip('/')}/api/v10/users/@me/channels"

    async def _post(active_client: httpx.AsyncClient) -> str | None:
        response = await active_client.post(
            url,
            headers={
                "Authorization": f"Bot {bot_token}",
                "Content-Type": "application/json",
            },
            json={"recipient_id": user_id},
        )
        if response.status_code < 200 or response.status_code >= 300:
            return None
        payload = response.json()
        channel_id = payload.get("id") if isinstance(payload, dict) else None
        return channel_id if isinstance(channel_id, str) and channel_id else None

    try:
        if client is not None:
            return await _post(client)
        async with httpx.AsyncClient(timeout=10) as active_client:
            return await _post(active_client)
    except (httpx.HTTPError, ValueError):
        return None


async def import_msg_router_migration_dump(
    db: AsyncSession,
    *,
    user_id: UUID,
    agent_id: UUID,
    dump: Mapping[str, Any],
    provider_tokens: Mapping[str, str] | None = None,
    discord_base_url: str = "https://discord.com",
    discord_client: httpx.AsyncClient | None = None,
) -> MsgRouterMigrationImportResult:
    validation_error = validate_migration_dump(dump)
    if validation_error is not None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=validation_error)
    tenant = dump["tenant"]
    if not isinstance(tenant, Mapping):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="tenant required")
    mux_tenant_id = str(tenant["id"]).strip()
    mux_tenant_name = str(tenant.get("name") or mux_tenant_id).strip() or mux_tenant_id
    raw_bindings = dump["bindings"]
    if not isinstance(raw_bindings, list):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="bindings must be an array",
        )

    channels_in_dump = {
        str(binding.get("channel"))
        for binding in raw_bindings
        if isinstance(binding, Mapping) and isinstance(binding.get("channel"), str)
    }
    accounts: dict[str, ChannelAccount] = {}
    account_tokens: dict[str, MigratedChannelAccount] = {}
    for provider in sorted(channels_in_dump):
        if provider not in CHANNEL_PROVIDERS:
            continue
        account, agent_token, webhook_secret = await _get_or_create_migrated_channel_account(
            db,
            user_id=user_id,
            agent_id=agent_id,
            provider=provider,
            mux_tenant_id=mux_tenant_id,
            mux_tenant_name=mux_tenant_name,
            provider_token=(provider_tokens or {}).get(provider),
        )
        accounts[provider] = account
        account_tokens[provider] = MigratedChannelAccount(
            account_id=account.id,
            provider=provider,  # type: ignore[arg-type]
            agent_token=agent_token,
            webhook_secret=webhook_secret,
        )

    prepared: list[PreparedMigratedBinding] = []
    skipped: list[MsgRouterMigrationSkip] = []
    for raw_binding in raw_bindings:
        if not isinstance(raw_binding, Mapping):
            skipped.append(
                MsgRouterMigrationSkip(channel="", route_key="", reason="invalid_binding")
            )
            continue
        binding = _coerce_mux_binding(raw_binding)
        translation = translate_mux_binding(binding)
        if translation.ok is False:
            failure = translation.failure
            reason = failure.reason if failure is not None else "unparseable_route_key"
            skipped.append(
                MsgRouterMigrationSkip(
                    channel=binding.channel,
                    route_key=binding.route_key,
                    reason=reason,
                )
            )
            continue
        if translation.ok == "pending":
            pending = translation.pending
            account = accounts.get(CHANNEL_PROVIDER_DISCORD)
            if pending is None or account is None:
                skipped.append(
                    MsgRouterMigrationSkip(
                        channel=binding.channel,
                        route_key=binding.route_key,
                        reason="no_bot_assigned",
                    )
                )
                continue
            try:
                bot_token = decrypt_provider_token(account)
            except HTTPException:
                skipped.append(
                    MsgRouterMigrationSkip(
                        channel=binding.channel,
                        route_key=binding.route_key,
                        reason="no_provider_token",
                    )
                )
                continue
            channel_id = await resolve_discord_dm_channel_id(
                discord_base_url=discord_base_url,
                bot_token=bot_token,
                user_id=pending.user_id,
                client=discord_client,
            )
            if channel_id is None:
                skipped.append(
                    MsgRouterMigrationSkip(
                        channel=binding.channel,
                        route_key=binding.route_key,
                        reason="discord_dm_lookup_failed",
                    )
                )
                continue
            translated = TranslatedMuxBinding(
                channel=CHANNEL_PROVIDER_DISCORD,
                chat_id=channel_id,
                chat_type="dm",
                scope_id=None,
            )
        else:
            translated = translation.translated
            if translated is None:
                skipped.append(
                    MsgRouterMigrationSkip(
                        channel=binding.channel,
                        route_key=binding.route_key,
                        reason="unparseable_route_key",
                    )
                )
                continue
        if translated.channel not in accounts:
            skipped.append(
                MsgRouterMigrationSkip(
                    channel=binding.channel,
                    route_key=binding.route_key,
                    reason="no_bot_assigned",
                )
            )
            continue
        prepared.append(
            PreparedMigratedBinding(
                source_channel=binding.channel,
                channel=translated.channel,
                chat_id=translated.chat_id,
                chat_type=translated.chat_type,
                scope_id=translated.scope_id,
                route_key=binding.route_key,
            )
        )

    imported: dict[str, int] = {}
    if not skipped:
        for binding in prepared:
            account = accounts[binding.channel]
            link, _raw_agent_token = await get_or_create_bot_agent_link(
                db,
                account=account,
                agent_id=agent_id,
            )
            await get_or_create_binding(
                db,
                account=account,
                bot_agent_link_id=link.id,
                external_chat_id=binding.chat_id,
                external_chat_type=binding.chat_type,
                external_chat_name=binding.scope_id,
            )
            imported[binding.source_channel] = imported.get(binding.source_channel, 0) + 1
    await db.flush()
    return MsgRouterMigrationImportResult(
        channel_accounts=account_tokens,
        bindings_imported=imported,
        bindings_skipped=skipped,
    )


async def _get_or_create_migrated_channel_account(
    db: AsyncSession,
    *,
    user_id: UUID,
    agent_id: UUID,
    provider: str,
    mux_tenant_id: str,
    mux_tenant_name: str,
    provider_token: str | None,
) -> tuple[ChannelAccount, str, str]:
    existing = await _find_migrated_channel_account(
        db,
        user_id=user_id,
        provider=provider,
        mux_tenant_id=mux_tenant_id,
    )
    if existing is not None:
        agent_token = await _ensure_migrated_agent_link_secret(
            db,
            existing,
            agent_id=agent_id,
            provider=provider,
        )
        webhook_secret = await _ensure_migrated_account_secret(
            db,
            existing,
            name=MIGRATION_WEBHOOK_SECRET_SECRET,
            generator=generate_webhook_secret,
        )
        if provider_token and not existing.encrypted_provider_token:
            ciphertext, nonce = encrypt_optional_token(provider_token)
            existing.encrypted_provider_token = ciphertext
            existing.provider_token_nonce = nonce
        return existing, agent_token, webhook_secret

    agent_token = generate_agent_token(provider)
    webhook_secret = generate_webhook_secret()
    ciphertext, nonce = encrypt_optional_token(provider_token)
    account = ChannelAccount(
        user_id=user_id,
        provider=provider,
        name=_migration_account_name(provider, mux_tenant_id, mux_tenant_name),
        encrypted_provider_token=ciphertext,
        provider_token_nonce=nonce,
        webhook_secret_hash=hash_token(webhook_secret),
        config={
            MIGRATION_CONFIG_SOURCE_ID: mux_tenant_id,
            MIGRATION_CONFIG_SOURCE_NAME: mux_tenant_name,
            MIGRATION_CONFIG_IMPORTED_AT: datetime.now(UTC).isoformat(),
        },
    )
    db.add(account)
    await db.flush()
    await get_or_create_bot_agent_link(
        db,
        account=account,
        agent_id=agent_id,
        agent_token=agent_token,
    )
    await store_channel_secrets(
        db,
        account=account,
        secrets_by_name={
            MIGRATION_AGENT_TOKEN_SECRET: agent_token,
            MIGRATION_WEBHOOK_SECRET_SECRET: webhook_secret,
        },
    )
    return account, agent_token, webhook_secret


async def _find_migrated_channel_account(
    db: AsyncSession,
    *,
    user_id: UUID,
    provider: str,
    mux_tenant_id: str,
) -> ChannelAccount | None:
    result = await db.execute(
        select(ChannelAccount).where(
            ChannelAccount.user_id == user_id,
            ChannelAccount.provider == provider,
            ChannelAccount.archived_at.is_(None),
        )
    )
    for account in result.scalars().all():
        config = account.config if isinstance(account.config, dict) else {}
        if config.get(MIGRATION_CONFIG_SOURCE_ID) == mux_tenant_id:
            return account
    return None


async def _ensure_migrated_account_secret(
    db: AsyncSession,
    account: ChannelAccount,
    *,
    name: str,
    generator: Any,
) -> str:
    secret = await get_channel_secret(db, account=account, name=name)
    if secret:
        return secret
    secret = generator()
    account.webhook_secret_hash = hash_token(secret)
    await store_channel_secrets(db, account=account, secrets_by_name={name: secret})
    return secret


async def _ensure_migrated_agent_link_secret(
    db: AsyncSession,
    account: ChannelAccount,
    *,
    agent_id: UUID,
    provider: str,
) -> str:
    agent_token = await get_channel_secret(db, account=account, name=MIGRATION_AGENT_TOKEN_SECRET)
    if not agent_token:
        agent_token = generate_agent_token(provider)
        await store_channel_secrets(
            db,
            account=account,
            secrets_by_name={MIGRATION_AGENT_TOKEN_SECRET: agent_token},
        )
    await get_or_create_bot_agent_link(
        db,
        account=account,
        agent_id=agent_id,
        agent_token=agent_token,
    )
    return agent_token


def _coerce_mux_binding(entry: MuxBinding | Mapping[str, Any]) -> MuxBinding:
    if isinstance(entry, MuxBinding):
        return entry
    route_key = entry.get("routeKey", entry.get("route_key", ""))
    return MuxBinding(
        channel=str(entry.get("channel", "")),
        scope=str(entry.get("scope", "")),
        route_key=str(route_key),
    )


def _translation_failure(
    entry: MuxBinding,
    reason: TranslationFailureReason,
) -> TranslationResult:
    return TranslationResult(ok=False, failure=TranslationFailure(entry=entry, reason=reason))


def _migration_account_name(provider: str, mux_tenant_id: str, mux_tenant_name: str) -> str:
    digest = hashlib.sha1(mux_tenant_id.encode("utf-8")).hexdigest()[:8]
    clean_name = " ".join(mux_tenant_name.split())[:72] or mux_tenant_id[:24]
    return f"msg-router {clean_name} {provider} {digest}"[:120]
