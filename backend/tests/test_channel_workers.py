from __future__ import annotations

import asyncio
from types import SimpleNamespace
from uuid import UUID

import pytest

from app.core.config import settings
from app.routes.channel_routers.whatsapp import _wait_whatsapp_websocket_inbox
from app.services.ai_provider_oauth_revoke_worker import AiProviderOAuthRevokeWorker
from app.services.channel_delivery_worker import ChannelDeliveryWorker
from app.services.channel_message_retention_worker import ChannelMessageRetentionWorker
from app.services.channel_wakeups import ChannelWakeup
from app.services.channel_webhook_delivery_worker import ChannelWebhookDeliveryWorker
from app.services.channels import ChannelRetentionBatch
from app.services.discord_command_reconciliation_worker import (
    DiscordCommandReconciliationWorker,
)
from app.services.discord_gateway_worker import DiscordGatewayWorker
from app.services.principal_lifecycle_cleanup_worker import PrincipalLifecycleCleanupWorker
from app.services.runtime_observation_retention_worker import RuntimeObservationRetentionWorker
from app.workers.channels import (
    ChannelWorkerHealth,
    _handle_health_request,
    build_channel_workers,
    run_channel_workers,
)

pytestmark = pytest.mark.committed_db


def test_channel_worker_stack_runs_revoke_delivery_webhook_gateway_and_retention_workers():
    workers = build_channel_workers()

    assert tuple(type(worker) for worker in workers) == (
        AiProviderOAuthRevokeWorker,
        ChannelDeliveryWorker,
        ChannelWebhookDeliveryWorker,
        DiscordCommandReconciliationWorker,
        DiscordGatewayWorker,
        PrincipalLifecycleCleanupWorker,
        ChannelMessageRetentionWorker,
        RuntimeObservationRetentionWorker,
    )


@pytest.mark.asyncio
async def test_channel_worker_process_owns_postgres_listener(monkeypatch):
    import app.workers.channels as channel_workers

    calls: list[str] = []

    class Worker:
        async def run_forever(self, _stop):
            calls.append("worker")

    async def start_listener():
        calls.append("start-listener")

    async def stop_listener():
        calls.append("stop-listener")

    monkeypatch.setattr(channel_workers, "start_postgres_listener", start_listener)
    monkeypatch.setattr(channel_workers, "stop_postgres_listener", stop_listener)
    monkeypatch.setattr(channel_workers, "build_channel_workers", lambda: (Worker(),))

    await run_channel_workers(asyncio.Event())

    assert calls == ["start-listener", "worker", "stop-listener"]


@pytest.mark.asyncio
async def test_channel_delivery_worker_wakes_on_enqueue_signal(monkeypatch):
    wakeup = ChannelWakeup()
    stop = asyncio.Event()
    idle = asyncio.Event()
    awakened = asyncio.Event()
    calls = 0
    worker = ChannelDeliveryWorker(None, poll_interval_seconds=60, wakeup=wakeup)

    async def fake_run_once():
        nonlocal calls
        calls += 1
        if calls == 1:
            idle.set()
            return None
        awakened.set()
        stop.set()
        return None

    monkeypatch.setattr(worker, "run_once", fake_run_once)
    task = asyncio.create_task(worker.run_forever(stop))
    await idle.wait()

    wakeup.signal()

    await asyncio.wait_for(awakened.wait(), timeout=1)
    await asyncio.wait_for(task, timeout=1)
    assert calls == 2


@pytest.mark.asyncio
async def test_channel_delivery_worker_polls_when_listener_is_disabled(monkeypatch):
    stop = asyncio.Event()
    calls = 0
    worker = ChannelDeliveryWorker(None, poll_interval_seconds=0, wakeup=ChannelWakeup())

    async def fake_run_once():
        nonlocal calls
        calls += 1
        if calls == 2:
            stop.set()
        return None

    monkeypatch.setattr(worker, "run_once", fake_run_once)

    await asyncio.wait_for(worker.run_forever(stop), timeout=1)
    assert calls == 2


@pytest.mark.asyncio
async def test_whatsapp_websocket_inbox_wakes_on_inbound_signal(monkeypatch):
    import app.routes.channel_routers.whatsapp as whatsapp_routes

    wakeup = ChannelWakeup()
    first_query_complete = asyncio.Event()
    query_count = 0
    message = SimpleNamespace(
        inbox_sequence=1,
        external_chat_id="15551110000@s.whatsapp.net",
        payload={},
        provider_message_id="message-1",
        text="hello",
    )

    class Result:
        def __init__(self, values):
            self._values = values

        def scalars(self):
            return self

        def all(self):
            return self._values

    class Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            return False

        async def execute(self, _statement):
            nonlocal query_count
            query_count += 1
            if query_count == 1:
                first_query_complete.set()
                return Result([])
            return Result([message])

    monkeypatch.setattr(whatsapp_routes, "async_session_factory", Session)
    monkeypatch.setattr(whatsapp_routes, "channel_inbound_messages_enqueued", wakeup)
    monkeypatch.setattr(settings, "channel_long_poll_max_seconds", 60)
    monkeypatch.setattr(settings, "channel_long_poll_interval_seconds", 60)
    waiting = asyncio.create_task(
        _wait_whatsapp_websocket_inbox(
            account_id=UUID("00000000-0000-4000-8000-000000000906"),
            bot_agent_link_id=UUID("00000000-0000-4000-8000-000000000907"),
            after_sequence=0,
            limit=100,
        )
    )
    await first_query_complete.wait()

    wakeup.signal()

    events = await asyncio.wait_for(waiting, timeout=1)
    assert [event.provider_message_id for event in events] == ["message-1"]
    assert query_count == 2


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
