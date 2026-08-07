from __future__ import annotations

from uuid import UUID, uuid4

import httpx
import pytest
from sqlalchemy import event as sqlalchemy_event
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel import (
    BINDING_STATUS_ARCHIVED,
    MESSAGE_DIRECTION_INBOUND,
    ChannelAccount,
    ChannelBinding,
    ChannelBotAgentLink,
    ChannelDebugEvent,
    ChannelMessage,
)
from app.models.user import User
from app.services.channel_debug_events import (
    public_channel_debug_details,
    record_channel_debug_event,
)
from app.services.whatsapp_provider_bridge import (
    register_whatsapp_provider_transport,
    unregister_whatsapp_provider_transport,
)

pytestmark = pytest.mark.usefixtures("channel_agent")


def test_public_channel_debug_details_allows_only_known_whatsapp_runtime_enums():
    assert public_channel_debug_details("baileys_websocket", key="runtime") == ("baileys_websocket")
    assert public_channel_debug_details("baileys_noise", key="runtime") == "baileys_noise"
    assert public_channel_debug_details("provider-controlled", key="runtime") == "[redacted]"
    assert (
        public_channel_debug_details("server=s.whatsapp.net device=true", key="jidDescription")
        == "server=s.whatsapp.net device=true"
    )
    assert (
        public_channel_debug_details("server=secret.example device=true", key="jidDescription")
        == "[redacted]"
    )
    digest = "a" * 64
    assert public_channel_debug_details(digest, key="clientStaticSha256") == digest
    assert public_channel_debug_details("not-a-digest", key="clientStaticSha256") == "[redacted]"


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
        error="upstream Authorization: Bot debug-secret-marker " + ("x" * 700),
        details={
            "providerToken": "debug-secret-marker",
            "nested": {
                "authorization": "Bearer debug-secret-marker",
                "message": "postgresql://user:debug-secret-marker@db.example/app",
            },
            "provider_body": "https://cdn.example/file?signature=debug-secret-marker",
            "reason": "provider_failure",
            "items": list(range(25)),
            "opaque": object(),
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
    assert event["details"]["nested"]["message"] == "[redacted]"
    assert event["details"]["provider_body"] == "[redacted]"
    assert event["details"]["reason"] == "provider_failure"
    assert len(event["details"]["items"]) == 20
    assert isinstance(event["details"]["opaque"], str)
    assert event["error"] == "channel_operation_failed"
    assert "debug-secret-marker" not in response.text

    stored = (
        await db_session.execute(
            select(ChannelDebugEvent).where(ChannelDebugEvent.id == UUID(event["id"]))
        )
    ).scalar_one()
    assert stored.error == "channel_operation_failed"
    assert "debug-secret-marker" not in str(stored.details)


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
    historical_binding = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=UUID(created["agent_link_id"]),
        user_id=seed_user.id,
        external_chat_id="discord-channel-debug-historical",
        external_chat_type="guild_text",
        external_chat_name="debug historical",
        status=BINDING_STATUS_ARCHIVED,
    )
    db_session.add_all([binding, historical_binding])
    await db_session.flush()
    db_session.add_all(
        [
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
            ),
            ChannelMessage(
                account_id=account.id,
                bot_agent_link_id=UUID(created["agent_link_id"]),
                binding_id=historical_binding.id,
                user_id=seed_user.id,
                direction=MESSAGE_DIRECTION_INBOUND,
                external_chat_id=historical_binding.external_chat_id,
                provider_message_id="debug-message-historical",
                text="must not affect debug health",
                payload={"t": "MESSAGE_CREATE"},
            ),
        ]
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
    assert health["oldestPendingInboxAt"] is not None
    assert health["lastEvent"]["stage"] == "rest"
    assert health["lastError"]["error"] == "channel_operation_failed"


@pytest.mark.asyncio
async def test_channel_debug_health_select_count_is_constant_across_accounts(
    client: httpx.AsyncClient,
    engine,
):
    async def create_account(index: int) -> None:
        response = await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": f"debug-health-query-count-{index}-{uuid4().hex}",
            },
        )
        assert response.status_code == 201, response.text

    async def health_select_count() -> int:
        select_count = 0

        def count_selects(_conn, _cursor, statement, _parameters, _context, _executemany):
            nonlocal select_count
            if statement.lstrip().upper().startswith("SELECT"):
                select_count += 1

        sqlalchemy_event.listen(engine.sync_engine, "before_cursor_execute", count_selects)
        try:
            response = await client.get("/v1/channels/debug/health")
        finally:
            sqlalchemy_event.remove(engine.sync_engine, "before_cursor_execute", count_selects)
        assert response.status_code == 200, response.text
        return select_count

    await create_account(0)
    one_account_count = await health_select_count()
    for index in range(1, 5):
        await create_account(index)
    five_account_count = await health_select_count()

    assert one_account_count == 4
    assert five_account_count == one_account_count


@pytest.mark.asyncio
async def test_channel_debug_health_isolates_cross_user_accounts_and_aggregates(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    channel_agent,
):
    owned = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": f"owned-debug-health-{uuid4().hex}"},
        )
    ).json()
    owned_account = await db_session.get(ChannelAccount, UUID(owned["id"]))
    assert owned_account is not None

    other_user = User(
        clerk_id=f"debug-health-other-{uuid4().hex}",
        email=f"debug-health-other-{uuid4().hex}@clawdi.local",
        name="Debug Health Other",
    )
    db_session.add(other_user)
    await db_session.flush()
    other_account = ChannelAccount(
        user_id=other_user.id,
        provider="telegram",
        name=f"other-debug-health-{uuid4().hex}",
        webhook_secret_hash=uuid4().hex,
    )
    db_session.add(other_account)
    await db_session.flush()
    other_link = ChannelBotAgentLink(
        account_id=other_account.id,
        user_id=other_user.id,
        agent_id=channel_agent.id,
        agent_token_hash=uuid4().hex,
    )
    db_session.add(other_link)
    await db_session.flush()
    other_binding = ChannelBinding(
        account_id=other_account.id,
        bot_agent_link_id=other_link.id,
        user_id=other_user.id,
        external_chat_id="other-user-debug-health",
    )
    db_session.add(other_binding)
    await db_session.flush()
    db_session.add(
        ChannelMessage(
            account_id=other_account.id,
            bot_agent_link_id=other_link.id,
            binding_id=other_binding.id,
            user_id=other_user.id,
            direction=MESSAGE_DIRECTION_INBOUND,
            external_chat_id=other_binding.external_chat_id,
            text="other user pending",
        )
    )
    await record_channel_debug_event(
        db_session,
        account=other_account,
        user_id=other_user.id,
        provider="telegram",
        direction="inbound",
        stage="other_user_secret_stage",
        outcome="failure",
        error="must remain isolated",
    )
    await db_session.commit()

    response = await client.get("/v1/channels/debug/health")

    assert response.status_code == 200, response.text
    by_account = {item["accountId"]: item for item in response.json()["channels"]}
    assert owned["id"] in by_account
    assert str(other_account.id) not in by_account
    assert "other_user_secret_stage" not in response.text


@pytest.mark.asyncio
async def test_channel_debug_health_reports_whatsapp_native_transport_status(
    client: httpx.AsyncClient,
):
    class FakeWhatsAppTransport:
        async def relay_outbound_message(self, message):
            return None

        async def relay_raw_node(self, node):
            return None

        async def query_iq(self, node, timeout_ms):
            return None

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
        "available": False,
        "mode": "none",
        "reason": "provider-transport-unavailable",
        "supportsOutboundMessages": False,
        "supportsRawRelay": False,
        "supportsIqQueries": False,
    }

    account_id = UUID(created["id"])
    register_whatsapp_provider_transport(account_id, FakeWhatsAppTransport())
    try:
        available = await client.get("/v1/channels/debug/health")
    finally:
        unregister_whatsapp_provider_transport(account_id)

    assert available.status_code == 200
    health = next(
        channel for channel in available.json()["channels"] if channel["accountId"] == created["id"]
    )
    assert health["nativeTransport"] == {
        "available": True,
        "mode": "in_process",
        "reason": None,
        "supportsOutboundMessages": True,
        "supportsRawRelay": True,
        "supportsIqQueries": True,
    }
