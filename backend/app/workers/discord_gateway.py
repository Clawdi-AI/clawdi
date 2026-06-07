from __future__ import annotations

import asyncio
import logging
import signal

from app.core.database import async_session_factory, engine
from app.services.discord_gateway_worker import DiscordGatewayWorker

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)


async def main() -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    worker = DiscordGatewayWorker(async_session_factory, lock_engine=engine)
    log.info("discord gateway worker started")
    await worker.run_forever(stop)
    log.info("discord gateway worker stopped")


if __name__ == "__main__":
    asyncio.run(main())
