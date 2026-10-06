from __future__ import annotations

import asyncio
import json
import socket
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock
from urllib.parse import quote
from uuid import UUID, uuid4

import httpx
import pytest
import pytest_asyncio
from fastapi import HTTPException
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import settings
from app.core.database import get_session
from app.main import app
from app.models.channel import (
    BINDING_STATUS_ACTIVE,
    BINDING_STATUS_ARCHIVED,
    BOT_AGENT_LINK_STATUS_ACTIVE,
    BOT_AGENT_LINK_STATUS_ARCHIVED,
    CHANNEL_PROVIDER_TELEGRAM,
    CHANNEL_VISIBILITY_PUBLIC,
    MESSAGE_DIRECTION_INBOUND,
    MESSAGE_DIRECTION_OUTBOUND,
    PAIR_CODE_STATUS_PENDING,
    ChannelAccount,
    ChannelAgentReference,
    ChannelBinding,
    ChannelBotAgentLink,
    ChannelMessage,
    ChannelPairCode,
)
from app.routes import admin as admin_router
from app.routes.channel_routers import discord as discord_router
from app.routes.channel_routers import public as public_router
from app.routes.channel_routers import telegram as telegram_router
from app.services import channels as channel_service
from app.services import sync_events
from app.services.channel_wakeups import notify_channel_inbound_message_enqueued
from app.services.channel_webhook_delivery_worker import ChannelWebhookDeliveryWorker
from app.services.channels import (
    channel_runtime_account_key,
    channel_runtime_placeholder_token,
    encrypt_optional_token,
    generate_agent_token,
    normalize_telegram_bot_username,
    telegram_direct_messages_topic_id_from_update,
    telegram_message_reference_value,
    telegram_message_thread_id_from_update,
    wait_for_telegram_updates,
)
from app.services.telegram_rate_limiter import telegram_rate_limiter
from app.services.url_security import UnsafeOutboundUrlError
from tests.channel_helpers import (
    TELEGRAM_AGENT_TOKEN_RE,
    _clear_fake_provider_calls,
    _client_for_user,
    _create_paired_telegram_channel,
    _create_user_with_channel_agent,
    _FailingProviderClient,
    _FakeProviderClient,
    _pair_telegram_chat,
    _paired_telegram_shared_chat,
    _reset_fake_provider_client,
    _reset_sequenced_provider_client,
    _SequencedProviderClient,
    _telegram_agent_headers,
    _telegram_bot_path,
)
from tests.db_lock_helpers import wait_for_lock_wait

pytestmark = [pytest.mark.usefixtures("channel_agent"), pytest.mark.committed_db]


@pytest.fixture(autouse=True)
def _verified_discord_guild_membership(monkeypatch: pytest.MonkeyPatch) -> None:
    original_configure = public_router.configure_discord_application
    original_sync = public_router.sync_channel_commands
    original_verify_token = admin_router.verify_discord_application_token_identity

    async def verified_membership(
        _account: ChannelAccount,
        *,
        guild_id: str,
    ) -> channel_service.DiscordGuildMembershipCheck:
        assert guild_id
        return channel_service.DiscordGuildMembershipCheck()

    async def configure_test_discord_application(account: ChannelAccount) -> dict[str, Any]:
        config = dict(account.config) if isinstance(account.config, dict) else {}
        if config.get("_test_discord_server_state") is not True:
            return await original_configure(account)
        config["discord_install_config_version"] = channel_service.DISCORD_INSTALL_CONFIG_VERSION
        config["discord_user_install_supported"] = True
        account.config = config
        return {
            "id": config.get("application_id"),
            "integration_types_config": {"0": {}, "1": {}},
        }

    async def sync_test_discord_commands(
        *,
        account: ChannelAccount,
        commands: list[dict[str, Any]] | None = None,
        guild_id: str | None = None,
        use_configured_discord_guild: bool | None = None,
    ) -> list[dict[str, Any]]:
        config = account.config if isinstance(account.config, dict) else {}
        if (
            config.get("_test_discord_server_state") is True
            and channel_service.discord_reserved_commands_are_current(account)
            and commands is None
            and use_configured_discord_guild is False
        ):
            return []
        return await original_sync(
            account=account,
            commands=commands,
            guild_id=guild_id,
            use_configured_discord_guild=use_configured_discord_guild,
        )

    async def verify_test_discord_token_identity(
        *,
        application_id: str,
        provider_token: str,
        config: dict[str, Any] | None,
    ) -> dict[str, Any]:
        if isinstance(config, dict) and config.get("_test_discord_server_state") is True:
            return {"id": application_id}
        return await original_verify_token(
            application_id=application_id,
            provider_token=provider_token,
            config=config,
        )

    monkeypatch.setattr(
        channel_service,
        "discord_bot_guild_membership_check",
        verified_membership,
    )
    monkeypatch.setattr(
        public_router,
        "configure_discord_application",
        configure_test_discord_application,
    )
    monkeypatch.setattr(public_router, "sync_channel_commands", sync_test_discord_commands)
    monkeypatch.setattr(
        admin_router,
        "verify_discord_application_token_identity",
        verify_test_discord_token_identity,
    )
    monkeypatch.setattr(discord_router, "verify_discord_signature", lambda **_kwargs: True)


@pytest_asyncio.fixture(autouse=True)
async def _reset_channel_provider_http_client():
    await channel_service.close_channel_provider_http_client()
    _reset_fake_provider_client()
    _clear_fake_provider_calls()
    try:
        yield
    finally:
        await channel_service.close_channel_provider_http_client()


@pytest.mark.asyncio
async def test_create_telegram_channel_rejects_malformed_token_before_provider_io(
    client: httpx.AsyncClient,
    monkeypatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"username": "ClawdiWebhookBot"}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)

    # Observed pastes: a bot username and a token with a full-width colon.
    for token in ("@clawdi_bot", "123456\uff1atelegram-secret"):
        response = await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "bad-token", "provider_token": token},
        )
        assert response.status_code == 400
        assert response.json() == {"detail": "Enter a valid Telegram bot token from @BotFather."}
    assert _FakeProviderClient.calls == []


@pytest.mark.asyncio
async def test_create_telegram_channel_registers_provider_webhook(
    client: httpx.AsyncClient,
    monkeypatch,
):
    previous_public_api_url = settings.public_api_url
    settings.public_api_url = "https://cloud.example.test"
    _reset_fake_provider_client({"ok": True, "result": {"username": "ClawdiWebhookBot"}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    try:
        response = await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "auto-webhook",
                "provider_token": "123456:telegram-secret",
            },
        )
    finally:
        settings.public_api_url = previous_public_api_url

    assert response.status_code == 201
    created = response.json()
    assert len(_FakeProviderClient.calls) == 2
    assert _FakeProviderClient.calls[0]["url"].endswith("/bot123456:telegram-secret/getMe")
    call = _FakeProviderClient.calls[1]
    assert call["url"].endswith("/bot123456:telegram-secret/setWebhook")
    assert call["json"] == {
        "url": created["webhook_url"],
        "secret_token": created["webhook_secret"],
    }
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"agent_link_id": created["agent_link_id"], "ttl_seconds": 900},
        )
    ).json()
    assert pair["bot_username"] == "ClawdiWebhookBot"
    assert pair["deep_link"] == f"https://t.me/ClawdiWebhookBot?start={pair['code']}"


def test_generate_telegram_agent_token_matches_bot_api_contract():
    tokens = [generate_agent_token(CHANNEL_PROVIDER_TELEGRAM) for _ in range(25)]

    assert len(set(tokens)) == len(tokens)
    assert all(TELEGRAM_AGENT_TOKEN_RE.fullmatch(token) for token in tokens)


@pytest.mark.asyncio
async def test_synthetic_telegram_identity_is_account_scoped_and_topics_fail_closed(
    client: httpx.AsyncClient,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": f"synthetic-me-{uuid4().hex}"},
        )
    ).json()
    bot_path = _telegram_bot_path(created, "getMe")
    before = await client.post(bot_path, headers=_telegram_agent_headers(created), json={})
    rotated = await client.post(
        f"/v1/channels/{created['id']}/agent-links/{created['agent_link_id']}/token"
    )
    rotated_channel = {**created, "agent_token": rotated.json()["agent_token"]}
    after = await client.post(
        bot_path,
        headers=_telegram_agent_headers(rotated_channel),
        json={},
    )

    assert before.status_code == 200
    assert rotated.status_code == 200
    assert after.status_code == 200
    assert before.json()["result"]["id"] == after.json()["result"]["id"]
    assert before.json()["result"]["has_topics_enabled"] is False
    assert after.json()["result"]["has_topics_enabled"] is False


@pytest.mark.asyncio
async def test_second_managed_telegram_account_is_rejected_before_provider_io(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    user, agent = await _create_user_with_channel_agent(
        db_session,
        label="telegram-provider-admission",
        agent_type="openclaw",
    )
    _reset_fake_provider_client({"ok": True, "result": {"username": "AdmissionTestBot"}})
    monkeypatch.setattr(settings, "public_api_url", "https://cloud.example.test")
    async with _client_for_user(db_session, user) as user_client:
        monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
        first = await user_client.post(
            "/v1/channels",
            json={
                "provider": CHANNEL_PROVIDER_TELEGRAM,
                "name": "telegram-provider-admission-first",
                "provider_token": "123456:first-token",
                "agent_id": str(agent.id),
            },
        )
        assert first.status_code == 201, first.text
        assert [call["url"].rsplit("/", 1)[-1] for call in _FakeProviderClient.calls] == [
            "getMe",
            "setWebhook",
        ]
        _clear_fake_provider_calls()
        second = await user_client.post(
            "/v1/channels",
            json={
                "provider": CHANNEL_PROVIDER_TELEGRAM,
                "name": "telegram-provider-admission-second",
                "provider_token": "123456:second-token",
                "agent_id": str(agent.id),
            },
        )

    assert second.status_code == 409, second.text
    assert second.json()["detail"] == (
        "This Agent already has a Telegram bot. Unlink it before connecting another."
    )
    assert _FakeProviderClient.calls == []


@pytest.mark.asyncio
async def test_telegram_bot_api_get_updates_reads_paired_inbox(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "telegram-agent"},
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 1,
            "message": {
                "message_id": 1,
                "text": f"/clawdi_pair {pair['code']}",
                "chat": {"id": 222, "type": "private"},
            },
        },
    )
    await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "message": {
                "message_id": 2,
                "text": "hello agent",
                "chat": {"id": 222, "type": "private"},
            },
        },
    )

    updates = await client.get(
        _telegram_bot_path(created, "getUpdates"),
        headers=_telegram_agent_headers(created),
        params={"offset": 2},
    )

    assert updates.status_code == 200
    assert updates.json()["ok"] is True
    assert updates.json()["result"] == [
        {
            "update_id": 2,
            "message": {
                "message_id": 2,
                "text": "hello agent",
                "chat": {"id": 222, "type": "private"},
            },
        }
    ]


@pytest.mark.asyncio
async def test_telegram_bot_api_accepts_official_bot_path_shape(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"ok": True, "result": True})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-official-path",
        chat_id="333",
    )
    await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 3,
            "message": {
                "message_id": 3,
                "text": "official path",
                "chat": {"id": 333, "type": "private"},
            },
        },
    )

    updates = await client.get(
        _telegram_bot_path(created, "getUpdates", slash_variant=False),
        headers=_telegram_agent_headers(created),
        params={"offset": 3},
    )
    delete_webhook = await client.post(
        _telegram_bot_path(created, "deleteWebhook", slash_variant=False),
        headers=_telegram_agent_headers(created),
    )

    assert updates.status_code == 200
    assert updates.json()["ok"] is True
    assert updates.json()["result"][0]["message"]["text"] == "official path"
    assert delete_webhook.status_code == 200
    assert delete_webhook.json() == {"ok": True, "result": True}


@pytest.mark.asyncio
async def test_telegram_managed_bot_api_keeps_credential_out_of_loggable_path(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"ok": True, "result": True})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-managed-auth",
        chat_id="334",
    )
    routing_id = channel_runtime_placeholder_token(
        CHANNEL_PROVIDER_TELEGRAM,
        channel_runtime_account_key(UUID(created["id"])),
    )
    path = f"/v1/channels/telegram/bot{routing_id}/getUpdates"
    headers = {"Authorization": f"Bearer {created['agent_token']}"}

    response = await client.get(path, headers=headers)
    missing_header = await client.get(path)
    old_secret_path = f"/v1/channels/telegram/bot{created['agent_token']}/getUpdates"
    rejected_old_secret_path = await client.get(old_secret_path)
    mismatched_route = await client.get(
        f"/v1/channels/telegram/bot{routing_id}x/getUpdates",
        headers=headers,
    )

    assert created["agent_token"] not in path
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert missing_header.status_code == 401
    assert created["agent_token"] in old_secret_path
    assert rejected_old_secret_path.status_code == 401
    assert mismatched_route.status_code == 401


@pytest.mark.asyncio
async def test_telegram_repair_moves_chat_to_new_agent_link(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    second_channel_agent,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-public-bot",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    default_pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    workspace_pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"agent_id": str(second_channel_agent.id), "ttl_seconds": 900},
        )
    ).json()
    assert workspace_pair["agent_link_id"] != created["agent_link_id"]
    assert workspace_pair["agent_token"]

    async def post_update(update_id: int, text: str):
        return await client.post(
            f"/v1/channels/telegram/{created['id']}/webhook",
            headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
            json={
                "update_id": update_id,
                "message": {
                    "message_id": update_id,
                    "text": text,
                    "chat": {"id": 777, "type": "private"},
                },
            },
        )

    default_claim = await post_update(101, f"/clawdi_pair {default_pair['code']}")
    workspace_claim = await post_update(102, f"/clawdi_pair {workspace_pair['code']}")
    inbound = await post_update(103, "shared chat update")
    assert default_claim.status_code == 200
    assert default_claim.json()["paired"] is True
    assert workspace_claim.status_code == 200
    assert workspace_claim.json()["paired"] is True
    assert inbound.status_code == 200

    messages = (
        (
            await db_session.execute(
                select(ChannelMessage).where(
                    ChannelMessage.account_id == UUID(created["id"]),
                    ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
                    ChannelMessage.external_chat_id == "777",
                    ChannelMessage.provider_message_id == "103",
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(messages) == 1
    assert str(messages[0].bot_agent_link_id) == workspace_pair["agent_link_id"]

    default_updates = await client.get(
        _telegram_bot_path(created, "getUpdates"),
        headers=_telegram_agent_headers(created),
        params={"offset": 103},
    )
    workspace_updates = await client.get(
        _telegram_bot_path(workspace_pair, "getUpdates", account_id=created["id"]),
        headers=_telegram_agent_headers(workspace_pair),
        params={"offset": 103},
    )
    assert default_updates.status_code == 200
    assert workspace_updates.status_code == 200
    assert default_updates.json()["result"] == []
    assert workspace_updates.json()["result"] == [
        {
            "update_id": 103,
            "message": {
                "message_id": 103,
                "text": "shared chat update",
                "chat": {"id": 777, "type": "private"},
            },
        }
    ]


@pytest.mark.asyncio
async def test_telegram_unpair_archives_current_chat_route(
    client: httpx.AsyncClient,
    channel_agent,
    second_channel_agent,
):
    created, _workspace_pair, chat_id = await _paired_telegram_shared_chat(
        client,
        channel_agent,
        second_channel_agent,
    )

    unpaired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 203,
            "message": {
                "message_id": 203,
                "text": "/clawdi_unpair",
                "chat": {"id": int(chat_id), "type": "private"},
            },
        },
    )
    bindings = await client.get(f"/v1/channels/{created['id']}/bindings")

    assert unpaired.status_code == 200
    assert unpaired.json()["unpaired"] is True
    assert bindings.json() == []


@pytest.mark.asyncio
async def test_telegram_same_provider_multiple_bots_are_account_scoped(
    client: httpx.AsyncClient,
    channel_agent,
    second_channel_agent,
):
    first = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-bot-one",
                "agent_id": str(second_channel_agent.id),
            },
        )
    ).json()
    second = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-bot-two",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    assert first["agent_id"] != second["agent_id"]
    assert first["agent_link_id"] != second["agent_link_id"]
    assert first["agent_token"] != second["agent_token"]

    async def pair_and_post(account: dict[str, Any], update_id: int, text: str) -> None:
        pair = (
            await client.post(
                f"/v1/channels/{account['id']}/pair-codes",
                json={"ttl_seconds": 900},
            )
        ).json()
        paired = await client.post(
            f"/v1/channels/telegram/{account['id']}/webhook",
            headers={"x-telegram-bot-api-secret-token": account["webhook_secret"]},
            json={
                "update_id": update_id,
                "message": {
                    "message_id": update_id,
                    "text": f"/clawdi_pair {pair['code']}",
                    "chat": {"id": 888, "type": "private"},
                },
            },
        )
        inbound = await client.post(
            f"/v1/channels/telegram/{account['id']}/webhook",
            headers={"x-telegram-bot-api-secret-token": account["webhook_secret"]},
            json={
                "update_id": update_id + 1,
                "message": {
                    "message_id": update_id + 1,
                    "text": text,
                    "chat": {"id": 888, "type": "private"},
                },
            },
        )
        assert paired.status_code == 200
        assert paired.json()["paired"] is True
        assert inbound.status_code == 200

    await pair_and_post(first, 201, "first bot update")
    await pair_and_post(second, 301, "second bot update")

    first_updates = await client.get(
        _telegram_bot_path(first, "getUpdates"),
        headers=_telegram_agent_headers(first),
        params={"offset": 202},
    )
    second_updates = await client.get(
        _telegram_bot_path(second, "getUpdates"),
        headers=_telegram_agent_headers(second),
        params={"offset": 302},
    )
    first_token_cannot_read_second_bot = await client.get(
        _telegram_bot_path(first, "getUpdates"),
        headers=_telegram_agent_headers(first),
        params={"offset": 302},
    )
    assert first_updates.status_code == 200
    assert second_updates.status_code == 200
    assert first_token_cannot_read_second_bot.status_code == 200
    assert first_updates.json()["result"][0]["message"]["text"] == "first bot update"
    assert second_updates.json()["result"][0]["message"]["text"] == "second bot update"
    assert first_token_cannot_read_second_bot.json()["result"] == []


@pytest.mark.asyncio
async def test_telegram_bot_api_get_updates_empty_allowed_updates_delivers_all(
    client: httpx.AsyncClient,
):
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-allowed-updates-empty",
        chat_id="222",
        provider_token=None,
    )
    await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "message": {
                "message_id": 2,
                "text": "empty allowlist still arrives",
                "chat": {"id": 222, "type": "private"},
            },
        },
    )

    updates = await client.post(
        _telegram_bot_path(created, "getUpdates"),
        headers=_telegram_agent_headers(created),
        json={"offset": 2, "allowed_updates": []},
    )

    assert updates.status_code == 200
    assert updates.json()["result"][0]["message"]["text"] == "empty allowlist still arrives"


@pytest.mark.asyncio
async def test_telegram_webhook_synthesizes_bot_command_entities(
    client: httpx.AsyncClient,
):
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-command-entities",
        chat_id="222",
        provider_token=None,
    )
    inbound = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 3,
            "message": {
                "message_id": 3,
                "text": "/start hello",
                "chat": {"id": 222, "type": "private"},
            },
        },
    )
    updates = await client.get(
        _telegram_bot_path(created, "getUpdates"),
        headers=_telegram_agent_headers(created),
        params={"offset": 3},
    )

    assert inbound.status_code == 200
    assert updates.status_code == 200
    assert updates.json()["result"][0]["message"]["entities"] == [
        {"type": "bot_command", "offset": 0, "length": 6}
    ]


@pytest.mark.asyncio
async def test_telegram_bot_api_get_updates_allowed_updates_drains_filtered_rows(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-allowed-updates-filter",
        chat_id="222",
        provider_token=None,
    )
    await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "message": {
                "message_id": 2,
                "text": "filtered out",
                "chat": {"id": 222, "type": "private"},
            },
        },
    )
    await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 3,
            "callback_query": {
                "id": "cb-allowed",
                "message": {"chat": {"id": 222, "type": "private"}},
                "data": "button",
            },
        },
    )

    updates = await client.post(
        _telegram_bot_path(created, "getUpdates"),
        headers=_telegram_agent_headers(created),
        json={"offset": 2, "allowed_updates": ["callback_query"]},
    )
    filtered_message = (
        await db_session.execute(
            select(ChannelMessage).where(
                ChannelMessage.account_id == UUID(created["id"]),
                ChannelMessage.text == "filtered out",
            )
        )
    ).scalar_one()

    assert updates.status_code == 200
    assert updates.json()["result"] == [
        {
            "update_id": 3,
            "callback_query": {
                "id": "cb-allowed",
                "message": {"chat": {"id": 222, "type": "private"}},
                "data": "button",
            },
        }
    ]
    assert filtered_message.delivered_at is not None


@pytest.mark.asyncio
async def test_telegram_get_updates_wait_helper_sees_new_committed_update(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-long-poll",
        chat_id="222",
        provider_token=None,
    )
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)

    pending = asyncio.create_task(
        wait_for_telegram_updates(
            sessionmaker,
            account_id=UUID(created["id"]),
            offset=2,
            limit=100,
            timeout_seconds=1,
            poll_interval_seconds=30,
        )
    )
    await sync_events.start_postgres_listener()
    try:
        await asyncio.sleep(0.01)
        async with sessionmaker() as insert_session:
            binding = (
                await insert_session.execute(
                    select(ChannelBinding).where(
                        ChannelBinding.account_id == UUID(created["id"]),
                        ChannelBinding.external_chat_id == "222",
                    )
                )
            ).scalar_one()
            insert_session.add(
                ChannelMessage(
                    account_id=binding.account_id,
                    bot_agent_link_id=binding.bot_agent_link_id,
                    binding_id=binding.id,
                    user_id=binding.user_id,
                    direction=MESSAGE_DIRECTION_INBOUND,
                    external_chat_id="222",
                    provider_message_id="2",
                    text="arrived during long poll",
                    payload={
                        "update_id": 2,
                        "message": {
                            "message_id": 2,
                            "text": "arrived during long poll",
                            "chat": {"id": 222, "type": "private"},
                        },
                    },
                )
            )
            await insert_session.flush()
            await notify_channel_inbound_message_enqueued(
                insert_session,
                account_id=created["id"],
            )
            await insert_session.commit()

        updates = await asyncio.wait_for(pending, timeout=1)
    finally:
        await sync_events.stop_postgres_listener()
        if not pending.done():
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)

    assert updates == [
        {
            "update_id": 2,
            "message": {
                "message_id": 2,
                "text": "arrived during long poll",
                "chat": {"id": 222, "type": "private"},
            },
        }
    ]


@pytest.mark.asyncio
async def test_telegram_bot_api_get_updates_long_poll_times_out_empty(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-long-poll-empty",
        chat_id="333",
        provider_token=None,
    )

    calls = 0
    original_dequeue = channel_service.dequeue_telegram_updates

    async def observed_dequeue(*args, **kwargs):
        nonlocal calls
        calls += 1
        return await original_dequeue(*args, **kwargs)

    monkeypatch.setattr(channel_service, "dequeue_telegram_updates", observed_dequeue)
    monkeypatch.setattr(settings, "channel_long_poll_interval_seconds", 5.0)
    updates = await client.get(
        _telegram_bot_path(created, "getUpdates"),
        headers=_telegram_agent_headers(created),
        params={"offset": 2, "timeout": 1},
    )

    assert updates.status_code == 200
    assert updates.json() == {"ok": True, "result": []}
    # One initial read, plus at most one deadline recheck. The previous 5 ms
    # test fallback opened roughly ten sessions over this 50 ms long poll.
    assert 1 <= calls <= 2


@pytest.mark.asyncio
async def test_telegram_bot_api_set_webhook_conflicts_with_get_updates(
    client: httpx.AsyncClient,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "telegram-webhook-agent"},
        )
    ).json()

    set_webhook = await client.post(
        _telegram_bot_path(created, "setWebhook"),
        headers=_telegram_agent_headers(created),
        json={"url": "https://agent.example/webhook", "secret_token": "agent-secret"},
    )
    get_updates = await client.get(
        _telegram_bot_path(created, "getUpdates"), headers=_telegram_agent_headers(created)
    )

    assert set_webhook.status_code == 200
    assert set_webhook.json() == {"ok": True, "result": True}
    assert get_updates.status_code == 409
    assert get_updates.json()["ok"] is False
    assert get_updates.json()["error_code"] == 409


@pytest.mark.asyncio
async def test_telegram_agent_webhook_is_scoped_to_agent_link(
    client: httpx.AsyncClient,
    channel_agent,
    second_channel_agent,
    monkeypatch,
):
    _reset_sequenced_provider_client([200])
    monkeypatch.setattr(
        "app.services.channel_webhooks.SafePublicHttpClient",
        _SequencedProviderClient,
    )
    created, workspace_pair, chat_id = await _paired_telegram_shared_chat(
        client,
        channel_agent,
        second_channel_agent,
    )
    set_workspace_webhook = await client.post(
        _telegram_bot_path(workspace_pair, "setWebhook", account_id=created["id"]),
        headers=_telegram_agent_headers(workspace_pair),
        json={"url": "https://agent.example/workspace-hook"},
    )
    default_get_updates = await client.get(
        _telegram_bot_path(created, "getUpdates"),
        headers=_telegram_agent_headers(created),
    )
    workspace_get_updates = await client.get(
        _telegram_bot_path(workspace_pair, "getUpdates", account_id=created["id"]),
        headers=_telegram_agent_headers(workspace_pair),
    )
    inbound = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 204,
            "message": {
                "message_id": 204,
                "text": "link scoped delivery",
                "chat": {"id": int(chat_id), "type": "private"},
            },
        },
    )
    default_updates = await client.get(
        _telegram_bot_path(created, "getUpdates"),
        headers=_telegram_agent_headers(created),
    )

    assert set_workspace_webhook.status_code == 200
    assert default_get_updates.status_code == 200
    assert workspace_get_updates.status_code == 409
    assert inbound.status_code == 200
    assert len(_SequencedProviderClient.calls) == 1
    assert _SequencedProviderClient.calls[0]["url"] == "https://agent.example/workspace-hook"
    assert default_updates.json()["result"] == []


@pytest.mark.asyncio
async def test_telegram_get_me_proxies_provider_bot_identity(
    client: httpx.AsyncClient,
    monkeypatch,
):
    _reset_fake_provider_client(
        {
            "ok": True,
            "result": {
                "id": 123456,
                "is_bot": True,
                "first_name": "Provider Bot",
                "username": "provider_bot",
            },
        }
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-get-me",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()

    response = await client.post(
        _telegram_bot_path(created, "getMe"),
        headers=_telegram_agent_headers(created),
        json={},
    )

    assert response.status_code == 200
    assert response.json()["result"]["username"] == "provider_bot"
    assert _FakeProviderClient.calls[0]["url"].endswith("/bot123456:telegram-secret/getMe")


@pytest.mark.asyncio
async def test_telegram_set_webhook_rejects_private_targets(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "telegram-webhook-private"},
        )
    ).json()

    missing_url = await client.post(
        _telegram_bot_path(created, "setWebhook"),
        headers=_telegram_agent_headers(created),
        json={},
    )
    private_url = await client.post(
        _telegram_bot_path(created, "setWebhook"),
        headers=_telegram_agent_headers(created),
        json={"url": "https://127.0.0.1/hook"},
    )

    assert missing_url.status_code == 400
    assert missing_url.json()["description"] == "Bad Request: url is required"
    assert private_url.status_code == 400
    assert private_url.json()["ok"] is False
    assert "private host" in private_url.json()["description"]


@pytest.mark.asyncio
async def test_telegram_set_webhook_rejects_private_dns_targets(
    client: httpx.AsyncClient,
    monkeypatch,
):
    def fake_getaddrinfo(host, port, *_args):
        assert host == "agent-hook.example"
        assert port == 443
        return [
            (
                socket.AF_INET,
                socket.SOCK_STREAM,
                6,
                "",
                ("10.0.0.5", 0),
            )
        ]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "telegram-webhook-private-dns"},
        )
    ).json()

    response = await client.post(
        _telegram_bot_path(created, "setWebhook"),
        headers=_telegram_agent_headers(created),
        json={"url": "https://agent-hook.example/hook"},
    )

    assert response.status_code == 400
    assert response.json()["ok"] is False
    assert "resolves to a private host" in response.json()["description"]


@pytest.mark.asyncio
async def test_telegram_command_sync_rejects_malformed_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    real_client = httpx.AsyncClient

    def provider_handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ok": "true", "result": True})

    def client_factory(*_args: object, **_kwargs: object) -> httpx.AsyncClient:
        return real_client(transport=httpx.MockTransport(provider_handler))

    async def allow_test_url(_url: str, *, label: str) -> None:
        assert label == "telegram api base url"

    monkeypatch.setattr(channel_service.httpx, "AsyncClient", client_factory)
    monkeypatch.setattr(channel_service, "validate_channel_http_url", allow_test_url)
    ciphertext, nonce = encrypt_optional_token("telegram-token")
    account = ChannelAccount(
        provider="telegram",
        encrypted_provider_token=ciphertext,
        provider_token_nonce=nonce,
    )

    with pytest.raises(HTTPException) as exc_info:
        await channel_service.sync_telegram_commands(account=account, commands=[])

    assert exc_info.value.status_code == 502
    assert exc_info.value.detail == "telegram api returned invalid commands"


@pytest.mark.asyncio
async def test_telegram_command_sync_rejects_private_provider_base_url(monkeypatch):
    _reset_fake_provider_client()
    monkeypatch.setattr(
        "app.services.channels.httpx.AsyncClient",
        _FakeProviderClient,
    )
    monkeypatch.setattr(settings, "channel_telegram_api_base_url", "https://127.0.0.1")
    ciphertext, nonce = encrypt_optional_token("telegram-token")
    account = ChannelAccount(
        provider="telegram",
        encrypted_provider_token=ciphertext,
        provider_token_nonce=nonce,
    )

    with pytest.raises(HTTPException) as exc:
        await channel_service.sync_telegram_commands(account=account, commands=[])

    assert exc.value.status_code == 400
    assert exc.value.detail == "telegram provider url must be a public https URL"
    assert _FakeProviderClient.calls == []


@pytest.mark.asyncio
async def test_telegram_proxy_url_error_does_not_leak_validator_detail(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "telegram-sensitive-proxy-url-error"},
        )
    ).json()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    ciphertext, nonce = encrypt_optional_token("telegram-provider-token")
    account.encrypted_provider_token = ciphertext
    account.provider_token_nonce = nonce
    await db_session.commit()
    marker = "169.254.169.254 Authorization: Bot proxy-secret"

    async def reject_sensitive_url(_url: str, *, label: str) -> None:
        assert label == "telegram api base url"
        raise UnsafeOutboundUrlError(marker)

    monkeypatch.setattr(telegram_router, "validate_channel_http_url", reject_sensitive_url)

    response = await client.post(
        _telegram_bot_path(created, "getMe"),
        headers=_telegram_agent_headers(created),
        json={},
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "telegram api base url must be a public https URL"}
    assert marker not in response.text


@pytest.mark.asyncio
async def test_telegram_bot_api_chat_capabilities_are_agent_link_scoped(
    client: httpx.AsyncClient,
    channel_agent,
    second_channel_agent,
    monkeypatch,
):
    _reset_fake_provider_client({"ok": True, "result": True})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-method-capabilities",
                "provider_token": "123456:telegram-secret",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    await _pair_telegram_chat(client, created=created, chat_id="111", chat_type="private")
    second = (
        await client.post(
            f"/v1/channels/{created['id']}/agent-links",
            json={"agent_id": str(second_channel_agent.id)},
        )
    ).json()
    second_pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"agent_link_id": second["id"], "ttl_seconds": 900},
        )
    ).json()
    paired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "message": {
                "message_id": 2,
                "from": {"id": 4242, "is_bot": False, "first_name": "Pairer"},
                "text": f"/clawdi_pair {second_pair['code']}",
                "chat": {"id": 222, "type": "private"},
            },
        },
    )
    assert paired.json()["paired"] is True

    for update_id, chat_id, callback_query_id, file_id in (
        (3, 111, "cb-first", "file-first"),
        (4, 222, "cb-second", "file-second"),
    ):
        inbound = await client.post(
            f"/v1/channels/telegram/{created['id']}/webhook",
            headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
            json={
                "update_id": update_id,
                "callback_query": {
                    "id": callback_query_id,
                    "data": "approve",
                    "message": {
                        "message_id": update_id,
                        "chat": {"id": chat_id, "type": "private"},
                        "document": {"file_id": file_id, "file_name": "report.pdf"},
                    },
                },
            },
        )
        assert inbound.status_code == 200

    cases = (
        {
            "name": "valid chat-scoped method",
            "method": "sendMessage",
            "json": {"chat_id": "111", "text": "allowed"},
            "status": 200,
            "forwarded": True,
        },
        {
            "name": "unknown method with bound chat",
            "method": "futureGlobalMutation",
            "json": {"chat_id": "111"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "unknown method without chat",
            "method": "futureGlobalMutation",
            "json": {},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "known global mutation with smuggled chat",
            "method": "setMyProfilePhoto",
            "json": {"chat_id": "111", "photo": "attach://photo"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "known chat method without chat",
            "method": "sendMessage",
            "json": {"text": "missing target"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "chat owned by another link",
            "method": "sendMessage",
            "json": {"chat_id": "222", "text": "blocked"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "source chat owned by another link",
            "method": "forwardMessage",
            "json": {"chat_id": "111", "from_chat_id": "222", "message_id": 1},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "reply chat owned by another link",
            "method": "sendMessage",
            "json": {
                "chat_id": "111",
                "text": "blocked reply",
                "reply_parameters": {"chat_id": "222", "message_id": 1},
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "query-encoded reply chat owned by another link",
            "method": "sendMessage",
            "params": {
                "chat_id": "111",
                "text": "blocked reply",
                "reply_parameters": json.dumps({"chat_id": "222", "message_id": 1}),
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "sender chat owned by another link",
            "method": "banChatSenderChat",
            "json": {"chat_id": "111", "sender_chat_id": "222"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "callback query owned by another link",
            "method": "sendMessage",
            "json": {"chat_id": "111", "callback_query_id": "cb-second", "text": "blocked"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "callback query owned by same link",
            "method": "sendMessage",
            "json": {"chat_id": "111", "callback_query_id": "cb-first", "text": "allowed"},
            "status": 200,
            "forwarded": True,
        },
        {
            "name": "callback answer owned by another link",
            "method": "answerCallbackQuery",
            "json": {"callback_query_id": "cb-second"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "callback answer owned by same link",
            "method": "answerCallbackQuery",
            "json": {"callback_query_id": "cb-first"},
            "status": 200,
            "forwarded": True,
        },
        {
            "name": "file owned by another link",
            "method": "getFile",
            "json": {"file_id": "file-second"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "file owned by same link",
            "method": "getFile",
            "json": {"file_id": "file-first"},
            "status": 200,
            "forwarded": True,
        },
        {
            "name": "inbound photo file owned by same link",
            "method": "sendPhoto",
            "json": {"chat_id": "111", "photo": "file-first"},
            "status": 200,
            "forwarded": True,
        },
        {
            "name": "foreign top-level photo",
            "method": "sendPhoto",
            "json": {"chat_id": "111", "photo": "file-second"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign top-level document",
            "method": "sendDocument",
            "json": {"chat_id": "111", "document": "file-second"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign top-level sticker",
            "method": "sendSticker",
            "json": {"chat_id": "111", "sticker": "file-second"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign top-level animation",
            "method": "sendAnimation",
            "json": {"chat_id": "111", "animation": "file-second"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign top-level audio",
            "method": "sendAudio",
            "json": {"chat_id": "111", "audio": "file-second"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign top-level video",
            "method": "sendVideo",
            "json": {"chat_id": "111", "video": "file-second"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign top-level voice",
            "method": "sendVoice",
            "json": {"chat_id": "111", "voice": "file-second"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign top-level video note",
            "method": "sendVideoNote",
            "json": {"chat_id": "111", "video_note": "file-second"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign top-level live photo",
            "method": "sendLivePhoto",
            "json": {
                "chat_id": "111",
                "live_photo": "file-second",
                "photo": "file-first",
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign reusable video cover",
            "method": "sendVideo",
            "json": {
                "chat_id": "111",
                "video": "https://example.com/video.mp4",
                "cover": "file-second",
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "provider validates thumbnail reuse semantics",
            "method": "sendVideo",
            "json": {
                "chat_id": "111",
                "video": "https://example.com/video.mp4",
                "thumbnail": "file-first",
            },
            "status": 200,
            "forwarded": True,
        },
        {
            "name": "foreign media group item",
            "method": "sendMediaGroup",
            "json": {
                "chat_id": "111",
                "media": [
                    {"type": "photo", "media": "file-second"},
                    {"type": "document", "media": "https://example.com/report.pdf"},
                ],
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "query-encoded foreign media group item",
            "method": "sendMediaGroup",
            "params": {
                "chat_id": "111",
                "media": json.dumps([{"type": "photo", "media": "file-second"}]),
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "duplicate query file parameter",
            "method": "sendPhoto",
            "params": [
                ("chat_id", "111"),
                ("photo", "file-second"),
                ("photo", "https://example.com/photo.jpg"),
            ],
            "status": 400,
            "forwarded": False,
        },
        {
            "name": "duplicate JSON file key",
            "method": "sendPhoto",
            "content": b"""
                {"chat_id":"111","photo":"file-second",
                "photo":"https://example.com/photo.jpg"}
            """,
            "status": 400,
            "forwarded": False,
        },
        {
            "name": "query cannot override body file authorization",
            "method": "sendPhoto",
            "query": {"photo": "file-second"},
            "json": {"chat_id": "111", "photo": "https://example.com/photo.jpg"},
            "status": 400,
            "forwarded": False,
        },
        {
            "name": "same-link media group item and URL",
            "method": "sendMediaGroup",
            "json": {
                "chat_id": "111",
                "media": [
                    {"type": "photo", "media": "file-first"},
                    {"type": "document", "media": "https://example.com/report.pdf"},
                ],
            },
            "status": 200,
            "forwarded": True,
        },
        {
            "name": "foreign paid media cover",
            "method": "sendPaidMedia",
            "json": {
                "chat_id": "111",
                "star_count": 1,
                "media": [
                    {
                        "type": "video",
                        "media": "https://example.com/video.mp4",
                        "cover": "file-second",
                    }
                ],
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign paid media file",
            "method": "sendPaidMedia",
            "json": {
                "chat_id": "111",
                "star_count": 1,
                "media": [{"type": "photo", "media": "file-second"}],
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign edited media",
            "method": "editMessageMedia",
            "json": {
                "chat_id": "111",
                "message_id": 1,
                "media": {"type": "document", "media": "file-second"},
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign edited ephemeral media",
            "method": "editEphemeralMessageMedia",
            "json": {
                "chat_id": "111",
                "receiver_user_id": 7,
                "ephemeral_message_id": 8,
                "media": {"type": "photo", "media": "file-second"},
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign poll description media",
            "method": "sendPoll",
            "json": {
                "chat_id": "111",
                "question": "Question?",
                "options": [{"text": "One"}, {"text": "Two"}],
                "media": {"type": "photo", "media": "file-second"},
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign poll option media",
            "method": "sendPoll",
            "json": {
                "chat_id": "111",
                "question": "Question?",
                "options": [
                    {
                        "text": "One",
                        "media": {"type": "sticker", "media": "file-second"},
                    },
                    {"text": "Two"},
                ],
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign rich message media",
            "method": "sendRichMessage",
            "json": {
                "chat_id": "111",
                "rich_message": {
                    "html": '<img src="tg://photo?id=hero">',
                    "media": [
                        {
                            "id": "hero",
                            "media": {"type": "photo", "media": "file-second"},
                        }
                    ],
                },
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign rich message block media",
            "method": "sendRichMessage",
            "json": {
                "chat_id": "111",
                "rich_message": {
                    "blocks": [
                        {
                            "type": "details",
                            "summary": "Media",
                            "blocks": [
                                {
                                    "type": "video",
                                    "video": {"type": "video", "media": "file-second"},
                                }
                            ],
                        }
                    ]
                },
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "HTTPS media URL",
            "method": "sendDocument",
            "json": {
                "chat_id": "111",
                "document": "https://example.com/report.pdf",
            },
            "status": 200,
            "forwarded": True,
        },
        {
            "name": "provider validates live photo URL semantics",
            "method": "sendLivePhoto",
            "json": {
                "chat_id": "111",
                "live_photo": "https://example.com/live.mp4",
                "photo": "file-first",
            },
            "status": 200,
            "forwarded": True,
        },
        {
            "name": "provider validates unknown nested media type",
            "method": "sendMediaGroup",
            "json": {
                "chat_id": "111",
                "media": [{"type": "future_media", "media": "file-first"}],
            },
            "status": 200,
            "forwarded": True,
        },
        {
            "name": "provider validates future file field on allowed method",
            "method": "sendMessage",
            "json": {"chat_id": "111", "text": "hello", "photo": "file-first"},
            "status": 200,
            "forwarded": True,
        },
        {
            "name": "unscoped business connection",
            "method": "sendMessage",
            "json": {
                "chat_id": "111",
                "business_connection_id": "business-other",
                "text": "blocked",
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "unscoped inline message",
            "method": "editMessageText",
            "json": {"chat_id": "111", "inline_message_id": "inline-other", "text": "blocked"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "shared Stars mutation",
            "method": "sendMessage",
            "json": {"chat_id": "111", "allow_paid_broadcast": True, "text": "blocked"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "shared payment invoice",
            "method": "sendInvoice",
            "json": {
                "chat_id": "111",
                "title": "Unsafe invoice",
                "description": "Payment updates have no attributable chat",
                "payload": "link-opaque",
                "currency": "XTR",
                "prices": [{"label": "Item", "amount": 1}],
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "shared paid media domain",
            "method": "sendPaidMedia",
            "json": {
                "chat_id": "111",
                "star_count": 1,
                "media": [{"type": "photo", "media": "https://example.com/photo.jpg"}],
            },
            "status": 403,
            "forwarded": False,
        },
    )
    for case in cases:
        telegram_rate_limiter.reset()
        _reset_fake_provider_client({"ok": True, "result": True})
        request_headers = _telegram_agent_headers(created)
        if "params" in case:
            request_kwargs = {"params": case["params"]}
        elif "content" in case:
            request_kwargs = {"content": case["content"]}
            request_headers = {**request_headers, "content-type": "application/json"}
        else:
            request_kwargs = {"json": case["json"]}
        if "query" in case:
            request_kwargs["params"] = case["query"]
        response = await client.request(
            "GET" if "params" in case else "POST",
            _telegram_bot_path(created, case["method"]),
            headers=request_headers,
            **request_kwargs,
        )
        assert response.status_code == case["status"], case["name"]
        assert bool(_FakeProviderClient.calls) is case["forwarded"], case["name"]


@pytest.mark.asyncio
async def test_telegram_bot_profile_shadow_is_account_scoped(
    client: httpx.AsyncClient,
    channel_agent,
    second_channel_agent,
):
    account_a = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-profile-a",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    account_b = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-profile-b",
                "agent_id": str(second_channel_agent.id),
            },
        )
    ).json()

    set_name = await client.post(
        _telegram_bot_path(account_a, "setMyName"),
        headers=_telegram_agent_headers(account_a),
        json={"name": "Tenant A Bot"},
    )
    get_a = await client.post(
        _telegram_bot_path(account_a, "getMyName"),
        headers=_telegram_agent_headers(account_a),
        json={},
    )
    get_b = await client.post(
        _telegram_bot_path(account_b, "getMyName"),
        headers=_telegram_agent_headers(account_b),
        json={},
    )

    assert set_name.status_code == 200
    assert set_name.json() == {"ok": True, "result": True}
    assert get_a.json() == {"ok": True, "result": {"name": "Tenant A Bot"}}
    assert get_b.json() == {"ok": True, "result": {"name": ""}}


@pytest.mark.asyncio
async def test_telegram_bot_profile_shadow_is_link_scoped_on_shared_account(
    client: httpx.AsyncClient,
    channel_agent,
    second_channel_agent,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-shared-profile",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    assert (
        await client.post(
            _telegram_bot_path(created, "setMyName"),
            headers=_telegram_agent_headers(created),
            json={"name": "First link"},
        )
    ).status_code == 200
    second = (
        await client.post(
            f"/v1/channels/{created['id']}/agent-links",
            json={"agent_id": str(second_channel_agent.id)},
        )
    ).json()
    first_get = await client.post(
        _telegram_bot_path(created, "getMyName"),
        headers=_telegram_agent_headers(created),
        json={},
    )
    second_get = await client.post(
        _telegram_bot_path(second, "getMyName", account_id=created["id"]),
        headers=_telegram_agent_headers(second),
        json={},
    )

    assert first_get.json() == {"ok": True, "result": {"name": "First link"}}
    assert second_get.json() == {"ok": True, "result": {"name": ""}}


@pytest.mark.asyncio
async def test_telegram_profile_shadow_accepts_official_clear_and_boolean_wire_values(
    client: httpx.AsyncClient,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "telegram-profile-wire-values"},
        )
    ).json()
    assert (
        await client.post(
            _telegram_bot_path(created, "setMyName"),
            headers=_telegram_agent_headers(created),
            json={"name": "Before clear"},
        )
    ).status_code == 200
    cleared = await client.post(
        _telegram_bot_path(created, "setMyName"),
        headers=_telegram_agent_headers(created),
        json={"name": ""},
    )
    rights = {"can_manage_chat": True, "future_administrator_right": True}
    set_channel_rights = await client.get(
        _telegram_bot_path(created, "setMyDefaultAdministratorRights"),
        headers=_telegram_agent_headers(created),
        params={"rights": json.dumps(rights), "for_channels": "yes"},
    )
    get_channel_rights = await client.get(
        _telegram_bot_path(created, "getMyDefaultAdministratorRights"),
        headers=_telegram_agent_headers(created),
        params={"for_channels": "1"},
    )
    get_group_rights = await client.get(
        _telegram_bot_path(created, "getMyDefaultAdministratorRights"),
        headers=_telegram_agent_headers(created),
    )

    assert cleared.status_code == 200
    assert (
        await client.post(
            _telegram_bot_path(created, "getMyName"),
            headers=_telegram_agent_headers(created),
            json={},
        )
    ).json() == {"ok": True, "result": {"name": ""}}
    assert set_channel_rights.status_code == 200
    assert get_channel_rights.json() == {"ok": True, "result": rights}
    assert get_group_rights.json() == {"ok": True, "result": {}}


@pytest.mark.asyncio
async def test_telegram_chat_menu_button_is_scoped_and_replayed_per_link(
    client: httpx.AsyncClient,
    channel_agent,
    second_channel_agent,
    monkeypatch,
):
    _reset_fake_provider_client({"ok": True, "result": True})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-shared-menu-button",
                "provider_token": "123456:telegram-secret",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    await _pair_telegram_chat(client, created=created, chat_id="777", chat_type="private")
    first_default = {
        "type": "web_app",
        "text": "First",
        "web_app": {"url": "https://a.test", "future_web_app_field": "preserved"},
        "future_menu_field": {"enabled": True},
    }
    first_chat = {"type": "commands"}
    invalid_menu = await client.post(
        _telegram_bot_path(created, "setChatMenuButton"),
        headers=_telegram_agent_headers(created),
        json={
            "menu_button": {
                "text": "Missing provider discriminator",
            }
        },
    )
    assert invalid_menu.status_code == 400
    assert _FakeProviderClient.calls == []
    assert (
        await client.post(
            _telegram_bot_path(created, "setChatMenuButton"),
            headers=_telegram_agent_headers(created),
            json={"menu_button": first_default},
        )
    ).status_code == 200
    assert (
        await client.post(
            _telegram_bot_path(created, "setChatMenuButton"),
            headers=_telegram_agent_headers(created),
            json={"chat_id": "777", "menu_button": first_chat},
        )
    ).status_code == 200
    first_get = await client.post(
        _telegram_bot_path(created, "getChatMenuButton"),
        headers=_telegram_agent_headers(created),
        json={"chat_id": "777"},
    )
    assert first_get.json() == {"ok": True, "result": first_chat}

    second = (
        await client.post(
            f"/v1/channels/{created['id']}/agent-links",
            json={"agent_id": str(second_channel_agent.id)},
        )
    ).json()
    blocked_second_get = await client.post(
        _telegram_bot_path(second, "getChatMenuButton", account_id=created["id"]),
        headers=_telegram_agent_headers(second),
        json={"chat_id": "777"},
    )
    assert blocked_second_get.status_code == 403
    second_default = {
        "type": "web_app",
        "text": "Second",
        "web_app": {"url": "https://b.test"},
    }
    _reset_fake_provider_client({"ok": True, "result": True})
    assert (
        await client.post(
            _telegram_bot_path(second, "setChatMenuButton", account_id=created["id"]),
            headers=_telegram_agent_headers(second),
            json={"menu_button": second_default},
        )
    ).status_code == 200
    assert _FakeProviderClient.calls == []

    second_pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"agent_link_id": second["id"], "ttl_seconds": 900},
        )
    ).json()
    _reset_fake_provider_client({"ok": True, "result": True})
    repaired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "message": {
                "message_id": 2,
                "from": {"id": 4242, "is_bot": False, "first_name": "Pairer"},
                "text": f"/clawdi_pair {second_pair['code']}",
                "chat": {"id": 777, "type": "private"},
            },
        },
    )
    assert repaired.status_code == 200
    assert [
        call["json"]
        for call in _FakeProviderClient.calls
        if call["url"].endswith("/setChatMenuButton")
    ] == [{"chat_id": "777", "menu_button": second_default}]
    blocked_first_get = await client.post(
        _telegram_bot_path(created, "getChatMenuButton"),
        headers=_telegram_agent_headers(created),
        json={"chat_id": "777"},
    )
    second_get = await client.post(
        _telegram_bot_path(second, "getChatMenuButton", account_id=created["id"]),
        headers=_telegram_agent_headers(second),
        json={"chat_id": "777"},
    )
    assert blocked_first_get.status_code == 403
    assert second_get.json() == {"ok": True, "result": second_default}

    _reset_fake_provider_client({"ok": True, "result": True})
    unpaired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 3,
            "message": {
                "message_id": 3,
                "from": {"id": 4242, "is_bot": False, "first_name": "Pairer"},
                "text": "/clawdi_unpair",
                "chat": {"id": 777, "type": "private"},
            },
        },
    )
    assert unpaired.status_code == 200
    assert [
        call["json"]
        for call in _FakeProviderClient.calls
        if call["url"].endswith("/setChatMenuButton")
    ] == [{"chat_id": "777", "menu_button": {"type": "default"}}]


@pytest.mark.asyncio
async def test_telegram_legacy_profile_fallback_only_applies_to_single_link(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    second_channel_agent,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-legacy-profile",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    account.config = {"telegram_bot_profile": {"name:": "Legacy account name"}}
    await db_session.commit()
    single_link = await client.post(
        _telegram_bot_path(created, "getMyName"),
        headers=_telegram_agent_headers(created),
        json={},
    )
    second = (
        await client.post(
            f"/v1/channels/{created['id']}/agent-links",
            json={"agent_id": str(second_channel_agent.id)},
        )
    ).json()
    first_after_share = await client.post(
        _telegram_bot_path(created, "getMyName"),
        headers=_telegram_agent_headers(created),
        json={},
    )
    second_after_share = await client.post(
        _telegram_bot_path(second, "getMyName", account_id=created["id"]),
        headers=_telegram_agent_headers(second),
        json={},
    )

    assert single_link.json() == {"ok": True, "result": {"name": "Legacy account name"}}
    assert first_after_share.json() == {"ok": True, "result": {"name": ""}}
    assert second_after_share.json() == {"ok": True, "result": {"name": ""}}


@pytest.mark.asyncio
async def test_telegram_bot_commands_are_shadowed_and_scope_checked(
    client: httpx.AsyncClient,
):
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-command-shadow",
        chat_id="42",
        provider_token=None,
    )

    set_commands = await client.post(
        _telegram_bot_path(created, "setMyCommands"),
        headers=_telegram_agent_headers(created),
        json={"commands": [{"command": "start", "description": "Start"}]},
    )
    get_commands = await client.post(
        _telegram_bot_path(created, "getMyCommands"),
        headers=_telegram_agent_headers(created),
        json={},
    )
    wrong_scope = await client.post(
        _telegram_bot_path(created, "getMyCommands"),
        headers=_telegram_agent_headers(created),
        json={"scope": {"type": "chat", "chat_id": 99}},
    )
    query_wrong_scope = await client.get(
        _telegram_bot_path(created, "getMyCommands"),
        headers=_telegram_agent_headers(created),
        params={"scope": json.dumps({"type": "chat", "chat_id": 99})},
    )
    unknown_scope = await client.post(
        _telegram_bot_path(created, "setMyCommands"),
        headers=_telegram_agent_headers(created),
        json={
            "commands": [{"command": "future", "description": "Future"}],
            "scope": {"type": "future_global_scope", "chat_id": 42},
        },
    )
    incomplete_member_scope = await client.post(
        _telegram_bot_path(created, "setMyCommands"),
        headers=_telegram_agent_headers(created),
        json={
            "commands": [{"command": "member", "description": "Member"}],
            "scope": {"type": "chat_member", "chat_id": 42},
        },
    )

    assert set_commands.status_code == 200
    assert get_commands.json() == {
        "ok": True,
        "result": [{"command": "start", "description": "Start"}],
    }
    assert wrong_scope.status_code == 403
    assert wrong_scope.json()["ok"] is False
    assert query_wrong_scope.status_code == 403
    assert unknown_scope.status_code == 400
    assert unknown_scope.json()["description"] == "Bad Request: invalid scope"
    assert incomplete_member_scope.status_code == 400
    assert incomplete_member_scope.json()["description"] == "Bad Request: invalid scope"


@pytest.mark.asyncio
async def test_telegram_bot_commands_preserve_scope_language_and_delete(
    client: httpx.AsyncClient,
):
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-command-scope-language",
        chat_id="42",
        provider_token=None,
    )

    default_en = await client.post(
        _telegram_bot_path(created, "setMyCommands"),
        headers=_telegram_agent_headers(created),
        json={"commands": [{"command": "start", "description": "Start"}]},
    )
    default_es = await client.post(
        _telegram_bot_path(created, "setMyCommands"),
        headers=_telegram_agent_headers(created),
        json={
            "language_code": "es",
            "commands": [{"command": "start", "description": "Inicio"}],
        },
    )
    chat_scope = await client.post(
        _telegram_bot_path(created, "setMyCommands"),
        headers=_telegram_agent_headers(created),
        json={
            "scope": {"type": "chat", "chat_id": "42"},
            "commands": [{"command": "deploy", "description": "Deploy"}],
        },
    )
    get_default_en = await client.post(
        _telegram_bot_path(created, "getMyCommands"),
        headers=_telegram_agent_headers(created),
        json={},
    )
    get_default_es = await client.post(
        _telegram_bot_path(created, "getMyCommands"),
        headers=_telegram_agent_headers(created),
        json={"language_code": "es"},
    )
    get_chat_scope = await client.post(
        _telegram_bot_path(created, "getMyCommands"),
        headers=_telegram_agent_headers(created),
        json={"scope": {"type": "chat", "chat_id": "42"}},
    )
    deleted_es = await client.post(
        _telegram_bot_path(created, "deleteMyCommands"),
        headers=_telegram_agent_headers(created),
        json={"language_code": "es"},
    )
    get_deleted_es = await client.post(
        _telegram_bot_path(created, "getMyCommands"),
        headers=_telegram_agent_headers(created),
        json={"language_code": "es"},
    )

    assert default_en.status_code == 200
    assert default_es.status_code == 200
    assert chat_scope.status_code == 200
    assert get_default_en.json()["result"] == [{"command": "start", "description": "Start"}]
    assert get_default_es.json()["result"] == [{"command": "start", "description": "Inicio"}]
    assert get_chat_scope.json()["result"] == [{"command": "deploy", "description": "Deploy"}]
    assert deleted_es.status_code == 200
    assert get_deleted_es.json()["result"] == [
        {"command": "clawdi_pair", "description": "Pair this chat with Clawdi."},
        {"command": "clawdi_unpair", "description": "Disconnect this chat from Clawdi."},
        {"command": "clawdi_help", "description": "Show safe Clawdi pairing instructions."},
    ]


@pytest.mark.parametrize(
    ("chat_type", "shadow", "expected"),
    [
        (
            "private",
            {
                "default:": [{"command": "default", "description": "Default"}],
                "default:es": [{"command": "default_es", "description": "Default ES"}],
                "all_private_chats:": [{"command": "private", "description": "Private"}],
                "all_private_chats:es": [{"command": "private_es", "description": "Private ES"}],
                "chat:42:": [{"command": "chat", "description": "Chat"}],
            },
            {
                ("chat", ""): "chat",
                ("chat", "es"): "chat",
            },
        ),
        (
            "group",
            {
                "default:": [{"command": "default", "description": "Default"}],
                "all_group_chats:": [{"command": "group", "description": "Group"}],
                "all_chat_administrators:": [{"command": "all_admin", "description": "All admins"}],
                "chat:42:": [{"command": "chat", "description": "Chat"}],
                "chat_administrators:42:": [
                    {"command": "chat_admin", "description": "Chat admins"}
                ],
                "chat_member:42:7:es": [{"command": "member_es", "description": "Member ES"}],
            },
            {
                ("chat", ""): "chat",
                ("chat", "es"): "chat",
                ("chat_administrators", ""): "chat_admin",
                ("chat_administrators", "es"): "chat_admin",
                ("chat_member", "es"): "member_es",
            },
        ),
    ],
)
def test_telegram_binding_command_projection_follows_provider_precedence(
    chat_type: str,
    shadow: dict[str, list[dict[str, Any]]],
    expected: dict[tuple[str, str], str],
):
    binding = ChannelBinding(
        external_chat_id="42",
        external_chat_type=chat_type,
    )

    projections = [
        telegram_router._telegram_materialize_command_target(target)
        for target in telegram_router._telegram_binding_command_targets(shadow, binding)
    ]
    projected = {
        (payload["scope"]["type"], payload.get("language_code", "")): payload["commands"][3][
            "command"
        ]
        for payload in projections
    }

    assert projected == expected


def test_telegram_physical_commands_enforce_ownership_and_provider_limit():
    commands = [
        {"command": "clawdi_pair", "description": "Agent conflict"},
        {"command": "clawdi", "description": "Agent-owned"},
        {"command": "clawdi", "description": "Duplicate"},
    ]

    projected = telegram_router._telegram_physical_commands(commands)

    assert [command["command"] for command in projected] == [
        "clawdi_pair",
        "clawdi_unpair",
        "clawdi_help",
        "clawdi",
    ]
    assert projected[0]["description"] == "Pair this chat with Clawdi."
    with pytest.raises(ValueError):
        telegram_router._telegram_physical_commands(
            [{"command": f"agent_{index}", "description": "Agent command"} for index in range(98)]
        )


@pytest.mark.asyncio
async def test_telegram_legacy_oversized_shadow_does_not_block_cleanup_or_pair_replay(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
):
    ciphertext, nonce = encrypt_optional_token("telegram-provider-token")
    account = ChannelAccount(
        id=uuid4(),
        encrypted_provider_token=ciphertext,
        provider_token_nonce=nonce,
    )
    link = ChannelBotAgentLink(
        id=uuid4(),
        status=BOT_AGENT_LINK_STATUS_ACTIVE,
        config={
            "telegram_agent_commands": {
                "default:": [
                    {"command": f"agent_{index}", "description": "Agent command"}
                    for index in range(98)
                ]
            }
        },
    )
    binding = ChannelBinding(
        id=uuid4(),
        bot_agent_link_id=link.id,
        external_chat_id="42",
        external_chat_type="private",
    )
    requests: list[httpx.Request] = []
    real_client = httpx.AsyncClient

    def provider_handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"ok": True, "result": True})

    transport = httpx.MockTransport(provider_handler)

    def client_factory(*_args: object, **_kwargs: object) -> httpx.AsyncClient:
        return real_client(transport=transport)

    async def allow_test_url(_url: str, *, label: str) -> None:
        assert label == "telegram api base url"

    monkeypatch.setattr(telegram_router.httpx, "AsyncClient", client_factory)
    monkeypatch.setattr(telegram_router, "validate_channel_http_url", allow_test_url)
    db = AsyncMock(spec=AsyncSession)
    db.get.return_value = link

    assert await telegram_router._clear_telegram_commands_for_binding(
        account=account,
        link=link,
        binding=binding,
    )
    await telegram_router._replay_telegram_commands_on_pair(
        db,
        account=account,
        binding=binding,
    )

    assert [request.url.path.rsplit("/", 1)[-1] for request in requests] == ["deleteMyCommands"]
    assert json.loads(requests[0].content) == {"scope": {"type": "chat", "chat_id": "42"}}
    assert "telegram_pair_command_replay_skipped_oversized_projection" in caplog.text


@pytest.mark.asyncio
async def test_telegram_set_my_commands_fans_out_to_bound_chats(
    client: httpx.AsyncClient,
    monkeypatch,
):
    _reset_fake_provider_client({"ok": True, "result": True})
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-command-fanout",
        chat_id="42",
        chat_type="private",
    )
    await _pair_telegram_chat(
        client,
        created=created,
        chat_id="-100",
        update_id=2,
        chat_type="group",
    )
    await _pair_telegram_chat(
        client,
        created=created,
        chat_id="-200",
        update_id=3,
        chat_type="supergroup",
    )
    await _pair_telegram_chat(client, created=created, chat_id="99", update_id=4)

    response = await client.post(
        _telegram_bot_path(created, "setMyCommands"),
        headers=_telegram_agent_headers(created),
        json={"commands": [{"command": "start", "description": "Start"}]},
    )

    assert response.status_code == 200
    assert response.json() == {"ok": True, "result": True}
    assert {
        (call["json"]["scope"]["chat_id"], call["json"]["scope"]["type"])
        for call in _FakeProviderClient.calls
    } == {
        ("42", "chat"),
        ("-100", "chat_administrators"),
        ("-100", "chat"),
        ("-200", "chat_administrators"),
        ("-200", "chat"),
        ("99", "chat"),
    }
    assert all(
        call["url"].endswith("/bot123456:telegram-secret/setMyCommands")
        for call in _FakeProviderClient.calls
    )

    _FakeProviderClient.calls = []
    private_scope = await client.post(
        _telegram_bot_path(created, "setMyCommands"),
        headers=_telegram_agent_headers(created),
        json={
            "commands": [{"command": "private", "description": "Private"}],
            "scope": {"type": "all_private_chats"},
        },
    )

    assert private_scope.status_code == 200
    assert {call["json"]["scope"]["chat_id"] for call in _FakeProviderClient.calls} == {"42", "99"}

    _FakeProviderClient.calls = []
    group_scope = await client.post(
        _telegram_bot_path(created, "setMyCommands"),
        headers=_telegram_agent_headers(created),
        json={
            "commands": [{"command": "group", "description": "Group"}],
            "scope": {"type": "all_group_chats"},
        },
    )

    assert group_scope.status_code == 200
    assert {
        (call["json"]["scope"]["chat_id"], call["json"]["scope"]["type"])
        for call in _FakeProviderClient.calls
    } == {
        ("-100", "chat"),
        ("-100", "chat_administrators"),
        ("-200", "chat"),
        ("-200", "chat_administrators"),
    }

    _FakeProviderClient.calls = []
    admin_scope = await client.post(
        _telegram_bot_path(created, "setMyCommands"),
        headers=_telegram_agent_headers(created),
        json={
            "commands": [{"command": "admin", "description": "Admin"}],
            "scope": {"type": "all_chat_administrators"},
        },
    )

    assert admin_scope.status_code == 200
    assert {
        (call["json"]["scope"]["chat_id"], call["json"]["scope"]["type"])
        for call in _FakeProviderClient.calls
    } == {("-100", "chat_administrators"), ("-200", "chat_administrators")}


@pytest.mark.asyncio
async def test_telegram_delete_my_commands_projects_documented_fallback(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"ok": True, "result": True})
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-command-delete-fallback",
        chat_id="42",
        chat_type="private",
    )
    headers = _telegram_agent_headers(created)
    path = _telegram_bot_path(created, "setMyCommands")

    async def set_commands(command: str, **params: Any) -> None:
        response = await client.post(
            path,
            headers=headers,
            json={
                "commands": [{"command": command, "description": command}],
                **params,
            },
        )
        assert response.status_code == 200

    await set_commands("default")
    await set_commands("default_es", language_code="es")
    await set_commands("private_es", scope={"type": "all_private_chats"}, language_code="es")
    await set_commands("chat", scope={"type": "chat", "chat_id": "42"})

    _clear_fake_provider_calls()
    deleted_chat = await client.post(
        _telegram_bot_path(created, "deleteMyCommands"),
        headers=headers,
        json={"scope": {"type": "chat", "chat_id": "42"}},
    )

    assert deleted_chat.status_code == 200
    projections = {
        call["json"].get("language_code", ""): call["json"]["commands"][3]["command"]
        for call in _FakeProviderClient.calls
        if call["url"].endswith("/setMyCommands")
    }
    assert projections == {"": "default", "es": "private_es"}

    _clear_fake_provider_calls()
    deleted_private_es = await client.post(
        _telegram_bot_path(created, "deleteMyCommands"),
        headers=headers,
        json={"scope": {"type": "all_private_chats"}, "language_code": "es"},
    )
    assert deleted_private_es.status_code == 200
    es_projection = next(
        call["json"]
        for call in _FakeProviderClient.calls
        if call["url"].endswith("/setMyCommands") and call["json"].get("language_code") == "es"
    )
    assert es_projection["commands"][3]["command"] == "default_es"

    _clear_fake_provider_calls()
    deleted_default_es = await client.post(
        _telegram_bot_path(created, "deleteMyCommands"),
        headers=headers,
        json={"language_code": "es"},
    )
    assert deleted_default_es.status_code == 200
    assert [
        call["json"]
        for call in _FakeProviderClient.calls
        if call["url"].endswith("/deleteMyCommands")
    ] == [{"scope": {"type": "chat", "chat_id": "42"}, "language_code": "es"}]


@pytest.mark.asyncio
async def test_telegram_set_my_commands_rejects_projection_over_provider_limit(
    client: httpx.AsyncClient,
):
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-command-provider-limit",
        chat_id="42",
        provider_token=None,
    )

    response = await client.post(
        _telegram_bot_path(created, "setMyCommands"),
        headers=_telegram_agent_headers(created),
        json={
            "commands": [
                {"command": f"agent_{index}", "description": "Agent command"} for index in range(98)
            ]
        },
    )

    assert response.status_code == 400
    assert response.json()["description"] == (
        "Bad Request: merged command list exceeds 100 commands"
    )


@pytest.mark.asyncio
async def test_telegram_pairing_replays_stored_broad_scope_commands(
    client: httpx.AsyncClient,
    monkeypatch,
):
    _reset_fake_provider_client({"ok": True, "result": True})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-command-replay-on-pair",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    commands = [{"command": "welcome", "description": "Say hi"}]
    stored = await client.post(
        _telegram_bot_path(created, "setMyCommands"),
        headers=_telegram_agent_headers(created),
        json={"commands": commands},
    )
    assert stored.status_code == 200
    _reset_fake_provider_client({"ok": True, "result": True})

    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    paired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 51,
            "message": {
                "message_id": 51,
                "text": f"/clawdi_pair {pair['code']}",
                "chat": {"id": 777, "type": "private"},
                "from": {"id": 777, "is_bot": False},
            },
        },
    )

    assert paired.status_code == 200
    assert paired.json()["paired"] is True
    command_calls = [
        call
        for call in _FakeProviderClient.calls
        if call["url"].endswith("/setMyCommands") and "scope" in call["json"]
    ]
    assert len(command_calls) == 1
    assert command_calls[0]["json"] == {
        "commands": [*telegram_router._TELEGRAM_RESERVED_COMMANDS, *commands],
        "scope": {"type": "chat", "chat_id": "777"},
    }


@pytest.mark.asyncio
async def test_telegram_repair_and_unpair_clear_previous_link_commands(
    client: httpx.AsyncClient,
    channel_agent,
    second_channel_agent,
    monkeypatch,
):
    _reset_fake_provider_client({"ok": True, "result": True})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-command-repair-isolation",
                "provider_token": "123456:telegram-secret",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    await _pair_telegram_chat(client, created=created, chat_id="777", chat_type="private")
    first_commands = [{"command": "first", "description": "First link"}]
    assert (
        await client.post(
            _telegram_bot_path(created, "setMyCommands"),
            headers=_telegram_agent_headers(created),
            json={"commands": first_commands},
        )
    ).status_code == 200
    assert (
        await client.post(
            _telegram_bot_path(created, "setMyCommands"),
            headers=_telegram_agent_headers(created),
            json={"commands": first_commands, "language_code": "es"},
        )
    ).status_code == 200
    assert (
        await client.post(
            _telegram_bot_path(created, "setMyCommands"),
            headers=_telegram_agent_headers(created),
            json={
                "commands": first_commands,
                "scope": {"type": "chat_member", "chat_id": "777", "user_id": "4242"},
            },
        )
    ).status_code == 200
    _reset_fake_provider_client({"ok": True, "result": True})
    assert (
        await client.delete(f"/v1/channels/{created['id']}/agent-links/{created['agent_link_id']}")
    ).status_code == 204
    unlink_command_calls = [
        call for call in _FakeProviderClient.calls if call["url"].endswith("/deleteMyCommands")
    ]
    assert {json.dumps(call["json"], sort_keys=True) for call in unlink_command_calls} == {
        json.dumps({"scope": {"type": "chat", "chat_id": "777"}}, sort_keys=True),
        json.dumps(
            {"scope": {"type": "chat", "chat_id": "777"}, "language_code": "es"},
            sort_keys=True,
        ),
        json.dumps(
            {"scope": {"type": "chat_member", "chat_id": "777", "user_id": "4242"}},
            sort_keys=True,
        ),
    }
    second = (
        await client.post(
            f"/v1/channels/{created['id']}/agent-links",
            json={"agent_id": str(second_channel_agent.id)},
        )
    ).json()
    second_pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"agent_link_id": second["id"], "ttl_seconds": 900},
        )
    ).json()

    _reset_fake_provider_client({"ok": True, "result": True})
    repaired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "message": {
                "message_id": 2,
                "from": {"id": 4242, "is_bot": False, "first_name": "Pairer"},
                "text": f"/clawdi_pair {second_pair['code']}",
                "chat": {"id": 777, "type": "private"},
            },
        },
    )

    assert repaired.status_code == 200
    assert repaired.json()["paired"] is True
    command_calls = [
        call
        for call in _FakeProviderClient.calls
        if call["url"].endswith(("/setMyCommands", "/deleteMyCommands"))
    ]
    assert command_calls == []
    second_get = await client.post(
        _telegram_bot_path(second, "getMyCommands", account_id=created["id"]),
        headers=_telegram_agent_headers(second),
        json={},
    )
    assert second_get.json()["result"] == [
        {"command": "clawdi_pair", "description": "Pair this chat with Clawdi."},
        {"command": "clawdi_unpair", "description": "Disconnect this chat from Clawdi."},
        {"command": "clawdi_help", "description": "Show safe Clawdi pairing instructions."},
    ]

    second_commands = [{"command": "second", "description": "Second link"}]
    _reset_fake_provider_client({"ok": True, "result": True})
    assert (
        await client.post(
            _telegram_bot_path(second, "setMyCommands", account_id=created["id"]),
            headers=_telegram_agent_headers(second),
            json={"commands": second_commands},
        )
    ).status_code == 200
    assert [
        call["json"] for call in _FakeProviderClient.calls if call["url"].endswith("/setMyCommands")
    ] == [
        {
            "commands": [*telegram_router._TELEGRAM_RESERVED_COMMANDS, *second_commands],
            "scope": {"type": "chat", "chat_id": "777"},
        }
    ]

    _reset_fake_provider_client({"ok": True, "result": True})
    unpaired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 3,
            "message": {
                "message_id": 3,
                "from": {"id": 4242, "is_bot": False, "first_name": "Pairer"},
                "text": "/clawdi_unpair",
                "chat": {"id": 777, "type": "private"},
            },
        },
    )
    assert unpaired.status_code == 200
    assert unpaired.json()["unpaired"] is True
    assert [
        call["json"]
        for call in _FakeProviderClient.calls
        if call["url"].endswith("/deleteMyCommands")
    ] == [{"scope": {"type": "chat", "chat_id": "777"}}]


@pytest.mark.asyncio
async def test_telegram_generic_bot_api_proxies_only_bound_chats(
    client: httpx.AsyncClient,
    monkeypatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 7}})
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-generic-proxy",
        chat_id="42",
    )
    await _pair_telegram_chat(client, created=created, chat_id="99", update_id=2)

    edit = await client.post(
        _telegram_bot_path(created, "editMessageText"),
        headers=_telegram_agent_headers(created),
        json={"chat_id": 42, "message_id": 1, "text": "edited"},
    )
    copy = await client.post(
        _telegram_bot_path(created, "copyMessage"),
        headers=_telegram_agent_headers(created),
        json={"chat_id": 42, "from_chat_id": 99, "message_id": 1},
    )
    blocked_reply = await client.post(
        _telegram_bot_path(created, "sendMessage"),
        headers=_telegram_agent_headers(created),
        json={
            "chat_id": 42,
            "text": "reply",
            "reply_parameters": {"chat_id": 100, "message_id": 1},
        },
    )
    no_chat = await client.post(
        _telegram_bot_path(created, "answerInlineQuery"),
        headers=_telegram_agent_headers(created),
        json={"inline_query_id": "inline-1", "results": []},
    )

    assert edit.status_code == 200
    assert edit.json()["ok"] is True
    assert copy.status_code == 200
    assert blocked_reply.status_code == 403
    assert (
        blocked_reply.json()["description"] == "Forbidden: referenced chat is not bound to this bot"
    )
    assert no_chat.status_code == 403
    assert no_chat.json()["description"] == "Forbidden: method is not available to this bot"
    assert _FakeProviderClient.calls[0]["url"].endswith(
        "/bot123456:telegram-secret/editMessageText"
    )
    assert json.loads(_FakeProviderClient.calls[0]["content"].decode("utf-8"))["chat_id"] == 42


@pytest.mark.asyncio
async def test_telegram_ordinary_requests_preserve_raw_payload_query_and_content_type(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 7}})
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-opaque-provider-payloads",
        chat_id="42",
    )
    raw_json = (
        b'{  "chat_id" : 42, "text":"json", "future_hint":"first", '
        b'"future_hint":"second", "future_payload":{"type":"first","type":"second"} }\n'
    )
    raw_form = b"chat_id=42&text=form+body&future_hint=%2f&future_hint=second&empty="
    raw_query = "chat_id=42&text=query+body&future_hint=%2f&future_hint=second&empty="

    json_response = await client.post(
        _telegram_bot_path(created, "sendMessage"),
        headers={**_telegram_agent_headers(created), "content-type": "application/json"},
        content=raw_json,
    )
    form_response = await client.post(
        _telegram_bot_path(created, "sendMessage"),
        headers={
            **_telegram_agent_headers(created),
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        content=raw_form,
    )
    query_response = await client.get(
        f"{_telegram_bot_path(created, 'sendMessage')}?{raw_query}",
        headers=_telegram_agent_headers(created),
    )

    assert json_response.status_code == 200
    assert form_response.status_code == 200
    assert query_response.status_code == 200
    assert _FakeProviderClient.calls[0]["content"] == raw_json
    assert _FakeProviderClient.calls[0]["headers"]["content-type"] == "application/json"
    assert _FakeProviderClient.calls[1]["content"] == raw_form
    assert _FakeProviderClient.calls[1]["headers"]["content-type"] == (
        "application/x-www-form-urlencoded; charset=UTF-8"
    )
    assert _FakeProviderClient.calls[2]["url"].endswith(f"/sendMessage?{raw_query}")


@pytest.mark.asyncio
async def test_telegram_private_and_forum_thread_methods_preserve_message_thread_id(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"ok": True, "result": True})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-native-private-forum-topics",
        chat_id="42",
        chat_type="private",
    )
    await _pair_telegram_chat(
        client,
        created=created,
        chat_id="-10042",
        update_id=2,
        chat_type="supergroup",
    )
    _reset_fake_provider_client({"ok": True, "result": True})
    json_requests = (
        (
            "sendMessageDraft",
            b'{ "chat_id": 42, "message_thread_id": 7, "draft_id": 1, "text": "draft" }\n',
        ),
        (
            "sendChatAction",
            b'{ "chat_id": 42, "message_thread_id": 7, "action": "typing" }\n',
        ),
        (
            "sendMessage",
            b'{ "chat_id": -10042, "message_thread_id": 9, "text": "forum" }\n',
        ),
        (
            "sendChatAction",
            b'{ "chat_id": -10042, "message_thread_id": 9, "action": "typing" }\n',
        ),
    )

    for method, body in json_requests:
        response = await client.post(
            _telegram_bot_path(created, method),
            headers={**_telegram_agent_headers(created), "content-type": "application/json"},
            content=body,
        )
        assert response.status_code == 200

    private_form = b"chat_id=42&message_thread_id=8&action=typing&future_hint=preserved"
    form_response = await client.post(
        _telegram_bot_path(created, "sendChatAction"),
        headers={
            **_telegram_agent_headers(created),
            "content-type": "application/x-www-form-urlencoded",
        },
        content=private_form,
    )
    ordinary_private = b'{ "chat_id": 42, "action": "typing", "future_hint": true }\n'
    ordinary_response = await client.post(
        _telegram_bot_path(created, "sendChatAction"),
        headers={**_telegram_agent_headers(created), "content-type": "application/json"},
        content=ordinary_private,
    )
    assert form_response.status_code == 200
    assert ordinary_response.status_code == 200

    assert [call["content"] for call in _FakeProviderClient.calls] == [
        *[body for _method, body in json_requests],
        private_form,
        ordinary_private,
    ]
    assert [call["url"].rsplit("/", 1)[-1] for call in _FakeProviderClient.calls] == [
        *[method for method, _body in json_requests],
        "sendChatAction",
        "sendChatAction",
    ]
    assert all(
        b"direct_messages_topic_id" not in call["content"] for call in _FakeProviderClient.calls
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("content", "query"),
    [
        (b'{"chat_id":42,"chat_id":99,"text":"ambiguous"}', None),
        (
            b'{"chat_id":42,"text":"ambiguous",'
            b'"reply_parameters":{"chat_id":42,"chat_id":99,"message_id":1}}',
            None,
        ),
        (None, "chat_id=42&chat_id=99&text=ambiguous"),
    ],
)
async def test_telegram_duplicate_authority_fields_are_rejected(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    content: bytes | None,
    query: str | None,
):
    _reset_fake_provider_client({"ok": True, "result": True})
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-duplicate-authority",
        chat_id="42",
    )
    if query is not None:
        response = await client.get(
            f"{_telegram_bot_path(created, 'sendMessage')}?{query}",
            headers=_telegram_agent_headers(created),
        )
    else:
        response = await client.post(
            _telegram_bot_path(created, "sendMessage"),
            headers={**_telegram_agent_headers(created), "content-type": "application/json"},
            content=content,
        )

    assert response.status_code == 400
    assert response.json()["description"].startswith("Bad Request: duplicate parameter")
    assert _FakeProviderClient.calls == []


@pytest.mark.asyncio
async def test_telegram_multipart_reply_parameters_are_scope_checked(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"ok": True, "result": True})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-multipart-scope",
        chat_id="42",
    )

    response = await client.post(
        _telegram_bot_path(created, "sendPhoto"),
        headers=_telegram_agent_headers(created),
        data={
            "chat_id": "42",
            "caption": "photo",
            "reply_parameters": json.dumps({"chat_id": 99, "message_id": 7}),
        },
        files={"photo": ("photo.png", b"PNGDATA", "image/png")},
    )

    assert response.status_code == 403
    assert response.json()["description"] == "Forbidden: referenced chat is not bound to this bot"


@pytest.mark.asyncio
async def test_telegram_native_attach_multipart_is_forwarded_byte_for_byte_and_recorded(
    client: httpx.AsyncClient,
    monkeypatch,
):
    _reset_fake_provider_client(
        {
            "ok": True,
            "result": {
                "message_id": 7,
                "photo": [
                    {"file_id": "uploaded-photo-small"},
                    {"file_id": "uploaded-photo"},
                ],
            },
        }
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-native-attach",
        chat_id="42",
    )
    boundary = "telegram-native-boundary"
    content_type = f'multipart/form-data; boundary="{boundary}"'
    multipart_body = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="chat_id"\r\n\r\n'
        "42\r\n"
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="photo"\r\n\r\n'
        "attach://photo_file\r\n"
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="future_caption_style"\r\n\r\n'
        "future-value\r\n"
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="photo_file"; filename="photo.png"\r\n'
        "Content-Type: image/png\r\n\r\n"
        "PNGDATA\r\n"
        f"--{boundary}--\r\n"
    ).encode("ascii")

    response = await client.post(
        _telegram_bot_path(created, "sendPhoto"),
        headers={**_telegram_agent_headers(created), "content-type": content_type},
        content=multipart_body,
    )

    assert response.status_code == 200
    assert _FakeProviderClient.calls[0]["content"] == multipart_body
    assert _FakeProviderClient.calls[0]["headers"]["content-type"] == content_type

    _reset_fake_provider_client({"ok": True, "result": {"message_id": 8}})
    reuse = await client.post(
        _telegram_bot_path(created, "sendPhoto"),
        headers=_telegram_agent_headers(created),
        json={"chat_id": "42", "photo": "uploaded-photo"},
    )

    assert reuse.status_code == 200
    assert len(_FakeProviderClient.calls) == 1


@pytest.mark.asyncio
async def test_telegram_proxy_releases_transaction_during_provider_io(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"ok": True, "result": True})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-provider-transaction",
        chat_id="42",
    )

    class TransactionObservingProviderClient(_FakeProviderClient):
        fail = False
        transaction_states: list[bool] = []

        async def request(self, method, url, **kwargs):
            self.transaction_states.append(db_session.in_transaction())
            assert self.transaction_states[-1] is False
            if self.fail:
                raise httpx.ConnectError("network down")
            return await super().request(method, url, **kwargs)

    _reset_fake_provider_client(
        {
            "ok": True,
            "result": {
                "message_id": 71,
                "chat": {"id": 42, "type": "private"},
                "document": {"file_id": "transaction-safe-file"},
            },
        }
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        TransactionObservingProviderClient,
    )
    await channel_service.close_channel_provider_http_client()

    sent = await client.post(
        _telegram_bot_path(created, "sendDocument"),
        headers=_telegram_agent_headers(created),
        json={"chat_id": "42", "document": "https://example.test/report.pdf"},
    )

    assert sent.status_code == 200
    assert TransactionObservingProviderClient.transaction_states == [False]
    assert not db_session.in_transaction()
    references = set(
        await db_session.scalars(
            select(ChannelAgentReference.ref_value).where(
                ChannelAgentReference.account_id == UUID(created["id"]),
                ChannelAgentReference.ref_value.in_(
                    {"transaction-safe-file", telegram_message_reference_value("42", 71)}
                ),
            )
        )
    )
    assert references == {
        "transaction-safe-file",
        telegram_message_reference_value("42", 71),
    }
    await db_session.rollback()

    TransactionObservingProviderClient.fail = True
    failed = await client.post(
        _telegram_bot_path(created, "sendChatAction"),
        headers=_telegram_agent_headers(created),
        json={"chat_id": "42", "action": "typing"},
    )

    assert failed.status_code == 502
    assert TransactionObservingProviderClient.transaction_states == [False, False]
    assert not db_session.in_transaction()


@pytest.mark.asyncio
async def test_telegram_successful_send_survives_reference_recording_failure(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
):
    provider_payload = {
        "ok": True,
        "result": {
            "message_id": 71,
            "chat": {"id": 42, "type": "private"},
            "document": {"file_id": "telegram-file-before-recording-failure"},
        },
    }
    provider_body = (
        b'{  "ok" : true, "result" : { "message_id" : 71, '
        b'"chat" : {"id":42,"type":"private"}, '
        b'"document":{"file_id":"telegram-file-before-recording-failure"} } }\n'
    )
    provider_headers = {
        "content-type": "application/json; charset=utf-8",
        "content-length": str(len(provider_body)),
        "retry-after": "3",
        "x-ratelimit-remaining": "9",
        "x-request-id": "telegram-send-recording-request",
        "x-correlation-id": "telegram-send-recording-correlation",
    }
    _reset_fake_provider_client(
        provider_payload,
        content=provider_body,
        headers=provider_headers,
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-send-recording-failure",
        chat_id="42",
    )
    recording_calls = 0

    async def fail_second_reference_recording(db: AsyncSession, **kwargs):
        nonlocal recording_calls
        recording_calls += 1
        if recording_calls == 2:
            await db.execute(text("SELECT * FROM telegram_missing_reference_recording_table"))
        return await channel_service.record_channel_agent_reference(db, **kwargs)

    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.record_channel_agent_reference",
        fail_second_reference_recording,
    )

    response = await client.post(
        _telegram_bot_path(created, "sendDocument"),
        headers=_telegram_agent_headers(created),
        json={"chat_id": "42", "document": "https://example.test/report.pdf"},
    )

    assert response.status_code == 200
    assert response.content == provider_body
    assert response.headers["content-type"] == provider_headers["content-type"]
    assert response.headers["content-length"] == provider_headers["content-length"]
    assert response.headers["retry-after"] == provider_headers["retry-after"]
    assert response.headers["x-ratelimit-remaining"] == provider_headers["x-ratelimit-remaining"]
    assert response.headers["x-telegram-request-id"] == provider_headers["x-request-id"]
    assert response.headers["x-request-id"] != provider_headers["x-request-id"]
    assert response.headers["x-correlation-id"] == provider_headers["x-correlation-id"]
    assert recording_calls == 2
    recorded_reference = (
        await db_session.execute(
            select(ChannelAgentReference.id).where(
                ChannelAgentReference.account_id == UUID(created["id"]),
                ChannelAgentReference.ref_value == "telegram-file-before-recording-failure",
            )
        )
    ).scalar_one_or_none()
    assert recorded_reference is None
    assert (await db_session.execute(select(1))).scalar_one() == 1
    assert "telegram_reference_recording_failed" in caplog.text
    assert f"account_id={created['id']}" in caplog.text
    assert "method=sendDocument" in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize("provider_status", [200, 400])
async def test_telegram_failed_outbound_response_does_not_grant_file_reference(
    client: httpx.AsyncClient,
    monkeypatch,
    provider_status: int,
):
    _reset_fake_provider_client({"ok": True, "result": True})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name=f"telegram-failed-upload-ref-{provider_status}",
        chat_id="42",
    )
    _reset_fake_provider_client(
        {
            "ok": False,
            "error_code": 400,
            "description": "Bad Request: upload failed",
            "result": {"document": {"file_id": "failed-upload-file"}},
        },
        status_code=provider_status,
    )

    failed = await client.post(
        _telegram_bot_path(created, "sendDocument"),
        headers=_telegram_agent_headers(created),
        data={"chat_id": "42"},
        files={"document": ("report.pdf", b"PDFDATA", "application/pdf")},
    )
    assert failed.status_code == provider_status
    assert failed.json()["ok"] is False
    assert len(_FakeProviderClient.calls) == 1

    _reset_fake_provider_client({"ok": True, "result": {"message_id": 8}})
    reuse = await client.post(
        _telegram_bot_path(created, "sendDocument"),
        headers=_telegram_agent_headers(created),
        json={"chat_id": "42", "document": "failed-upload-file"},
    )

    assert reuse.status_code == 403
    assert reuse.json()["description"] == "Forbidden: file_id is not bound to this bot"
    assert _FakeProviderClient.calls == []


@pytest.mark.asyncio
async def test_telegram_send_methods_are_rate_limited(
    client: httpx.AsyncClient,
    monkeypatch,
):
    telegram_rate_limiter.reset()
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 7}})
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-rate-limit",
        chat_id="42",
    )

    for index in range(5):
        response = await client.post(
            _telegram_bot_path(created, "sendMessage"),
            headers=_telegram_agent_headers(created),
            json={"chat_id": 42, "text": f"msg{index}"},
        )
        assert response.status_code == 200

    limited = await client.post(
        _telegram_bot_path(created, "sendMessage"),
        headers=_telegram_agent_headers(created),
        json={"chat_id": 42, "text": "overflow"},
    )

    assert limited.status_code == 429
    assert limited.json()["ok"] is False
    assert limited.json()["parameters"]["retry_after"] >= 1


@pytest.mark.asyncio
async def test_telegram_delete_webhook_drop_pending_updates(client: httpx.AsyncClient):
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-drop-pending",
        chat_id="42",
        provider_token=None,
    )
    await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "message": {
                "message_id": 2,
                "text": "queued",
                "chat": {"id": 42, "type": "private"},
            },
        },
    )
    await client.post(
        _telegram_bot_path(created, "setWebhook"),
        headers=_telegram_agent_headers(created),
        json={"url": "https://agent.example/webhook"},
    )

    deleted = await client.post(
        _telegram_bot_path(created, "deleteWebhook"),
        headers=_telegram_agent_headers(created),
        json={"drop_pending_updates": True},
    )
    updates = await client.get(
        _telegram_bot_path(created, "getUpdates"), headers=_telegram_agent_headers(created)
    )

    assert deleted.status_code == 200
    assert updates.status_code == 200
    assert updates.json() == {"ok": True, "result": []}


@pytest.mark.asyncio
async def test_telegram_agent_webhook_success_acks_inbox(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    _reset_sequenced_provider_client([200])
    monkeypatch.setattr(
        "app.services.channel_webhooks.SafePublicHttpClient",
        _SequencedProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-agent-webhook-ack",
        provider_token=None,
    )
    set_webhook = await client.post(
        _telegram_bot_path(created, "setWebhook"),
        headers=_telegram_agent_headers(created),
        json={"url": "https://agent.example/agent-hook", "secret_token": "agent-secret"},
    )

    inbound = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 901,
            "message": {
                "message_id": 901,
                "text": "deliver to agent",
                "chat": {"id": 42, "type": "private"},
            },
        },
    )

    message = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.provider_message_id == "901")
        )
    ).scalar_one()
    assert set_webhook.status_code == 200
    assert inbound.status_code == 200
    assert message.delivered_at is not None
    assert _SequencedProviderClient.calls[0]["headers"] == {
        "X-Telegram-Bot-Api-Secret-Token": "agent-secret"
    }
    assert _SequencedProviderClient.calls[0]["json"]["message"]["text"] == "deliver to agent"


@pytest.mark.asyncio
async def test_telegram_agent_webhook_5xx_defers_ack_to_worker(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    _reset_sequenced_provider_client([503, 200])
    monkeypatch.setattr(
        "app.services.channel_webhooks.SafePublicHttpClient",
        _SequencedProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-agent-webhook-retry-5xx",
        provider_token=None,
    )
    await client.post(
        _telegram_bot_path(created, "setWebhook"),
        headers=_telegram_agent_headers(created),
        json={"url": "https://agent.example/agent-hook"},
    )

    inbound = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 907,
            "message": {
                "message_id": 907,
                "text": "retry 5xx immediately",
                "chat": {"id": 42, "type": "private"},
            },
        },
    )

    message = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.provider_message_id == "907")
        )
    ).scalar_one()
    assert inbound.status_code == 200
    assert message.delivered_at is None
    assert len(_SequencedProviderClient.calls) == 1

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    result = await ChannelWebhookDeliveryWorker(sessionmaker).run_once()
    await db_session.refresh(message)

    assert result is not None
    assert result.message_id == message.id
    assert result.delivered is True
    assert message.delivered_at is not None
    assert len(_SequencedProviderClient.calls) == 2


@pytest.mark.asyncio
async def test_telegram_update_redelivery_retries_failed_agent_webhook(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    _reset_sequenced_provider_client([503, 200])
    monkeypatch.setattr(
        "app.services.channel_webhooks.SafePublicHttpClient",
        _SequencedProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-redelivery-retry",
        provider_token=None,
    )
    await client.post(
        _telegram_bot_path(created, "setWebhook"),
        headers=_telegram_agent_headers(created),
        json={"url": "https://agent.example/agent-hook"},
    )
    payload = {
        "update_id": 909,
        "message": {
            "message_id": 77,
            "text": "retry identical update",
            "chat": {"id": 42, "type": "private"},
        },
    }
    webhook_url = f"/v1/channels/telegram/{created['id']}/webhook"
    headers = {"x-telegram-bot-api-secret-token": created["webhook_secret"]}

    first = await client.post(webhook_url, headers=headers, json=payload)
    redelivery = await client.post(webhook_url, headers=headers, json=payload)
    messages = list(
        (
            await db_session.execute(
                select(ChannelMessage).where(
                    ChannelMessage.account_id == UUID(created["id"]),
                    ChannelMessage.provider_event_id == "update:909",
                )
            )
        ).scalars()
    )

    assert first.status_code == 200
    assert redelivery.status_code == 200
    assert len(messages) == 1
    assert messages[0].provider_message_id == "77"
    assert messages[0].delivered_at is None
    assert len(_SequencedProviderClient.calls) == 1

    # Production webhook requests close their scoped session after the
    # redelivery response. Mirror that boundary before the independent worker
    # tries to acquire the Binding delivery fence.
    await db_session.rollback()
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    result = await ChannelWebhookDeliveryWorker(sessionmaker).run_once()
    await db_session.refresh(messages[0])

    assert result is not None
    assert result.message_id == messages[0].id
    assert result.delivered is True
    assert messages[0].delivered_at is not None
    assert len(_SequencedProviderClient.calls) == 2


@pytest.mark.asyncio
async def test_telegram_agent_webhook_inactive_link_records_debug_health(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    _reset_sequenced_provider_client([200])
    monkeypatch.setattr(
        "app.services.channel_webhooks.SafePublicHttpClient",
        _SequencedProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-agent-webhook-inactive-link",
        chat_id="4301",
        provider_token=None,
    )
    await client.post(
        _telegram_bot_path(created, "setWebhook"),
        headers=_telegram_agent_headers(created),
        json={"url": "https://agent.example/agent-hook"},
    )
    link = await db_session.get(ChannelBotAgentLink, UUID(created["agent_link_id"]))
    assert link is not None
    link.status = "archived"
    link.archived_at = datetime.now(UTC)
    await db_session.commit()

    inbound = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 908,
            "message": {
                "message_id": 908,
                "text": "link is inactive",
                "chat": {"id": 4301, "type": "private"},
            },
        },
    )
    message = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.provider_message_id == "908")
        )
    ).scalar_one()
    health_response = await client.get("/v1/channels/health")
    activity_response = await client.get(
        f"/v1/channels/{created['id']}/activity",
        params={"external_chat_id": "4301", "limit": 20},
    )

    assert inbound.status_code == 200
    assert message.delivered_at is None
    assert _SequencedProviderClient.calls == []
    assert health_response.status_code == 200, health_response.text
    health = next(
        item for item in health_response.json()["items"] if item["account_id"] == created["id"]
    )
    assert health["health_status"] == "error"
    assert "pending_inbox" not in health["reasons"]
    assert "recent_error" in health["reasons"]
    assert health["pending_inbox"] == 0
    assert health["last_error"] == "channel_operation_failed"
    assert health["last_error_stage"] == "agent_webhook"
    assert health["last_error_outcome"] == "failure"
    assert activity_response.status_code == 200, activity_response.text
    debug_item = next(
        item for item in activity_response.json()["items"] if item["kind"] == "debug_event"
    )
    assert debug_item["stage"] == "agent_webhook"
    assert debug_item["outcome"] == "failure"
    assert debug_item["error"] == "channel_operation_failed"
    assert debug_item["details"]["reason"] == "link_archived"
    assert debug_item["details"]["bot_agent_link_id"] == created["agent_link_id"]
    assert debug_item["details"]["bot_agent_link_status"] == "archived"


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_status", [302, 403])
async def test_telegram_agent_webhook_non_2xx_does_not_ack_inbox(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    failure_status: int,
):
    _reset_sequenced_provider_client([failure_status, 200])
    monkeypatch.setattr(
        "app.services.channel_webhooks.SafePublicHttpClient",
        _SequencedProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-agent-webhook-4xx",
        provider_token=None,
    )
    set_webhook = await client.post(
        _telegram_bot_path(created, "setWebhook"),
        headers=_telegram_agent_headers(created),
        json={"url": "https://agent.example/agent-hook", "secret_token": "agent-secret"},
    )

    inbound = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 904,
            "message": {
                "message_id": 904,
                "text": "do not ack 4xx",
                "chat": {"id": 42, "type": "private"},
            },
        },
    )

    message = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.provider_message_id == "904")
        )
    ).scalar_one()
    assert set_webhook.status_code == 200
    assert inbound.status_code == 200
    assert message.delivered_at is None

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    result = await ChannelWebhookDeliveryWorker(sessionmaker).run_once()
    await db_session.refresh(message)

    assert result is not None
    assert result.message_id == message.id
    assert result.delivered is True
    assert message.delivered_at is not None
    assert len(_SequencedProviderClient.calls) == 2


@pytest.mark.asyncio
async def test_telegram_agent_webhook_revalidates_dns_at_delivery(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    resolutions = [
        ("8.8.8.8", 0),
        ("10.0.0.5", 0),
    ]

    def fake_getaddrinfo(host, port, *_args):
        assert host == "agent-hook.example"
        assert port == 443
        address = resolutions.pop(0)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", address)]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-agent-webhook-dns-revalidate",
        provider_token=None,
    )
    set_webhook = await client.post(
        _telegram_bot_path(created, "setWebhook"),
        headers=_telegram_agent_headers(created),
        json={"url": "https://agent-hook.example/agent-hook"},
    )

    inbound = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 905,
            "message": {
                "message_id": 905,
                "text": "dns rebind",
                "chat": {"id": 42, "type": "private"},
            },
        },
    )

    message = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.provider_message_id == "905")
        )
    ).scalar_one()
    assert set_webhook.status_code == 200
    assert inbound.status_code == 200
    assert message.delivered_at is None
    assert _FakeProviderClient.calls == []


@pytest.mark.asyncio
async def test_telegram_webhook_worker_retries_failed_agent_delivery(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    _reset_sequenced_provider_client([503, 503, 503, 200])
    monkeypatch.setattr(
        "app.services.channel_webhooks.SafePublicHttpClient",
        _SequencedProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-agent-webhook-retry",
        provider_token=None,
    )
    await client.post(
        _telegram_bot_path(created, "setWebhook"),
        headers=_telegram_agent_headers(created),
        json={"url": "https://agent.example/agent-hook", "secret_token": "agent-secret"},
    )
    await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 902,
            "message": {
                "message_id": 902,
                "text": "retry to agent",
                "chat": {"id": 42, "type": "private"},
            },
        },
    )
    message = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.provider_message_id == "902")
        )
    ).scalar_one()
    assert message.delivered_at is None

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    worker = ChannelWebhookDeliveryWorker(sessionmaker)
    results = []
    for _ in range(3):
        await db_session.execute(
            update(ChannelBinding)
            .where(ChannelBinding.id == message.binding_id)
            .values(webhook_retry_at=None)
        )
        await db_session.commit()
        results.append(await worker.run_once())
    first_result, second_result, result = results
    await db_session.refresh(message)

    assert first_result is not None
    assert first_result.message_id == message.id
    assert first_result.delivered is False
    assert second_result is not None
    assert second_result.message_id == message.id
    assert second_result.delivered is False
    assert result is not None
    assert result.message_id == message.id
    assert result.delivered is True
    assert message.delivered_at is not None
    assert len(_SequencedProviderClient.calls) == 4


@pytest.mark.asyncio
async def test_telegram_webhook_worker_does_not_retry_after_unpair(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _reset_sequenced_provider_client([503])
    monkeypatch.setattr(
        "app.services.channel_webhooks.SafePublicHttpClient",
        _SequencedProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-agent-webhook-unpair-revokes-retry",
        provider_token=None,
    )
    assert (
        await client.post(
            _telegram_bot_path(created, "setWebhook"),
            headers=_telegram_agent_headers(created),
            json={"url": "https://agent.example/agent-hook"},
        )
    ).status_code == 200
    inbound = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 9_021,
            "message": {
                "message_id": 9_021,
                "text": "must not retry after unpair",
                "chat": {"id": 42, "type": "private"},
                "from": {"id": 4242, "is_bot": False},
            },
        },
    )
    message = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.provider_event_id == "update:9021")
        )
    ).scalar_one()
    assert inbound.status_code == 200
    assert message.delivered_at is None
    assert len(_SequencedProviderClient.calls) == 1

    unpaired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 9_022,
            "message": {
                "message_id": 9_022,
                "text": "/clawdi_unpair",
                "chat": {"id": 42, "type": "private"},
                "from": {"id": 4242, "is_bot": False},
            },
        },
    )
    assert unpaired.status_code == 200
    assert unpaired.json()["unpaired"] is True
    await db_session.refresh(message)
    assert message.delivered_at is not None

    # Historical rows can predate revocation consumption. Even if one remains
    # pending, the worker must treat current binding authority as the fence.
    message.delivered_at = None
    await db_session.commit()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    assert await channel_service.pending_channel_inbox_count(db_session, account=account) == 0
    binding = await db_session.get(ChannelBinding, message.binding_id)
    assert binding is not None
    assert (
        await telegram_router._deliver_telegram_agent_webhook_for_binding(
            db_session,
            account=account,
            binding=binding,
            payload={"update_id": 9_021},
        )
        is False
    )

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    assert await ChannelWebhookDeliveryWorker(sessionmaker).run_once() is None
    assert len(_SequencedProviderClient.calls) == 1


@pytest.mark.asyncio
async def test_telegram_webhook_worker_skips_non_webhook_queue_head(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    channel_agent,
    second_channel_agent,
):
    _reset_sequenced_provider_client([503, 503, 503, 200])
    monkeypatch.setattr(
        "app.services.channel_webhooks.SafePublicHttpClient",
        _SequencedProviderClient,
    )
    polling_channel = await _create_paired_telegram_channel(
        client,
        name="telegram-worker-polling-queue-head",
        provider_token=None,
        chat_id="4201",
        agent_id=channel_agent.id,
    )
    webhook_channel = await _create_paired_telegram_channel(
        client,
        name="telegram-worker-webhook-behind-queue-head",
        provider_token=None,
        chat_id="4202",
        agent_id=second_channel_agent.id,
    )
    await client.post(
        _telegram_bot_path(webhook_channel, "setWebhook"),
        headers=_telegram_agent_headers(webhook_channel),
        json={"url": "https://agent.example/agent-hook"},
    )

    polling_binding = (
        await db_session.execute(
            select(ChannelBinding).where(
                ChannelBinding.account_id == UUID(polling_channel["id"]),
            )
        )
    ).scalar_one()
    for index in range(101):
        db_session.add(
            ChannelMessage(
                account_id=polling_binding.account_id,
                bot_agent_link_id=polling_binding.bot_agent_link_id,
                binding_id=polling_binding.id,
                user_id=polling_binding.user_id,
                direction=MESSAGE_DIRECTION_INBOUND,
                external_chat_id=polling_binding.external_chat_id,
                provider_message_id=f"polling-{index}",
                text="polling mode pending",
                payload={},
            )
        )
    await db_session.flush()

    inbound = await client.post(
        f"/v1/channels/telegram/{webhook_channel['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": webhook_channel["webhook_secret"]},
        json={
            "update_id": 906,
            "message": {
                "message_id": 906,
                "text": "behind polling queue",
                "chat": {"id": 4202, "type": "private"},
            },
        },
    )
    webhook_message = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.provider_message_id == "906")
        )
    ).scalar_one()
    assert inbound.status_code == 200
    assert webhook_message.delivered_at is None

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    worker = ChannelWebhookDeliveryWorker(sessionmaker)
    results = []
    for _ in range(3):
        await db_session.execute(
            update(ChannelBinding)
            .where(ChannelBinding.id == webhook_message.binding_id)
            .values(webhook_retry_at=None)
        )
        await db_session.commit()
        results.append(await worker.run_once())
    first_result, second_result, result = results
    await db_session.refresh(webhook_message)

    assert first_result is not None
    assert first_result.message_id == webhook_message.id
    assert first_result.delivered is False
    assert second_result is not None
    assert second_result.message_id == webhook_message.id
    assert second_result.delivered is False
    assert result is not None
    assert result.message_id == webhook_message.id
    assert result.delivered is True
    assert webhook_message.delivered_at is not None
    assert len(_SequencedProviderClient.calls) == 4


@pytest.mark.asyncio
async def test_telegram_webhook_worker_drops_expired_agent_delivery(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    _reset_sequenced_provider_client([503, 503, 503])
    monkeypatch.setattr(
        "app.services.channel_webhooks.SafePublicHttpClient",
        _SequencedProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-agent-webhook-ttl",
        provider_token=None,
    )
    await client.post(
        _telegram_bot_path(created, "setWebhook"),
        headers=_telegram_agent_headers(created),
        json={"url": "https://agent.example/agent-hook"},
    )
    await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 903,
            "message": {
                "message_id": 903,
                "text": "expire agent delivery",
                "chat": {"id": 42, "type": "private"},
            },
        },
    )
    message = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.provider_message_id == "903")
        )
    ).scalar_one()
    message.created_at = datetime.now(UTC) - timedelta(days=2)
    await db_session.commit()

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    result = await ChannelWebhookDeliveryWorker(sessionmaker, ttl_seconds=60).run_once()
    await db_session.refresh(message)

    assert result is not None
    assert result.message_id == message.id
    assert result.expired is True
    assert message.delivered_at is not None
    assert len(_SequencedProviderClient.calls) == 1


@pytest.mark.asyncio
async def test_telegram_callback_query_answer_requires_recorded_reference(
    client: httpx.AsyncClient,
    monkeypatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"callback_query_id": "cb-1"}})
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-callback-ref",
        chat_id="42",
    )
    await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "callback_query": {
                "id": "cb-1",
                "data": "approve",
                "message": {
                    "message_id": 2,
                    "chat": {"id": 42, "type": "private"},
                },
            },
        },
    )

    owned = await client.post(
        _telegram_bot_path(created, "answerCallbackQuery"),
        headers=_telegram_agent_headers(created),
        json={"callback_query_id": "cb-1", "text": "ok"},
    )
    unowned = await client.post(
        _telegram_bot_path(created, "answerCallbackQuery"),
        headers=_telegram_agent_headers(created),
        json={"callback_query_id": "cb-other", "text": "ok"},
    )

    assert owned.status_code == 200
    assert owned.json()["ok"] is True
    assert unowned.status_code == 403
    assert unowned.json()["description"] == "Forbidden: callback_query_id is not bound to this bot"


@pytest.mark.asyncio
@pytest.mark.parametrize("compact_encoded_path", [False, True], ids=["legacy", "sdk-encoded"])
async def test_telegram_get_file_records_path_and_download_is_scoped(
    client: httpx.AsyncClient,
    monkeypatch,
    compact_encoded_path: bool,
):
    _reset_fake_provider_client({"ok": True, "result": {"file_path": "photos/file_1.jpg"}})
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-file-ref",
        chat_id="42",
    )
    routing_id = channel_runtime_placeholder_token(
        CHANNEL_PROVIDER_TELEGRAM,
        channel_runtime_account_key(UUID(created["id"])),
    )
    managed_headers = {"Authorization": f"Bearer {created['agent_token']}"}
    await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "message": {
                "message_id": 2,
                "chat": {"id": 42, "type": "private"},
                "document": {"file_id": "file_1", "file_name": "report.pdf"},
            },
        },
    )

    get_file = await client.post(
        f"/v1/channels/telegram/bot/{routing_id}/getFile",
        headers=managed_headers,
        json={"file_id": "file_1"},
    )
    unowned_file = await client.post(
        f"/v1/channels/telegram/bot/{routing_id}/getFile",
        headers=managed_headers,
        json={"file_id": "file_other"},
    )
    _reset_fake_provider_client(
        {"ok": True},
        content=b"telegram-file",
        headers={"content-type": "text/plain"},
    )
    route = quote(routing_id, safe="") if compact_encoded_path else f"/{routing_id}"
    download_path = f"/v1/channels/telegram/file/bot{route}/photos/file_1.jpg"
    unowned_download_path = f"/v1/channels/telegram/file/bot{route}/photos/other.jpg"
    download = await client.get(download_path, headers=managed_headers)
    unowned_download = await client.get(unowned_download_path, headers=managed_headers)
    wrong_route = await client.get(
        f"/v1/channels/telegram/file/bot{route}-other/photos/file_1.jpg",
        headers=managed_headers,
    )
    rejected_old_secret_path = await client.get(
        f"/v1/channels/telegram/file/bot/{created['agent_token']}/photos/file_1.jpg"
    )

    assert get_file.status_code == 200
    assert get_file.json()["result"]["file_path"] == "photos/file_1.jpg"
    assert unowned_file.status_code == 403
    assert unowned_file.json()["description"] == "Forbidden: file_id is not bound to this bot"
    assert download.status_code == 200
    assert download.text == "telegram-file"
    assert created["agent_token"] not in download_path
    assert created["agent_token"] not in unowned_download_path
    assert rejected_old_secret_path.status_code == 401
    assert _FakeProviderClient.calls[0]["url"].endswith(
        "/file/bot123456:telegram-secret/photos/file_1.jpg"
    )
    assert unowned_download.status_code == 403
    assert unowned_download.json()["description"] == "Forbidden: file_path is not bound to this bot"
    assert wrong_route.status_code == 401
    if compact_encoded_path:
        double_encoded = await client.get(
            f"/v1/channels/telegram/file/bot{quote(route, safe='')}/photos/file_1.jpg",
            headers=managed_headers,
        )
        assert double_encoded.status_code == 401


@pytest.mark.asyncio
async def test_telegram_get_file_success_survives_path_recording_failure(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
):
    _reset_fake_provider_client({"ok": True, "result": True})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-get-file-recording-failure",
        chat_id="42",
    )
    inbound = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "message": {
                "message_id": 2,
                "chat": {"id": 42, "type": "private"},
                "document": {"file_id": "telegram-owned-file"},
            },
        },
    )
    assert inbound.status_code == 200
    provider_payload = {
        "ok": True,
        "result": {
            "file_id": "telegram-owned-file",
            "file_path": "documents/provider-success.dat",
        },
    }
    provider_body = (
        b'{ "ok" : true, "result" : {"file_id":"telegram-owned-file", '
        b'"file_path":"documents/provider-success.dat"} }\n'
    )
    provider_headers = {
        "content-type": "application/json; charset=utf-8",
        "content-length": str(len(provider_body)),
        "retry-after": "5",
        "ratelimit-reset": "8",
        "x-request-id": "telegram-get-file-recording-request",
        "x-correlation-id": "telegram-get-file-recording-correlation",
    }
    _reset_fake_provider_client(
        provider_payload,
        content=provider_body,
        headers=provider_headers,
    )

    async def fail_file_path_recording(db: AsyncSession, **_kwargs):
        await db.execute(text("SELECT * FROM telegram_missing_file_path_recording_table"))

    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.record_channel_agent_reference",
        fail_file_path_recording,
    )

    response = await client.post(
        _telegram_bot_path(created, "getFile"),
        headers=_telegram_agent_headers(created),
        json={"file_id": "telegram-owned-file"},
    )

    assert response.status_code == 200
    assert response.content == provider_body
    assert response.headers["content-type"] == provider_headers["content-type"]
    assert response.headers["content-length"] == provider_headers["content-length"]
    assert response.headers["retry-after"] == provider_headers["retry-after"]
    assert response.headers["ratelimit-reset"] == provider_headers["ratelimit-reset"]
    assert response.headers["x-telegram-request-id"] == provider_headers["x-request-id"]
    assert response.headers["x-request-id"] != provider_headers["x-request-id"]
    assert response.headers["x-correlation-id"] == provider_headers["x-correlation-id"]
    recorded_path = (
        await db_session.execute(
            select(ChannelAgentReference.id).where(
                ChannelAgentReference.account_id == UUID(created["id"]),
                ChannelAgentReference.ref_value == "documents/provider-success.dat",
            )
        )
    ).scalar_one_or_none()
    assert recorded_path is None
    assert (await db_session.execute(select(1))).scalar_one() == 1
    assert "telegram_reference_recording_failed" in caplog.text
    assert f"account_id={created['id']}" in caplog.text
    assert "method=getFile" in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "payload"),
    [
        ("getFile", {"file_id": "file-owned"}),
        ("answerCallbackQuery", {"callback_query_id": "callback-owned", "text": "done"}),
    ],
)
async def test_telegram_reference_methods_preserve_provider_failure_response(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    method: str,
    payload: dict[str, str],
):
    _reset_fake_provider_client({"ok": True, "result": True})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name=f"telegram-transparent-{method.lower()}",
        chat_id="42",
    )
    inbound = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "callback_query": {
                "id": "callback-owned",
                "data": "approve",
                "message": {
                    "message_id": 2,
                    "chat": {"id": 42, "type": "private"},
                    "document": {"file_id": "file-owned"},
                },
            },
        },
    )
    assert inbound.status_code == 200
    provider_body = b"telegram provider overloaded\n"
    provider_headers = {
        "content-type": "text/plain; charset=utf-8",
        "content-length": str(len(provider_body)),
        "retry-after": "11",
        "x-ratelimit-reset-after": "11.5",
        "x-request-id": "telegram-request-1",
        "x-correlation-id": "telegram-correlation-1",
    }
    _reset_fake_provider_client(
        {"ok": False, "future_error": {"retry_after": 11}},
        status_code=429,
        content=provider_body,
        headers=provider_headers,
    )

    response = await client.post(
        _telegram_bot_path(created, method),
        headers=_telegram_agent_headers(created),
        json=payload,
    )

    assert response.status_code == 429
    assert response.content == provider_body
    for key, value in provider_headers.items():
        if key == "x-request-id":
            assert response.headers["x-telegram-request-id"] == value
            assert response.headers["x-request-id"] != value
        else:
            assert response.headers[key] == value


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "payload"),
    [
        (
            "setMyCommands",
            {
                "commands": [
                    {
                        "command": "future",
                        "description": "Future command",
                        "future_command_field": "preserved",
                    }
                ],
                "future_top_level_option": {"enabled": True},
            },
        ),
        (
            "setChatMenuButton",
            {
                "chat_id": "42",
                "menu_button": {
                    "type": "future_button",
                    "future_menu_field": {"enabled": True},
                },
                "future_top_level_option": "preserved",
            },
        ),
    ],
)
async def test_telegram_materialized_shadow_methods_preserve_provider_error_and_unknown_fields(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    method: str,
    payload: dict[str, Any],
):
    _reset_fake_provider_client({"ok": True, "result": True})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name=f"telegram-transparent-shadow-{method.lower()}",
        chat_id="42",
    )
    provider_body = b'{  "ok" : false, "future_error":"provider-owned"  }\n'
    provider_headers = {
        "content-type": "application/json; charset=utf-8",
        "content-length": str(len(provider_body)),
        "retry-after": "7",
        "x-request-id": "telegram-shadow-request",
    }
    _reset_fake_provider_client(
        {"ok": False, "future_error": "provider-owned"},
        content=provider_body,
        headers=provider_headers,
    )

    response = await client.post(
        _telegram_bot_path(created, method),
        headers=_telegram_agent_headers(created),
        json=payload,
    )

    assert response.status_code == 200
    assert response.content == provider_body
    for key, value in provider_headers.items():
        if key == "x-request-id":
            assert response.headers["x-telegram-request-id"] == value
            assert response.headers["x-request-id"] != value
        else:
            assert response.headers[key] == value
    assert _FakeProviderClient.calls
    provider_payload = _FakeProviderClient.calls[0]["json"]
    assert provider_payload["future_top_level_option"] == payload["future_top_level_option"]
    if method == "setMyCommands":
        future_command = next(
            command for command in provider_payload["commands"] if command["command"] == "future"
        )
        assert future_command["future_command_field"] == "preserved"
    else:
        assert provider_payload["menu_button"]["future_menu_field"] == {"enabled": True}


@pytest.mark.asyncio
async def test_telegram_webhook_pair_code_creates_binding(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "telegram-main"},
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    webhook = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 1,
            "message": {
                "message_id": 42,
                "message_thread_id": 321,
                "is_topic_message": True,
                "text": f"/clawdi_pair {pair['code']}",
                "chat": {
                    "id": 987654321,
                    "type": "private",
                    "username": "paco",
                },
            },
        },
    )

    assert webhook.status_code == 200
    assert webhook.json()["paired"] is True
    assert webhook.json()["binding_id"]
    bindings = await client.get(f"/v1/channels/{created['id']}/bindings")
    assert bindings.status_code == 200
    assert bindings.json()[0]["external_chat_id"] == "987654321"
    assert bindings.json()[0]["external_chat_type"] == "private"
    assert bindings.json()[0]["external_chat_name"] == "paco"


@pytest.mark.asyncio
async def test_telegram_pairing_threads_share_one_chat_binding(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "telegram-chat-level-binding"},
        )
    ).json()
    webhook_url = f"/v1/channels/telegram/{created['id']}/webhook"
    headers = {"x-telegram-bot-api-secret-token": created["webhook_secret"]}

    for update_id, thread_id in ((11, 321), (12, 654)):
        pair = (
            await client.post(
                f"/v1/channels/{created['id']}/pair-codes",
                json={"agent_link_id": created["agent_link_id"], "ttl_seconds": 900},
            )
        ).json()
        response = await client.post(
            webhook_url,
            headers=headers,
            json={
                "update_id": update_id,
                "message": {
                    "message_id": update_id,
                    "message_thread_id": thread_id,
                    "text": f"/clawdi_pair {pair['code']}",
                    "chat": {"id": 987654321, "type": "private"},
                    "from": {"id": 987654321, "is_bot": False},
                },
            },
        )
        assert response.status_code == 200
        assert response.json()["paired"] is True

    bindings = await client.get(f"/v1/channels/{created['id']}/bindings")
    assert bindings.status_code == 200
    assert [binding["external_chat_id"] for binding in bindings.json()] == ["987654321"]


@pytest.mark.asyncio
async def test_telegram_pair_code_returns_server_owned_deep_link_metadata(
    client: httpx.AsyncClient,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-deep-link",
                "config": {"bot_username": "@Clawdi_Test_Bot"},
            },
        )
    ).json()
    response = await client.post(
        f"/v1/channels/{created['id']}/pair-codes",
        json={"agent_link_id": created["agent_link_id"], "ttl_seconds": 900},
    )

    assert response.status_code == 201
    pair = response.json()
    assert pair["pairing_command"] == f"/clawdi_pair {pair['code']}"
    assert pair["bot_username"] == "Clawdi_Test_Bot"
    assert pair["deep_link"] == f"https://t.me/Clawdi_Test_Bot?start={pair['code']}"
    assert pair["qr_payload"] == pair["deep_link"]
    assert created["agent_token"] not in pair["deep_link"]
    assert "telegram-secret" not in response.text


@pytest.mark.asyncio
async def test_telegram_pair_code_omits_link_metadata_for_invalid_username(
    client: httpx.AsyncClient,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-no-username",
                "config": {"bot_username": "ValidUser"},
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"agent_link_id": created["agent_link_id"], "ttl_seconds": 900},
        )
    ).json()

    assert pair["bot_username"] is None
    assert pair["deep_link"] is None
    assert pair["qr_payload"] is None
    assert pair["pairing_command"] == f"/clawdi_pair {pair['code']}"


@pytest.mark.asyncio
async def test_telegram_inbound_dedupes_update_redelivery_but_keeps_edits(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-update-identity",
        chat_id="4242",
        provider_token=None,
    )
    webhook_url = f"/v1/channels/telegram/{created['id']}/webhook"
    headers = {"x-telegram-bot-api-secret-token": created["webhook_secret"]}
    original = {
        "update_id": 7001,
        "message": {
            "message_id": 88,
            "text": "before edit",
            "chat": {"id": 4242, "type": "private"},
        },
    }
    edited = {
        "update_id": 7002,
        "edited_message": {
            "message_id": 88,
            "text": "after edit",
            "chat": {"id": 4242, "type": "private"},
        },
    }
    conflicting_chat_replay = {
        "update_id": 7001,
        "message": {
            "message_id": 99,
            "text": "must not become a second physical update",
            "chat": {"id": 4343, "type": "private"},
        },
    }

    assert (await client.post(webhook_url, headers=headers, json=original)).status_code == 200
    assert (await client.post(webhook_url, headers=headers, json=original)).status_code == 200
    assert (
        await client.post(webhook_url, headers=headers, json=conflicting_chat_replay)
    ).status_code == 200
    assert (await client.post(webhook_url, headers=headers, json=edited)).status_code == 200
    messages = list(
        (
            await db_session.execute(
                select(ChannelMessage).where(
                    ChannelMessage.account_id == UUID(created["id"]),
                    ChannelMessage.provider_event_id.in_(["update:7001", "update:7002"]),
                )
            )
        ).scalars()
    )
    assert sorted(
        (message.provider_event_id, message.provider_message_id, message.text)
        for message in messages
    ) == [
        ("update:7001", "88", "before edit"),
        ("update:7002", "88", "after edit"),
    ]
    activity = await client.get(f"/v1/channels/{created['id']}/activity")
    edited_items = [
        item
        for item in activity.json()["items"]
        if item.get("text") in {"before edit", "after edit"}
    ]
    assert [item["provider_message_id"] for item in edited_items] == ["88", "88"]


@pytest.mark.asyncio
async def test_telegram_concurrent_redelivery_has_one_agent_side_effect(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    real_httpx_async_client = httpx.AsyncClient
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-concurrent-redelivery",
        chat_id="4242",
        provider_token=None,
    )
    assert (
        await client.post(
            _telegram_bot_path(created, "setWebhook"),
            headers=_telegram_agent_headers(created),
            json={"url": "https://agent.example/concurrent-redelivery"},
        )
    ).status_code == 200
    _reset_sequenced_provider_client([200])
    monkeypatch.setattr(
        "app.services.channel_webhooks.SafePublicHttpClient",
        _SequencedProviderClient,
    )
    update = {
        "update_id": 7_501,
        "message": {
            "message_id": 101,
            "text": "deliver exactly once",
            "chat": {"id": 4242, "type": "private"},
        },
    }
    session_factory = async_sessionmaker(db_session.bind, expire_on_commit=False)
    previous_session_override = app.dependency_overrides[get_session]

    async def concurrent_session_override():
        async with session_factory() as request_session:
            yield request_session

    app.dependency_overrides[get_session] = concurrent_session_override
    try:
        async with real_httpx_async_client(
            transport=client._transport,
            base_url=str(client.base_url),
        ) as concurrent:
            first, second = await asyncio.gather(
                concurrent.post(
                    f"/v1/channels/telegram/{created['id']}/webhook",
                    headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
                    json=update,
                ),
                concurrent.post(
                    f"/v1/channels/telegram/{created['id']}/webhook",
                    headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
                    json=update,
                ),
            )
    finally:
        app.dependency_overrides[get_session] = previous_session_override

    assert first.status_code == 200
    assert second.status_code == 200
    messages = list(
        (
            await db_session.execute(
                select(ChannelMessage).where(
                    ChannelMessage.account_id == UUID(created["id"]),
                    ChannelMessage.provider_event_id == "update:7501",
                )
            )
        ).scalars()
    )
    assert len(messages) == 1
    assert len(_SequencedProviderClient.calls) == 1


@pytest.mark.asyncio
async def test_telegram_webhook_pair_code_sends_user_reply(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 100}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-pair-reply",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    webhook = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 1,
            "message": {
                "message_id": 42,
                "message_thread_id": 321,
                "is_topic_message": True,
                "text": f"/clawdi_pair {pair['code']}",
                "chat": {"id": 987654321, "type": "private", "username": "paco"},
                "from": {"id": 987654321, "is_bot": False, "username": "paco"},
            },
        },
    )

    assert webhook.status_code == 200
    assert webhook.json()["paired"] is True
    send_call = next(
        call for call in _FakeProviderClient.calls if call["url"].endswith("/sendMessage")
    )
    assert send_call["json"] == {
        "chat_id": "987654321",
        "message_thread_id": 321,
        "text": "Paired! This chat is now connected to your agent.",
    }


@pytest.mark.asyncio
async def test_telegram_general_forum_pairing_reply_omits_thread_id(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 109}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-general-forum-pair-reply",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    _clear_fake_provider_calls()

    paired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 7_601,
            "message": {
                "message_id": 7_601,
                "message_thread_id": 1,
                "is_topic_message": True,
                "text": f"/clawdi_pair {pair['code']}",
                "chat": {
                    "id": -1007601,
                    "type": "supergroup",
                    "is_forum": True,
                },
                "from": {"id": 7601, "is_bot": False},
            },
        },
    )

    assert paired.status_code == 200
    assert paired.json()["paired"] is True
    pairing_reply = next(
        call for call in _FakeProviderClient.calls if call["url"].endswith("/sendMessage")
    )
    assert pairing_reply["json"] == {
        "chat_id": "-1007601",
        "text": "Paired! This chat is now connected to your agent.",
    }


@pytest.mark.asyncio
async def test_telegram_webhook_pair_command_sends_failure_replies(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 101}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-pair-failure-replies",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()

    missing = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 1,
            "message": {
                "message_id": 43,
                "message_thread_id": 322,
                "is_topic_message": True,
                "text": "/clawdi_pair",
                "chat": {
                    "id": 987654322,
                    "type": "supergroup",
                    "is_forum": True,
                },
                "from": {"id": 987654322, "is_bot": False},
            },
        },
    )
    invalid = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "message": {
                "message_id": 44,
                "message_thread_id": 999,
                "is_topic_message": False,
                "text": "/clawdi_pair BCDFGHJKLM",
                "chat": {"id": 987654322, "type": "private"},
                "from": {"id": 987654322, "is_bot": False},
            },
        },
    )

    assert missing.status_code == 200
    assert invalid.status_code == 200
    assert [call["json"] for call in _FakeProviderClient.calls] == [
        {
            "chat_id": "987654322",
            "message_thread_id": 322,
            "text": "Usage: /clawdi_pair <code>",
        },
        {
            "chat_id": "987654322",
            "text": "Pairing failed: invalid.",
        },
    ]


@pytest.mark.asyncio
async def test_telegram_webhook_unpair_sends_user_reply(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 102}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-unpair-reply",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 1,
            "message": {
                "message_id": 45,
                "message_thread_id": 323,
                "is_topic_message": True,
                "text": f"/clawdi_pair {pair['code']}",
                "chat": {"id": 987654323, "type": "private"},
                "from": {"id": 987654323, "is_bot": False},
            },
        },
    )
    unpaired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "message": {
                "message_id": 46,
                "message_thread_id": 324,
                "is_topic_message": True,
                "text": "/clawdi_unpair",
                "chat": {"id": 987654323, "type": "private"},
                "from": {"id": 987654323, "is_bot": False},
            },
        },
    )

    assert unpaired.status_code == 200
    assert unpaired.json()["unpaired"] is True
    assert [
        call["json"] for call in _FakeProviderClient.calls if call["url"].endswith("/sendMessage")
    ] == [
        {
            "chat_id": "987654323",
            "message_thread_id": 323,
            "text": "Paired! This chat is now connected to your agent.",
        },
        {
            "chat_id": "987654323",
            "message_thread_id": 324,
            "text": "Unpaired. This chat is no longer connected to an agent.",
        },
    ]
    assert [
        call["json"]
        for call in _FakeProviderClient.calls
        if call["url"].endswith("/setChatMenuButton")
    ] == [
        {"chat_id": "987654323", "menu_button": {"type": "default"}},
        {"chat_id": "987654323", "menu_button": {"type": "default"}},
    ]


@pytest.mark.asyncio
async def test_public_telegram_unpair_reply_uses_platform_unbound_send(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    account = ChannelAccount(
        id=uuid4(),
        provider=CHANNEL_PROVIDER_TELEGRAM,
        visibility=CHANNEL_VISIBILITY_PUBLIC,
        user_id=None,
    )
    binding = ChannelBinding(bot_agent_link_id=uuid4())
    binding_result = channel_service.InboundBindingResult(
        binding=binding,
        unpaired=True,
        command_handled=True,
    )
    unbound_send = AsyncMock()
    bound_send = AsyncMock(side_effect=AssertionError("archived binding must not authorize reply"))
    monkeypatch.setattr(channel_service, "send_platform_unbound_channel_message", unbound_send)
    monkeypatch.setattr(channel_service, "send_channel_outbound_message", bound_send)

    reply = await channel_service.send_control_command_reply(
        db_session,
        account=account,
        external_chat_id="987654323",
        telegram_message_thread_id=324,
        command=channel_service.ChannelControlCommand(kind="unpair"),
        binding_result=binding_result,
    )

    assert reply is None
    unbound_send.assert_awaited_once_with(
        account=account,
        external_chat_id="987654323",
        text="Unpaired. This chat is no longer connected to an agent.",
        telegram_message_thread_id=324,
        telegram_direct_messages_topic_id=None,
    )
    bound_send.assert_not_awaited()


@pytest.mark.asyncio
async def test_telegram_channel_direct_message_pairing_replies_stay_in_originating_topic(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 104}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient", _FakeProviderClient
    )
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-direct-message-topic-replies",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    webhook_url = f"/v1/channels/telegram/{created['id']}/webhook"
    headers = {"x-telegram-bot-api-secret-token": created["webhook_secret"]}
    chat = {
        "id": -100987654326,
        "type": "supergroup",
        "is_direct_messages": True,
    }

    paired = await client.post(
        webhook_url,
        headers=headers,
        json={
            "update_id": 1,
            "message": {
                "message_id": 48,
                "direct_messages_topic": {"topic_id": 4242},
                "is_topic_message": True,
                "text": f"/clawdi_pair {pair['code']}",
                "chat": chat,
                "from": {"id": 4242, "is_bot": False},
            },
        },
    )
    same_actor = await client.post(
        webhook_url,
        headers=headers,
        json={
            "update_id": 2,
            "message": {
                "message_id": 49,
                "direct_messages_topic": {"topic_id": 4242},
                "is_topic_message": True,
                "text": "same actor reaches its isolated topic",
                "chat": chat,
                "from": {"id": 4242, "is_bot": False},
            },
        },
    )
    updates = await client.post(
        _telegram_bot_path(created, "getUpdates"),
        headers=_telegram_agent_headers(created),
        json={},
    )
    compatibility_body = (
        b'{ "chat_id": -100987654326, "message_thread_id": 4242, '
        b'"text": "reply through virtual topic transport", '
        b'"future_hint":"first", "future_hint":"second" }\n'
    )
    agent_reply = await client.post(
        _telegram_bot_path(created, "sendMessage"),
        headers={**_telegram_agent_headers(created), "content-type": "application/json"},
        content=compatibility_body,
    )
    edit_own_message = await client.post(
        _telegram_bot_path(created, "editMessageText"),
        headers=_telegram_agent_headers(created),
        json={
            "chat_id": -100987654326,
            "message_id": 104,
            "text": "edit an owned streamed message",
        },
    )
    edit_other_topic_message = await client.post(
        _telegram_bot_path(created, "editMessageText"),
        headers=_telegram_agent_headers(created),
        json={
            "chat_id": -100987654326,
            "message_id": 105,
            "text": "must not edit another topic",
        },
    )
    query_reply = await client.get(
        _telegram_bot_path(created, "sendMessage"),
        headers=_telegram_agent_headers(created),
        params={
            "chat_id": -100987654326,
            "message_thread_id": 4242,
            "text": "query topic transport",
        },
    )
    form_reply = await client.post(
        _telegram_bot_path(created, "sendMessage"),
        headers=_telegram_agent_headers(created),
        data={
            "chat_id": -100987654326,
            "message_thread_id": 4242,
            "text": "form topic transport",
        },
    )
    multipart_reply = await client.post(
        _telegram_bot_path(created, "sendMessage"),
        headers=_telegram_agent_headers(created),
        data={
            "chat_id": -100987654326,
            "message_thread_id": 4242,
            "text": "multipart topic transport",
        },
        files={"attachment": ("unused.txt", b"unused")},
    )
    telegram_rate_limiter.reset()
    native_direct_body = (
        b'{ "chat_id": -100987654326, "direct_messages_topic_id": 4242, '
        b'"text": "native direct topic" }\n'
    )
    native_direct_reply = await client.post(
        _telegram_bot_path(created, "sendMessage"),
        headers={**_telegram_agent_headers(created), "content-type": "application/json"},
        content=native_direct_body,
    )
    draft_body = (
        b'{ "chat_id": -100987654326, "message_thread_id": 4242, '
        b'"draft_id": 1, "text": "native draft" }\n'
    )
    draft = await client.post(
        _telegram_bot_path(created, "sendMessageDraft"),
        headers={**_telegram_agent_headers(created), "content-type": "application/json"},
        content=draft_body,
    )
    typing_body = b'{ "chat_id": -100987654326, "message_thread_id": 4242, "action": "typing" }\n'
    typing = await client.post(
        _telegram_bot_path(created, "sendChatAction"),
        headers={**_telegram_agent_headers(created), "content-type": "application/json"},
        content=typing_body,
    )
    missing_direct_topic = await client.post(
        _telegram_bot_path(created, "sendMessage"),
        headers=_telegram_agent_headers(created),
        json={"chat_id": -100987654326, "text": "ambiguous channel DM"},
    )
    duplicate_topic = await client.post(
        _telegram_bot_path(created, "sendMessage"),
        headers=_telegram_agent_headers(created),
        json={
            "chat_id": -100987654326,
            "message_thread_id": 4242,
            "direct_messages_topic_id": 4242,
            "text": "ambiguous topic transport",
        },
    )
    other_topic_reply = await client.post(
        _telegram_bot_path(created, "sendMessage"),
        headers=_telegram_agent_headers(created),
        json={
            "chat_id": -100987654326,
            "message_thread_id": 9999,
            "text": "must not cross direct-message actors",
        },
    )
    other_actor = await client.post(
        webhook_url,
        headers=headers,
        json={
            "update_id": 3,
            "message": {
                "message_id": 50,
                "direct_messages_topic": {"topic_id": 9999},
                "is_topic_message": True,
                "text": "must not cross direct-message actors",
                "chat": chat,
                "from": {"id": 9999, "is_bot": False},
            },
        },
    )
    unpaired = await client.post(
        webhook_url,
        headers=headers,
        json={
            "update_id": 4,
            "message": {
                "message_id": 51,
                "direct_messages_topic": {"topic_id": 4242},
                "is_topic_message": True,
                "text": "/clawdi_unpair",
                "chat": chat,
                "from": {"id": 4242, "is_bot": False},
            },
        },
    )

    assert paired.status_code == 200
    assert paired.json()["paired"] is True
    assert same_actor.status_code == 200
    assert updates.status_code == 200
    assert updates.json()["result"][0]["message"]["message_thread_id"] == 4242
    assert updates.json()["result"][0]["message"]["direct_messages_topic"] == {"topic_id": 4242}
    assert agent_reply.status_code == 200
    assert edit_own_message.status_code == 200
    assert edit_other_topic_message.status_code == 403
    assert query_reply.status_code == 200
    assert form_reply.status_code == 200
    assert multipart_reply.status_code == 200
    assert native_direct_reply.status_code == 200
    assert draft.status_code == 200
    assert typing.status_code == 200
    assert missing_direct_topic.status_code == 400
    assert missing_direct_topic.json()["description"] == (
        "Bad Request: direct message topic is required"
    )
    assert duplicate_topic.status_code == 400
    assert other_topic_reply.status_code == 403
    assert other_actor.status_code == 200
    assert other_actor.json()["binding_id"] is None
    assert unpaired.status_code == 200
    assert unpaired.json()["unpaired"] is True
    assert [
        call["json"]
        for call in _FakeProviderClient.calls
        if call["url"].endswith("/sendMessage") and "json" in call
    ] == [
        {
            "chat_id": "-100987654326",
            "direct_messages_topic_id": 4242,
            "text": "Paired! This chat is now connected to your agent.",
        },
        {
            "chat_id": "-100987654326",
            "direct_messages_topic_id": 9999,
            "text": telegram_router.TELEGRAM_UNPAIRED_TUTORIAL,
        },
        {
            "chat_id": "-100987654326",
            "direct_messages_topic_id": 4242,
            "text": "Unpaired. This chat is no longer connected to an agent.",
        },
    ]
    proxied_reply = next(
        call
        for call in _FakeProviderClient.calls
        if call.get("method") == "POST" and call["url"].endswith("/sendMessage")
    )
    assert proxied_reply["content"] == compatibility_body.replace(
        b'"message_thread_id"',
        b'"direct_messages_topic_id"',
    )
    query_call = next(
        call
        for call in _FakeProviderClient.calls
        if call.get("method") == "GET" and "/sendMessage?" in call["url"]
    )
    assert b"direct_messages_topic_id=4242" in httpx.URL(query_call["url"]).query
    assert b"message_thread_id" not in httpx.URL(query_call["url"]).query
    form_call = next(
        call
        for call in _FakeProviderClient.calls
        if call.get("method") == "POST"
        and call["url"].endswith("/sendMessage")
        and b"form+topic+transport" in call.get("content", b"")
    )
    assert b"direct_messages_topic_id=4242" in form_call["content"]
    assert b"message_thread_id" not in form_call["content"]
    multipart_call = next(
        call
        for call in _FakeProviderClient.calls
        if call.get("method") == "POST"
        and call["url"].endswith("/sendMessage")
        and b"multipart topic transport" in call.get("content", b"")
    )
    assert b'name="direct_messages_topic_id"' in multipart_call["content"]
    assert b'name="message_thread_id"' not in multipart_call["content"]
    native_direct_call = next(
        call
        for call in _FakeProviderClient.calls
        if call.get("method") == "POST"
        and call["url"].endswith("/sendMessage")
        and b"native direct topic" in call.get("content", b"")
    )
    assert native_direct_call["content"] == native_direct_body
    draft_call = next(
        call
        for call in _FakeProviderClient.calls
        if call.get("method") == "POST" and call["url"].endswith("/sendMessageDraft")
    )
    typing_call = next(
        call
        for call in _FakeProviderClient.calls
        if call.get("method") == "POST" and call["url"].endswith("/sendChatAction")
    )
    assert draft_call["content"] == draft_body
    assert typing_call["content"] == typing_body


@pytest.mark.asyncio
async def test_telegram_webhook_unpair_redelivery_does_not_duplicate_reply(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 103}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-unpair-redelivery",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    await _pair_telegram_chat(
        client,
        created=created,
        chat_id="987654325",
        chat_type="private",
    )
    payload = {
        "update_id": 7003,
        "message": {
            "message_id": 47,
            "text": "/clawdi_unpair",
            "chat": {"id": 987654325, "type": "private"},
            "from": {"id": 4242, "is_bot": False},
        },
    }
    webhook_url = f"/v1/channels/telegram/{created['id']}/webhook"
    headers = {"x-telegram-bot-api-secret-token": created["webhook_secret"]}

    first = await client.post(webhook_url, headers=headers, json=payload)
    redelivery = await client.post(webhook_url, headers=headers, json=payload)

    assert first.status_code == 200
    assert first.json()["unpaired"] is True
    assert redelivery.status_code == 200
    assert redelivery.json()["unpaired"] is False
    replies = [call for call in _FakeProviderClient.calls if call["url"].endswith("/sendMessage")]
    assert [call["json"]["text"] for call in replies] == [
        "Unpaired. This chat is no longer connected to an agent."
    ]
    command_message = (
        await db_session.execute(
            select(ChannelMessage).where(
                ChannelMessage.account_id == UUID(created["id"]),
                ChannelMessage.provider_event_id == "update:7003",
            )
        )
    ).scalar_one()
    assert command_message.delivered_at is not None


@pytest.mark.asyncio
async def test_telegram_concurrent_replayed_unpair_cannot_archive_replacement_binding(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 105}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    chat_id = "987654399"
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-concurrent-replayed-unpair",
        chat_id=chat_id,
    )
    replacement_pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    original_unpair = {
        "update_id": 7_603,
        "message": {
            "message_id": 7_603,
            "text": "/clawdi_unpair",
            "chat": {"id": int(chat_id), "type": "private"},
            "from": {"id": 4242, "is_bot": False},
        },
    }
    replacement_pair_update = {
        "update_id": 7_604,
        "message": {
            "message_id": 7_604,
            "text": f"/clawdi_pair {replacement_pair['code']}",
            "chat": {"id": int(chat_id), "type": "private"},
            "from": {"id": 4242, "is_bot": False},
        },
    }
    original_record = telegram_router.record_inbound_messages_for_bindings
    unpair_before_event_commit = asyncio.Event()
    release_unpair_commit = asyncio.Event()
    paused = False

    async def pause_first_unpair_before_event_commit(*args: Any, **kwargs: Any):
        nonlocal paused
        binding_result = kwargs["binding_result"]
        if binding_result.unpaired and not paused:
            paused = True
            unpair_before_event_commit.set()
            await release_unpair_commit.wait()
        return await original_record(*args, **kwargs)

    monkeypatch.setattr(
        telegram_router,
        "record_inbound_messages_for_bindings",
        pause_first_unpair_before_event_commit,
    )
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    previous_session_override = app.dependency_overrides[get_session]

    request_backend_pids: asyncio.Queue[int] = asyncio.Queue()

    async def independent_request_session() -> AsyncIterator[AsyncSession]:
        async with sessionmaker() as request_db:
            backend_pid = await request_db.scalar(text("SELECT pg_backend_pid()"))
            assert isinstance(backend_pid, int)
            request_backend_pids.put_nowait(backend_pid)
            yield request_db

    await db_session.rollback()
    app.dependency_overrides[get_session] = independent_request_session

    async def post_update(payload: dict[str, Any]) -> httpx.Response:
        return await client.post(
            f"/v1/channels/telegram/{created['id']}/webhook",
            headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
            json=payload,
        )

    try:
        first_unpair_task = asyncio.create_task(post_update(original_unpair))
        await asyncio.wait_for(unpair_before_event_commit.wait(), timeout=2)
        await asyncio.wait_for(request_backend_pids.get(), timeout=2)
        replacement_pair_task = asyncio.create_task(post_update(replacement_pair_update))
        await wait_for_lock_wait(
            sessionmaker, await asyncio.wait_for(request_backend_pids.get(), timeout=2)
        )
        replay_task = asyncio.create_task(post_update(original_unpair))
        await wait_for_lock_wait(
            sessionmaker, await asyncio.wait_for(request_backend_pids.get(), timeout=2)
        )
        release_unpair_commit.set()
        first_unpair, repaired, replay = await asyncio.gather(
            first_unpair_task,
            replacement_pair_task,
            replay_task,
        )
    finally:
        release_unpair_commit.set()
        app.dependency_overrides[get_session] = previous_session_override

    assert first_unpair.json()["unpaired"] is True
    assert repaired.json()["paired"] is True
    assert replay.json()["unpaired"] is False
    async with sessionmaker() as verification_db:
        active_bindings = list(
            (
                await verification_db.execute(
                    select(ChannelBinding).where(
                        ChannelBinding.account_id == UUID(created["id"]),
                        ChannelBinding.status == BINDING_STATUS_ACTIVE,
                    )
                )
            ).scalars()
        )
    assert len(active_bindings) == 1
    assert active_bindings[0].external_chat_id == chat_id
    replies = [call for call in _FakeProviderClient.calls if call["url"].endswith("/sendMessage")]
    assert [call["json"]["text"] for call in replies].count(
        "Unpaired. This chat is no longer connected to an agent."
    ) == 1


@pytest.mark.asyncio
async def test_telegram_unpaired_private_tutorial_is_idempotent_cooled_down_and_non_authoritative(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    expected_tutorial = (
        "This chat isn't paired yet. In Clawdi, open your agent's Telegram channel, "
        "choose Pair, then use the link or send /clawdi_pair <code> here."
    )
    assert telegram_router.TELEGRAM_UNPAIRED_TUTORIAL == expected_tutorial
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 106}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-unpaired-private-tutorial",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    _clear_fake_provider_calls()
    webhook_url = f"/v1/channels/telegram/{created['id']}/webhook"
    headers = {"x-telegram-bot-api-secret-token": created["webhook_secret"]}
    first_update = {
        "update_id": 7_610,
        "message": {
            "message_id": 7_610,
            "text": "/start",
            "chat": {"id": 987654410, "type": "private"},
            "from": {"id": 987654410, "is_bot": False},
        },
    }

    first = await client.post(webhook_url, headers=headers, json=first_update)
    replay = await client.post(webhook_url, headers=headers, json=first_update)
    cooled_down = await client.post(
        webhook_url,
        headers=headers,
        json={
            "update_id": 7_611,
            "message": {
                "message_id": 7_611,
                "text": "hello?",
                "chat": {"id": 987654410, "type": "private"},
                "from": {"id": 987654410, "is_bot": False},
            },
        },
    )

    assert first.status_code == 200
    assert replay.status_code == 200
    assert cooled_down.status_code == 200
    tutorial_calls = [
        call for call in _FakeProviderClient.calls if call["url"].endswith("/sendMessage")
    ]
    assert [call["json"] for call in tutorial_calls] == [
        {
            "chat_id": "987654410",
            "text": expected_tutorial,
        }
    ]
    assert (await client.get(f"/v1/channels/{created['id']}/bindings")).json() == []
    pair_row = await db_session.get(ChannelPairCode, UUID(pair["id"]))
    assert pair_row is not None
    assert pair_row.status == PAIR_CODE_STATUS_PENDING
    tutorial_message = (
        await db_session.execute(
            select(ChannelMessage).where(
                ChannelMessage.account_id == UUID(created["id"]),
                ChannelMessage.direction == MESSAGE_DIRECTION_OUTBOUND,
                ChannelMessage.text == expected_tutorial,
            )
        )
    ).scalar_one()
    tutorial_message.created_at = (
        datetime.now(UTC)
        - telegram_router.TELEGRAM_UNPAIRED_TUTORIAL_COOLDOWN
        - timedelta(seconds=1)
    )
    await db_session.commit()

    after_cooldown = await client.post(
        webhook_url,
        headers=headers,
        json={
            "update_id": 7_612,
            "message": {
                "message_id": 7_612,
                "text": "still there?",
                "chat": {"id": 987654410, "type": "private"},
                "from": {"id": 987654410, "is_bot": False},
            },
        },
    )
    assert after_cooldown.status_code == 200
    assert (
        len([call for call in _FakeProviderClient.calls if call["url"].endswith("/sendMessage")])
        == 2
    )


@pytest.mark.asyncio
async def test_telegram_unpaired_tutorial_failure_does_not_expose_internal_error(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 110}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-unpaired-tutorial-provider-failure",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    _FailingProviderClient.calls = []
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FailingProviderClient)

    response = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 7_613,
            "message": {
                "message_id": 7_613,
                "text": "help me pair",
                "chat": {"id": 987654413, "type": "private"},
                "from": {"id": 987654413, "is_bot": False},
            },
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "paired": False,
        "unpaired": False,
        "binding_id": None,
    }
    assert len(_FailingProviderClient.calls) == 1
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(ChannelMessage)
            .where(
                ChannelMessage.account_id == UUID(created["id"]),
                ChannelMessage.direction == MESSAGE_DIRECTION_OUTBOUND,
            )
        )
        == 0
    )


@pytest.mark.asyncio
async def test_telegram_unpaired_tutorial_avoids_groups_and_scopes_channel_dm_cooldown(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 107}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-unpaired-tutorial-scopes",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    _clear_fake_provider_calls()
    webhook_url = f"/v1/channels/telegram/{created['id']}/webhook"
    headers = {"x-telegram-bot-api-secret-token": created["webhook_secret"]}

    for update_id, chat in (
        (7_620, {"id": -1007620, "type": "group"}),
        (7_621, {"id": -1007621, "type": "supergroup", "is_forum": True}),
    ):
        response = await client.post(
            webhook_url,
            headers=headers,
            json={
                "update_id": update_id,
                "message": {
                    "message_id": update_id,
                    "message_thread_id": 77,
                    "is_topic_message": True,
                    "text": "ordinary group message",
                    "chat": chat,
                    "from": {"id": 77, "is_bot": False},
                },
            },
        )
        assert response.status_code == 200

    direct_chat = {
        "id": -1007622,
        "type": "supergroup",
        "is_direct_messages": True,
    }
    for update_id, topic_id in ((7_622, 81), (7_623, 81), (7_624, 82)):
        response = await client.post(
            webhook_url,
            headers=headers,
            json={
                "update_id": update_id,
                "message": {
                    "message_id": update_id,
                    "direct_messages_topic": {"topic_id": topic_id},
                    "is_topic_message": True,
                    "text": "ordinary channel DM",
                    "chat": direct_chat,
                    "from": {"id": topic_id, "is_bot": False},
                },
            },
        )
        assert response.status_code == 200

    tutorial_calls = [
        call for call in _FakeProviderClient.calls if call["url"].endswith("/sendMessage")
    ]
    assert [call["json"] for call in tutorial_calls] == [
        {
            "chat_id": "-1007622",
            "direct_messages_topic_id": 81,
            "text": telegram_router.TELEGRAM_UNPAIRED_TUTORIAL,
        },
        {
            "chat_id": "-1007622",
            "direct_messages_topic_id": 82,
            "text": telegram_router.TELEGRAM_UNPAIRED_TUTORIAL,
        },
    ]


@pytest.mark.asyncio
async def test_telegram_update_dedupe_is_account_scoped_across_repair(
    client: httpx.AsyncClient,
    channel_agent,
    second_channel_agent,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 104}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-account-dedupe-repair",
                "provider_token": "123456:telegram-secret",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    second_link = (
        await client.post(
            f"/v1/channels/{created['id']}/agent-links",
            json={"agent_id": str(second_channel_agent.id)},
        )
    ).json()
    webhook_url = f"/v1/channels/telegram/{created['id']}/webhook"
    headers = {"x-telegram-bot-api-secret-token": created["webhook_secret"]}
    chat = {"id": 987654326, "type": "private"}
    actor = {"id": 987654326, "is_bot": False}

    first_pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"agent_link_id": created["agent_link_id"], "ttl_seconds": 900},
        )
    ).json()
    first_payload = {
        "update_id": 7201,
        "message": {
            "message_id": 201,
            "text": f"/clawdi_pair {first_pair['code']}",
            "chat": chat,
            "from": actor,
        },
    }
    assert (await client.post(webhook_url, headers=headers, json=first_payload)).json()[
        "paired"
    ] is True
    assert (
        await client.post(
            webhook_url,
            headers=headers,
            json={
                "update_id": 7202,
                "message": {
                    "message_id": 202,
                    "text": "/clawdi_unpair",
                    "chat": chat,
                    "from": actor,
                },
            },
        )
    ).json()["unpaired"] is True

    second_pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"agent_link_id": second_link["id"], "ttl_seconds": 900},
        )
    ).json()
    assert (
        await client.post(
            webhook_url,
            headers=headers,
            json={
                "update_id": 7203,
                "message": {
                    "message_id": 203,
                    "text": f"/clawdi_pair {second_pair['code']}",
                    "chat": chat,
                    "from": actor,
                },
            },
        )
    ).json()["paired"] is True

    redelivery = await client.post(webhook_url, headers=headers, json=first_payload)
    bindings = await client.get(f"/v1/channels/{created['id']}/bindings")
    replies = [call for call in _FakeProviderClient.calls if call["url"].endswith("/sendMessage")]

    assert redelivery.status_code == 200
    assert redelivery.json()["paired"] is False
    assert bindings.json()[0]["agent_link_id"] == second_link["id"]
    assert [call["json"]["text"] for call in replies] == [
        "Paired! This chat is now connected to your agent.",
        "Unpaired. This chat is no longer connected to an agent.",
        "Paired! This chat is now connected to your agent.",
    ]


@pytest.mark.asyncio
async def test_delete_binding_unpairs_exactly_one_chat_and_cleans_telegram_projection(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    monkeypatch: pytest.MonkeyPatch,
):
    runtime_signals: list[tuple[UUID, UUID]] = []

    async def record_runtime_signal(_db, user_id: UUID, environment_id: UUID) -> bool:
        runtime_signals.append((user_id, environment_id))
        return True

    monkeypatch.setattr(
        "app.routes.channel_routers.public.queue_environment_runtime_manifest_changed",
        record_runtime_signal,
    )
    _reset_fake_provider_client({"ok": True, "result": {"username": "clawdi_test_bot"}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-ui-unpair-isolation",
                "provider_token": "123456:telegram-secret",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    runtime_signals.clear()
    await _pair_telegram_chat(
        client,
        created=created,
        chat_id="111",
        update_id=101,
        chat_type="private",
    )
    await _pair_telegram_chat(
        client,
        created=created,
        chat_id="222",
        update_id=102,
        chat_type="private",
    )
    commands = [{"command": "status", "description": "Show status"}]
    assert (
        await client.post(
            _telegram_bot_path(created, "setMyCommands"),
            headers=_telegram_agent_headers(created),
            json={"commands": commands},
        )
    ).status_code == 200
    bindings_before = (await client.get(f"/v1/channels/{created['id']}/bindings")).json()
    target = next(item for item in bindings_before if item["external_chat_id"] == "111")
    sibling = next(item for item in bindings_before if item["external_chat_id"] == "222")
    _clear_fake_provider_calls()

    deleted = await client.delete(f"/v1/channels/{created['id']}/bindings/{target['id']}")
    repeated = await client.delete(f"/v1/channels/{created['id']}/bindings/{target['id']}")

    assert deleted.status_code == 200, deleted.text
    assert deleted.json() == {
        "binding_id": target["id"],
        "unpaired": True,
        "notification_status": "sent",
        "provider_cleanup_status": "succeeded",
        "warning": None,
    }
    assert repeated.status_code == 200, repeated.text
    assert repeated.json()["unpaired"] is False
    assert runtime_signals == []
    binding_rows = {
        str(binding.id): binding
        for binding in (
            await db_session.execute(
                select(ChannelBinding).where(
                    ChannelBinding.id.in_([UUID(target["id"]), UUID(sibling["id"])])
                )
            )
        ).scalars()
    }
    assert binding_rows[target["id"]].status == BINDING_STATUS_ARCHIVED
    assert binding_rows[sibling["id"]].status == BINDING_STATUS_ACTIVE
    link = await db_session.get(ChannelBotAgentLink, UUID(created["agent_link_id"]))
    assert link is not None
    assert link.status != BOT_AGENT_LINK_STATUS_ARCHIVED
    assert link.archived_at is None
    remaining = (await client.get(f"/v1/channels/{created['id']}/bindings")).json()
    assert [item["id"] for item in remaining] == [sibling["id"]]
    assert [
        call["json"]
        for call in _FakeProviderClient.calls
        if call["url"].endswith("/deleteMyCommands")
    ] == [{"scope": {"type": "chat", "chat_id": "111"}}]
    assert [
        call["json"]
        for call in _FakeProviderClient.calls
        if call["url"].endswith("/setChatMenuButton")
    ] == [{"chat_id": "111", "menu_button": {"type": "default"}}]
    assert [
        call["json"] for call in _FakeProviderClient.calls if call["url"].endswith("/sendMessage")
    ] == [
        {
            "chat_id": "111",
            "text": "Unpaired. This chat is no longer connected to an agent.",
        }
    ]


@pytest.mark.asyncio
async def test_telegram_ui_unpair_revokes_pending_polling_update_across_repair(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 108}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-ui-unpair-revokes-polling",
        chat_id="441",
        chat_type="private",
    )
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    binding = (
        await db_session.execute(
            select(ChannelBinding).where(
                ChannelBinding.account_id == account.id,
                ChannelBinding.external_chat_id == "441",
            )
        )
    ).scalar_one()
    inbound = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 7_641,
            "message": {
                "message_id": 7_641,
                "text": "queued before unpair",
                "chat": {"id": 441, "type": "private"},
                "from": {"id": 4242, "is_bot": False},
            },
        },
    )
    assert inbound.status_code == 200
    queued = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.provider_event_id == "update:7641")
        )
    ).scalar_one()
    assert queued.delivered_at is None
    assert await channel_service.pending_channel_inbox_count(db_session, account=account) == 1

    deleted = await client.delete(f"/v1/channels/{created['id']}/bindings/{binding.id}")
    assert deleted.status_code == 200
    assert deleted.json()["unpaired"] is True
    await db_session.refresh(queued)
    assert queued.delivered_at is not None
    assert await channel_service.pending_channel_inbox_count(db_session, account=account) == 0

    replacement_pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    repaired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 7_642,
            "message": {
                "message_id": 7_642,
                "text": f"/clawdi_pair {replacement_pair['code']}",
                "chat": {"id": 441, "type": "private"},
                "from": {"id": 4242, "is_bot": False},
            },
        },
    )
    assert repaired.status_code == 200
    assert repaired.json()["paired"] is True
    active_binding = (
        await db_session.execute(
            select(ChannelBinding)
            .where(
                ChannelBinding.account_id == account.id,
                ChannelBinding.status == BINDING_STATUS_ACTIVE,
            )
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert active_binding.id == binding.id
    updates = await client.post(
        _telegram_bot_path(created, "getUpdates"),
        headers=_telegram_agent_headers(created),
        json={},
    )
    assert updates.status_code == 200
    assert updates.json()["result"] == []


@pytest.mark.asyncio
async def test_telegram_ui_unpair_winning_before_inbound_lease_records_only_unbound_evidence(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 109}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    chat_id = "442"
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-unpair-wins-before-inbound-lease",
        chat_id=chat_id,
        chat_type="private",
    )
    binding = (
        await db_session.execute(
            select(ChannelBinding).where(
                ChannelBinding.account_id == UUID(created["id"]),
                ChannelBinding.external_chat_id == chat_id,
            )
        )
    ).scalar_one()
    binding_id = binding.id
    original_record = telegram_router.record_inbound_messages_for_bindings
    resolved_before_lease = asyncio.Event()
    release_inbound = asyncio.Event()

    async def pause_before_ordinary_inbound_lease(*args: Any, **kwargs: Any):
        if kwargs["text"] == "ordinary update paused before lease":
            assert kwargs["require_active_authority"] is True
            resolved_before_lease.set()
            await release_inbound.wait()
        return await original_record(*args, **kwargs)

    monkeypatch.setattr(
        telegram_router,
        "record_inbound_messages_for_bindings",
        pause_before_ordinary_inbound_lease,
    )
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    previous_session_override = app.dependency_overrides[get_session]

    async def independent_request_session() -> AsyncIterator[AsyncSession]:
        async with sessionmaker() as request_db:
            yield request_db

    await db_session.rollback()
    await db_session.refresh(seed_user)
    app.dependency_overrides[get_session] = independent_request_session
    inbound_task: asyncio.Task[httpx.Response] | None = None
    try:
        inbound_task = asyncio.create_task(
            client.post(
                f"/v1/channels/telegram/{created['id']}/webhook",
                headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
                json={
                    "update_id": 7_643,
                    "message": {
                        "message_id": 7_643,
                        "text": "ordinary update paused before lease",
                        "chat": {"id": int(chat_id), "type": "private"},
                        "from": {"id": 4242, "is_bot": False},
                    },
                },
            )
        )
        await asyncio.wait_for(resolved_before_lease.wait(), timeout=2)
        deleted = await client.delete(f"/v1/channels/{created['id']}/bindings/{binding_id}")
        assert deleted.status_code == 200, deleted.text
        assert deleted.json()["unpaired"] is True
        release_inbound.set()
        inbound = await asyncio.wait_for(inbound_task, timeout=2)
    finally:
        release_inbound.set()
        if inbound_task is not None and not inbound_task.done():
            await asyncio.gather(inbound_task, return_exceptions=True)
        app.dependency_overrides[get_session] = previous_session_override

    assert inbound.status_code == 200, inbound.text
    assert inbound.json()["binding_id"] is None
    async with sessionmaker() as verification_db:
        message = (
            await verification_db.execute(
                select(ChannelMessage).where(ChannelMessage.provider_event_id == "update:7643")
            )
        ).scalar_one()
        account = await verification_db.get(ChannelAccount, UUID(created["id"]))
        assert account is not None
        assert message.binding_id is None
        assert (
            await channel_service.pending_channel_inbox_count(
                verification_db,
                account=account,
            )
            == 0
        )
    updates = await client.post(
        _telegram_bot_path(created, "getUpdates"),
        headers=_telegram_agent_headers(created),
        json={},
    )
    assert updates.status_code == 200
    assert updates.json()["result"] == []


@pytest.mark.asyncio
async def test_telegram_inbound_lease_makes_ui_unpair_wait_and_consume_inserted_row(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 110}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    chat_id = "443"
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-inbound-lease-makes-unpair-wait",
        chat_id=chat_id,
        chat_type="private",
    )
    binding = (
        await db_session.execute(
            select(ChannelBinding).where(
                ChannelBinding.account_id == UUID(created["id"]),
                ChannelBinding.external_chat_id == chat_id,
            )
        )
    ).scalar_one()
    binding_id = binding.id
    original_record = telegram_router.record_inbound_messages_for_bindings
    lease_acquired = asyncio.Event()
    release_inbound_commit = asyncio.Event()

    async def pause_after_ordinary_inbound_lease(*args: Any, **kwargs: Any):
        messages = await original_record(*args, **kwargs)
        if kwargs["text"] == "ordinary update holding lease":
            assert kwargs["require_active_authority"] is True
            lease_acquired.set()
            await release_inbound_commit.wait()
        return messages

    monkeypatch.setattr(
        telegram_router,
        "record_inbound_messages_for_bindings",
        pause_after_ordinary_inbound_lease,
    )
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    business_backend_pids: asyncio.Queue[int] = asyncio.Queue()
    previous_session_override = app.dependency_overrides[get_session]

    async def independent_request_session() -> AsyncIterator[AsyncSession]:
        async with sessionmaker() as request_db:
            backend_pid = await request_db.scalar(select(func.pg_backend_pid()))
            assert isinstance(backend_pid, int)
            business_backend_pids.put_nowait(backend_pid)
            yield request_db

    await db_session.rollback()
    await db_session.refresh(seed_user)
    app.dependency_overrides[get_session] = independent_request_session
    inbound_task: asyncio.Task[httpx.Response] | None = None
    unpair_task: asyncio.Task[httpx.Response] | None = None
    try:
        inbound_task = asyncio.create_task(
            client.post(
                f"/v1/channels/telegram/{created['id']}/webhook",
                headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
                json={
                    "update_id": 7_644,
                    "message": {
                        "message_id": 7_644,
                        "text": "ordinary update holding lease",
                        "chat": {"id": int(chat_id), "type": "private"},
                        "from": {"id": 4242, "is_bot": False},
                    },
                },
            )
        )
        inbound_backend_pid = await asyncio.wait_for(business_backend_pids.get(), timeout=2)
        await asyncio.wait_for(lease_acquired.wait(), timeout=2)
        unpair_task = asyncio.create_task(
            client.delete(f"/v1/channels/{created['id']}/bindings/{binding_id}")
        )
        unpair_backend_pid = await asyncio.wait_for(business_backend_pids.get(), timeout=2)
        assert unpair_backend_pid != inbound_backend_pid
        await asyncio.wait_for(
            wait_for_lock_wait(sessionmaker, unpair_backend_pid),
            timeout=2,
        )
        release_inbound_commit.set()
        inbound, deleted = await asyncio.wait_for(
            asyncio.gather(inbound_task, unpair_task),
            timeout=3,
        )
    finally:
        release_inbound_commit.set()
        pending_tasks = [
            task for task in (inbound_task, unpair_task) if task is not None and not task.done()
        ]
        if pending_tasks:
            for task in pending_tasks:
                task.cancel()
            await asyncio.gather(*pending_tasks, return_exceptions=True)
        app.dependency_overrides[get_session] = previous_session_override

    assert inbound.status_code == 200, inbound.text
    assert inbound.json()["binding_id"] == str(binding_id)
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["unpaired"] is True
    async with sessionmaker() as verification_db:
        message = (
            await verification_db.execute(
                select(ChannelMessage).where(ChannelMessage.provider_event_id == "update:7644")
            )
        ).scalar_one()
        account = await verification_db.get(ChannelAccount, UUID(created["id"]))
        assert account is not None
        assert message.binding_id == binding_id
        assert message.delivered_at is not None
        assert (
            await channel_service.pending_channel_inbox_count(
                verification_db,
                account=account,
            )
            == 0
        )
    updates = await client.post(
        _telegram_bot_path(created, "getUpdates"),
        headers=_telegram_agent_headers(created),
        json={},
    )
    assert updates.status_code == 200
    assert updates.json()["result"] == []


@pytest.mark.asyncio
async def test_delete_binding_keeps_unpair_durable_when_telegram_notification_fails(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"username": "clawdi_test_bot"}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-ui-unpair-notify-failure",
        chat_id="333",
        chat_type="private",
    )
    binding = (await client.get(f"/v1/channels/{created['id']}/bindings")).json()[0]
    _FailingProviderClient.calls = []
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FailingProviderClient,
    )
    await channel_service.close_channel_provider_http_client()

    deleted = await client.delete(f"/v1/channels/{created['id']}/bindings/{binding['id']}")

    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["unpaired"] is True
    assert deleted.json()["notification_status"] == "failed"
    assert deleted.json()["provider_cleanup_status"] == "failed"
    assert "unpaired" in deleted.json()["warning"].lower()
    archived = await db_session.get(ChannelBinding, UUID(binding["id"]))
    assert archived is not None
    assert archived.status == BINDING_STATUS_ARCHIVED
    audit = await client.get(
        "/v1/audit/events",
        params={"channel_account_id": created["id"], "limit": 20},
    )
    cleanup_event = next(
        item
        for item in audit.json()["items"]
        if item["action"] == "channel.binding.telegram_cleanup"
    )
    assert cleanup_event["details"] == {
        "notification_status": "failed",
        "provider_cleanup_status": "failed",
    }


@pytest.mark.asyncio
async def test_telegram_webhook_pair_reply_failure_does_not_roll_back_binding(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"ok": True, "result": True})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-pair-reply-fails",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    _FailingProviderClient.calls = []
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FailingProviderClient)
    await channel_service.close_channel_provider_http_client()

    webhook = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 1,
            "message": {
                "message_id": 47,
                "text": f"/clawdi_pair {pair['code']}",
                "chat": {"id": 987654324, "type": "private"},
                "from": {"id": 987654324, "is_bot": False},
            },
        },
    )

    assert webhook.status_code == 200
    assert webhook.json()["paired"] is True
    bindings = await client.get(f"/v1/channels/{created['id']}/bindings")
    assert bindings.status_code == 200
    assert bindings.json()[0]["external_chat_id"] == "987654324"
    assert [call["url"].rsplit("/", 1)[-1] for call in _FailingProviderClient.calls] == [
        "sendMessage",
        "setChatMenuButton",
    ]


@pytest.mark.asyncio
async def test_telegram_webhook_start_deep_link_pair_code_creates_binding(
    client: httpx.AsyncClient,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "telegram-start-pair"},
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    webhook = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 1,
            "message": {
                "message_id": 42,
                "text": f"/start {pair['code']}",
                "chat": {"id": 987654322, "type": "private"},
            },
        },
    )
    legacy_start = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "message": {
                "message_id": 43,
                "text": "/start OLD_PAIR_CODE",
                "chat": {"id": 987654323, "type": "private"},
            },
        },
    )

    assert webhook.status_code == 200
    assert webhook.json()["paired"] is True
    assert legacy_start.status_code == 200
    assert legacy_start.json()["paired"] is False
    bindings = await client.get(f"/v1/channels/{created['id']}/bindings")
    assert [binding["external_chat_id"] for binding in bindings.json()] == ["987654322"]


@pytest.mark.asyncio
async def test_telegram_start_claims_explicit_agent_link_and_redelivery_is_idempotent(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    second_channel_agent,
    monkeypatch: pytest.MonkeyPatch,
):
    real_httpx_async_client = httpx.AsyncClient
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 100}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-explicit-start-pair",
                "agent_id": str(channel_agent.id),
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    _clear_fake_provider_calls()
    second = (
        await client.post(
            f"/v1/channels/{created['id']}/agent-links",
            json={"agent_id": str(second_channel_agent.id)},
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"agent_link_id": second["id"], "ttl_seconds": 900},
        )
    ).json()
    payload = {
        "update_id": 7101,
        "message": {
            "message_id": 91,
            "text": f"/start@Clawdi_Test_Bot {pair['code']}",
            "chat": {"id": 987654399, "type": "private"},
            "from": {"id": 987654399, "is_bot": False},
        },
    }
    webhook_url = f"/v1/channels/telegram/{created['id']}/webhook"
    headers = {"x-telegram-bot-api-secret-token": created["webhook_secret"]}
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)

    async def independent_session():
        async with sessionmaker() as session:
            yield session

    previous_session_override = app.dependency_overrides[get_session]
    app.dependency_overrides[get_session] = independent_session
    try:
        transport = httpx.ASGITransport(app=app)
        async with real_httpx_async_client(
            transport=transport, base_url="http://test"
        ) as concurrent:
            first, redelivery = await asyncio.gather(
                concurrent.post(webhook_url, headers=headers, json=payload),
                concurrent.post(webhook_url, headers=headers, json=payload),
            )
    finally:
        app.dependency_overrides[get_session] = previous_session_override
    bindings = await client.get(f"/v1/channels/{created['id']}/bindings")
    events = list(
        (
            await db_session.execute(
                select(ChannelMessage).where(
                    ChannelMessage.account_id == UUID(created["id"]),
                    ChannelMessage.provider_event_id == "update:7101",
                )
            )
        ).scalars()
    )

    assert first.status_code == 200
    assert redelivery.status_code == 200
    assert sorted([first.json()["paired"], redelivery.json()["paired"]]) == [False, True]
    assert len(bindings.json()) == 1
    assert len(events) == 1
    assert bindings.json()[0]["agent_link_id"] == second["id"]
    pairing_replies = [
        call for call in _FakeProviderClient.calls if call["url"].endswith("/sendMessage")
    ]
    assert len(pairing_replies) == 1
    assert "paired" in pairing_replies[0]["json"]["text"].lower()


@pytest.mark.asyncio
async def test_telegram_webhook_rejects_invalid_secret(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "telegram-secret-check"},
        )
    ).json()

    response = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": "wrong"},
        json={
            "message": {
                "message_id": 1,
                "text": "hello",
                "chat": {"id": 123, "type": "private"},
            }
        },
    )

    assert response.status_code == 401


def test_telegram_reply_thread_requires_a_true_private_or_forum_topic():
    def update(*, chat_type: str, is_topic: bool, is_forum: bool = False):
        return {
            "message": {
                "message_thread_id": 77,
                "is_topic_message": is_topic,
                "chat": {"id": -1001, "type": chat_type, "is_forum": is_forum},
            }
        }

    assert telegram_message_thread_id_from_update(update(chat_type="private", is_topic=True)) == 77
    assert (
        telegram_message_thread_id_from_update(
            update(chat_type="supergroup", is_topic=True, is_forum=True)
        )
        == 77
    )
    general_topic = update(chat_type="supergroup", is_topic=True, is_forum=True)
    general_topic["message"]["message_thread_id"] = 1
    assert telegram_message_thread_id_from_update(general_topic) is None
    assert (
        telegram_message_thread_id_from_update(update(chat_type="private", is_topic=False)) is None
    )
    assert (
        telegram_message_thread_id_from_update(
            update(chat_type="supergroup", is_topic=False, is_forum=True)
        )
        is None
    )
    assert (
        telegram_message_thread_id_from_update(
            update(chat_type="group", is_topic=True, is_forum=False)
        )
        is None
    )


def test_telegram_direct_message_reply_topic_requires_a_true_direct_messages_chat():
    def update(*, chat_type: str, is_direct_messages: bool, topic_id: object):
        return {
            "message": {
                "direct_messages_topic": {"topic_id": topic_id},
                "chat": {
                    "id": -1001,
                    "type": chat_type,
                    "is_direct_messages": is_direct_messages,
                },
            }
        }

    assert (
        telegram_direct_messages_topic_id_from_update(
            update(
                chat_type="supergroup",
                is_direct_messages=True,
                topic_id=4_294_967_297,
            )
        )
        == 4_294_967_297
    )
    assert (
        telegram_direct_messages_topic_id_from_update(
            update(chat_type="supergroup", is_direct_messages=False, topic_id=77)
        )
        is None
    )
    assert (
        telegram_direct_messages_topic_id_from_update(
            update(chat_type="private", is_direct_messages=True, topic_id=77)
        )
        is None
    )
    assert (
        telegram_direct_messages_topic_id_from_update(
            update(chat_type="supergroup", is_direct_messages=True, topic_id=True)
        )
        is None
    )


def test_normalize_telegram_bot_username_requires_bot_suffix():
    assert normalize_telegram_bot_username(" @Clawdi_Test_Bot ") == "Clawdi_Test_Bot"
    assert normalize_telegram_bot_username("ClawdiPublicBot") == "ClawdiPublicBot"
    assert normalize_telegram_bot_username("ValidUser") is None
    assert normalize_telegram_bot_username("bad!") is None
    assert normalize_telegram_bot_username("bot") is None


@pytest.mark.asyncio
async def test_telegram_webhook_unpair_archives_and_allows_repair(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "telegram-unpair"},
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    paired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "message": {
                "message_id": 1,
                "text": f"/clawdi_pair {pair['code']}",
                "chat": {"id": 123456, "type": "private"},
            }
        },
    )
    assert paired.status_code == 200
    assert paired.json()["paired"] is True

    unpaired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "message": {
                "message_id": 2,
                "text": "/clawdi_unpair@shared_bot",
                "chat": {"id": 123456, "type": "private"},
            }
        },
    )
    assert unpaired.status_code == 200
    assert unpaired.json()["unpaired"] is True

    bindings = await client.get(f"/v1/channels/{created['id']}/bindings")
    assert bindings.status_code == 200
    assert bindings.json() == []

    pair_again = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    repaired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "message": {
                "message_id": 3,
                "text": f"/clawdi_pair {pair_again['code']}",
                "chat": {"id": 123456, "type": "private"},
            }
        },
    )
    assert repaired.status_code == 200
    assert repaired.json()["paired"] is True
    repaired_bindings = await client.get(f"/v1/channels/{created['id']}/bindings")
    assert len(repaired_bindings.json()) == 1


@pytest.mark.asyncio
async def test_telegram_pairing_same_agent_is_idempotent_and_consumes_code(
    client: httpx.AsyncClient,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "telegram-already-bound"},
        )
    ).json()
    first = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    second = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    paired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "message": {
                "message_id": 1,
                "text": f"/clawdi_pair {first['code']}",
                "chat": {"id": 111, "type": "private"},
            }
        },
    )
    repaired_same_agent = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "message": {
                "message_id": 2,
                "text": f"/clawdi_pair {second['code']}",
                "chat": {"id": 111, "type": "private"},
            }
        },
    )
    await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "message": {
                "message_id": 3,
                "text": "/clawdi_unpair",
                "chat": {"id": 111, "type": "private"},
            }
        },
    )
    repaired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "message": {
                "message_id": 4,
                "text": f"/clawdi_pair {second['code']}",
                "chat": {"id": 111, "type": "private"},
            }
        },
    )

    assert paired.json()["paired"] is True
    assert repaired_same_agent.json()["paired"] is True
    assert repaired.json()["paired"] is False


@pytest.mark.asyncio
async def test_telegram_provider_429_preserves_official_retry_after(
    monkeypatch: pytest.MonkeyPatch,
):
    class RateLimitedTelegramClient:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def aclose(self):
            return None

        async def post(self, *_args, **_kwargs):
            return httpx.Response(
                429,
                json={
                    "ok": False,
                    "error_code": 429,
                    "parameters": {"retry_after": 12},
                },
            )

    async def allow_test_url(*_args, **_kwargs):
        return None

    monkeypatch.setattr(channel_service.httpx, "AsyncClient", RateLimitedTelegramClient)
    monkeypatch.setattr(channel_service, "validate_channel_http_url", allow_test_url)

    with pytest.raises(HTTPException) as caught:
        await channel_service._post_provider_json(
            channel=CHANNEL_PROVIDER_TELEGRAM,
            method="sendMessage",
            url="https://api.telegram.org/bot-placeholder/sendMessage",
            json_payload={"chat_id": "1", "text": "rate limit"},
            timeout_seconds=20,
            unreachable_detail="telegram api unreachable",
            rejected_detail="telegram api rejected message",
        )

    assert caught.value.status_code == 429
    assert caught.value.detail == "telegram api rate limited"
    assert caught.value.headers == {"Retry-After": "12.0"}


@pytest.mark.asyncio
async def test_telegram_command_sync_uses_set_my_commands(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    _FakeProviderClient.calls = []
    _FakeProviderClient.response_payload = {"ok": True, "result": True}
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-commands",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()

    response = await client.post(f"/v1/channels/{created['id']}/commands/sync", json={})

    assert response.status_code == 200
    assert response.json()["provider"] == "telegram"
    assert _FakeProviderClient.calls[0]["url"].endswith("/bot123456:telegram-secret/setMyCommands")
    assert _FakeProviderClient.calls[0]["json"]["commands"] == [
        {"command": "clawdi_pair", "description": "Pair this chat with Clawdi."},
        {"command": "clawdi_unpair", "description": "Disconnect this chat from Clawdi."},
        {"command": "clawdi_help", "description": "Show safe Clawdi pairing instructions."},
    ]

    _clear_fake_provider_calls()
    custom = await client.post(
        f"/v1/channels/{created['id']}/commands/sync",
        json={
            "commands": [
                {"name": "clawdi_help", "description": "Agent conflict"},
                {"name": "agent_owned", "description": "Agent command"},
            ]
        },
    )
    assert custom.status_code == 200
    assert _FakeProviderClient.calls[0]["json"]["commands"] == [
        {"command": "clawdi_pair", "description": "Pair this chat with Clawdi."},
        {"command": "clawdi_unpair", "description": "Disconnect this chat from Clawdi."},
        {"command": "clawdi_help", "description": "Show safe Clawdi pairing instructions."},
        {"command": "agent_owned", "description": "Agent command"},
    ]
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    await db_session.refresh(account)
    assert (
        account.config["telegram_reserved_command_version"]
        == channel_service.TELEGRAM_RESERVED_COMMAND_VERSION
    )

    _clear_fake_provider_calls()
    oversized = await client.post(
        f"/v1/channels/{created['id']}/commands/sync",
        json={
            "commands": [
                {"name": f"agent_{index}", "description": "Agent command"} for index in range(98)
            ]
        },
    )
    assert oversized.status_code == 400
    assert _FakeProviderClient.calls == []


@pytest.mark.asyncio
async def test_telegram_pair_code_converges_reserved_default_once_before_issuance(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"ok": True, "result": True})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-reserved-command-convergence",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    _reset_fake_provider_client({"ok": False})

    failed = await client.post(
        f"/v1/channels/{created['id']}/pair-codes",
        json={"ttl_seconds": 900},
    )

    assert failed.status_code == 502
    assert (
        await db_session.execute(
            select(func.count())
            .select_from(ChannelPairCode)
            .where(ChannelPairCode.account_id == UUID(created["id"]))
        )
    ).scalar_one() == 0

    _reset_fake_provider_client({"ok": True, "result": True})
    first = await client.post(
        f"/v1/channels/{created['id']}/pair-codes",
        json={"ttl_seconds": 900},
    )
    assert first.status_code == 201
    assert len(_FakeProviderClient.calls) == 1
    assert _FakeProviderClient.calls[0]["json"]["commands"] == list(
        telegram_router._TELEGRAM_RESERVED_COMMANDS
    )

    _clear_fake_provider_calls()
    second = await client.post(
        f"/v1/channels/{created['id']}/pair-codes",
        json={"ttl_seconds": 900},
    )
    assert second.status_code == 201
    assert _FakeProviderClient.calls == []


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
