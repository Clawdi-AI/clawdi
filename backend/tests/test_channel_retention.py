from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.channel import (
    CHANNEL_PROVIDER_DISCORD,
    CHANNEL_PROVIDER_TELEGRAM,
    CHANNEL_PROVIDER_WHATSAPP,
    CHANNEL_STATUS_DISABLED,
    DELIVERY_STATUS_FAILED,
    DELIVERY_STATUS_SUCCEEDED,
    MESSAGE_DIRECTION_INBOUND,
    PAIR_CODE_STATUS_CLAIMED,
    PAIR_CODE_STATUS_PENDING,
    PAIR_CODE_STATUS_REVOKED,
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
    DISCORD_REF_INTERACTION_ID_TOKEN,
    DISCORD_REF_INTERACTION_TOKEN,
    TELEGRAM_REF_FILE_ID,
    ChannelRetentionBatch,
    channel_queue_snapshots,
    deliver_channel_delivery,
    enqueue_channel_outbound_message,
    expire_stale_telegram_inbox_messages,
    prune_channel_messages,
    prune_channel_pair_codes,
    prune_channel_retention_batch,
    send_discord_message,
    send_telegram_message,
    send_whatsapp_message,
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
async def test_synchronous_retained_provider_outbound_is_terminal_on_record(
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
    whatsapp, _whatsapp_link, _whatsapp_binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_WHATSAPP,
        chat_id="whatsapp-sync",
    )

    async def fake_telegram_send(**_kwargs):
        return "telegram-provider-message", {"ok": True}

    async def fake_discord_send(**_kwargs):
        return "discord-provider-message", {"id": "discord-provider-message"}

    async def fake_whatsapp_send(**_kwargs):
        return "whatsapp-provider-message", {"secret": "must-not-be-retained"}

    monkeypatch.setattr(channel_service, "_send_telegram_provider_payload", fake_telegram_send)
    monkeypatch.setattr(channel_service, "_send_discord_provider_payload", fake_discord_send)
    monkeypatch.setattr(channel_service, "_send_whatsapp_provider_payload", fake_whatsapp_send)

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
    whatsapp_message = await send_whatsapp_message(
        db_session,
        account=whatsapp,
        external_chat_id="whatsapp-sync",
        text="whatsapp delivered",
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
    assert whatsapp_message.delivered_at is not None
    assert whatsapp_message.payload == {
        "provider": "whatsapp",
        "accepted": True,
        "provider_message_id": "whatsapp-provider-message",
    }
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
        provider=CHANNEL_PROVIDER_WHATSAPP,
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
async def test_stale_telegram_delivery_expiry_handles_offline_links_and_strict_cutoff(
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
):
    telegram, telegram_link, telegram_binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        chat_id="offline-polling-no-webhook",
    )
    assert telegram_link.config is None
    discord, _discord_link, discord_binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_DISCORD,
        chat_id="discord-no-silent-expiry",
    )
    disabled, _disabled_link, disabled_binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        chat_id="disabled-telegram",
    )
    disabled.status = CHANNEL_STATUS_DISABLED
    now = datetime(2026, 8, 2, tzinfo=UTC)
    cutoff = now - timedelta(hours=24)
    expired = await _add_message(
        db_session,
        account=telegram,
        binding=telegram_binding,
        text="expired offline update",
    )
    expired.created_at = cutoff - timedelta(microseconds=1)
    boundary = await _add_message(
        db_session,
        account=telegram,
        binding=telegram_binding,
        text="strict boundary",
    )
    boundary.created_at = cutoff
    active = await _add_message(
        db_session,
        account=telegram,
        binding=telegram_binding,
        text="still within provider horizon",
    )
    active.created_at = cutoff + timedelta(microseconds=1)
    old_discord = await _add_message(
        db_session,
        account=discord,
        binding=discord_binding,
        text="discord remains pending",
    )
    old_discord.created_at = cutoff - timedelta(days=30)
    old_disabled = await _add_message(
        db_session,
        account=disabled,
        binding=disabled_binding,
        text="disabled telegram remains pending",
    )
    old_disabled.created_at = cutoff - timedelta(days=30)
    await db_session.flush()

    expired_count = await expire_stale_telegram_inbox_messages(
        db_session,
        now=now,
        limit=10,
    )

    assert expired_count == 1
    assert expired.delivered_at == now
    assert boundary.delivered_at is None
    assert active.delivered_at is None
    assert old_discord.delivered_at is None
    assert old_disabled.delivered_at is None
    assert await db_session.get(ChannelMessage, expired.id) is not None


@pytest.mark.asyncio
async def test_concurrent_telegram_delivery_expiry_cleaners_skip_locked_rows(
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
        chat_id="concurrent-telegram-expiry",
    )
    now = datetime(2026, 8, 2, tzinfo=UTC)
    for index in range(5):
        message = await _add_message(
            db_session,
            account=account,
            binding=binding,
            text=f"stale-pending-{index}",
        )
        message.created_at = now - timedelta(hours=25)
    await db_session.commit()

    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as first, session_factory() as second:
        first_expired = await expire_stale_telegram_inbox_messages(first, now=now, limit=2)
        second_expired = await expire_stale_telegram_inbox_messages(second, now=now, limit=2)
        await first.commit()
        await second.commit()

    delivered = await db_session.scalar(
        select(func.count(ChannelMessage.id)).where(
            ChannelMessage.account_id == account.id,
            ChannelMessage.delivered_at.is_not(None),
        )
    )
    total = await db_session.scalar(
        select(func.count(ChannelMessage.id)).where(ChannelMessage.account_id == account.id)
    )
    assert first_expired == 2
    assert second_expired == 2
    assert delivered == 4
    assert total == 5


@pytest.mark.asyncio
async def test_expired_telegram_delivery_becomes_ordinary_retention_eligible(
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
):
    account, _link, binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        chat_id="eventual-physical-retention",
    )
    now = datetime(2026, 8, 2, tzinfo=UTC)
    message = await _add_message(
        db_session,
        account=account,
        binding=binding,
        text="expire then retain",
    )
    message.created_at = now - timedelta(hours=25)
    await db_session.flush()

    assert await expire_stale_telegram_inbox_messages(db_session, now=now, limit=1) == 1
    assert message.delivered_at == now
    await prune_channel_messages(
        db_session,
        now=now + timedelta(days=30),
        delivered_retention=timedelta(days=30),
        limit=10_000,
    )
    assert await db_session.get(ChannelMessage, message.id) is not None
    await prune_channel_messages(
        db_session,
        now=now + timedelta(days=30, microseconds=1),
        delivered_retention=timedelta(days=30),
        limit=10_000,
    )
    assert await db_session.get(ChannelMessage, message.id) is None


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
async def test_pair_code_retention_uses_short_unbound_horizon_and_preserves_boundary(
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
):
    account, link, _binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        chat_id="pair-retention-horizon",
    )
    now = datetime(2026, 8, 2, tzinfo=UTC)
    cutoff = now - timedelta(hours=24)
    expired_terminal = ChannelPairCode(
        account_id=account.id,
        bot_agent_link_id=link.id,
        user_id=seed_user.id,
        code_hash=uuid4().hex,
        status=PAIR_CODE_STATUS_CLAIMED,
        expires_at=cutoff,
        claimed_at=cutoff,
        created_at=cutoff - timedelta(days=1),
        updated_at=cutoff - timedelta(microseconds=1),
    )
    expired_pending = ChannelPairCode(
        account_id=account.id,
        bot_agent_link_id=link.id,
        user_id=seed_user.id,
        code_hash=uuid4().hex,
        status=PAIR_CODE_STATUS_PENDING,
        expires_at=cutoff - timedelta(microseconds=1),
        created_at=cutoff - timedelta(days=1),
        updated_at=cutoff,
    )
    boundary_terminal = ChannelPairCode(
        account_id=account.id,
        bot_agent_link_id=link.id,
        user_id=seed_user.id,
        code_hash=uuid4().hex,
        status=PAIR_CODE_STATUS_REVOKED,
        expires_at=cutoff,
        created_at=cutoff - timedelta(hours=1),
        updated_at=cutoff,
    )
    boundary_pending = ChannelPairCode(
        account_id=account.id,
        bot_agent_link_id=link.id,
        user_id=seed_user.id,
        code_hash=uuid4().hex,
        status=PAIR_CODE_STATUS_PENDING,
        expires_at=cutoff,
        created_at=cutoff - timedelta(hours=1),
        updated_at=cutoff,
    )
    live_pending = ChannelPairCode(
        account_id=account.id,
        bot_agent_link_id=link.id,
        user_id=seed_user.id,
        code_hash=uuid4().hex,
        status=PAIR_CODE_STATUS_PENDING,
        expires_at=now + timedelta(minutes=5),
    )
    db_session.add_all(
        [
            expired_terminal,
            expired_pending,
            boundary_terminal,
            boundary_pending,
            live_pending,
        ]
    )
    await db_session.flush()

    deleted = await prune_channel_pair_codes(db_session, now=now, limit=10)

    assert deleted == 2
    assert await db_session.get(ChannelPairCode, expired_terminal.id) is None
    assert await db_session.get(ChannelPairCode, expired_pending.id) is None
    assert await db_session.get(ChannelPairCode, boundary_terminal.id) is not None
    assert await db_session.get(ChannelPairCode, boundary_pending.id) is not None
    assert await db_session.get(ChannelPairCode, live_pending.id) is not None


@pytest.mark.asyncio
async def test_discord_interaction_secrets_expire_without_deleting_pending_content(
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
):
    discord, link, binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_DISCORD,
        chat_id="discord-secret-retention",
    )
    telegram, _telegram_link, telegram_binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        chat_id="telegram-secret-control",
    )
    now = datetime(2026, 8, 2, tzinfo=UTC)
    expired = now - timedelta(minutes=20, microseconds=1)
    boundary = now - timedelta(minutes=20)

    webhook_message = await _add_message(
        db_session,
        account=discord,
        binding=binding,
        text="keep webhook content",
    )
    webhook_message.created_at = expired
    webhook_message.payload = {
        "type": 2,
        "id": "interaction-webhook",
        "token": "expired-webhook-secret",
        "application_id": "discord-application",
        "context": 0,
        "data": {"name": "agent_status", "options": [{"name": "detail", "value": 1}]},
    }
    gateway_message = await _add_message(
        db_session,
        account=discord,
        binding=binding,
        text="keep gateway content",
    )
    gateway_message.created_at = expired
    gateway_message.payload = {
        "op": 0,
        "t": "INTERACTION_CREATE",
        "s": 42,
        "d": {
            "id": "interaction-gateway",
            "token": "expired-gateway-secret",
            "application_id": "discord-application",
            "content": "keep event content",
            "context": 1,
        },
    }
    recent_message = await _add_message(
        db_session,
        account=discord,
        binding=binding,
        text="recent interaction",
    )
    recent_message.created_at = boundary
    recent_message.payload = {
        "type": 2,
        "id": "interaction-recent",
        "token": "recent-secret",
        "application_id": "discord-application",
        "context": 0,
        "data": {"name": "agent_status"},
    }
    telegram_control = await _add_message(
        db_session,
        account=telegram,
        binding=telegram_binding,
        text="telegram token-shaped payload",
    )
    telegram_control.created_at = expired
    telegram_control.payload = {
        "id": "telegram-control",
        "token": "telegram-secret-shaped-value",
        "application_id": "not-discord",
        "message": {"text": "keep telegram payload"},
    }
    expired_references = [
        ChannelAgentReference(
            account_id=discord.id,
            bot_agent_link_id=link.id,
            binding_id=binding.id,
            message_id=webhook_message.id,
            user_id=seed_user.id,
            provider=CHANNEL_PROVIDER_DISCORD,
            ref_kind=DISCORD_REF_INTERACTION_ID_TOKEN,
            ref_value="interaction-webhook:expired-webhook-secret",
            created_at=expired,
            updated_at=expired,
        ),
        ChannelAgentReference(
            account_id=discord.id,
            bot_agent_link_id=link.id,
            binding_id=binding.id,
            message_id=gateway_message.id,
            user_id=seed_user.id,
            provider=CHANNEL_PROVIDER_DISCORD,
            ref_kind=DISCORD_REF_INTERACTION_TOKEN,
            ref_value="expired-gateway-secret",
            created_at=expired,
            updated_at=expired,
        ),
    ]
    recent_reference = ChannelAgentReference(
        account_id=discord.id,
        bot_agent_link_id=link.id,
        binding_id=binding.id,
        message_id=recent_message.id,
        user_id=seed_user.id,
        provider=CHANNEL_PROVIDER_DISCORD,
        ref_kind=DISCORD_REF_INTERACTION_TOKEN,
        ref_value="recent-secret",
        created_at=boundary,
        updated_at=boundary,
    )
    db_session.add_all([*expired_references, recent_reference])
    await db_session.flush()

    batch = await prune_channel_retention_batch(db_session, now=now, limit=20)

    assert batch.messages == 0
    assert batch.discord_interaction_payloads == 2
    assert batch.agent_references == 2
    await db_session.refresh(webhook_message)
    await db_session.refresh(gateway_message)
    await db_session.refresh(recent_message)
    await db_session.refresh(telegram_control)
    assert webhook_message.payload == {
        "type": 2,
        "id": "interaction-webhook",
        "application_id": "discord-application",
        "context": 0,
        "data": {"name": "agent_status", "options": [{"name": "detail", "value": 1}]},
    }
    assert gateway_message.payload == {
        "op": 0,
        "t": "INTERACTION_CREATE",
        "s": 42,
        "d": {
            "id": "interaction-gateway",
            "application_id": "discord-application",
            "content": "keep event content",
            "context": 1,
        },
    }
    assert recent_message.payload is not None
    assert recent_message.payload["token"] == "recent-secret"
    assert telegram_control.payload is not None
    assert telegram_control.payload["token"] == "telegram-secret-shaped-value"
    for reference in expired_references:
        assert await db_session.get(ChannelAgentReference, reference.id) is None
    assert await db_session.get(ChannelAgentReference, recent_reference.id) is not None


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
    assert 'msg_router_channel_queue_pending{provider="telegram",queue="inbox"} 1.0' in metrics
    assert (
        'msg_router_channel_queue_stuck_pending{provider="telegram",queue="inbox"} 0.0' in metrics
    )
    assert 'msg_router_channel_retention_delivery_expirations_total{provider="telegram"}' in metrics
    assert "provider=telegram queue=inbox" not in caplog.text
    assert "provider=discord queue=outbox" in caplog.text


@pytest.mark.asyncio
async def test_queue_snapshots_ignore_historical_inactive_authority_and_identity_mismatches(
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
):
    active, _active_link, active_binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        chat_id="snapshot-active",
    )
    (
        archived_account,
        _archived_account_link,
        archived_account_binding,
    ) = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        chat_id="snapshot-archived-account",
    )
    (
        disabled_account,
        _disabled_account_link,
        disabled_account_binding,
    ) = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        chat_id="snapshot-disabled-account",
    )
    archived_binding_account, _binding_link, archived_binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        chat_id="snapshot-archived-binding",
    )
    archived_link_account, archived_link, archived_link_binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        chat_id="snapshot-archived-link",
    )
    mismatch_account, mismatch_link, mismatch_binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        chat_id="snapshot-mismatch",
    )
    now = datetime(2026, 8, 2, tzinfo=UTC)
    old = now - timedelta(hours=25)

    valid_inbox = await _add_message(
        db_session,
        account=active,
        binding=active_binding,
        text="valid inbox",
    )
    valid_inbox.created_at = old
    valid_outbox_message, valid_outbox = await enqueue_channel_outbound_message(
        db_session,
        account=active,
        external_chat_id=active_binding.external_chat_id,
        text="valid linked outbox",
    )
    account_outbox_message, account_outbox = await enqueue_channel_outbound_message(
        db_session,
        account=active,
        external_chat_id="snapshot-account-scoped",
        text="valid account outbox",
    )
    for row in (valid_outbox_message, valid_outbox, account_outbox_message, account_outbox):
        row.created_at = old

    historical_authorities = (
        (archived_account, archived_account_binding),
        (disabled_account, disabled_account_binding),
        (archived_binding_account, archived_binding),
        (archived_link_account, archived_link_binding),
    )
    for account, binding in historical_authorities:
        inbox = await _add_message(
            db_session,
            account=account,
            binding=binding,
            text="historical inbox",
        )
        inbox.created_at = old
        outbox_message, outbox = await enqueue_channel_outbound_message(
            db_session,
            account=account,
            external_chat_id=binding.external_chat_id,
            text="historical outbox",
        )
        outbox_message.created_at = old
        outbox.created_at = old

    mismatch_inbox = await _add_message(
        db_session,
        account=mismatch_account,
        binding=mismatch_binding,
        text="mismatched inbox identity",
    )
    mismatch_inbox.created_at = old
    mismatch_inbox.bot_agent_link_id = active_binding.bot_agent_link_id
    mismatch_outbox_message, mismatch_outbox = await enqueue_channel_outbound_message(
        db_session,
        account=mismatch_account,
        external_chat_id=mismatch_binding.external_chat_id,
        text="mismatched outbox identity",
    )
    mismatch_outbox_message.created_at = old
    mismatch_outbox.created_at = old
    mismatch_outbox.bot_agent_link_id = active_binding.bot_agent_link_id

    archived_account.archived_at = now
    disabled_account.status = CHANNEL_STATUS_DISABLED
    archived_binding.status = "archived"
    archived_link.archived_at = now
    await db_session.flush()

    snapshots = await channel_queue_snapshots(
        db_session,
        now=now,
        stuck_after=timedelta(hours=24),
    )
    by_key = {(snapshot.provider, snapshot.queue): snapshot for snapshot in snapshots}

    telegram_inbox = by_key[(CHANNEL_PROVIDER_TELEGRAM, "inbox")]
    telegram_outbox = by_key[(CHANNEL_PROVIDER_TELEGRAM, "outbox")]
    assert telegram_inbox.pending_count == 1
    assert telegram_inbox.stuck_count == 1
    assert telegram_inbox.oldest_pending_at == old
    assert telegram_outbox.pending_count == 2
    assert telegram_outbox.stuck_count == 2
    assert telegram_outbox.oldest_pending_at == old
    assert mismatch_link.archived_at is None


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
    await db_session.commit()
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    worker = ChannelMessageRetentionWorker(
        session_factory,
        batch_size=2,
        max_batches=2,
        stuck_pending_hours=24,
    )

    with caplog.at_level(logging.WARNING):
        processed = await worker.run_once()

    remaining_pending = await db_session.scalar(
        select(func.count(ChannelMessage.id)).where(
            ChannelMessage.account_id == account.id,
            ChannelMessage.delivered_at.is_(None),
        )
    )
    retained_rows = await db_session.scalar(
        select(func.count(ChannelMessage.id)).where(
            ChannelMessage.account_id == account.id,
        )
    )
    assert processed == 4
    assert remaining_pending == 1
    assert retained_rows == 5
    assert "channel retention batch budget exhausted" in caplog.text
    assert "telegram_delivery_expirations" in caplog.text


@pytest.mark.asyncio
async def test_channel_retention_indexes_match_oldest_first_query_contract(engine):
    expected = {
        "ix_channel_bot_agent_links_retention_inactive": "(id)",
        "ix_channel_debug_events_retention_created": "(created_at, id)",
        "ix_channel_pair_codes_retention_terminal": "(updated_at, id)",
        "ix_channel_pair_codes_retention_expired": "(expires_at, id)",
        "ix_channel_agent_references_retention_orphaned": "(updated_at, id)",
        "ix_channel_agent_references_link_retention": "(bot_agent_link_id, updated_at, id)",
        "ix_channel_agent_references_discord_interaction": "(created_at, id)",
        "ix_channel_messages_retention_delivered": "(delivered_at, id)",
        "ix_channel_messages_retention_unbound": "(created_at, id)",
        "ix_channel_messages_discord_interaction_token": "(created_at, id)",
        "ix_channel_deliveries_retention_terminal": "(updated_at, id)",
    }
    async with engine.connect() as connection:
        rows = await connection.execute(
            text(
                "SELECT indexname, indexdef FROM pg_indexes "
                "WHERE schemaname = current_schema() AND ("
                "indexname LIKE 'ix_channel_%retention%' OR "
                "indexname = 'ix_channel_messages_discord_interaction_token' OR "
                "indexname = 'ix_channel_agent_references_discord_interaction')"
            )
        )
    definitions = {row.indexname: row.indexdef for row in rows}

    assert expected.keys() <= definitions.keys()
    for index_name, ordered_columns in expected.items():
        assert ordered_columns in definitions[index_name]
        assert " WHERE " in definitions[index_name]
