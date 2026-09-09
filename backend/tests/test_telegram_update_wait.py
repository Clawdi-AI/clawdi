from __future__ import annotations

import asyncio
import time
from uuid import UUID

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.config import settings
from app.models.channel import ChannelBinding, ChannelMessage
from app.services import channels
from app.services.channel_wakeups import (
    ChannelInboxPage,
    ChannelWakeup,
    wait_for_channel_inbound_messages,
)
from tests.test_channel_inbox import _add_message, _create_account_and_binding
from tests.test_channels import (
    _create_paired_telegram_channel,
    _telegram_agent_headers,
    _telegram_bot_path,
)

pytestmark = pytest.mark.committed_db


@pytest.mark.parametrize("limit", [1, 100])
@pytest.mark.parametrize("discard", ["filter", "offset"])
async def test_get_updates_reaches_ready_message_behind_discarded_page(
    client, db_session, channel_agent, monkeypatch, limit, discard
):
    monkeypatch.setattr(settings, "channel_long_poll_interval_seconds", 5.0)
    monkeypatch.setattr(settings, "channel_long_poll_max_seconds", 30.0)
    # All rows predate the request. No later notification should be needed to
    # reach a ready row behind the first page of filtered/acknowledged updates.
    wakeup = ChannelWakeup()
    monkeypatch.setattr(channels, "channel_inbound_messages_enqueued", wakeup)
    created = await _create_paired_telegram_channel(
        client, name="filtered-page-latency", provider_token=None, agent_id=channel_agent.id
    )
    binding = await db_session.scalar(
        select(ChannelBinding).where(ChannelBinding.account_id == UUID(created["id"]))
    )
    assert binding is not None
    dropped = 4 * limit + 1
    for index in range(dropped + 1):
        ready = index == dropped
        kind = "message" if ready or discard == "offset" else "edited_message"
        db_session.add(
            ChannelMessage(
                account_id=binding.account_id,
                bot_agent_link_id=binding.bot_agent_link_id,
                binding_id=binding.id,
                user_id=binding.user_id,
                direction="inbound",
                external_chat_id=binding.external_chat_id,
                text="ready" if ready else "discard",
                payload={
                    "update_id": 1000 + index,
                    kind: {"message_id": index, "chat": {"id": 42, "type": "private"}},
                },
            )
        )
        # Keep the provider update order explicit; bulk RETURNING may reorder inserts.
        await db_session.flush()
    await db_session.commit()
    started = time.perf_counter()
    response = await client.post(
        _telegram_bot_path(created, "getUpdates"),
        headers=_telegram_agent_headers(created),
        json={
            "limit": limit,
            "timeout": 10,
            "offset": 1000 + dropped if discard == "offset" else None,
            "allowed_updates": ["message"],
        },
    )
    elapsed = time.perf_counter() - started
    assert response.status_code == 200, response.text
    assert [item["update_id"] for item in response.json()["result"]] == [1000 + dropped]
    print(f"telegram_page_latency discard={discard} limit={limit} seconds={elapsed:.6f}")
    assert not wakeup._waiters
    # Leave ample room for DB work while detecting the old unconditional 5s wait.
    assert elapsed < 2.5


@pytest.mark.parametrize("timeout", [0, 0.02])
async def test_channel_inbound_progress_obeys_wait_budget(timeout):
    calls = 0
    source = ChannelWakeup()

    async def fetch():
        nonlocal calls
        calls += 1
        return ChannelInboxPage([], progressed=True)

    result = await asyncio.wait_for(
        wait_for_channel_inbound_messages(
            fetch, account_id="budget", timeout_seconds=timeout, wakeup=source
        ),
        1,
    )
    assert result == []
    if timeout == 0:
        assert calls == 1
    else:
        assert calls > 1
    assert not source._waiters


async def test_channel_inbound_progress_yields_for_cancellation():
    fetched = asyncio.Event()
    source = ChannelWakeup()

    async def fetch():
        fetched.set()
        return ChannelInboxPage([], progressed=True)

    pending = asyncio.create_task(
        wait_for_channel_inbound_messages(
            fetch, account_id="cancel", timeout_seconds=30, wakeup=source
        )
    )
    try:
        await asyncio.wait_for(fetched.wait(), 1)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(pending, 1)
        assert not source._waiters
    finally:
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)


async def test_telegram_page_progress_commits_and_releases_binding_lock(
    db_session, engine, seed_user, channel_agent, monkeypatch
):
    account, binding = await _create_account_and_binding(
        db_session, user=seed_user, agent=channel_agent, provider="telegram", chat_id="progress"
    )
    account_id, binding_id = account.id, binding.id
    for index in range(6):
        await _add_message(
            db_session,
            account=account,
            binding=binding,
            text="page",
            payload={"update_id": index, "message" if index == 5 else "edited_message": {}},
        )
    await db_session.commit()
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    original = channels.dequeue_telegram_updates
    calls = 0

    async def observe(db, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            async with sessions() as observer:
                await observer.execute(
                    select(ChannelBinding.id)
                    .where(ChannelBinding.id == binding_id)
                    .with_for_update(nowait=True)
                )
                consumed = await observer.scalar(
                    select(func.count(ChannelMessage.id)).where(
                        ChannelMessage.binding_id == binding_id,
                        ChannelMessage.delivered_at.is_not(None),
                    )
                )
                assert consumed == 4
        return await original(db, **kwargs)

    monkeypatch.setattr(channels, "dequeue_telegram_updates", observe)
    updates = await channels.wait_for_telegram_updates(
        sessions,
        account_id=account_id,
        offset=None,
        limit=1,
        allowed_updates={"message"},
        timeout_seconds=1,
    )
    assert [update["update_id"] for update in updates] == [5]
    assert calls == 2
