from __future__ import annotations

from uuid import UUID

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel import (
    MESSAGE_DIRECTION_INBOUND,
    ChannelAccount,
    ChannelBinding,
    ChannelMessage,
)
from app.models.user import User
from app.services.channel_debug_events import record_channel_debug_event

pytestmark = pytest.mark.usefixtures("channel_agent")


@pytest.mark.asyncio
async def test_channel_debug_events_are_sanitized_and_filterable(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "debug-telegram"},
        )
    ).json()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None

    await record_channel_debug_event(
        db_session,
        account=account,
        user_id=seed_user.id,
        provider="Telegram",
        direction="inbound",
        stage="webhook",
        outcome="failure",
        external_chat_id="chat-1",
        request_id="req-1",
        status_code=503,
        error="upstream " + ("x" * 700),
        details={
            "providerToken": "telegram-secret",
            "nested": {
                "authorization": "Bearer secret",
                "message": "m" * 700,
            },
            "items": list(range(25)),
        },
    )
    await db_session.commit()
    await db_session.refresh(seed_user)

    response = await client.get(
        "/v1/channels/debug/events",
        params={"provider": "telegram", "outcome": "failure", "limit": 10},
    )

    assert response.status_code == 200
    events = response.json()
    assert len(events) == 1
    event = events[0]
    assert event["provider"] == "telegram"
    assert event["externalChatId"] == "chat-1"
    assert event["status"] == 503
    assert event["details"]["providerToken"] == "[redacted]"
    assert event["details"]["nested"]["authorization"] == "[redacted]"
    assert "telegram-secret" not in response.text
    assert len(event["details"]["nested"]["message"]) <= 503
    assert len(event["details"]["items"]) == 20
    assert len(event["error"]) <= 503


@pytest.mark.asyncio
async def test_channel_debug_health_reports_pending_inbox_and_last_error(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "debug-discord",
                "provider_token": "discord-debug-token",
                "config": {
                    "application_id": "123456789012345678",
                    "public_key": "ab" * 32,
                },
            },
        )
    ).json()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    binding = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=UUID(created["agent_link_id"]),
        user_id=seed_user.id,
        external_chat_id="discord-channel-debug",
        external_chat_type="guild_text",
        external_chat_name="debug",
    )
    db_session.add(binding)
    await db_session.flush()
    db_session.add(
        ChannelMessage(
            account_id=account.id,
            bot_agent_link_id=UUID(created["agent_link_id"]),
            binding_id=binding.id,
            user_id=seed_user.id,
            direction=MESSAGE_DIRECTION_INBOUND,
            external_chat_id=binding.external_chat_id,
            provider_message_id="debug-message-1",
            text="debug payload",
            payload={"t": "MESSAGE_CREATE"},
        )
    )
    await record_channel_debug_event(
        db_session,
        account=account,
        user_id=seed_user.id,
        provider="discord",
        direction="inbound",
        stage="gateway",
        outcome="received",
    )
    await record_channel_debug_event(
        db_session,
        account=account,
        user_id=seed_user.id,
        provider="discord",
        direction="outbound",
        stage="rest",
        outcome="failure",
        error="rate limited",
    )
    await db_session.commit()
    await db_session.refresh(seed_user)

    response = await client.get("/v1/channels/debug/health")

    assert response.status_code == 200
    channels = response.json()["channels"]
    health = next(channel for channel in channels if channel["accountId"] == created["id"])
    assert health["provider"] == "discord"
    assert health["pendingInbox"] == 1
    assert health["lastEvent"]["stage"] == "rest"
    assert health["lastError"]["error"] == "rate limited"


@pytest.mark.asyncio
async def test_channel_debug_health_reports_whatsapp_sidecar_status(
    client: httpx.AsyncClient,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "whatsapp", "name": "debug-whatsapp-native"},
        )
    ).json()

    unavailable = await client.get("/v1/channels/debug/health")
    assert unavailable.status_code == 200
    health = next(
        channel
        for channel in unavailable.json()["channels"]
        if channel["accountId"] == created["id"]
    )
    assert health["nativeTransport"] == {
        "mode": "sidecar",
        "configured": False,
        "connected": None,
    }
