from __future__ import annotations

import asyncio
import json
import logging
import signal
from dataclasses import dataclass, field
from datetime import UTC, datetime

from app.core.database import async_session_factory, engine
from app.core.logging_config import configure_application_logging
from app.services.ai_provider_oauth_revoke_worker import AiProviderOAuthRevokeWorker
from app.services.channel_delivery_worker import ChannelDeliveryWorker
from app.services.channel_message_retention_worker import ChannelMessageRetentionWorker
from app.services.channel_webhook_delivery_worker import ChannelWebhookDeliveryWorker
from app.services.discord_command_reconciliation_worker import (
    DiscordCommandReconciliationWorker,
)
from app.services.discord_gateway_worker import DiscordGatewayWorker
from app.services.metrics import metrics_content_type, render_metrics
from app.services.principal_lifecycle_cleanup_worker import PrincipalLifecycleCleanupWorker
from app.services.runtime_observation_retention_worker import RuntimeObservationRetentionWorker

configure_application_logging()
log = logging.getLogger(__name__)

CHANNEL_WORKER_HEALTH_HOST = "0.0.0.0"
CHANNEL_WORKER_HEALTH_PORT = 8000


@dataclass
class ChannelWorkerHealth:
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    ready: bool = False
    stopping: bool = False

    @property
    def healthy(self) -> bool:
        return self.ready and not self.stopping

    def payload(self) -> dict[str, str]:
        if self.stopping:
            status = "stopping"
        elif self.ready:
            status = "ok"
        else:
            status = "starting"
        return {
            "status": status,
            "worker": "channels",
            "started_at": self.started_at.isoformat(),
        }


def _raw_http_response(status_code: int, body: bytes, *, content_type: str) -> bytes:
    reason = {
        200: "OK",
        404: "Not Found",
        503: "Service Unavailable",
    }.get(status_code, "Error")
    headers = (
        f"HTTP/1.1 {status_code} {reason}\r\n"
        f"Content-Type: {content_type}\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Connection: close\r\n"
        "\r\n"
    ).encode("ascii")
    return headers + body


def _http_response(status_code: int, payload: dict[str, str]) -> bytes:
    return _raw_http_response(
        status_code,
        json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        content_type="application/json",
    )


async def _handle_health_request(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    health: ChannelWorkerHealth,
) -> None:
    try:
        request_line = await asyncio.wait_for(reader.readline(), timeout=2)
        parts = request_line.decode("ascii", errors="ignore").strip().split()
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=2)
            if line in {b"\r\n", b"\n", b""}:
                break

        method = parts[0] if parts else ""
        path = parts[1] if len(parts) > 1 else ""
        if method == "GET" and path == "/metrics":
            writer.write(
                _raw_http_response(
                    200,
                    render_metrics(),
                    content_type=metrics_content_type(),
                )
            )
        elif method != "GET" or path != "/health":
            writer.write(_http_response(404, {"status": "not_found"}))
        elif health.healthy:
            writer.write(_http_response(200, health.payload()))
        else:
            writer.write(_http_response(503, health.payload()))
        await writer.drain()
    finally:
        writer.close()
        await writer.wait_closed()


async def run_health_server(
    *,
    health: ChannelWorkerHealth,
    stop: asyncio.Event,
    host: str = CHANNEL_WORKER_HEALTH_HOST,
    port: int = CHANNEL_WORKER_HEALTH_PORT,
) -> None:
    server = await asyncio.start_server(
        lambda reader, writer: _handle_health_request(reader, writer, health),
        host,
        port,
    )
    log.info("channel worker health server listening on %s:%s", host, port)
    async with server:
        await stop.wait()
        health.stopping = True
        server.close()
        await server.wait_closed()


def build_channel_workers() -> tuple[
    AiProviderOAuthRevokeWorker,
    ChannelDeliveryWorker,
    ChannelWebhookDeliveryWorker,
    DiscordCommandReconciliationWorker,
    DiscordGatewayWorker,
    PrincipalLifecycleCleanupWorker,
    ChannelMessageRetentionWorker,
    RuntimeObservationRetentionWorker,
]:
    """Build the Clawdi-owned channel worker stack.

    These are backend outbox/webhook/gateway workers. They do not recreate an
    application-level runtime relay or own physical provider transport state.
    """
    return (
        AiProviderOAuthRevokeWorker(async_session_factory),
        ChannelDeliveryWorker(async_session_factory),
        ChannelWebhookDeliveryWorker(async_session_factory),
        DiscordCommandReconciliationWorker(async_session_factory),
        DiscordGatewayWorker(async_session_factory, lock_engine=engine),
        PrincipalLifecycleCleanupWorker(async_session_factory),
        ChannelMessageRetentionWorker(async_session_factory),
        RuntimeObservationRetentionWorker(async_session_factory),
    )


async def run_channel_workers(
    stop: asyncio.Event,
    health: ChannelWorkerHealth | None = None,
) -> None:
    workers = build_channel_workers()
    if health is not None:
        health.ready = True
    await asyncio.gather(*(worker.run_forever(stop) for worker in workers))


async def main() -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    log.info("channel workers started")
    health = ChannelWorkerHealth()
    health_task = asyncio.create_task(run_health_server(health=health, stop=stop))
    worker_task = asyncio.create_task(run_channel_workers(stop, health))
    try:
        await asyncio.gather(health_task, worker_task)
    finally:
        health.stopping = True
        stop.set()
        for task in (health_task, worker_task):
            if not task.done():
                task.cancel()
        await asyncio.gather(health_task, worker_task, return_exceptions=True)
    log.info("channel workers stopped")


if __name__ == "__main__":
    asyncio.run(main())
