from __future__ import annotations

import asyncio

import pytest

from app.services.channel_delivery_worker import ChannelDeliveryWorker
from app.services.channel_message_retention_worker import ChannelMessageRetentionWorker
from app.services.channel_webhook_delivery_worker import ChannelWebhookDeliveryWorker
from app.services.discord_gateway_worker import DiscordGatewayWorker
from app.workers.channels import build_channel_workers


def test_channel_worker_stack_runs_delivery_webhook_gateway_and_retention_workers():
    workers = build_channel_workers()

    assert tuple(type(worker) for worker in workers) == (
        ChannelDeliveryWorker,
        ChannelWebhookDeliveryWorker,
        DiscordGatewayWorker,
        ChannelMessageRetentionWorker,
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
