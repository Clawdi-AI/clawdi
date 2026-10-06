"""Channel offline replies with permanent runtime evidence isolated by rollback."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock
from uuid import UUID

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.channel import (
    BINDING_STATUS_ACTIVE,
    BINDING_STATUS_ARCHIVED,
    BOT_AGENT_LINK_STATUS_ACTIVE,
    BOT_AGENT_LINK_STATUS_ARCHIVED,
    CHANNEL_PROVIDER_DISCORD,
    CHANNEL_PROVIDER_TELEGRAM,
    CHANNEL_RUNTIME_MARKER_AGENT_OFFLINE_REPLY,
    MESSAGE_DIRECTION_INBOUND,
    ChannelAccount,
    ChannelAccountRuntimeMarker,
    ChannelBinding,
    ChannelDelivery,
    ChannelMessage,
)
from app.models.session import AgentEnvironment
from app.models.user import User
from app.routes.channel_routers import telegram as telegram_router
from app.services import channels as channel_service
from app.services.channel_message_retention_worker import ChannelMessageRetentionWorker
from app.services.channels import (
    channel_control_help_reply,
    channel_queue_snapshots,
    encrypt_optional_token,
    enqueue_channel_outbound_message,
)
from app.services.discord_gateway_worker import record_discord_gateway_dispatch
from app.services.metrics import render_metrics
from app.services.whatsapp_baileys import whatsapp_text_message_proto
from app.services.whatsapp_native_transport import WhatsAppProviderMessageEvent
from app.services.whatsapp_provider_bridge import (
    persist_whatsapp_provider_event,
    register_whatsapp_provider_transport,
    unregister_whatsapp_provider_transport,
)
from tests.channel_helpers import (
    DISCORD_TEST_APPLICATION_ID,
    _clear_fake_provider_calls,
    _create_paired_discord_channel,
    _create_paired_telegram_channel,
    _discord_ready_config,
    _FakeProviderClient,
    _record_discord_interaction,
    _reset_fake_provider_client,
    _seed_created_channel_link,
    _telegram_agent_headers,
    _telegram_bot_path,
)
from tests.test_channel_retention import _add_message, _create_account_and_binding
from tests.test_channels_discord import (
    _reset_channel_provider_http_client as _reset_channel_provider_http_client,
)
from tests.test_channels_discord import (
    _verified_discord_guild_membership as _verified_discord_guild_membership,
)
from tests.test_whatsapp_provider_bridge import (
    _FakeProviderTransport,
    _seed_whatsapp_link_and_binding,
    _use_delivery_transport,
)


@pytest.mark.asyncio
async def test_whatsapp_offline_consumes_once_and_replies_in_new_periods(
    client,
    db_session,
    channel_agent,
    channel_runtime_head,
    monkeypatch,
):
    account, _link, binding = await _seed_whatsapp_link_and_binding(
        client, db_session, channel_agent, name="wa-offline-periods"
    )
    current_time = datetime.now(UTC)

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return current_time

    monkeypatch.setattr(channel_service, "datetime", Clock)
    await channel_runtime_head(
        channel_agent,
        received_at=current_time - timedelta(hours=1),
        freshness_deadline=current_time - timedelta(minutes=11),
    )
    # The legacy Agent timestamp must not override runtime observation authority.
    channel_agent.last_seen_at = current_time
    await db_session.commit()
    transport = _FakeProviderTransport()
    _use_delivery_transport(monkeypatch, transport)
    register_whatsapp_provider_transport(account.id, transport)

    async def inbound(sequence):
        event = WhatsAppProviderMessageEvent(
            sequence=sequence,
            message_id=f"offline-{sequence}",
            remote_jid=binding.external_chat_id,
            remote_jid_alt=None,
            participant=None,
            participant_alt=None,
            push_name=None,
            message_timestamp=None,
            message_proto=whatsapp_text_message_proto("hello"),
        )
        await persist_whatsapp_provider_event(db_session, account_id=account.id, event=event)
        return (
            await db_session.execute(
                select(ChannelMessage).where(
                    ChannelMessage.account_id == account.id,
                    ChannelMessage.provider_message_id == event.message_id,
                )
            )
        ).scalar_one()

    try:
        assert (await inbound(1)).delivered_at == current_time
        assert binding.status == BINDING_STATUS_ACTIVE
        assert len(transport.outbound_messages) == 1
        assert transport.outbound_messages[0].conversation == channel_service.AGENT_OFFLINE_REPLY
        assert transport.outbound_messages[0].to_jid == binding.external_chat_id
        assert (await inbound(2)).delivered_at is not None
        assert len(transport.outbound_messages) == 1

        current_time += timedelta(minutes=1)
        await channel_runtime_head(
            channel_agent,
            received_at=current_time,
            freshness_deadline=current_time + timedelta(minutes=1),
        )
        assert (await inbound(3)).delivered_at is None
        assert len(transport.outbound_messages) == 1

        current_time += timedelta(minutes=12)
        assert (await inbound(4)).delivered_at is not None
        assert len(transport.outbound_messages) == 2
        assert (await inbound(5)).delivered_at is not None
        assert len(transport.outbound_messages) == 2

        current_time += channel_service.AGENT_OFFLINE_REPLY_COOLDOWN
        assert (await inbound(6)).delivered_at is not None
        assert len(transport.outbound_messages) == 3
        assert (
            await db_session.scalar(
                select(func.count(ChannelDelivery.id)).where(
                    ChannelDelivery.account_id == account.id
                )
            )
            == 0
        )
        assert binding.status == BINDING_STATUS_ACTIVE
    finally:
        unregister_whatsapp_provider_transport(account.id)


@pytest.mark.asyncio
@pytest.mark.parametrize("head_state", ["none", "grace", "tombstoned"])
async def test_whatsapp_offline_observation_boundaries(
    client,
    db_session,
    channel_agent,
    channel_runtime_head,
    monkeypatch,
    head_state,
):
    account, _link, binding = await _seed_whatsapp_link_and_binding(
        client, db_session, channel_agent, name="wa-offline-boundaries"
    )
    now = datetime.now(UTC)

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return now

    monkeypatch.setattr(channel_service, "datetime", Clock)
    if head_state != "none":
        await channel_runtime_head(
            channel_agent,
            received_at=now - timedelta(minutes=5),
            freshness_deadline=now - channel_service.AGENT_OFFLINE_GRACE,
            tombstoned=head_state == "tombstoned",
        )
    transport = _FakeProviderTransport()
    _use_delivery_transport(monkeypatch, transport)
    register_whatsapp_provider_transport(account.id, transport)
    try:
        await persist_whatsapp_provider_event(
            db_session,
            account_id=account.id,
            event=WhatsAppProviderMessageEvent(
                sequence=1,
                message_id="offline-boundary",
                remote_jid=binding.external_chat_id,
                remote_jid_alt=None,
                participant=None,
                participant_alt=None,
                push_name=None,
                message_timestamp=None,
                message_proto=whatsapp_text_message_proto("hello"),
            ),
        )
        message = (
            await db_session.execute(
                select(ChannelMessage).where(
                    ChannelMessage.account_id == account.id,
                    ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
                )
            )
        ).scalar_one()
        assert (message.delivered_at is not None) == (head_state == "tombstoned")
        assert len(transport.outbound_messages) == (1 if head_state == "tombstoned" else 0)
    finally:
        unregister_whatsapp_provider_transport(account.id)


@pytest.mark.asyncio
async def test_whatsapp_pair_help_and_unpair_work_while_offline(
    client,
    db_session,
    channel_agent,
    channel_runtime_head,
    monkeypatch,
):
    account, link, binding = await _seed_whatsapp_link_and_binding(
        client, db_session, channel_agent, name="wa-offline-controls"
    )
    binding.status = BINDING_STATUS_ARCHIVED
    now = datetime.now(UTC)
    await channel_runtime_head(
        channel_agent,
        received_at=now - timedelta(hours=1),
        freshness_deadline=now - timedelta(minutes=11),
    )
    pair_response = await client.post(
        f"/v1/channels/{account.id}/pair-codes",
        json={"agent_link_id": str(link.id), "ttl_seconds": 900},
    )
    assert pair_response.status_code == 201, pair_response.text
    transport = _FakeProviderTransport()
    _use_delivery_transport(monkeypatch, transport)
    register_whatsapp_provider_transport(account.id, transport)
    try:
        for sequence, text in enumerate(
            [f"/clawdi_pair {pair_response.json()['code']}", "/clawdi_help", "/clawdi_unpair"],
            start=1,
        ):
            await persist_whatsapp_provider_event(
                db_session,
                account_id=account.id,
                event=WhatsAppProviderMessageEvent(
                    sequence=sequence,
                    message_id=f"offline-control-{sequence}",
                    remote_jid=binding.external_chat_id,
                    remote_jid_alt=None,
                    participant=None,
                    participant_alt=None,
                    push_name=None,
                    message_timestamp=None,
                    message_proto=whatsapp_text_message_proto(text),
                ),
            )
        assert [message.conversation for message in transport.outbound_messages] == [
            channel_service.PAIRING_REPLY_PAIRED,
            channel_control_help_reply(),
            channel_service.PAIRING_REPLY_UNPAIRED,
        ]
        assert (
            await db_session.scalar(
                select(func.count(ChannelBinding.id)).where(
                    ChannelBinding.account_id == account.id,
                    ChannelBinding.status == BINDING_STATUS_ACTIVE,
                )
            )
            == 0
        )
        assert (
            await db_session.scalar(
                select(func.count(ChannelAccountRuntimeMarker.id)).where(
                    ChannelAccountRuntimeMarker.account_id == account.id,
                    ChannelAccountRuntimeMarker.kind == CHANNEL_RUNTIME_MARKER_AGENT_OFFLINE_REPLY,
                )
            )
            == 0
        )
    finally:
        unregister_whatsapp_provider_transport(account.id)


@pytest.mark.asyncio
async def test_whatsapp_failed_offline_reply_is_consumed_and_not_retried(
    client,
    db_session,
    channel_agent,
    channel_runtime_head,
    monkeypatch,
    caplog,
):
    account, _link, binding = await _seed_whatsapp_link_and_binding(
        client, db_session, channel_agent, name="wa-offline-send-failure"
    )
    now = datetime.now(UTC)
    await channel_runtime_head(
        channel_agent,
        received_at=now - timedelta(hours=1),
        freshness_deadline=now - timedelta(minutes=11),
    )

    class FailingTransport(_FakeProviderTransport):
        async def relay_outbound_message(self, message):
            self.outbound_messages.append(message)
            raise HTTPException(status_code=502, detail="test provider unavailable")

    transport = FailingTransport()
    _use_delivery_transport(monkeypatch, transport)
    register_whatsapp_provider_transport(account.id, transport)
    try:
        for sequence in (1, 2):
            await persist_whatsapp_provider_event(
                db_session,
                account_id=account.id,
                event=WhatsAppProviderMessageEvent(
                    sequence=sequence,
                    message_id=f"offline-failure-{sequence}",
                    remote_jid=binding.external_chat_id,
                    remote_jid_alt=None,
                    participant=None,
                    participant_alt=None,
                    push_name=None,
                    message_timestamp=None,
                    message_proto=whatsapp_text_message_proto("hello"),
                ),
            )
        assert len(transport.outbound_messages) == 1
        assert "channel_agent_offline_reply_failed" in caplog.text
        messages = list(
            (
                await db_session.execute(
                    select(ChannelMessage).where(
                        ChannelMessage.account_id == account.id,
                        ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
                    )
                )
            ).scalars()
        )
        assert len(messages) == 2
        assert all(message.delivered_at is not None for message in messages)
        assert binding.status == BINDING_STATUS_ACTIVE
    finally:
        unregister_whatsapp_provider_transport(account.id)


@pytest.mark.asyncio
@pytest.mark.parametrize("topic", ["thread", "direct_messages"])
async def test_telegram_offline_reply_preserves_topic_and_skips_agent_delivery(
    client,
    db_session,
    channel_agent,
    channel_runtime_head,
    monkeypatch,
    topic,
):
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-offline-topic",
        provider_token=None,
        agent_id=channel_agent.id,
    )
    response = await client.post(
        _telegram_bot_path(created, "setWebhook"),
        headers=_telegram_agent_headers(created),
        json={"url": "https://agent.example/agent-hook"},
    )
    assert response.status_code == 200
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    account.encrypted_provider_token, account.provider_token_nonce = encrypt_optional_token(
        "123456:telegram-secret"
    )
    await db_session.commit()
    agent_webhook = AsyncMock(return_value=True)
    monkeypatch.setattr(
        telegram_router, "_deliver_telegram_agent_webhook_for_binding", agent_webhook
    )
    now = datetime.now(UTC)
    await channel_runtime_head(
        channel_agent,
        received_at=now - timedelta(hours=1),
        freshness_deadline=now - timedelta(minutes=11),
    )
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 700, "chat": {"id": 42}}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    topic_payload = (
        {"message_thread_id": 321, "is_topic_message": True}
        if topic == "thread"
        else {
            "chat": {"id": 42, "type": "supergroup", "is_direct_messages": True},
            "direct_messages_topic": {"topic_id": 4242},
        }
    )
    for update_id in (701, 702):
        inbound = await client.post(
            f"/v1/channels/telegram/{created['id']}/webhook",
            headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
            json={
                "update_id": update_id,
                "message": {
                    "message_id": update_id,
                    "text": "hello",
                    "chat": {"id": 42, "type": "private"},
                    **topic_payload,
                },
            },
        )
        assert inbound.status_code == 200
    calls = [call for call in _FakeProviderClient.calls if call["url"].endswith("/sendMessage")]
    assert len(calls) == 1
    assert calls[0]["json"] == {
        "chat_id": "42",
        "text": channel_service.AGENT_OFFLINE_REPLY,
        **({"message_thread_id": 321} if topic == "thread" else {"direct_messages_topic_id": 4242}),
    }
    agent_webhook.assert_not_awaited()
    messages = list(
        (
            await db_session.execute(
                select(ChannelMessage).where(
                    ChannelMessage.account_id == UUID(created["id"]),
                    ChannelMessage.provider_message_id.in_(["701", "702"]),
                )
            )
        ).scalars()
    )
    assert len(messages) == 2
    assert all(message.delivered_at is not None for message in messages)
    deleted = await client.post(
        _telegram_bot_path(created, "deleteWebhook"),
        headers=_telegram_agent_headers(created),
        json={},
    )
    assert deleted.status_code == 200
    updates = await client.post(
        _telegram_bot_path(created, "getUpdates"),
        headers=_telegram_agent_headers(created),
        json={"timeout": 0},
    )
    assert updates.status_code == 200
    assert updates.json()["result"] == []


@pytest.mark.asyncio
async def test_discord_offline_interactions_reply_ephemerally_without_dedup(
    client,
    db_session,
    channel_agent,
    channel_runtime_head,
):
    created = await _create_paired_discord_channel(
        client,
        name="discord-offline-interactions",
        agent_id=channel_agent.id,
    )
    now = datetime.now(UTC)
    await channel_runtime_head(
        channel_agent,
        received_at=now - timedelta(hours=1),
        freshness_deadline=now - timedelta(minutes=11),
    )
    _clear_fake_provider_calls()
    for interaction_id in ("offline-interaction-1", "offline-interaction-2"):
        response = await _record_discord_interaction(
            client,
            created=created,
            interaction_id=interaction_id,
            token=f"{interaction_id}-token",
            application_id=DISCORD_TEST_APPLICATION_ID,
        )
        assert response.status_code == 200
        assert response.json() == {
            "type": 4,
            "data": {"content": channel_service.AGENT_OFFLINE_REPLY, "flags": 64},
        }
    assert _FakeProviderClient.calls == []
    messages = list(
        (
            await db_session.execute(
                select(ChannelMessage).where(
                    ChannelMessage.account_id == UUID(created["id"]),
                    ChannelMessage.provider_message_id.in_(
                        ["offline-interaction-1", "offline-interaction-2"]
                    ),
                )
            )
        ).scalars()
    )
    assert len(messages) == 2
    assert all(message.delivered_at is not None for message in messages)

    autocomplete = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 4,
            "id": "offline-autocomplete",
            "token": "autocomplete-token",
            "application_id": DISCORD_TEST_APPLICATION_ID,
            "channel_id": "discord-chan-1",
            "guild_id": "discord-guild-1",
            "data": {"name": "agent_command"},
        },
    )
    assert autocomplete.status_code == 200
    assert autocomplete.json() == {"type": 8, "data": {"choices": []}}


@pytest.mark.asyncio
async def test_discord_gateway_offline_reply_targets_channel_and_preserves_online_guild_binding(
    client,
    db_session,
    channel_agent,
    second_channel_agent,
    channel_runtime_head,
    monkeypatch,
):
    guild_id = "offline-shared-guild"
    channel_id = "offline-guild-channel"
    offline = await _create_paired_discord_channel(
        client,
        name="discord-offline-gateway",
        agent_id=channel_agent.id,
        guild_id=guild_id,
        channel_id=channel_id,
    )
    online_response = await client.post(
        "/v1/channels",
        json={
            "provider": "discord",
            "name": "discord-online-gateway",
            "agent_id": None,
            "provider_token": "discord-provider-token-2",
            "config": _discord_ready_config(),
        },
    )
    assert online_response.status_code == 201, online_response.text
    online = online_response.json()
    online_link = await _seed_created_channel_link(
        db_session,
        created=online,
        agent=second_channel_agent,
    )
    db_session.add(
        ChannelBinding(
            account_id=UUID(online["id"]),
            bot_agent_link_id=online_link.id,
            user_id=online_link.user_id,
            external_chat_id=guild_id,
            external_chat_type="guild",
        )
    )
    await db_session.commit()
    now = datetime.now(UTC)
    await channel_runtime_head(
        channel_agent,
        received_at=now - timedelta(hours=1),
        freshness_deadline=now - timedelta(minutes=11),
    )
    await channel_runtime_head(
        second_channel_agent,
        received_at=now,
        freshness_deadline=now + timedelta(minutes=1),
    )
    _reset_fake_provider_client({"id": "offline-reply", "channel_id": channel_id})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    frame = {
        "op": 0,
        "t": "MESSAGE_CREATE",
        "s": 80,
        "d": {
            "id": "offline-gateway-message",
            "channel_id": channel_id,
            "guild_id": guild_id,
            "content": "hello",
            "author": {"id": "discord-sender"},
        },
    }
    interaction = await _record_discord_interaction(
        client,
        created=offline,
        interaction_id="offline-http-before-gateway",
        token="offline-http-token",
        application_id=DISCORD_TEST_APPLICATION_ID,
        channel_id=channel_id,
        guild_id=guild_id,
    )
    assert interaction.status_code == 200
    assert interaction.json()["data"]["content"] == channel_service.AGENT_OFFLINE_REPLY
    for event_type, data in (
        ("MESSAGE_REACTION_ADD", {"message_id": "offline-reaction", "user_id": "discord-sender"}),
        ("MESSAGE_CREATE", {"id": "offline-bot", "author": {"id": "discord-bot", "bot": True}}),
    ):
        assert await record_discord_gateway_dispatch(
            sessionmaker,
            UUID(offline["id"]),
            {
                "op": 0,
                "t": event_type,
                "s": 79,
                "d": {"channel_id": channel_id, "guild_id": guild_id, **data},
            },
        )
    assert _FakeProviderClient.calls == []
    assert (
        await db_session.scalar(
            select(func.count(ChannelAccountRuntimeMarker.id)).where(
                ChannelAccountRuntimeMarker.account_id == UUID(offline["id"]),
                ChannelAccountRuntimeMarker.kind == CHANNEL_RUNTIME_MARKER_AGENT_OFFLINE_REPLY,
            )
        )
        == 0
    )
    for created in (offline, online):
        assert await record_discord_gateway_dispatch(sessionmaker, UUID(created["id"]), frame)
    calls = [call for call in _FakeProviderClient.calls if call["url"].endswith("/messages")]
    assert len(calls) == 1
    assert calls[0]["url"].endswith(f"/channels/{channel_id}/messages")
    assert calls[0]["json"]["content"] == channel_service.AGENT_OFFLINE_REPLY
    messages = list(
        (
            await db_session.execute(
                select(ChannelMessage).where(
                    ChannelMessage.provider_message_id == "offline-gateway-message",
                    ChannelMessage.account_id.in_([UUID(offline["id"]), UUID(online["id"])]),
                )
            )
        ).scalars()
    )
    assert len(messages) == 2
    by_account = {str(message.account_id): message for message in messages}
    assert by_account[offline["id"]].delivered_at is not None
    assert by_account[online["id"]].delivered_at is None
    assert all(message.binding_id is not None for message in messages)
    assert (
        await db_session.scalar(
            select(func.count(ChannelDelivery.id)).where(
                ChannelDelivery.account_id == UUID(offline["id"]),
            )
        )
        == 0
    )


@pytest.mark.asyncio
async def test_inactive_link_is_not_offline_replyable(
    db_session, seed_user, channel_agent, channel_runtime_head
):
    account, link, binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=channel_agent,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        chat_id="inactive-link",
    )
    now = datetime.now(UTC)
    await channel_runtime_head(
        channel_agent,
        received_at=now - timedelta(hours=1),
        freshness_deadline=now - timedelta(minutes=11),
    )
    message = await _add_message(db_session, account=account, binding=binding, text="hello")
    for link_status, archived_at in (
        (BOT_AGENT_LINK_STATUS_ARCHIVED, None),
        (BOT_AGENT_LINK_STATUS_ACTIVE, now),
    ):
        link.status = link_status
        link.archived_at = archived_at
        assert (
            await channel_service.consume_inbound_messages_for_offline_agents(
                db_session, account=account, messages=[(message, binding)], claim_reply=True
            )
            == ()
        )
        assert message.delivered_at is None
    assert (
        await db_session.scalar(
            select(func.count(ChannelAccountRuntimeMarker.id)).where(
                ChannelAccountRuntimeMarker.account_id == account.id,
                ChannelAccountRuntimeMarker.kind == CHANNEL_RUNTIME_MARKER_AGENT_OFFLINE_REPLY,
            )
        )
        == 0
    )


@pytest.mark.asyncio
async def test_queue_snapshots_report_provider_specific_stuck_pending(
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
    second_channel_agent: AgentEnvironment,
    channel_runtime_head,
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

    offline_account, _offline_link, offline_binding = await _create_account_and_binding(
        db_session,
        user=seed_user,
        agent=second_channel_agent,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        chat_id="telegram-offline-stuck",
    )
    offline_inbox = await _add_message(
        db_session, account=offline_account, binding=offline_binding, text="offline inbox"
    )
    offline_inbox.created_at = old
    await channel_runtime_head(
        second_channel_agent,
        received_at=now - timedelta(hours=1),
        freshness_deadline=now - timedelta(minutes=11),
    )

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
        async_sessionmaker(db_session.bind, expire_on_commit=False),
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
