from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime, timedelta
from uuid import UUID

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.models.channel import ChannelBinding, ChannelMessage
from app.models.hosted_runtime import HostedRuntimeState
from app.services import channel_webhook_delivery_worker as worker_module
from app.services.channel_webhook_delivery_worker import ChannelWebhookDeliveryWorker
from tests.test_channels import (
    _create_paired_telegram_channel,
    _pair_telegram_chat,
    _telegram_agent_headers,
    _telegram_bot_path,
)

pytestmark = pytest.mark.committed_db


@pytest_asyncio.fixture
async def webhook_queue(client, db_session, engine, channel_agent, second_channel_agent):
    channels = []
    bindings = []
    for name, agent in (("a", channel_agent), ("b", second_channel_agent)):
        channel = await _create_paired_telegram_channel(
            client,
            name=f"retry-{name}",
            provider_token=None,
            agent_id=agent.id,
        )
        # Enqueue before setWebhook so the fixture does not make inline HTTP calls.
        for index in range(2 if name == "a" else 1):
            response = await client.post(
                f"/v1/channels/telegram/{channel['id']}/webhook",
                headers={"x-telegram-bot-api-secret-token": channel["webhook_secret"]},
                json={
                    "update_id": 100 + index,
                    "message": {
                        "message_id": 100 + index,
                        "text": f"{name}{index}",
                        "chat": {"id": 42, "type": "private"},
                    },
                },
            )
            assert response.status_code == 200, response.text
        response = await client.post(
            _telegram_bot_path(channel, "setWebhook"),
            headers=_telegram_agent_headers(channel),
            json={"url": f"https://{name}.example/hook"},
        )
        assert response.status_code == 200, response.text
        binding = await db_session.scalar(
            select(ChannelBinding).where(ChannelBinding.account_id == UUID(channel["id"]))
        )
        bindings.append(binding.id)
        channels.append(channel)
    await db_session.rollback()
    return async_sessionmaker(engine, expire_on_commit=False), bindings, channels


@pytest.fixture
def provider(monkeypatch):
    class Provider:
        calls = []
        fail_a = True
        entered = asyncio.Event()
        release = asyncio.Event()
        failed = asyncio.Event()
        delivered_b = asyncio.Event()
        block_a = False
        failure_returned_at = None
        b_called_at = None

        def __init__(self, **_kwargs):
            pass

        async def post(self, url, **kwargs):
            text = kwargs["json"]["message"]["text"]
            self.calls.append((url, text))
            if text.startswith("a"):
                self.entered.set()
                if self.block_a:
                    await self.release.wait()
                if self.fail_a:
                    Provider.failure_returned_at = time.perf_counter()
                    self.failed.set()
                    return httpx.Response(503)
            else:
                Provider.b_called_at = time.perf_counter()
                self.delivered_b.set()
            return httpx.Response(200)

    monkeypatch.setattr("app.services.channel_webhooks.SafePublicHttpClient", Provider)
    return Provider


async def make_due(factory, binding_id):
    async with factory() as db:
        await db.execute(
            update(ChannelBinding)
            .where(ChannelBinding.id == binding_id)
            .values(webhook_retry_at=datetime.now(UTC) - timedelta(seconds=1))
        )
        await db.commit()


async def test_failed_binding_does_not_sleep_before_healthy_binding(webhook_queue, provider):
    factory, bindings, _ = webhook_queue
    stop = asyncio.Event()
    task = asyncio.create_task(ChannelWebhookDeliveryWorker(factory).run_forever(stop))
    try:
        await asyncio.wait_for(provider.failed.wait(), 2)
        # Start the bound after A returns, not when B was enqueued. Serial HTTP
        # can still block B for the entire duration of A's in-flight request.
        await asyncio.wait_for(provider.delivered_b.wait(), 0.75)
    finally:
        stop.set()
        await asyncio.wait_for(task, 2)
    assert [text for _, text in provider.calls] == ["a0", "b0"]
    print(f"B called {provider.b_called_at - provider.failure_returned_at:.6f}s after A failure")
    # A newly constructed worker respects the committed cooldown as well.
    assert await ChannelWebhookDeliveryWorker(factory).run_once() is None
    await make_due(factory, bindings[0])
    provider.fail_a = False
    worker = ChannelWebhookDeliveryWorker(factory)
    assert (await worker.run_once()).delivered
    assert (await worker.run_once()).delivered
    assert [text for _, text in provider.calls] == ["a0", "b0", "a0", "a1"]
    async with factory() as db:
        binding = await db.get(ChannelBinding, bindings[0])
        assert (binding.webhook_retry_at, binding.webhook_retry_step) == (None, 0)


async def test_retry_steps_persist_and_cap_without_retrying_early(
    webhook_queue, provider, monkeypatch
):
    factory, bindings, _ = webhook_queue
    now = datetime.now(UTC)

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return now

    monkeypatch.setattr(worker_module, "datetime", Clock)
    for index, seconds in enumerate((1, 2, 4, 8, 16, 32, 60, 60)):
        worker = ChannelWebhookDeliveryWorker(factory)
        assert not (await worker.run_once()).delivered
        if index == 0:
            assert (await worker.run_once()).delivered  # Drain independent B.
        async with factory() as db:
            binding = await db.get(ChannelBinding, bindings[0])
            assert binding.webhook_retry_step == min(index + 1, 7)
            assert binding.webhook_retry_at == now + timedelta(seconds=seconds)
        now += timedelta(seconds=seconds, microseconds=-1)
        assert await ChannelWebhookDeliveryWorker(factory).run_once() is None
        now += timedelta(microseconds=1)
    assert [text for _, text in provider.calls].count("a0") == 8
    assert not any(text == "a1" for _, text in provider.calls)


async def test_two_workers_skip_the_entire_locked_binding(webhook_queue, provider):
    factory, _, _ = webhook_queue
    provider.block_a = True
    first = asyncio.create_task(ChannelWebhookDeliveryWorker(factory).run_once())
    try:
        await asyncio.wait_for(provider.entered.wait(), 2)
        second = ChannelWebhookDeliveryWorker(factory)
        assert (await asyncio.wait_for(second.run_once(), 1)).delivered
        assert await asyncio.wait_for(second.run_once(), 1) is None
        assert [text for _, text in provider.calls] == ["a0", "b0"]
    finally:
        provider.release.set()
        assert not (await asyncio.wait_for(first, 2)).delivered


@pytest.mark.parametrize("terminal", ["ttl", "authority", "inline", "retirement"])
async def test_retry_state_clears_on_terminal_outcomes(
    webhook_queue,
    provider,
    client,
    terminal,
    db_session,
    seed_user,
):
    factory, bindings, channels = webhook_queue
    worker = ChannelWebhookDeliveryWorker(factory)
    assert not (await worker.run_once()).delivered
    if terminal in {"ttl", "authority"}:
        await make_due(factory, bindings[0])
        async with factory() as db:
            if terminal == "ttl":
                await db.execute(
                    update(ChannelMessage)
                    .where(ChannelMessage.binding_id == bindings[0])
                    .values(created_at=datetime.now(UTC) - timedelta(days=2))
                )
            else:
                # A real persisted authority mismatch, not a mocked predicate.
                state = await db.get(HostedRuntimeState, UUID(channels[0]["agent_id"]))
                state.deployment_id = "retired-authority"
            await db.commit()
        assert (await worker.run_once()).expired
        assert len(provider.calls) == 1
    else:
        provider.fail_a = False
        response = await client.post(
            f"/v1/channels/telegram/{channels[0]['id']}/webhook",
            headers={"x-telegram-bot-api-secret-token": channels[0]["webhook_secret"]},
            json={
                "update_id": 200,
                "message": {
                    "message_id": 200,
                    "text": "a-inline" if terminal == "inline" else "/clawdi_unpair",
                    "chat": {"id": 42, "type": "private"},
                    "from": {"id": 4242, "is_bot": False},
                },
            },
        )
        assert response.status_code == 200, response.text
    async with factory() as db:
        binding = await db.get(ChannelBinding, bindings[0])
        assert (binding.webhook_retry_at, binding.webhook_retry_step) == (None, 0)
        if terminal == "retirement":
            assert binding.status == "archived"
            # Historical rows may still carry state. Reactivation must reset it.
            binding.webhook_retry_at = datetime.now(UTC) + timedelta(seconds=60)
            binding.webhook_retry_step = 7
            await db.commit()
    if terminal == "retirement":
        await db_session.refresh(seed_user)
        await _pair_telegram_chat(client, created=channels[0], chat_id="42", update_id=201)
        async with factory() as db:
            binding = await db.get(ChannelBinding, bindings[0])
            assert binding.status == "active"
            assert (binding.webhook_retry_at, binding.webhook_retry_step) == (None, 0)


async def test_webhook_reconfiguration_keeps_cooldown_without_waiting_for_binding(
    webhook_queue,
    provider,
    client,
):
    factory, bindings, channels = webhook_queue
    worker = ChannelWebhookDeliveryWorker(factory)
    assert not (await worker.run_once()).delivered
    assert (await worker.run_once()).delivered
    channel = channels[0]
    async with factory() as locked_db:
        binding = await locked_db.scalar(
            select(ChannelBinding).where(ChannelBinding.id == bindings[0]).with_for_update()
        )
        original_retry = binding.webhook_retry_at
        for method, body in (
            ("deleteWebhook", {}),
            ("setWebhook", {"url": "https://new.example/hook"}),
        ):
            response = await asyncio.wait_for(
                client.post(
                    _telegram_bot_path(channel, method),
                    headers=_telegram_agent_headers(channel),
                    json=body,
                ),
                1,
            )
            assert response.status_code == 200, response.text
        await locked_db.refresh(binding)
        assert binding.webhook_retry_at == original_retry
        assert binding.webhook_retry_step == 1
    info = await client.get(
        _telegram_bot_path(channel, "getWebhookInfo"), headers=_telegram_agent_headers(channel)
    )
    assert info.json()["result"]["url"] == "https://new.example/hook"
    assert info.json()["result"]["pending_update_count"] == 2
    assert await ChannelWebhookDeliveryWorker(factory).run_once() is None
    await make_due(factory, bindings[0])
    provider.fail_a = False
    assert (await worker.run_once()).delivered
    assert provider.calls[-1] == ("https://new.example/hook", "a0")


async def test_infrastructure_errors_back_off_and_stop(monkeypatch):
    worker = ChannelWebhookDeliveryWorker(None)
    stop = asyncio.Event()
    waits = []

    async def unavailable():
        raise RuntimeError("synthetic database outage")

    async def wait(event, seconds):
        waits.append(seconds)
        if len(waits) == 8:
            event.set()

    monkeypatch.setattr(worker, "run_once", unavailable)
    monkeypatch.setattr(worker_module, "_sleep_until_stop", wait)
    await worker.run_forever(stop)
    assert waits == [1, 2, 4, 8, 16, 32, 60, 60]
