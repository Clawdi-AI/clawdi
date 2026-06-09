from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.channel import (
    BOT_AGENT_LINK_STATUS_ACTIVE,
    CHANNEL_PROVIDER_TELEGRAM,
    CHANNEL_STATUS_ACTIVE,
    MESSAGE_DIRECTION_INBOUND,
    ChannelAccount,
    ChannelBotAgentLink,
    ChannelMessage,
)
from app.services.channel_webhooks import deliver_telegram_agent_webhook
from app.services.channels import telegram_update_payload
from app.services.metrics import webhook_ttl_drops

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class ChannelWebhookDeliveryResult:
    message_id: UUID
    delivered: bool
    expired: bool = False


class ChannelWebhookDeliveryWorker:
    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        poll_interval_seconds: float = 1.0,
        backoff_base_seconds: float = 1.0,
        backoff_cap_seconds: float = 60.0,
        ttl_seconds: int = 24 * 60 * 60,
    ) -> None:
        self._sessionmaker = sessionmaker
        self._poll_interval_seconds = poll_interval_seconds
        self._backoff_base_seconds = backoff_base_seconds
        self._backoff_cap_seconds = backoff_cap_seconds
        self._ttl = timedelta(seconds=ttl_seconds)

    async def run_once(self) -> ChannelWebhookDeliveryResult | None:
        async with self._sessionmaker() as db:
            candidate = await self._claim_next_telegram_webhook_message(db)
            if candidate is None:
                await db.rollback()
                return None
            message, account, link = candidate
            result = await self._deliver_message(message, account, link)
            await db.commit()
            return result

    async def run_forever(self, stop: asyncio.Event | None = None) -> None:
        stop_event = stop or asyncio.Event()
        backoff = self._backoff_base_seconds
        while not stop_event.is_set():
            try:
                result = await self.run_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - worker must survive one bad webhook.
                log.exception("channel webhook delivery worker failed: %s", exc)
                result = None

            if result is None:
                await _sleep_until_stop(stop_event, self._poll_interval_seconds)
                continue
            if result.delivered or result.expired:
                backoff = self._backoff_base_seconds
                continue
            await _sleep_until_stop(stop_event, backoff)
            backoff = min(backoff * 2, self._backoff_cap_seconds)

    async def _claim_next_telegram_webhook_message(
        self,
        db: AsyncSession,
    ) -> tuple[ChannelMessage, ChannelAccount, ChannelBotAgentLink] | None:
        result = await db.execute(
            select(ChannelMessage, ChannelAccount, ChannelBotAgentLink)
            .join(ChannelAccount, ChannelAccount.id == ChannelMessage.account_id)
            .join(
                ChannelBotAgentLink,
                ChannelBotAgentLink.id == ChannelMessage.bot_agent_link_id,
            )
            .where(
                ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
                ChannelMessage.binding_id.is_not(None),
                ChannelMessage.delivered_at.is_(None),
                ChannelAccount.provider == CHANNEL_PROVIDER_TELEGRAM,
                ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
                ChannelAccount.archived_at.is_(None),
                ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
                ChannelBotAgentLink.archived_at.is_(None),
                func.nullif(
                    func.btrim(
                        func.coalesce(
                            func.jsonb_extract_path_text(
                                ChannelBotAgentLink.config,
                                "telegram_webhook",
                                "url",
                            ),
                            "",
                        )
                    ),
                    "",
                ).is_not(None),
            )
            .order_by(ChannelMessage.inbox_sequence, ChannelMessage.created_at)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        row = result.first()
        if row is None:
            return None
        message, account, link = row
        return message, account, link

    async def _deliver_message(
        self,
        message: ChannelMessage,
        account: ChannelAccount,
        link: ChannelBotAgentLink,
    ) -> ChannelWebhookDeliveryResult:
        now = datetime.now(UTC)
        created_at = message.created_at
        if created_at is not None and now - created_at > self._ttl:
            message.delivered_at = now
            webhook_ttl_drops.inc()
            return ChannelWebhookDeliveryResult(
                message_id=message.id, delivered=False, expired=True
            )

        delivered = await deliver_telegram_agent_webhook(
            account,
            link,
            telegram_update_payload(message),
        )
        if delivered:
            message.delivered_at = now
        return ChannelWebhookDeliveryResult(message_id=message.id, delivered=delivered)


async def _sleep_until_stop(stop_event: asyncio.Event, seconds: float) -> None:
    try:
        await asyncio.wait_for(stop_event.wait(), timeout=seconds)
    except TimeoutError:
        pass
