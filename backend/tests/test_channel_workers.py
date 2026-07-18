from __future__ import annotations

import asyncio

import pytest

from app.services.channel_delivery_worker import ChannelDeliveryWorker
from app.services.channel_message_retention_worker import ChannelMessageRetentionWorker
from app.services.channel_webhook_delivery_worker import ChannelWebhookDeliveryWorker
from app.services.discord_gateway_worker import DiscordGatewayWorker
from app.services.runtime_observation_retention_worker import RuntimeObservationRetentionWorker
from app.workers.channels import ChannelWorkerHealth, _handle_health_request, build_channel_workers

pytestmark = pytest.mark.committed_db


def test_channel_worker_stack_runs_delivery_webhook_gateway_and_retention_workers():
    workers = build_channel_workers()

    assert tuple(type(worker) for worker in workers) == (
        ChannelDeliveryWorker,
        ChannelWebhookDeliveryWorker,
        DiscordGatewayWorker,
        ChannelMessageRetentionWorker,
        RuntimeObservationRetentionWorker,
    )


@pytest.mark.asyncio
async def test_channel_message_retention_worker_delays_first_prune(monkeypatch):
    worker = ChannelMessageRetentionWorker(None, poll_interval_seconds=0.2)
    calls: list[str] = []

    async def fake_run_once() -> int:
        calls.append("run_once")
        return 0

    monkeypatch.setattr(worker, "run_once", fake_run_once)
    stop = asyncio.Event()
    task = asyncio.create_task(worker.run_forever(stop))
    await asyncio.sleep(0.01)
    stop.set()
    await asyncio.wait_for(task, timeout=1)

    assert calls == []


async def _read_health_response(port: int) -> str:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
    await writer.drain()
    response = await reader.read()
    writer.close()
    await writer.wait_closed()
    return response.decode("utf-8")


@pytest.mark.asyncio
async def test_channel_worker_health_endpoint_reports_readiness():
    health = ChannelWorkerHealth()
    server = await asyncio.start_server(
        lambda reader, writer: _handle_health_request(reader, writer, health),
        "127.0.0.1",
        0,
    )
    assert server.sockets
    port = server.sockets[0].getsockname()[1]

    async with server:
        starting = await _read_health_response(port)
        health.ready = True
        ready = await _read_health_response(port)
        health.stopping = True
        stopping = await _read_health_response(port)

    assert "503 Service Unavailable" in starting
    assert '"status":"starting"' in starting
    assert "200 OK" in ready
    assert '"status":"ok"' in ready
    assert "503 Service Unavailable" in stopping
    assert '"status":"stopping"' in stopping
