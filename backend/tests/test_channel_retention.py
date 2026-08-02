from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.channel import (
    CHANNEL_PROVIDER_DISCORD,
    CHANNEL_PROVIDER_TELEGRAM,
    DELIVERY_STATUS_FAILED,
    DELIVERY_STATUS_SUCCEEDED,
    MESSAGE_DIRECTION_INBOUND,
    PAIR_CODE_STATUS_CLAIMED,
    PAIR_CODE_STATUS_PENDING,
    ChannelAccount,
    ChannelAgentReference,
    ChannelBinding,
    ChannelBotAgentLink,
    ChannelDebugEvent,
    ChannelDelivery,
    ChannelMessage,
    ChannelPairCode,
    ChannelScheduledMessage,
)
from app.models.session import AgentEnvironment
from app.models.user import User
from app.services import channels as channel_service
from app.services.channel_message_retention_worker import ChannelMessageRetentionWorker
from app.services.channels import (
    DISCORD_REF_INTERACTION_TOKEN,
    TELEGRAM_REF_FILE_ID,
    ChannelRetentionBatch,
    channel_queue_snapshots,
    deliver_channel_delivery,
    enqueue_channel_outbound_message,
    prune_channel_messages,
    prune_channel_retention_batch,
    send_discord_message,
    send_telegram_message,
)
from app.services.metrics import render_metrics

pytestmark = pytest.mark.committed_db


async def _create_account_and_binding(
    db: AsyncSession,
    *,
    user: User,
    agent: AgentEnvironment,
    provider: str,
    chat_id: str,
) -> tuple[ChannelAccount, ChannelBotAgentLink, ChannelBinding]:
    account = ChannelAccount(
        user_id=user.id,
        provider=provider,
        name=f"{provider}-retention-{uuid4().hex[:12]}",
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
        external_chat_id=chat_id,
        external_chat_type="private",
        external_chat_name=f"Chat {chat_id}",
    )
    db.add(binding)
    await db.flush()
    return account, link, binding


async def _add_message(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    binding: ChannelBinding | None,
    text: str,
    direction: str = MESSAGE_DIRECTION_INBOUND,
) -> ChannelMessage:
    message = ChannelMessage(
        account_id=account.id,
        bot_agent_link_id=binding.bot_agent_link_id if binding is not None else None,
        binding_id=binding.id if binding is not None else None,
        user_id=account.user_id,
        direction=direction,
        external_chat_id=binding.external_chat_id if binding is not None else "unbound",
        text=text,
        payload={"text": text},
    )
    db.add(message)
    await db.flush()
    return message


@pytest.mark.asyncio
async def test_synchronous_telegram_and_discord_outbound_are_terminal_on_record(
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
    monkeypatch: pytest.MonkeyPatch,
):
    telegram, _telegram_link, _telegram_binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        chat_id="telegram-sync",
    )
    discord, _discord_link, discord_binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_DISCORD,
        chat_id="discord-sync",
    )

    async def fake_telegram_send(**_kwargs):
        return "telegram-provider-message", {"ok": True}

    async def fake_discord_send(**_kwargs):
        return "discord-provider-message", {"id": "discord-provider-message"}

    monkeypatch.setattr(channel_service, "_send_telegram_provider_payload", fake_telegram_send)
    monkeypatch.setattr(channel_service, "_send_discord_provider_payload", fake_discord_send)

    telegram_message = await send_telegram_message(
        db_session,
        account=telegram,
        external_chat_id="telegram-sync",
        text="telegram delivered",
        bind_to_existing=False,
    )
    discord_message = await send_discord_message(
        db_session,
        account=discord,
        external_chat_id="discord-sync",
        text="discord delivered",
        bind_to_existing=False,
    )
    recorded_discord_message = await channel_service.record_discord_outbound_message(
        db_session,
        account=discord,
        binding=discord_binding,
        external_chat_id=discord_binding.external_chat_id,
        provider_response={
            "id": "discord-gateway-provider-message",
            "channel_id": discord_binding.external_chat_id,
            "content": "discord gateway delivered",
        },
    )

    assert telegram_message.delivered_at is not None
    assert discord_message.delivered_at is not None
    assert recorded_discord_message.delivered_at is not None


@pytest.mark.asyncio
async def test_queued_success_and_terminal_failure_prune_with_delivery_cascade(
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
    monkeypatch: pytest.MonkeyPatch,
):
    account, _link, _binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        chat_id="bound-chat",
    )
    succeeded_message, succeeded_delivery = await enqueue_channel_outbound_message(
        db_session,
        account=account,
        external_chat_id="success-unbound-chat",
        text="success",
    )

    async def fake_success(**_kwargs):
        return "provider-success", {"ok": True}

    monkeypatch.setattr(channel_service, "send_provider_outbound_payload", fake_success)
    await deliver_channel_delivery(db_session, delivery=succeeded_delivery)
    assert succeeded_delivery.status == DELIVERY_STATUS_SUCCEEDED
    assert succeeded_message.delivered_at is not None

    failed_message, failed_delivery = await enqueue_channel_outbound_message(
        db_session,
        account=account,
        external_chat_id="failure-unbound-chat",
        text="failure",
    )

    async def fake_terminal_failure(**_kwargs):
        raise HTTPException(status_code=400, detail="provider rejected message")

    monkeypatch.setattr(channel_service, "send_provider_outbound_payload", fake_terminal_failure)
    await deliver_channel_delivery(db_session, delivery=failed_delivery)
    assert failed_delivery.status == DELIVERY_STATUS_FAILED
    assert failed_message.delivered_at is None

    pending_message, pending_delivery = await enqueue_channel_outbound_message(
        db_session,
        account=account,
        external_chat_id="pending-unbound-chat",
        text="pending",
    )
    now = datetime(2026, 8, 2, tzinfo=UTC)
    old = now - timedelta(days=31)
    succeeded_message.delivered_at = old
    succeeded_message.created_at = old
    succeeded_delivery.updated_at = old
    failed_message.created_at = old
    failed_delivery.updated_at = old
    pending_message.created_at = old
    pending_delivery.created_at = old
    pending_delivery.updated_at = old
    await db_session.flush()

    deleted = await prune_channel_messages(db_session, now=now, limit=10)

    assert deleted == 2
    assert await db_session.get(ChannelMessage, succeeded_message.id) is None
    assert await db_session.get(ChannelMessage, failed_message.id) is None
    terminal_deliveries = await db_session.scalar(
        select(func.count(ChannelDelivery.id)).where(
            ChannelDelivery.id.in_((succeeded_delivery.id, failed_delivery.id))
        )
    )
    assert terminal_deliveries == 0
    assert await db_session.get(ChannelMessage, pending_message.id) is not None
    assert await db_session.get(ChannelDelivery, pending_delivery.id) is not None


@pytest.mark.asyncio
async def test_retention_horizons_are_strict_and_pending_bound_is_not_deleted(
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
):
    account, _link, binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_DISCORD,
        chat_id="retention-horizon",
    )
    now = datetime(2026, 8, 2, tzinfo=UTC)
    delivered_cutoff = now - timedelta(days=30)
    unbound_cutoff = now - timedelta(hours=24)
    expired_delivered = await _add_message(
        db_session, account=account, binding=binding, text="expired-delivered"
    )
    expired_delivered.delivered_at = delivered_cutoff - timedelta(microseconds=1)
    boundary_delivered = await _add_message(
        db_session, account=account, binding=binding, text="boundary-delivered"
    )
    boundary_delivered.delivered_at = delivered_cutoff
    expired_unbound = await _add_message(
        db_session, account=account, binding=None, text="expired-unbound"
    )
    expired_unbound.created_at = unbound_cutoff - timedelta(microseconds=1)
    boundary_unbound = await _add_message(
        db_session, account=account, binding=None, text="boundary-unbound"
    )
    boundary_unbound.created_at = unbound_cutoff
    pending_bound = await _add_message(
        db_session, account=account, binding=binding, text="pending-bound"
    )
    pending_bound.created_at = now - timedelta(days=365)
    await db_session.flush()

    deleted = await prune_channel_messages(db_session, now=now, limit=10)

    assert deleted == 2
    assert await db_session.get(ChannelMessage, expired_delivered.id) is None
    assert await db_session.get(ChannelMessage, expired_unbound.id) is None
    assert await db_session.get(ChannelMessage, boundary_delivered.id) is not None
    assert await db_session.get(ChannelMessage, boundary_unbound.id) is not None
    assert await db_session.get(ChannelMessage, pending_bound.id) is not None


@pytest.mark.asyncio
async def test_concurrent_message_cleaners_skip_locked_rows(
    engine,
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
):
    account, _link, binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        chat_id="concurrent-cleaners",
    )
    now = datetime(2026, 8, 2, tzinfo=UTC)
    old = now - timedelta(days=31)
    for index in range(5):
        message = await _add_message(
            db_session,
            account=account,
            binding=binding,
            text=f"expired-{index}",
        )
        message.created_at = old
        message.delivered_at = old
    await db_session.commit()

    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as first, session_factory() as second:
        first_deleted = await prune_channel_messages(first, now=now, limit=2)
        second_deleted = await prune_channel_messages(second, now=now, limit=2)
        await first.commit()
        await second.commit()

    remaining = await db_session.scalar(
        select(func.count(ChannelMessage.id)).where(ChannelMessage.account_id == account.id)
    )
    assert first_deleted == 2
    assert second_deleted == 2
    assert remaining == 1


@pytest.mark.asyncio
async def test_operational_retention_preserves_live_authority_and_pending_work(
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
):
    telegram, telegram_link, telegram_binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        chat_id="telegram-operational",
    )
    discord, discord_link, discord_binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_DISCORD,
        chat_id="discord-operational",
    )
    now = datetime(2026, 8, 2, tzinfo=UTC)
    old = now - timedelta(days=31)

    old_debug = ChannelDebugEvent(
        account_id=telegram.id,
        user_id=seed_user.id,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        direction="inbound",
        stage="retention-test",
        outcome="failure",
        created_at=old,
    )
    recent_debug = ChannelDebugEvent(
        account_id=telegram.id,
        user_id=seed_user.id,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        direction="inbound",
        stage="retention-test",
        outcome="success",
        created_at=now - timedelta(days=1),
    )
    expired_pair = ChannelPairCode(
        account_id=telegram.id,
        bot_agent_link_id=telegram_link.id,
        user_id=seed_user.id,
        code_hash=uuid4().hex,
        status=PAIR_CODE_STATUS_PENDING,
        expires_at=old - timedelta(days=1),
        created_at=old,
        updated_at=old,
    )
    claimed_pair = ChannelPairCode(
        account_id=discord.id,
        bot_agent_link_id=discord_link.id,
        user_id=seed_user.id,
        code_hash=uuid4().hex,
        status=PAIR_CODE_STATUS_CLAIMED,
        expires_at=old,
        claimed_at=old,
        created_at=old,
        updated_at=old,
    )
    live_pair = ChannelPairCode(
        account_id=telegram.id,
        bot_agent_link_id=telegram_link.id,
        user_id=seed_user.id,
        code_hash=uuid4().hex,
        status=PAIR_CODE_STATUS_PENDING,
        expires_at=now + timedelta(hours=1),
    )
    active_telegram_file = ChannelAgentReference(
        account_id=telegram.id,
        bot_agent_link_id=telegram_link.id,
        binding_id=telegram_binding.id,
        user_id=seed_user.id,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        ref_kind=TELEGRAM_REF_FILE_ID,
        ref_value="active-file-id",
        created_at=old,
        updated_at=old,
    )
    expired_discord_token = ChannelAgentReference(
        account_id=discord.id,
        bot_agent_link_id=discord_link.id,
        binding_id=discord_binding.id,
        user_id=seed_user.id,
        provider=CHANNEL_PROVIDER_DISCORD,
        ref_kind=DISCORD_REF_INTERACTION_TOKEN,
        ref_value="expired-interaction-token",
        created_at=old,
        updated_at=old,
    )
    durable_discord_reference = ChannelAgentReference(
        account_id=discord.id,
        bot_agent_link_id=discord_link.id,
        binding_id=discord_binding.id,
        user_id=seed_user.id,
        provider=CHANNEL_PROVIDER_DISCORD,
        ref_kind="durable-test-reference",
        ref_value="keep-active-reference",
        created_at=old,
        updated_at=old,
    )
    orphan_reference = ChannelAgentReference(
        account_id=telegram.id,
        bot_agent_link_id=None,
        user_id=seed_user.id,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        ref_kind=TELEGRAM_REF_FILE_ID,
        ref_value="orphan-file-id",
        created_at=old,
        updated_at=old,
    )
    schedule = ChannelScheduledMessage(
        account_id=discord.id,
        bot_agent_link_id=discord_link.id,
        binding_id=discord_binding.id,
        user_id=seed_user.id,
        external_chat_id=discord_binding.external_chat_id,
        scheduled_for=now + timedelta(days=1),
        payload={"text": "future work"},
    )
    db_session.add_all(
        [
            old_debug,
            recent_debug,
            expired_pair,
            claimed_pair,
            live_pair,
            active_telegram_file,
            expired_discord_token,
            durable_discord_reference,
            orphan_reference,
            schedule,
        ]
    )
    pending_message, pending_delivery = await enqueue_channel_outbound_message(
        db_session,
        account=telegram,
        external_chat_id="pending-operational",
        text="pending work",
    )
    pending_message.created_at = old
    pending_delivery.created_at = old
    pending_delivery.updated_at = old
    await db_session.flush()

    batch = await prune_channel_retention_batch(db_session, now=now, limit=100)

    assert batch == ChannelRetentionBatch(
        messages=0,
        debug_events=1,
        pair_codes=2,
        agent_references=2,
    )
    assert await db_session.get(ChannelDebugEvent, old_debug.id) is None
    assert await db_session.get(ChannelDebugEvent, recent_debug.id) is not None
    assert await db_session.get(ChannelPairCode, live_pair.id) is not None
    assert await db_session.get(ChannelAgentReference, active_telegram_file.id) is not None
    assert await db_session.get(ChannelAgentReference, durable_discord_reference.id) is not None
    assert await db_session.get(ChannelAgentReference, expired_discord_token.id) is None
    assert await db_session.get(ChannelAgentReference, orphan_reference.id) is None
    assert await db_session.get(ChannelScheduledMessage, schedule.id) is not None
    assert await db_session.get(ChannelMessage, pending_message.id) is not None
    assert await db_session.get(ChannelDelivery, pending_delivery.id) is not None


@pytest.mark.asyncio
async def test_queue_snapshots_report_provider_specific_stuck_pending(
    engine,
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
    caplog: pytest.LogCaptureFixture,
):
    telegram, _telegram_link, telegram_binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        chat_id="telegram-stuck",
    )
    discord, _discord_link, discord_binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_DISCORD,
        chat_id="discord-stuck",
    )
    now = datetime(2026, 8, 2, tzinfo=UTC)
    old = now - timedelta(hours=25)
    old_inbox = await _add_message(
        db_session, account=telegram, binding=telegram_binding, text="old inbox"
    )
    old_inbox.created_at = old
    await _add_message(db_session, account=telegram, binding=telegram_binding, text="new inbox")
    old_outbox_message, old_outbox = await enqueue_channel_outbound_message(
        db_session,
        account=discord,
        external_chat_id=discord_binding.external_chat_id,
        text="old outbox",
    )
    old_outbox_message.created_at = old
    old_outbox.created_at = old
    await db_session.flush()

    snapshots = await channel_queue_snapshots(
        db_session,
        now=now,
        stuck_after=timedelta(hours=24),
    )
    by_key = {(snapshot.provider, snapshot.queue): snapshot for snapshot in snapshots}

    telegram_inbox = by_key[(CHANNEL_PROVIDER_TELEGRAM, "inbox")]
    discord_outbox = by_key[(CHANNEL_PROVIDER_DISCORD, "outbox")]
    assert telegram_inbox.pending_count == 2
    assert telegram_inbox.stuck_count == 1
    assert telegram_inbox.oldest_pending_at == old
    assert discord_outbox.pending_count == 1
    assert discord_outbox.stuck_count == 1
    assert discord_outbox.oldest_pending_at == old
    assert by_key[(CHANNEL_PROVIDER_DISCORD, "inbox")].pending_count == 0
    assert by_key[(CHANNEL_PROVIDER_TELEGRAM, "outbox")].pending_count == 0

    await db_session.commit()
    worker = ChannelMessageRetentionWorker(
        async_sessionmaker(engine, expire_on_commit=False),
        batch_size=10,
        max_batches=1,
        stuck_pending_hours=24,
    )
    with caplog.at_level(logging.WARNING):
        await worker.run_once()
    metrics = render_metrics().decode("utf-8")
    assert 'msg_router_channel_queue_pending{provider="telegram",queue="inbox"} 2.0' in metrics
    assert (
        'msg_router_channel_queue_stuck_pending{provider="telegram",queue="inbox"} 1.0' in metrics
    )
    assert "provider=telegram queue=inbox" in caplog.text
    assert "provider=discord queue=outbox" in caplog.text


@pytest.mark.asyncio
async def test_retention_worker_drains_multiple_bounded_batches(
    engine,
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
    caplog: pytest.LogCaptureFixture,
):
    account, _link, binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        chat_id="bounded-worker",
    )
    old = datetime.now(UTC) - timedelta(days=31)
    for index in range(5):
        message = await _add_message(
            db_session,
            account=account,
            binding=binding,
            text=f"bounded-{index}",
        )
        message.created_at = old
        message.delivered_at = old
    await db_session.commit()
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    worker = ChannelMessageRetentionWorker(
        session_factory,
        batch_size=2,
        max_batches=2,
        stuck_pending_hours=24,
    )

    with caplog.at_level(logging.WARNING):
        deleted = await worker.run_once()

    remaining = await db_session.scalar(
        select(func.count(ChannelMessage.id)).where(ChannelMessage.account_id == account.id)
    )
    assert deleted == 4
    assert remaining == 1
    assert "channel retention batch budget exhausted" in caplog.text
