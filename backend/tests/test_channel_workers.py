from __future__ import annotations

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
