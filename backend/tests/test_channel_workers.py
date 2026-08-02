from __future__ import annotations

import asyncio

import pytest

from app.services.ai_provider_oauth_revoke_worker import AiProviderOAuthRevokeWorker
from app.services.channel_delivery_worker import ChannelDeliveryWorker
from app.services.channel_message_retention_worker import ChannelMessageRetentionWorker
from app.services.channel_webhook_delivery_worker import ChannelWebhookDeliveryWorker
from app.services.channels import ChannelRetentionBatch
from app.services.discord_command_reconciliation_worker import (
    DiscordCommandReconciliationWorker,
)
from app.services.discord_gateway_worker import DiscordGatewayWorker
from app.services.runtime_observation_retention_worker import RuntimeObservationRetentionWorker
from app.workers.channels import ChannelWorkerHealth, _handle_health_request, build_channel_workers

pytestmark = pytest.mark.committed_db


def test_channel_worker_stack_runs_revoke_delivery_webhook_gateway_and_retention_workers():
    workers = build_channel_workers()

    assert tuple(type(worker) for worker in workers) == (
        AiProviderOAuthRevokeWorker,
        ChannelDeliveryWorker,
        ChannelWebhookDeliveryWorker,
        DiscordCommandReconciliationWorker,
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


class _FakeRetentionSession:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return False

    async def commit(self) -> None:
        return None


@pytest.mark.asyncio
async def test_channel_message_retention_worker_stops_between_batches(monkeypatch):
    stop = asyncio.Event()
    calls: list[int] = []

    async def fake_prune(_db, *, now, limit):
        del now
        calls.append(limit)
        stop.set()
        return ChannelRetentionBatch(messages=limit)

    monkeypatch.setattr(
        "app.services.channel_message_retention_worker.prune_channel_retention_batch",
        fake_prune,
    )
    worker = ChannelMessageRetentionWorker(
        lambda: _FakeRetentionSession(),
        batch_size=3,
        max_batches=10,
        stuck_pending_hours=24,
    )

    deleted = await worker.run_once(stop)

    assert deleted == 3
    assert calls == [3]


@pytest.mark.parametrize(
    ("field", "kwargs"),
    [
        ("batch_size", {"batch_size": 0}),
        ("max_batches", {"max_batches": 0}),
        ("stuck_pending_hours", {"stuck_pending_hours": 0}),
    ],
)
def test_channel_message_retention_worker_rejects_non_positive_bounds(field, kwargs):
    with pytest.raises(ValueError, match=field):
        ChannelMessageRetentionWorker(None, **kwargs)


async def _read_health_response(port: int, path: str = "/health") -> str:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".encode("ascii"))
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


@pytest.mark.asyncio
async def test_channel_worker_exports_process_local_metrics_without_changing_health():
    health = ChannelWorkerHealth(ready=True)
    server = await asyncio.start_server(
        lambda reader, writer: _handle_health_request(reader, writer, health),
        "127.0.0.1",
        0,
    )
    assert server.sockets
    port = server.sockets[0].getsockname()[1]

    async with server:
        metrics = await _read_health_response(port, "/metrics")
        health_response = await _read_health_response(port)

    assert "200 OK" in metrics
    assert "msg_router_channel_queue_pending" in metrics
    assert "200 OK" in health_response
    assert '"status":"ok"' in health_response
