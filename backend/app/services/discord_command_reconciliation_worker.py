from __future__ import annotations

import asyncio
import logging
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.channel import (
    BOT_AGENT_LINK_STATUS_ACTIVE,
    CHANNEL_PROVIDER_DISCORD,
    CHANNEL_STATUS_ACTIVE,
    ChannelAccount,
    ChannelBotAgentLink,
)
from app.routes.channel_routers.shared import (
    _clear_discord_guild_commands,
    _discord_command_materializations,
    _discord_command_retries,
    _discord_guild_command_fingerprint,
    _discord_guild_owned_by_link,
    _discord_historical_guilds_for_link,
    _discord_uncontested_guilds_for_link,
    _fan_out_discord_global_commands,
)

log = logging.getLogger(__name__)


async def reconcile_discord_guild_commands(
    sessionmaker: async_sessionmaker[AsyncSession],
    *,
    account_id: UUID,
    guild_id: str,
) -> int:
    """Reconcile one Guild after Discord explicitly reports the bot joined."""
    async with sessionmaker() as db:
        account = await db.get(ChannelAccount, account_id)
        if account is None:
            await db.rollback()
            return 0
        link_ids = list(
            (
                await db.execute(
                    select(ChannelBotAgentLink.id).where(
                        ChannelBotAgentLink.account_id == account_id,
                    )
                )
            ).scalars()
        )
    reconciled = 0
    for link_id in link_ids:
        async with sessionmaker() as db:
            account = await db.get(ChannelAccount, account_id)
            link = await db.get(ChannelBotAgentLink, link_id)
            if account is None or link is None or link.account_id != account.id:
                await db.rollback()
                continue
            try:
                if await _discord_guild_owned_by_link(
                    db,
                    account=account,
                    bot_agent_link_id=link.id,
                    guild_id=guild_id,
                ):
                    reconciled += await _fan_out_discord_global_commands(
                        db,
                        account=account,
                        bot_agent_link_id=link.id,
                        application_id=_discord_application_id(account),
                        commands=[],
                        guild_ids={guild_id},
                        automatic=False,
                        force=True,
                    )
                else:
                    known_guilds = await _discord_historical_guilds_for_link(
                        db,
                        account=account,
                        link=link,
                    )
                    known_guilds.update(_discord_command_materializations(link))
                    known_guilds.update(_discord_command_retries(link))
                    if guild_id in known_guilds:
                        await _clear_discord_guild_commands(
                            db,
                            account=account,
                            link=link,
                            application_id=_discord_application_id(account),
                            guild_ids={guild_id},
                            force=True,
                        )
            except HTTPException as exc:
                await db.rollback()
                log.warning(
                    "discord_command_join_reconciliation_deferred "
                    "account_id=%s link_id=%s guild_id=%s status=%s",
                    account_id,
                    link_id,
                    guild_id,
                    exc.status_code,
                )
    return reconciled


class DiscordCommandReconciliationWorker:
    """Retry durable Link command shadows until their Guild projections converge."""

    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        poll_interval_seconds: float = 30.0,
    ) -> None:
        self._sessionmaker = sessionmaker
        self._poll_interval_seconds = poll_interval_seconds

    async def run_once(self) -> int:
        async with self._sessionmaker() as db:
            rows = list(
                (
                    await db.execute(
                        select(ChannelBotAgentLink.id, ChannelAccount.id)
                        .join(ChannelAccount, ChannelAccount.id == ChannelBotAgentLink.account_id)
                        .where(
                            ChannelAccount.provider == CHANNEL_PROVIDER_DISCORD,
                            ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
                            ChannelAccount.archived_at.is_(None),
                        )
                    )
                ).all()
            )
        reconciled = 0
        for link_id, account_id in rows:
            reconciled += await self._reconcile_link(link_id=link_id, account_id=account_id)
        return reconciled

    async def _reconcile_link(self, *, link_id: UUID, account_id: UUID) -> int:
        async with self._sessionmaker() as db:
            account = await db.get(ChannelAccount, account_id)
            link = await db.get(ChannelBotAgentLink, link_id)
            if account is None or link is None or link.account_id != account.id:
                await db.rollback()
                return 0
            try:
                application_id = _discord_application_id(account)
                reconciled = 0
                active_link = (
                    link.status == BOT_AGENT_LINK_STATUS_ACTIVE and link.archived_at is None
                )
                if active_link:
                    reconciled += await _fan_out_discord_global_commands(
                        db,
                        account=account,
                        bot_agent_link_id=link.id,
                        application_id=application_id,
                        commands=[],
                        automatic=True,
                    )
                    await db.refresh(link)
                active_guilds = (
                    set(
                        await _discord_uncontested_guilds_for_link(
                            db,
                            account=account,
                            bot_agent_link_id=link.id,
                        )
                    )
                    if active_link
                    else set()
                )
                historical_guilds = await _discord_historical_guilds_for_link(
                    db,
                    account=account,
                    link=link,
                )
                materializations = _discord_command_materializations(link)
                retries = _discord_command_retries(link)
                empty_fingerprint = _discord_guild_command_fingerprint(
                    [],
                    application_id=application_id,
                )
                cleanup_guilds = {
                    guild_id
                    for guild_id in historical_guilds | set(materializations) | set(retries)
                    if guild_id not in active_guilds
                    and (materializations.get(guild_id) != empty_fingerprint or guild_id in retries)
                }
                if cleanup_guilds:
                    await _clear_discord_guild_commands(
                        db,
                        account=account,
                        link=link,
                        application_id=application_id,
                        guild_ids=cleanup_guilds,
                    )
                return reconciled
            except HTTPException as exc:
                await db.rollback()
                log.warning(
                    "discord_command_reconciliation_deferred account_id=%s link_id=%s status=%s",
                    account_id,
                    link_id,
                    exc.status_code,
                )
                return 0

    async def run_forever(self, stop: asyncio.Event | None = None) -> None:
        stop_event = stop or asyncio.Event()
        while not stop_event.is_set():
            try:
                await self.run_once()
            except asyncio.CancelledError:
                raise
            # One failed scan must not stop future durable retries.
            except Exception:
                log.exception("discord command reconciliation worker failed")
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=self._poll_interval_seconds)
            except TimeoutError:
                pass


def _discord_application_id(account: ChannelAccount) -> str:
    config = account.config if isinstance(account.config, dict) else {}
    for key in ("application_id", "app_id"):
        value = config.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    raise HTTPException(status_code=400, detail="discord application id unavailable")
