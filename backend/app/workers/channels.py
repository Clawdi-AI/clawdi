from __future__ import annotations

import asyncio
import logging
import signal

from app.core.database import async_session_factory, engine
from app.services.channel_delivery_worker import ChannelDeliveryWorker
from app.services.channel_webhook_delivery_worker import ChannelWebhookDeliveryWorker
from app.services.discord_gateway_worker import DiscordGatewayWorker

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)


def build_channel_workers() -> tuple[
    ChannelDeliveryWorker,
    ChannelWebhookDeliveryWorker,
    DiscordGatewayWorker,
]:
    """Build the Clawdi-owned channel worker stack.

    These are backend outbox/webhook/gateway workers. They do not recreate the
    old msg-router process or own provider routing state.
    """
    return (
        ChannelDeliveryWorker(async_session_factory),
        ChannelWebhookDeliveryWorker(async_session_factory),
        DiscordGatewayWorker(async_session_factory, lock_engine=engine),
    )


async def run_channel_workers(stop: asyncio.Event) -> None:
    workers = build_channel_workers()
    await asyncio.gather(*(worker.run_forever(stop) for worker in workers))


async def main() -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    log.info("channel workers started")
    await run_channel_workers(stop)
    log.info("channel workers stopped")


if __name__ == "__main__":
    asyncio.run(main())
