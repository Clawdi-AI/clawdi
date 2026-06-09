from __future__ import annotations

import asyncio
from uuid import uuid4

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.channel import (
    CHANNEL_PROVIDER_DISCORD,
    CHANNEL_PROVIDER_TELEGRAM,
    CHANNEL_PROVIDER_WHATSAPP,
    MESSAGE_DIRECTION_INBOUND,
    MESSAGE_DIRECTION_OUTBOUND,
    ChannelAccount,
    ChannelBinding,
    ChannelBotAgentLink,
    ChannelMessage,
)
from app.models.session import AgentEnvironment
from app.models.user import User
from app.services.channels import (
    ack_channel_inbox_events,
    dequeue_channel_inbox_events,
    dequeue_telegram_updates,
    drain_channel_inbox,
    pending_channel_inbox_count,
    wait_for_channel_inbox_events,
)


async def _create_account_and_binding(
    db: AsyncSession,
    *,
    user: User,
    agent: AgentEnvironment,
    provider: str,
    chat_id: str,
    chat_type: str = "private",
) -> tuple[ChannelAccount, ChannelBinding]:
    account = ChannelAccount(
        user_id=user.id,
        provider=provider,
        name=f"{provider}-{uuid4().hex[:12]}",
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
        external_chat_type=chat_type,
        external_chat_name=f"Chat {chat_id}",
    )
    db.add(binding)
    await db.flush()
    return account, binding


async def _add_message(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    binding: ChannelBinding | None,
    direction: str = MESSAGE_DIRECTION_INBOUND,
    text: str,
    payload: dict | None = None,
    provider_message_id: str | None = None,
) -> ChannelMessage:
    message = ChannelMessage(
        account_id=account.id,
        bot_agent_link_id=binding.bot_agent_link_id if binding is not None else None,
        binding_id=binding.id if binding is not None else None,
        user_id=account.user_id,
        direction=direction,
        external_chat_id=binding.external_chat_id if binding is not None else "unbound",
        provider_message_id=provider_message_id,
        text=text,
        payload=payload,
    )
    db.add(message)
    await db.flush()
    await db.refresh(message)
    return message


@pytest.mark.asyncio
async def test_channel_inbox_assigns_monotonic_sequences_and_dequeues_by_account_cursor_limit(
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
):
    account, binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_DISCORD,
        chat_id="discord-channel-1",
    )
    other_account, other_binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_DISCORD,
        chat_id="discord-channel-2",
    )
    first = await _add_message(db_session, account=account, binding=binding, text="msg1")
    second = await _add_message(db_session, account=account, binding=binding, text="msg2")
    await _add_message(db_session, account=other_account, binding=other_binding, text="other")

    assert second.inbox_sequence > first.inbox_sequence

    events = await dequeue_channel_inbox_events(
        db_session,
        account=account,
        after_sequence=0,
        limit=100,
    )
    assert [event.text for event in events] == ["msg1", "msg2"]

    after_first = await dequeue_channel_inbox_events(
        db_session,
        account=account,
        after_sequence=first.inbox_sequence,
        limit=100,
    )
    assert [event.id for event in after_first] == [second.id]

    limited = await dequeue_channel_inbox_events(
        db_session,
        account=account,
        after_sequence=0,
        limit=1,
    )
    assert [event.id for event in limited] == [first.id]


@pytest.mark.asyncio
async def test_channel_inbox_ack_marks_events_through_sequence_for_account_only(
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
):
    account, binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_DISCORD,
        chat_id="discord-channel-ack",
    )
    other_account, other_binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_DISCORD,
        chat_id="discord-channel-other",
    )
    first = await _add_message(db_session, account=account, binding=binding, text="first")
    second = await _add_message(db_session, account=account, binding=binding, text="second")
    third = await _add_message(db_session, account=account, binding=binding, text="third")
    other = await _add_message(
        db_session,
        account=other_account,
        binding=other_binding,
        text="other",
    )

    acked = await ack_channel_inbox_events(
        db_session,
        account=account,
        through_sequence=second.inbox_sequence,
    )
    remaining = await dequeue_channel_inbox_events(
        db_session,
        account=account,
        after_sequence=0,
        limit=100,
    )
    await db_session.refresh(first)
    await db_session.refresh(second)
    await db_session.refresh(other)

    assert acked == 2
    assert [event.id for event in remaining] == [third.id]
    assert first.delivered_at is not None
    assert second.delivered_at is not None
    assert other.delivered_at is None


@pytest.mark.asyncio
async def test_channel_inbox_drain_marks_only_bound_inbound_events_for_account(
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
):
    account, binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        chat_id="telegram-chat-drain",
    )
    other_account, other_binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_WHATSAPP,
        chat_id="whatsapp-chat-drain",
    )
    bound_one = await _add_message(db_session, account=account, binding=binding, text="one")
    bound_two = await _add_message(db_session, account=account, binding=binding, text="two")
    unbound = await _add_message(db_session, account=account, binding=None, text="unbound")
    outbound = await _add_message(
        db_session,
        account=account,
        binding=binding,
        direction=MESSAGE_DIRECTION_OUTBOUND,
        text="outbound",
    )
    other = await _add_message(db_session, account=other_account, binding=other_binding, text="wa")

    assert await pending_channel_inbox_count(db_session, account=account) == 2
    drained = await drain_channel_inbox(db_session, account=account)
    await db_session.refresh(bound_one)
    await db_session.refresh(bound_two)
    await db_session.refresh(unbound)
    await db_session.refresh(outbound)
    await db_session.refresh(other)

    assert drained == 2
    assert await pending_channel_inbox_count(db_session, account=account) == 0
    assert bound_one.delivered_at is not None
    assert bound_two.delivered_at is not None
    assert unbound.delivered_at is None
    assert outbound.delivered_at is None
    assert other.delivered_at is None


@pytest.mark.asyncio
async def test_telegram_inbox_uses_update_id_offset_and_drains_filtered_updates(
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
):
    account, binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        chat_id="telegram-chat-cursor",
    )
    old = await _add_message(
        db_session,
        account=account,
        binding=binding,
        text="old",
        payload={"update_id": 100, "message": {"text": "old"}},
    )
    filtered = await _add_message(
        db_session,
        account=account,
        binding=binding,
        text="filtered",
        payload={"update_id": 101, "message": {"text": "filtered"}},
    )
    callback = await _add_message(
        db_session,
        account=account,
        binding=binding,
        text="callback",
        payload={
            "update_id": 105,
            "callback_query": {
                "id": "cb-105",
                "message": {"chat": {"id": "telegram-chat-cursor"}},
            },
        },
    )

    updates = await dequeue_telegram_updates(
        db_session,
        account=account,
        offset=101,
        limit=100,
        allowed_updates={"callback_query"},
    )
    await db_session.refresh(old)
    await db_session.refresh(filtered)
    await db_session.refresh(callback)

    assert updates == [
        {
            "update_id": 105,
            "callback_query": {
                "id": "cb-105",
                "message": {"chat": {"id": "telegram-chat-cursor"}},
            },
        }
    ]
    assert old.delivered_at is not None
    assert filtered.delivered_at is not None
    assert callback.delivered_at is None

    assert (
        await dequeue_telegram_updates(
            db_session,
            account=account,
            offset=106,
            limit=100,
        )
        == []
    )
    await db_session.refresh(callback)
    assert callback.delivered_at is not None


@pytest.mark.asyncio
async def test_channel_inbox_wait_polls_until_new_committed_event(
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
):
    account, binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_DISCORD,
        chat_id="discord-channel-wait",
    )
    await db_session.commit()
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)

    async with sessionmaker() as wait_session:
        wait_account = await wait_session.get(ChannelAccount, account.id)
        assert wait_account is not None
        pending = asyncio.create_task(
            wait_for_channel_inbox_events(
                wait_session,
                account=wait_account,
                after_sequence=0,
                limit=10,
                timeout_seconds=1,
                poll_interval_seconds=0.005,
            )
        )

        await asyncio.sleep(0.01)
        await _add_message(db_session, account=account, binding=binding, text="delayed")
        await db_session.commit()
        events = await pending

    assert [event.text for event in events] == ["delayed"]
