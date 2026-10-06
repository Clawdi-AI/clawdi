from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, create_autospec
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.models.channel import ChannelAccount, ChannelDelivery, ChannelMessage
from app.services import channel_delivery_worker as worker_module
from app.services.channels import reap_expired_channel_delivery_leases

pytestmark = pytest.mark.committed_db


@pytest.mark.asyncio
async def test_reaper_failure_does_not_block_claims_or_retry_before_interval(monkeypatch):
    sessions = [AsyncMock(), AsyncMock(), AsyncMock()]
    for session in sessions:
        session.__aenter__.return_value = session
    session_iterator = iter(sessions)
    reaper = AsyncMock(side_effect=RuntimeError("reaper unavailable"))
    claim = AsyncMock(return_value=None)
    monkeypatch.setattr(worker_module, "reap_expired_channel_delivery_leases", reaper)
    monkeypatch.setattr(worker_module, "claim_next_channel_delivery", claim)
    sessionmaker = create_autospec(
        async_sessionmaker, instance=True, side_effect=lambda: next(session_iterator)
    )
    worker = worker_module.ChannelDeliveryWorker(sessionmaker)

    assert await worker.run_once() is None
    assert await worker.run_once() is None
    assert reaper.await_count == 1
    assert claim.await_count == 2
    assert claim.await_args_list[0].args[0] is sessions[1]
    assert claim.await_args_list[1].args[0] is sessions[2]


@pytest.mark.asyncio
async def test_reapers_take_bounded_disjoint_batches_and_skip_locked_rows(
    db_session, engine, seed_user
):
    now = datetime.now(UTC)
    account = ChannelAccount(
        user_id=seed_user.id, provider="telegram", name="reaper-test", webhook_secret_hash="0" * 64
    )
    db_session.add(account)
    await db_session.flush()
    message = ChannelMessage(
        account_id=account.id, user_id=seed_user.id, direction="outbound", external_chat_id="111"
    )
    db_session.add(message)
    await db_session.flush()
    rows = [
        ChannelDelivery(
            id=uuid4(),
            account_id=account.id,
            message_id=message.id,
            user_id=seed_user.id,
            status="in_progress",
            attempts=1,
            max_attempts=1 if index == 0 else 5,
            locked_by="abandoned",
            locked_at=now - timedelta(seconds=151),
            next_attempt_at=now,
        )
        for index in range(5)
    ]
    recent = ChannelDelivery(
        account_id=account.id,
        message_id=message.id,
        user_id=seed_user.id,
        status="in_progress",
        attempts=1,
        locked_by="live",
        locked_at=now,
        next_attempt_at=now,
    )
    db_session.add_all([*rows, recent])
    await db_session.commit()
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with sessionmaker() as holder, sessionmaker() as first, sessionmaker() as second:
            await holder.execute(
                select(ChannelDelivery).where(ChannelDelivery.id == rows[0].id).with_for_update()
            )
            assert await reap_expired_channel_delivery_leases(first, limit=2) == 2
            # The first reaper still owns its locks here; the second must skip them.
            assert await reap_expired_channel_delivery_leases(second, limit=2) == 2
            await first.commit()
            await second.commit()
            await holder.rollback()
        assert await reap_expired_channel_delivery_leases(db_session, limit=2) == 1
        await db_session.commit()
        for row in rows:
            await db_session.refresh(row)
            assert row.status == ("failed" if row.max_attempts == 1 else "pending")
            assert row.attempts == 1
            assert row.locked_by is None
        await db_session.refresh(recent)
        assert recent.status == "in_progress"
        assert recent.locked_by == "live"
    finally:
        await db_session.delete(account)
        await db_session.commit()
