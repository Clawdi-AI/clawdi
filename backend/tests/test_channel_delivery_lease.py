from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from sqlalchemy.pool import AsyncAdaptedQueuePool

import app.services.channels as channel_service
from app.models.channel import (
    CHANNEL_PROVIDER_TELEGRAM,
    DELIVERY_STATUS_IN_PROGRESS,
    DELIVERY_STATUS_SUCCEEDED,
    ChannelAccount,
    ChannelBinding,
    ChannelBotAgentLink,
    ChannelDelivery,
    ChannelMessage,
)
from app.models.session import AgentEnvironment
from app.models.user import User
from app.services.channel_delivery_worker import ChannelDeliveryWorker
from app.services.channels import enqueue_channel_outbound_message

pytestmark = [pytest.mark.asyncio, pytest.mark.committed_db]


async def _queue_linked_delivery(
    db: AsyncSession,
    *,
    user: User,
    agent: AgentEnvironment,
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[ChannelDelivery, ChannelBinding]:
    async def allow_link(*_args: object, **_kwargs: object) -> bool:
        return True

    monkeypatch.setattr(channel_service, "bot_agent_link_has_strict_v2_authority", allow_link)
    monkeypatch.setattr(
        channel_service,
        "bot_agent_link_has_provider_cardinality_capability",
        allow_link,
    )
    account = ChannelAccount(
        user_id=user.id,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        name=f"lease-{uuid4().hex[:12]}",
        webhook_secret_hash=f"secret-{uuid4().hex}",
    )
    db.add(account)
    await db.flush()
    link = ChannelBotAgentLink(
        account_id=account.id,
        user_id=user.id,
        agent_id=agent.id,
        agent_token_hash=f"token-{uuid4().hex}",
    )
    db.add(link)
    await db.flush()
    binding = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=link.id,
        user_id=user.id,
        external_chat_id="lease-chat",
        external_chat_type="private",
        external_chat_name="Lease Chat",
    )
    db.add(binding)
    await db.flush()
    _message, delivery = await enqueue_channel_outbound_message(
        db,
        account=account,
        external_chat_id=binding.external_chat_id,
        text="lease",
        bot_agent_link_id=link.id,
    )
    await db.commit()
    return delivery, binding


async def _load_delivery(engine: AsyncEngine, delivery_id: UUID) -> ChannelDelivery:
    async with async_sessionmaker(engine, expire_on_commit=False)() as db:
        return (
            await db.execute(select(ChannelDelivery).where(ChannelDelivery.id == delivery_id))
        ).scalar_one()


async def _expire_lease(engine: AsyncEngine, delivery_id: UUID) -> None:
    async with async_sessionmaker(engine)() as db:
        await db.execute(
            update(ChannelDelivery)
            .where(ChannelDelivery.id == delivery_id)
            .values(locked_at=datetime.now(UTC) - timedelta(hours=1))
        )
        await db.commit()


async def test_provider_send_holds_no_row_locks_or_pooled_connection(
    engine: AsyncEngine,
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
    monkeypatch: pytest.MonkeyPatch,
):
    delivery, binding = await _queue_linked_delivery(
        db_session, user=seed_user, agent=channel_agent, monkeypatch=monkeypatch
    )
    sending = asyncio.Event()
    release = asyncio.Event()

    async def blocked_send(**_kwargs: object) -> tuple[str, dict[str, object]]:
        sending.set()
        await release.wait()
        return "provider-1", {"ok": True}

    monkeypatch.setattr(channel_service, "send_provider_outbound_payload", blocked_send)
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    pool = engine.pool
    assert isinstance(pool, AsyncAdaptedQueuePool)
    checked_out_before = pool.checkedout()
    task = asyncio.create_task(ChannelDeliveryWorker(sessionmaker).run_once())
    try:
        await asyncio.wait_for(sending.wait(), timeout=10)
        assert pool.checkedout() == checked_out_before
        async with sessionmaker() as probe:
            claimed = (
                await probe.execute(
                    select(ChannelDelivery)
                    .where(ChannelDelivery.id == delivery.id)
                    .with_for_update(nowait=True)
                )
            ).scalar_one()
            assert claimed.status == DELIVERY_STATUS_IN_PROGRESS
            assert claimed.locked_by is not None
            assert claimed.attempts == 1
            await probe.execute(
                select(ChannelBotAgentLink.id)
                .where(ChannelBotAgentLink.id == binding.bot_agent_link_id)
                .with_for_update(nowait=True)
            )
            await probe.execute(
                select(ChannelBinding.id)
                .where(ChannelBinding.id == binding.id)
                .with_for_update(nowait=True)
            )
            await probe.rollback()
    finally:
        release.set()
        assert await asyncio.wait_for(task, timeout=10) == delivery.id

    delivered = await _load_delivery(engine, delivery.id)
    assert delivered.status == DELIVERY_STATUS_SUCCEEDED
    assert delivered.locked_by is None


async def test_expired_lease_is_retried_and_stale_outcome_is_ignored(
    engine: AsyncEngine,
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
    monkeypatch: pytest.MonkeyPatch,
):
    delivery, _binding = await _queue_linked_delivery(
        db_session, user=seed_user, agent=channel_agent, monkeypatch=monkeypatch
    )
    stale_sending = asyncio.Event()
    release_stale = asyncio.Event()
    calls = 0

    async def send(**_kwargs: object) -> tuple[str, dict[str, object]]:
        nonlocal calls
        calls += 1
        if calls == 1:
            stale_sending.set()
            await release_stale.wait()
            raise HTTPException(status_code=400, detail="telegram api rejected message")
        return "provider-retry", {"ok": True}

    monkeypatch.setattr(channel_service, "send_provider_outbound_payload", send)
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    stale_task = asyncio.create_task(ChannelDeliveryWorker(sessionmaker).run_once())
    try:
        await asyncio.wait_for(stale_sending.wait(), timeout=10)
        stale_token = (await _load_delivery(engine, delivery.id)).locked_by
        await _expire_lease(engine, delivery.id)

        assert await ChannelDeliveryWorker(sessionmaker).run_once() == delivery.id
    finally:
        release_stale.set()
        assert await asyncio.wait_for(stale_task, timeout=10) == delivery.id

    retried = await _load_delivery(engine, delivery.id)
    assert calls == 2
    assert stale_token is not None
    assert retried.status == DELIVERY_STATUS_SUCCEEDED
    assert retried.attempts == 2
    assert retried.last_error is None
    assert retried.provider_response == {
        "provider": CHANNEL_PROVIDER_TELEGRAM,
        "accepted": True,
        "provider_message_id": "provider-retry",
    }


async def test_outcome_commit_failure_keeps_lease_for_reaper(
    engine: AsyncEngine,
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
    monkeypatch: pytest.MonkeyPatch,
):
    delivery, _binding = await _queue_linked_delivery(
        db_session, user=seed_user, agent=channel_agent, monkeypatch=monkeypatch
    )
    sends: list[str] = []

    async def send(**kwargs: object) -> tuple[str, dict[str, object]]:
        sends.append(str(kwargs["external_chat_id"]))
        return f"provider-{len(sends)}", {"ok": True}

    monkeypatch.setattr(channel_service, "send_provider_outbound_payload", send)

    class OutcomeCommitFails(AsyncSession):
        commits = 0

        async def commit(self) -> None:
            OutcomeCommitFails.commits += 1
            # Commits: lease reap, claim, outcome.
            if OutcomeCommitFails.commits == 3:
                raise RuntimeError("outcome commit failed")
            await super().commit()

    failing = async_sessionmaker(engine, class_=OutcomeCommitFails, expire_on_commit=False)
    with pytest.raises(RuntimeError, match="outcome commit failed"):
        await ChannelDeliveryWorker(failing).run_once()

    stranded = await _load_delivery(engine, delivery.id)
    assert sends == ["lease-chat"]
    assert stranded.status == DELIVERY_STATUS_IN_PROGRESS
    assert stranded.locked_by is not None
    assert stranded.attempts == 1
    async with async_sessionmaker(engine)() as db:
        message = await db.get(ChannelMessage, stranded.message_id)
        assert message is not None
        assert message.provider_message_id is None

    # At-least-once: the lease expires and the reaper returns the row for retry.
    await _expire_lease(engine, delivery.id)
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    assert await ChannelDeliveryWorker(sessionmaker).run_once() == delivery.id

    redelivered = await _load_delivery(engine, delivery.id)
    assert sends == ["lease-chat", "lease-chat"]
    assert redelivered.status == DELIVERY_STATUS_SUCCEEDED
    assert redelivered.attempts == 2
    assert redelivered.locked_by is None
